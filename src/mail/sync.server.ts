import { operation } from "@tinkered/core";
import { z } from "zod";

import { accessToken } from "./auth.server";
import { mailBoard, provider } from "./contract";
import { googleMark, googlePull, googleRaw } from "./google.server";
import { microsoftMark, microsoftPull, microsoftRaw } from "./microsoft.server";
import type { Pulled } from "./provider.server";
import { applySync, listAccounts, noteSync } from "./store.server";

// Sync: pull each account's inbox into the store, then tell every reader its box changed.

/** A pull by the account's provider. */
const pullBy = operation({
  label: "sync.pullBy",
  input: z.object({ provider, access: z.string(), cursor: z.string().nullable() }),
  depends: { googlePull, microsoftPull },
  run: async ({ googlePull, microsoftPull }, { input }): Promise<Pulled> => {
    const call = { input: { access: input.access, cursor: input.cursor } };
    return input.provider === "google" ? googlePull.run(call) : microsoftPull.run(call);
  },
});

/** A message's source, by the account's provider. */
export const rawBy = operation({
  label: "sync.rawBy",
  input: z.object({ provider, access: z.string(), pid: z.string() }),
  depends: { googleRaw, microsoftRaw },
  run: async ({ googleRaw, microsoftRaw }, { input }) => {
    const call = { input: { access: input.access, pid: input.pid } };
    return input.provider === "google" ? googleRaw.run(call) : microsoftRaw.run(call);
  },
});

/** Sets a message's unread flag at its provider. */
export const markBy = operation({
  label: "sync.markBy",
  input: z.object({ provider, access: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { googleMark, microsoftMark },
  run: async ({ googleMark, microsoftMark }, { input }) => {
    const call = { input: { access: input.access, pid: input.pid, unread: input.unread } };
    await (input.provider === "google" ? googleMark.run(call) : microsoftMark.run(call));
  },
});

/** Writes one pull to the store; a reset clears the cursor, so the next pull is full. */
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

/** One account: a token, a pull (a second one after a reset), the store, then the readers. */
export const syncAccount = operation({
  label: "sync.account",
  input: z.object({ id: z.string(), provider, cursor: z.string().nullable() }),
  depends: { accessToken, pullBy, keepPull },
  run: async ({ accessToken, pullBy, keepPull }, { input }) => {
    const access = await accessToken.run({
      input: { account: input.id, provider: input.provider },
    });
    const { provider } = input;
    let pulled = await pullBy.run({ input: { provider, access, cursor: input.cursor } });
    if (pulled.kind === "reset") {
      pulled = await pullBy.run({ input: { provider, access, cursor: null } });
    }
    return keepPull.run({ input: { account: input.id, pulled } });
  },
});

/** Every account, one after another. A failure stays on its account, as a line to show. */
export const syncAll = operation({
  label: "sync.all",
  depends: { listAccounts, syncAccount, noteSync, invalidate: mailBoard.invalidate },
  run: async ({ listAccounts, syncAccount, noteSync, invalidate }, { clock }) => {
    const all = listAccounts.run();
    for (const a of all) {
      const done = await syncAccount.settle({
        input: { id: a.id, provider: a.provider, cursor: a.cursor },
      });
      const error = done.status === "success" ? "" : String(Object(done).error?.kind ?? "failed");
      const cursor = done.status === "success" ? done.value : null;
      noteSync.run({ input: { id: a.id, cursor, at: clock.currentTimeMillis(), error } });
    }
    await invalidate.run({ input: { accounts: {}, messages: {} } });
    return { accounts: all.length };
  },
});
