import { Database } from "bun:sqlite";

import { capsule, operation, tag } from "@tinkered/core";
import { z } from "zod";

import { type Account, folderKind, type FolderRow, provider, type Row } from "./contract";

const schema = tag<string>({
  label: "store.schema",
  default: `
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
create virtual table if not exists search using fts5(
  account unindexed, pid unindexed, head, body, tokenize = "unicode61 remove_diacritics 2"
);
create table if not exists folders (
  account text not null, id text not null, name text not null, kind text not null,
  position integer not null, primary key (account, id)
);
create table if not exists trusted (domain text primary key, at integer not null);
create table if not exists boxes (
  account text not null, folder text not null, synced_at integer not null default 0,
  viewed_at integer not null default 0, primary key (account, folder)
);
`,
});

const migrations = tag<readonly string[]>({
  label: "store.migrations",
  default: [
    `alter table messages rename to messages_v0;
     create table messages (
       account text not null, folder text not null, pid text not null, thread text not null,
       from_name text not null, from_addr text not null, subject text not null,
       snippet text not null, date integer not null, unread integer not null,
       starred integer not null, attach integer not null,
       primary key (account, folder, pid)
     );
     insert into messages select account, 'INBOX', pid, thread, from_name, from_addr, subject,
       snippet, date, unread, starred, attach from messages_v0;
     drop table messages_v0;
     drop index if exists messages_date;
     create index messages_date on messages (date desc);`,
  ],
});

const file = tag<string>({ label: "store.file" });

export const store = capsule({
  label: "store",
  config: { file: file.required, schema, migrations },
  hooks: {
    async start({ config, next, signal }) {
      await next();
      const db = new Database(config.file, { create: true, strict: true });

      db.run("pragma journal_mode = wal");
      db.exec(config.schema);
      const { user_version: done } = z
        .object({ user_version: z.number() })
        .parse(db.query("pragma user_version").get());
      db.transaction(() => {
        config.migrations.slice(done).forEach((step) => db.exec(step));
        db.exec(`pragma user_version = ${config.migrations.length}`);
      })();
      signal.addEventListener("abort", () => db.close());
      return db;
    },
  },
});

const bodyMax = tag<number>({ label: "store.bodyMax", default: 20_000 });

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
  folder: z.string(),
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

export const foldText = operation({
  label: "store.fold",
  input: z.array(z.string()),
  run: (_, { input }) =>
    input.map((text) =>
      text
        .normalize("NFD")
        .replaceAll(/\p{M}/gu, "")
        .replaceAll(/[đĐ]/g, "d")
        .toLowerCase(),
    ),
});

export const listAccounts = operation({
  label: "store.accounts",
  depends: { db: store },
  run: ({ db }) =>
    z.array(accountRow).parse(db.query("select * from accounts order by email").all()),
});

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

export const saveAccount = operation({
  label: "store.account.save",
  input: z.object({ id: z.string(), provider, email: z.string(), name: z.string() }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    db.query(
      `insert into accounts (id, provider, email, name) values ($id, $provider, $email, $name)
       on conflict (id) do update set name = excluded.name, error = ''`,
    ).run({ $id: input.id, $provider: input.provider, $email: input.email, $name: input.name });
  },
});

export const dropAccount = operation({
  label: "store.account.drop",
  input: z.object({ id: z.string() }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    const found = db.query("delete from accounts where id = $id").run({ $id: input.id });
    if (found.changes === 0) return { kind: "gone" as const, id: input.id };

    db.query("delete from messages where account = $id").run({ $id: input.id });
    db.query("delete from raws where account = $id").run({ $id: input.id });
    db.query("delete from search where account = $id").run({ $id: input.id });
    db.query("delete from folders where account = $id").run({ $id: input.id });
    db.query("delete from boxes where account = $id").run({ $id: input.id });
    return { kind: "removed" as const };
  },
});

export const noteSync = operation({
  label: "store.account.synced",
  input: z.object({
    id: z.string(),
    cursor: z.string().nullable(),
    at: z.number(),
    error: z.string(),
  }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    db.query(
      `update accounts set cursor = coalesce($cursor, cursor), synced_at = $at, error = $error
       where id = $id`,
    ).run({ $id: input.id, $cursor: input.cursor, $at: input.at, $error: input.error });
  },
});

