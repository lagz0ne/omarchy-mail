import { operation, tag } from "@tinkered/core";
import { z } from "zod";

import { accessToken } from "./auth.server";
import { mailAction, mailBoard, provider, syncing } from "./contract";
import {
  googleFolderPull,
  googleFolders,
  googleMark,
  googlePull,
  googleAct,
  googleRaw,
  googleRaws,
} from "./google.server";
import {
  microsoftFolders,
  microsoftMark,
  microsoftPull,
  microsoftAct,
  microsoftRaw,
  microsoftRaws,
} from "./microsoft.server";
import { announce } from "./notify.server";
import type { Pulled } from "./provider.server";
import { keepSource } from "./source.server";
import {
  meta,
  applySync,
  boxOf,
  listAccounts,
  missingSources,
  noteSync,
  saveFolders,
  touchBox,
  watchedBoxes,
} from "./store.server";
import { type Job, throttle } from "./throttle.server";

const pullBy = operation({
  label: "sync.pullBy",
  input: z.object({
    provider,
    access: z.string(),
    user: z.string(),
    cursor: z.string().nullable(),
  }),
  depends: { googlePull, microsoftPull },
  run: async ({ googlePull, microsoftPull }, { input }): Promise<Pulled> =>
    input.provider === "google"
      ? googlePull.run({ input: { access: input.access, cursor: input.cursor } })
      : microsoftPull.run({ input: { access: input.access, user: input.user, folder: "INBOX" } }),
});

export const rawBy = operation({
  label: "sync.rawBy",
  input: z.object({ provider, access: z.string(), user: z.string(), pid: z.string() }),
  depends: { googleRaw, microsoftRaw },
  run: async ({ googleRaw, microsoftRaw }, { input }) => {
    const call = { input: { access: input.access, user: input.user, pid: input.pid } };
    return input.provider === "google" ? googleRaw.run(call) : microsoftRaw.run(call);
  },
});

export const markBy = operation({
  label: "sync.markBy",
  input: z.object({
    provider,
    access: z.string(),
    user: z.string(),
    pid: z.string(),
    unread: z.boolean(),
  }),
  depends: { googleMark, microsoftMark },
  run: async ({ googleMark, microsoftMark }, { input }) => {
    const { access, user, pid, unread } = input;
    const call = { input: { access, user, pid, unread } };
    await (input.provider === "google" ? googleMark.run(call) : microsoftMark.run(call));
  },
});

export const actBy = operation({
  label: "sync.actBy",
  input: z.object({
    provider,
    access: z.string(),
    user: z.string(),
    pid: z.string(),
    action: mailAction,
    from: z.string(),
    to: z.string().optional(),
    places: z.record(z.string(), z.string()),
  }),
  depends: { googleAct, microsoftAct },
  run: async ({ googleAct, microsoftAct }, { input }) =>
    input.provider === "google" ? googleAct.run({ input }) : microsoftAct.run({ input }),
});

const keepPull = operation({
  label: "sync.keep",
  input: z.object({ account: z.string(), pulled: z.custom<Pulled>() }),
  depends: { applySync },
  run: ({ applySync }, { input }) => {
    const { account, pulled } = input;
    switch (pulled.kind) {
      case "full":
        return {
          cursor: pulled.cursor,
          fresh: applySync.run({
            input: { account, folder: "INBOX", full: true, rows: pulled.rows, removed: [] },
          }).fresh,
        };
      case "delta":
        return {
          cursor: pulled.cursor,
          fresh: applySync.run({
            input: {
              account,
              folder: "INBOX",
              full: false,
              rows: pulled.rows,
              removed: pulled.removed,
            },
          }).fresh,
        };
      case "reset":
        return { cursor: null, fresh: [] };
    }
  },
});

const foldersBy = operation({
  label: "sync.foldersBy",
  input: z.object({ provider, access: z.string(), user: z.string() }),
  depends: { googleFolders, microsoftFolders },
  run: async ({ googleFolders, microsoftFolders }, { input }) =>
    input.provider === "google"
      ? googleFolders.run({ input: { access: input.access } })
      : microsoftFolders.run({ input: { access: input.access, user: input.user } }),
});

const folderPullBy = operation({
  label: "sync.folderPullBy",
  input: z.object({ provider, access: z.string(), user: z.string(), folder: z.string() }),
  depends: { googleFolderPull, microsoftPull },
  run: async ({ googleFolderPull, microsoftPull }, { input }) =>
    input.provider === "google"
      ? googleFolderPull.run({ input: { access: input.access, folder: input.folder } })
      : (await microsoftPull.run({ input })).rows,
});

