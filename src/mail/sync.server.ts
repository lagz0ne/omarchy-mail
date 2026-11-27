import { operation, tag } from "@tinkered/core";
import { z } from "zod";

import { accessToken } from "./auth.server";
import { mailBoard, provider } from "./contract";
import { googleMark, googlePull, googleRaw, googleRaws } from "./google.server";
import { microsoftMark, microsoftPull, microsoftRaw, microsoftRaws } from "./microsoft.server";
import type { Pulled } from "./provider.server";
import { keepSource } from "./source.server";
import { applySync, listAccounts, missingSources, noteSync } from "./store.server";

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
      : microsoftPull.run({ input: { access: input.access, user: input.user } }),
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

const keepPull = operation({
  label: "sync.keep",
  input: z.object({ account: z.string(), pulled: z.custom<Pulled>() }),
  depends: { applySync },
  run: ({ applySync }, { input }) => {
    const { account, pulled } = input;
    switch (pulled.kind) {
      case "full":
        applySync.run({ input: { account, full: true, rows: pulled.rows, removed: [] } });
        return pulled.cursor;
      case "delta":
        applySync.run({
          input: { account, full: false, rows: pulled.rows, removed: pulled.removed },
        });
        return pulled.cursor;
      case "reset":
        return null;
    }
  },
});

export const syncAccount = operation({
  label: "sync.account",
  input: z.object({ id: z.string(), provider, user: z.string(), cursor: z.string().nullable() }),
  depends: { accessToken, pullBy, keepPull },
  run: async ({ accessToken, pullBy, keepPull }, { input }) => {
    const access = await accessToken.run({
      input: { account: input.id, provider: input.provider },
    });
    const { provider, user } = input;
    let pulled = await pullBy.run({ input: { provider, access, user, cursor: input.cursor } });
    if (pulled.kind === "reset") {
      pulled = await pullBy.run({ input: { provider, access, user, cursor: null } });
    }
    return keepPull.run({ input: { account: input.id, pulled } });
  },
});

export const syncAll = operation({
  label: "sync.all",
  depends: { listAccounts, syncAccount, noteSync, invalidate: mailBoard.invalidate },
  run: async ({ listAccounts, syncAccount, noteSync, invalidate }, { clock }) => {
    const all = listAccounts.run();
    for (const a of all) {
      const done = await syncAccount.settle({
        input: { id: a.id, provider: a.provider, user: a.email, cursor: a.cursor },
      });
      const error = done.status === "success" ? "" : String(Object(done).error?.kind ?? "failed");
      const cursor = done.status === "success" ? done.value : null;
      noteSync.run({ input: { id: a.id, cursor, at: clock.currentTimeMillis(), error } });
    }
    await invalidate.run({ input: { accounts: {}, messages: {} } });
    return { accounts: all.length };
  },
});

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

export const prefetchAll = operation({
  label: "sync.prefetch",
  depends: { listAccounts, prefetchAccount, invalidate: mailBoard.invalidate },
  run: async ({ listAccounts, prefetchAccount, invalidate }) => {
    let fetched = 0;
    for (const a of listAccounts.run()) {
      const done = await prefetchAccount.settle({
        input: { id: a.id, provider: a.provider, user: a.email },
      });
      if (done.status === "success") fetched += done.value;
    }
    if (fetched > 0) await invalidate.run({ input: { messages: {} } });
    return { fetched };
  },
});