export const applySync = operation({
  label: "store.apply",
  input: z.object({
    account: z.string(),
    folder: z.string(),
    full: z.boolean(),
    rows: z.array(meta),
    removed: z.array(z.string()),
  }),
  depends: { db: store, foldText },
  run: ({ db, foldText }, { input }) => {
    const heads = foldText.run({
      input: input.rows.map((m) => `${m.subject} ${m.fromName} ${m.fromAddr} ${m.snippet}`),
    });
    const head = db.query("update search set head = $head where account = $account and pid = $pid");
    const fresh = db.query("insert into search values ($account, $pid, $head, '')");
    const box = { $account: input.account, $folder: input.folder };

    const put = db.query(
      `insert or replace into messages values ($account, $folder, $pid, $thread, $fromName,
       $fromAddr, $subject, $snippet, $date, $unread, $starred, $attach)`,
    );
    const drop = db.query(
      "delete from messages where account = $account and folder = $folder and pid = $pid",
    );
    const known = db.query("select 1 from messages where account = $account and pid = $pid");
    const arrived = input.rows.filter(
      (m) => m.unread && known.get({ $account: input.account, $pid: m.pid }) === null,
    );

    db.transaction(() => {
      if (input.full) {
        db.query("delete from messages where account = $account and folder = $folder").run(box);
      }
      for (const m of input.rows) {
        put.run({
          ...box,
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
      input.rows.forEach((m, i) => {
        const key = { $account: input.account, $pid: m.pid, $head: heads[i] ?? "" };
        if (head.run(key).changes === 0) fresh.run(key);
      });
      for (const pid of input.removed) drop.run({ ...box, $pid: pid });
      db.query(
        `delete from search where account = $account
         and pid not in (select pid from messages where account = $account)`,
      ).run({ $account: input.account });
    })();
    return { count: input.rows.length, fresh: arrived };
  },
});

const rowsOf = operation({
  label: "store.rows",
  input: z.object({ box: z.string(), found: z.array(messageRow) }),
  run: (_, { input }): Row[] =>
    input.found.map((m) => ({
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
    })),
});

const searchMessages = operation({
  label: "store.search",
  input: z.object({ q: z.string(), limit: z.number() }),
  depends: { db: store, foldText },
  run: ({ db, foldText }, { input }): unknown[] => {
    const [folded = ""] = foldText.run({ input: [input.q] });
    const words = folded.split(/[^\p{L}\p{N}@._-]+/u).filter(Boolean);
    if (words.length === 0) return [];

    return db
      .query(
        `select m.* from search s join messages m on m.account = s.account and m.pid = s.pid
         where search match $match group by m.account, m.pid order by m.date desc limit $limit`,
      )
      .all({ $match: words.map((w) => `"${w}"*`).join(" "), $limit: input.limit });
  },
});

export const boxOf = operation({
  label: "store.box",
  input: z.string(),
  run: (_, { input }) => {
    const at = input.indexOf("~");
    if (input === "all") return { account: null, folder: "INBOX" };

    return at < 0
      ? { account: input, folder: "INBOX" }
      : { account: input.slice(0, at), folder: input.slice(at + 1) };
  },
});

export const loadMessages = operation({
  label: "store.messages.load",
  input: z.object({
    box: z.string(),
    order: z.enum(["-date"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  depends: { db: store, searchMessages, rowsOf, boxOf },
  run: ({ db, searchMessages, rowsOf, boxOf }, { input }): Row[] => {
    const limit = input.limit ?? 100;
    const { account, folder } = boxOf.run({ input: input.box });
    const found = input.box.startsWith("search:")
      ? searchMessages.run({ input: { q: input.box.slice(7), limit } })
      : db
          .query(
            `select * from messages where folder = $folder and ($all or account = $account)
             order by date desc limit $limit`,
          )
          .all({
            $all: Number(account === null),
            $account: account,
            $folder: folder,
            $limit: limit,
          });
    return rowsOf.run({ input: { box: input.box, found: z.array(messageRow).parse(found) } });
  },
});

export const folder = z.object({ id: z.string(), name: z.string(), kind: folderKind });

export type Folder = z.infer<typeof folder>;

export const saveFolders = operation({
  label: "store.folders.save",
  input: z.object({ account: z.string(), folders: z.array(folder) }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    const put = db.query("insert into folders values ($account, $id, $name, $kind, $position)");
    db.transaction(() => {
      db.query("delete from folders where account = $account").run({ $account: input.account });
      input.folders.forEach((f, position) =>
        put.run({
          $account: input.account,
          $id: f.id,
          $name: f.name,
          $kind: f.kind,
          $position: position,
        }),
      );
    })();
  },
});

export const loadFolders = operation({
  label: "store.folders.load",
  input: z.object({ account: z.string().optional() }),
  depends: { db: store },
  run: ({ db }, { input }): FolderRow[] =>
    z
      .array(z.object({ account: z.string(), id: z.string(), name: z.string(), kind: folderKind }))
      .parse(
        db
          .query(
            `select account, id, name, kind from folders where ($all or account = $account)
             order by account, position`,
          )
          .all({ $all: Number(input.account === undefined), $account: input.account ?? "" }),
      ),
});

export const touchBox = operation({
  label: "store.box.touch",
  input: z.object({
    account: z.string(),
    folder: z.string(),
    at: z.number(),
    what: z.enum(["viewed", "synced"]),
  }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    const column = input.what === "viewed" ? "viewed_at" : "synced_at";
    db.query(
      `insert into boxes (account, folder, ${column}) values ($account, $folder, $at)
       on conflict (account, folder) do update set ${column} = $at`,
    ).run({ $account: input.account, $folder: input.folder, $at: input.at });
    return z
      .object({ synced_at: z.number(), viewed_at: z.number() })
      .parse(
        db
          .query(
            "select synced_at, viewed_at from boxes where account = $account and folder = $folder",
          )
          .get({ $account: input.account, $folder: input.folder }),
      );
  },
});

export const watchedBoxes = operation({
  label: "store.boxes.watched",
  input: z.object({ since: z.number() }),
  depends: { db: store },
  run: ({ db }, { input }) =>
    z
      .array(z.object({ account: z.string(), folder: z.string() }))
      .parse(
        db
          .query(
            "select account, folder from boxes where viewed_at >= $since and folder != 'INBOX'",
          )
          .all({ $since: input.since }),
      ),
});

export const indexBody = operation({
  label: "store.body.index",
  input: z.object({ account: z.string(), pid: z.string(), text: z.string() }),
  depends: { db: store, foldText, bodyMax },
  run: ({ db, foldText, bodyMax }, { input }) => {
    const [body = ""] = foldText.run({ input: [input.text.slice(0, bodyMax)] });
    db.query("update search set body = $body where account = $account and pid = $pid").run({
      $account: input.account,
      $pid: input.pid,
      $body: body,
    });
  },
});

export const missingSources = operation({
  label: "store.raws.missing",
  input: z.object({ account: z.string(), limit: z.number() }),
  depends: { db: store },
  run: ({ db }, { input }) =>
    z
      .array(z.object({ pid: z.string() }))
      .parse(
        db
          .query(
            `select pid from messages m where account = $account and not exists
             (select 1 from raws r where r.account = m.account and r.pid = m.pid)
             group by pid order by max(unread) desc, max(date) desc limit $limit`,
          )
          .all({ $account: input.account, $limit: input.limit }),
      )
      .map((r) => r.pid),
});

export const findMessage = operation({
  label: "store.message.find",
  input: z.object({ account: z.string(), pid: z.string() }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    const found = db
      .query("select unread, from_addr from messages where account = $account and pid = $pid")
      .get({ $account: input.account, $pid: input.pid });
    return found === null
      ? null
      : z.object({ unread: z.number(), from_addr: z.string() }).parse(found);
  },
});

export const flagMessage = operation({
  label: "store.message.flag",
  input: z.object({ account: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    db.query("update messages set unread = $unread where account = $account and pid = $pid").run({
      $account: input.account,
      $pid: input.pid,
      $unread: Number(input.unread),
    });
  },
});

export const readRaw = operation({
  label: "store.raw.read",
  input: z.object({ account: z.string(), pid: z.string() }),
  depends: { db: store },
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
  depends: { db: store },
  run: ({ db }, { input }) => {
    db.query("insert or replace into raws values ($account, $pid, $mime)").run({
      $account: input.account,
      $pid: input.pid,
      $mime: input.mime,
    });
  },
});

export const trustDomain = operation({
  label: "store.trust",
  input: z.object({ domain: z.string().min(1), trust: z.boolean(), at: z.number() }),
  depends: { db: store },
  run: ({ db }, { input }) => {
    const key = { $domain: input.domain.toLowerCase() };
    if (input.trust) {
      db.query("insert or replace into trusted values ($domain, $at)").run({
        ...key,
        $at: input.at,
      });
      return { kind: "trusted" as const };
    }

    db.query("delete from trusted where domain = $domain").run(key);
    return { kind: "untrusted" as const };
  },
});

export const isTrusted = operation({
  label: "store.trusted.is",
  input: z.object({ domain: z.string() }),
  depends: { db: store },
  run: ({ db }, { input }) =>
    db
      .query("select 1 from trusted where domain = $domain")
      .get({ $domain: input.domain.toLowerCase() }) !== null,
});

export const loadTrusted = operation({
  label: "store.trusted.load",
  input: z.object({}),
  depends: { db: store },
  run: ({ db }) =>
    z
      .array(z.object({ domain: z.string(), at: z.number() }))
      .parse(db.query("select domain, at from trusted order by domain").all()),
});