export const syncAccount = operation({
  label: "sync.account",
  input: z.object({ id: z.string(), provider, user: z.string(), cursor: z.string().nullable() }),
  depends: { accessToken, pullBy, keepPull, foldersBy, saveFolders },
  run: async ({ accessToken, pullBy, keepPull, foldersBy, saveFolders }, { input }) => {
    const access = await accessToken.run({
      input: { account: input.id, provider: input.provider },
    });
    const { provider, user } = input;
    let pulled = await pullBy.run({ input: { provider, access, user, cursor: input.cursor } });

    if (pulled.kind === "reset") {
      pulled = await pullBy.run({ input: { provider, access, user, cursor: null } });
    }
    const folders = await foldersBy.run({ input: { provider, access, user } });
    saveFolders.run({ input: { account: input.id, folders } });
    return keepPull.run({ input: { account: input.id, pulled } });
  },
});

export const syncBox = operation({
  label: "sync.box",
  input: z.object({ account: z.string(), folder: z.string() }),
  depends: { listAccounts, accessToken, folderPullBy, applySync, touchBox },
  run: async (
    { listAccounts, accessToken, folderPullBy, applySync, touchBox },
    { input, clock },
  ) => {
    const owner = listAccounts.run().find((a) => a.id === input.account);
    if (!owner) return 0;

    const { provider, email: user } = owner;
    const access = await accessToken.run({ input: { account: owner.id, provider } });
    const rows = await folderPullBy.run({
      input: { provider, access, user, folder: input.folder },
    });
    applySync.run({ input: { ...input, full: true, rows, removed: [] } });
    touchBox.run({ input: { ...input, at: clock.currentTimeMillis(), what: "synced" } });
    return rows.length;
  },
});

const watchFor = tag<number>({ label: "sync.watchFor", default: 10 * 60_000 });

const fresh = tag<number>({ label: "sync.fresh", default: 60_000 });

const ahead = tag<number>({ label: "sync.ahead", default: 50 });

const rawsBy = operation({
  label: "sync.rawsBy",
  input: z.object({ provider, access: z.string(), user: z.string(), pids: z.array(z.string()) }),
  depends: { googleRaws, microsoftRaws },
  run: async ({ googleRaws, microsoftRaws }, { input }) =>
    input.provider === "google"
      ? googleRaws.run({ input: { access: input.access, pids: input.pids } })
      : microsoftRaws.run({ input }),
});

const prefetchAccount = operation({
  label: "sync.prefetch.account",
  input: z.object({ id: z.string(), provider, user: z.string() }),
  depends: { missingSources, accessToken, rawsBy, keepSource, ahead },
  run: async ({ missingSources, accessToken, rawsBy, keepSource, ahead }, { input }) => {
    const pids = missingSources.run({ input: { account: input.id, limit: ahead } });
    if (pids.length === 0) return 0;

    const access = await accessToken.run({
      input: { account: input.id, provider: input.provider },
    });
    const got = await rawsBy.run({
      input: { provider: input.provider, access, user: input.user, pids },
    });
    for (const m of got) {
      await keepSource.run({ input: { account: input.id, pid: m.pid, mime: m.mime } });
    }
    return got.length;
  },
});

const priorities = tag<Readonly<Record<"view" | "inbox" | "ahead", number>>>({
  label: "sync.priorities",
  default: { view: 0, inbox: 1, ahead: 2 },
});

const task = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox"), account: z.string() }),
  z.object({ kind: z.literal("box"), account: z.string(), folder: z.string() }),
  z.object({ kind: z.literal("ahead"), account: z.string() }),
]);

export const queueTask = operation({
  label: "sync.queue",
  input: z.object({ task, priority: z.enum(["view", "inbox", "ahead"]) }),
  depends: { listAccounts, throttle, priorities },
  run: ({ listAccounts, throttle, priorities }, { input }) => {
    const owner = listAccounts.run().find((a) => a.id === input.task.account);
    if (!owner) return "gone" as const;

    const where = input.task.kind === "box" ? `:${input.task.folder}` : "";
    return throttle.enqueue({
      key: `${input.task.kind}:${owner.id}${where}`,
      family: owner.provider,
      priority: priorities[input.priority],
      task: input.task,
    });
  },
});

const outcomeOf = operation({
  label: "sync.outcome",
  input: z.object({ done: z.unknown(), first: z.boolean() }),
  run: (_, { input }) => {
    const done = z
      .object({
        status: z.literal("success"),
        value: z.object({ cursor: z.string().nullable(), fresh: z.array(meta) }),
      })
      .safeParse(input.done);
    if (done.success) {
      const fresh = input.first ? [] : done.data.value.fresh;
      return { error: "", cursor: done.data.value.cursor, fresh };
    }

    const failure = z
      .object({
        error: z
          .object({
            kind: z.string().optional(),
            payload: z.object({ status: z.number().optional() }).passthrough().optional(),
          })
          .passthrough(),
      })
      .safeParse(input.done);
    const kind = failure.success ? (failure.data.error.kind ?? "failed") : "failed";
    const status = failure.success ? failure.data.error.payload?.status : undefined;
    return { error: status ? `${kind} ${status}` : kind, cursor: null, fresh: [] };
  },
});

