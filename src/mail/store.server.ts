import { operation } from "@tinkered/core";
import { z } from "zod";

import { database } from "./config.server";
import { type Account, provider, type Row } from "./contract";

// The store: SQLite through bun:sqlite. It is the truth; the board keeps no member, and each
// write ends with an `invalidate` from the op that made it (sync, mark, remove).

const schema = `
create table if not exists accounts (
  id text primary key, provider text not null, email text not null, name text not null,
  cursor text, synced_at integer not null default 0, error text not null default ''
);
create table if not exists messages (
  account text not null, pid text not null, thread text not null,
  from_name text not null, from_addr text not null, subject text not null, snippet text not null,
  date integer not null, unread integer not null, starred integer not null, attach integer not null,
  primary key (account, pid)
);
create index if not exists messages_date on messages (date desc);
create table if not exists raws (
  account text not null, pid text not null, mime blob not null, primary key (account, pid)
);
`;

/** What a provider gives for one message in a list. */
export const meta = z.object({
  pid: z.string(),
  thread: z.string(),
  fromName: z.string(),
  fromAddr: z.string(),
  subject: z.string(),
  snippet: z.string(),
  date: z.number(),
  unread: z.boolean(),
  starred: z.boolean(),
  attach: z.boolean(),
});

export type Meta = z.infer<typeof meta>;

const accountRow = z.object({
  id: z.string(),
  provider,
  email: z.string(),
  name: z.string(),
  cursor: z.string().nullable(),
  synced_at: z.number(),
  error: z.string(),
});

const messageRow = z.object({
  account: z.string(),
  pid: z.string(),
  thread: z.string(),
  from_name: z.string(),
  from_addr: z.string(),
  subject: z.string(),
  snippet: z.string(),
  date: z.number(),
  unread: z.number(),
  starred: z.number(),
  attach: z.number(),
});

/** Makes the tables when they are missing. Start runs it. */
export const initStore = operation({
  label: "store.init",
  depends: { db: database },
  run: ({ db }) => {
    db.run("pragma journal_mode = wal");
    db.exec(schema);
  },
});

/** Every account, with its sync cursor: the server's own view. */
export const listAccounts = operation({
  label: "store.accounts",
  depends: { db: database },
  run: ({ db }) =>
    z.array(accountRow).parse(db.query("select * from accounts order by email").all()),
});

/** The accounts as the board shows them: no cursor. */
export const loadAccounts = operation({
  label: "store.accounts.load",
  input: z.object({}),
  depends: { listAccounts },
  run: ({ listAccounts }): Account[] =>
    listAccounts.run().map((a) => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      name: a.name,
      syncedAt: a.synced_at,
      error: a.error,
    })),
});

/** Adds an account, or keeps the one with that id and its mail. */
export const saveAccount = operation({
  label: "store.account.save",
  input: z.object({ id: z.string(), provider, email: z.string(), name: z.string() }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    db.query(
      `insert into accounts (id, provider, email, name) values ($id, $provider, $email, $name)
       on conflict (id) do update set name = excluded.name, error = ''`,
    ).run({ $id: input.id, $provider: input.provider, $email: input.email, $name: input.name });
  },
});

/** Removes an account and every message of it. */
export const dropAccount = operation({
  label: "store.account.drop",
  input: z.object({ id: z.string() }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    const found = db.query("delete from accounts where id = $id").run({ $id: input.id });
    if (found.changes === 0) return { kind: "gone" as const, id: input.id };
    db.query("delete from messages where account = $id").run({ $id: input.id });
    db.query("delete from raws where account = $id").run({ $id: input.id });
    return { kind: "removed" as const };
  },
});

/** A sync's end: the cursor to start from next, and the failure to show ("" for none). */
export const noteSync = operation({
  label: "store.account.synced",
  input: z.object({
    id: z.string(),
    cursor: z.string().nullable(),
    at: z.number(),
    error: z.string(),
  }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    db.query(
      `update accounts set cursor = coalesce($cursor, cursor), synced_at = $at, error = $error
       where id = $id`,
    ).run({ $id: input.id, $cursor: input.cursor, $at: input.at, $error: input.error });
  },
});

/** Writes a sync's changes in one transaction. `full` drops every message the list left out. */
export const applySync = operation({
  label: "store.apply",
  input: z.object({
    account: z.string(),
    full: z.boolean(),
    rows: z.array(meta),
    removed: z.array(z.string()),
  }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    const put = db.query(
      `insert or replace into messages values
       ($account, $pid, $thread, $fromName, $fromAddr, $subject, $snippet, $date, $unread, $starred, $attach)`,
    );
    const drop = db.query("delete from messages where account = $account and pid = $pid");
    db.transaction(() => {
      if (input.full) {
        db.query("delete from messages where account = $account").run({ $account: input.account });
      }
      for (const m of input.rows) {
        put.run({
          $account: input.account,
          $pid: m.pid,
          $thread: m.thread,
          $fromName: m.fromName,
          $fromAddr: m.fromAddr,
          $subject: m.subject,
          $snippet: m.snippet,
          $date: m.date,
          $unread: Number(m.unread),
          $starred: Number(m.starred),
          $attach: Number(m.attach),
        });
      }
      for (const pid of input.removed) drop.run({ $account: input.account, $pid: pid });
    })();
    return { count: input.rows.length };
  },
});

/** A box's newest messages: "all" is every account's inbox. The store sorts and cuts. */
export const loadMessages = operation({
  label: "store.messages.load",
  input: z.object({
    box: z.string(),
    order: z.enum(["-date"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  depends: { db: database },
  run: ({ db }, { input }): Row[] => {
    const all = input.box === "all";
    const found = db
      .query(
        `select * from messages where ($all or account = $box) order by date desc limit $limit`,
      )
      .all({ $all: Number(all), $box: input.box, $limit: input.limit ?? 100 });
    return z
      .array(messageRow)
      .parse(found)
      .map((m) => ({
        box: input.box,
        id: `${m.account}:${m.pid}`,
        account: m.account,
        thread: m.thread,
        fromName: m.from_name,
        fromAddr: m.from_addr,
        subject: m.subject,
        snippet: m.snippet,
        date: m.date,
        unread: m.unread === 1,
        starred: m.starred === 1,
        attach: m.attach === 1,
      }));
  },
});

/** One message's flags, by its id; null when the store has no such message. */
export const findMessage = operation({
  label: "store.message.find",
  input: z.object({ account: z.string(), pid: z.string() }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    const found = db
      .query("select unread from messages where account = $account and pid = $pid")
      .get({ $account: input.account, $pid: input.pid });
    return found === null ? null : z.object({ unread: z.number() }).parse(found);
  },
});

/** Sets a message's unread flag, as the provider now has it. */
export const flagMessage = operation({
  label: "store.message.flag",
  input: z.object({ account: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    db.query("update messages set unread = $unread where account = $account and pid = $pid").run({
      $account: input.account,
      $pid: input.pid,
      $unread: Number(input.unread),
    });
  },
});

/** A message's source, kept after its first open; null before. */
export const readRaw = operation({
  label: "store.raw.read",
  input: z.object({ account: z.string(), pid: z.string() }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    const found = db
      .query("select mime from raws where account = $account and pid = $pid")
      .get({ $account: input.account, $pid: input.pid });
    return found === null ? null : z.object({ mime: z.instanceof(Uint8Array) }).parse(found).mime;
  },
});

export const keepRaw = operation({
  label: "store.raw.keep",
  input: z.object({ account: z.string(), pid: z.string(), mime: z.instanceof(Uint8Array) }),
  depends: { db: database },
  run: ({ db }, { input }) => {
    db.query("insert or replace into raws values ($account, $pid, $mime)").run({
      $account: input.account,
      $pid: input.pid,
      $mime: input.mime,
    });
  },
});