const syncInbox = operation({
  label: "sync.inbox",
  input: z.object({ account: z.string() }),
  depends: {
    listAccounts,
    syncAccount,
    noteSync,
    queueTask,
    announce,
    outcomeOf,
    invalidate: mailBoard.invalidate,
  },
  run: async (deps, { input, clock }) => {
    const owner = deps.listAccounts.run().find((a) => a.id === input.account);
    if (!owner) return "gone";

    const done = await deps.syncAccount.settle({
      input: { id: owner.id, provider: owner.provider, user: owner.email, cursor: owner.cursor },
    });
    const { error, cursor, fresh } = deps.outcomeOf.run({
      input: { done, first: owner.cursor === null },
    });
    deps.noteSync.run({ input: { id: owner.id, cursor, at: clock.currentTimeMillis(), error } });
    if (fresh.length) {
      await deps.announce.run({ input: { account: owner.id, email: owner.email, rows: fresh } });
    }
    await deps.invalidate.run({ input: { accounts: {}, messages: {}, folders: {} } });
    if (!error) {
      deps.queueTask.run({
        input: { task: { kind: "ahead", account: owner.id }, priority: "ahead" },
      });
    }
    return error;
  },
});

const fetchAhead = operation({
  label: "sync.ahead",
  input: z.object({ account: z.string() }),
  depends: { listAccounts, prefetchAccount, invalidate: mailBoard.invalidate },
  run: async ({ listAccounts, prefetchAccount, invalidate }, { input }) => {
    const owner = listAccounts.run().find((a) => a.id === input.account);
    if (!owner) return 0;

    const fetched = await prefetchAccount.run({
      input: { id: owner.id, provider: owner.provider, user: owner.email },
    });
    if (fetched > 0) await invalidate.run({ input: { messages: {} } });
    return fetched;
  },
});

export const runJob = operation({
  label: "sync.job",
  input: z.custom<Job>(),
  depends: {
    syncInbox,
    syncBox,
    fetchAhead,
    throttle,
    status: syncing.controller,
    invalidate: mailBoard.invalidate,
  },
  run: async (deps, { input, clock }) => {
    deps.status.set({ busy: true, at: deps.status.get().at });
    try {
      const job = task.parse(input.task);
      switch (job.kind) {
        case "inbox":
          return await deps.syncInbox.run({ input: job });
        case "box":
          await deps.syncBox.run({ input: job });
          await deps.invalidate.run({ input: { messages: {} } });
          return "";
        case "ahead":
          return await deps.fetchAhead.run({ input: job });
      }
    } finally {
      deps.status.set({ busy: deps.throttle.size() > 1, at: clock.currentTimeMillis() });
    }
  },
});

export const syncAll = operation({
  label: "sync.all",
  depends: { listAccounts, watchedBoxes, queueTask, watchFor },
  run: ({ listAccounts, watchedBoxes, queueTask, watchFor }, { clock }) => {
    const all = listAccounts.run();
    for (const a of all) {
      queueTask.run({ input: { task: { kind: "inbox", account: a.id }, priority: "inbox" } });
    }
    const since = clock.currentTimeMillis() - watchFor;
    for (const box of watchedBoxes.run({ input: { since } })) {
      queueTask.run({ input: { task: { kind: "box", ...box }, priority: "inbox" } });
    }
    return { accounts: all.length };
  },
});

export const pullBox = operation({
  label: "mail.pull.do",
  input: z.object({ box: z.string() }),
  depends: { boxOf, listAccounts, touchBox, queueTask, fresh },
  run: (deps, { input, clock }) => {
    const { account, folder } = deps.boxOf.run({ input: input.box });
    const known = deps.listAccounts.run().some((a) => a.id === account);
    if (!known || !account || input.box.startsWith("search:")) {
      return { kind: "gone" as const, id: input.box };
    }

    const now = clock.currentTimeMillis();
    const box = deps.touchBox.run({ input: { account, folder, at: now, what: "viewed" } });
    if (folder === "INBOX" || now - box.synced_at < deps.fresh) return { kind: "fresh" as const };

    deps.queueTask.run({ input: { task: { kind: "box", account, folder }, priority: "view" } });
    return { kind: "queued" as const };
  },
});
