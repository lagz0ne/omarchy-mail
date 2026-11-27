import { operation } from "@tinkered/core";
import { z } from "zod";

import { accessToken, forgetTokens } from "./auth.server";
import { mailApi, mailBoard } from "./contract";
import { renderMessage } from "./render.server";
import {
  dropAccount,
  findMessage,
  flagMessage,
  keepRaw,
  listAccounts,
  loadAccounts,
  loadMessages,
  readRaw,
} from "./store.server";
import { markBy, rawBy, syncAll } from "./sync.server";

// The server's side of `mailApi`, and the board's loads.

/** `g-1a2b3c:18c0f…` → the account and the provider's own id. */
export const splitId = operation({
  label: "mail.splitId",
  input: z.string(),
  run: (_, { input }) => {
    const at = input.indexOf(":");
    return { account: input.slice(0, at), pid: input.slice(at + 1) };
  },
});

/** A message's account, as the store has it; null when either is gone. */
const ownerOf = operation({
  label: "mail.owner",
  input: z.string(),
  depends: { splitId, listAccounts, findMessage },
  run: ({ splitId, listAccounts, findMessage }, { input }) => {
    const { account, pid } = splitId.run({ input });
    const owner = listAccounts.run().find((a) => a.id === account);
    const found = findMessage.run({ input: { account, pid } });
    return owner && found ? { owner, pid, unread: found.unread === 1 } : null;
  },
});

/** A message's source: kept from an earlier open, or fetched now and kept. */
export const sourceOf = operation({
  label: "mail.source",
  input: z.object({
    account: z.string(),
    provider: z.enum(["google", "microsoft"]),
    pid: z.string(),
  }),
  depends: { readRaw, keepRaw, accessToken, rawBy },
  run: async ({ readRaw, keepRaw, accessToken, rawBy }, { input }) => {
    const kept = readRaw.run({ input: { account: input.account, pid: input.pid } });
    if (kept) return kept;
    const access = await accessToken.run({
      input: { account: input.account, provider: input.provider },
    });

    const mime = await rawBy.run({ input: { provider: input.provider, access, pid: input.pid } });
    keepRaw.run({ input: { account: input.account, pid: input.pid, mime } });
    return mime;
  },
});

/** Sets unread here and at the provider, then tells the readers. */
const setUnread = operation({
  label: "mail.setUnread",
  input: z.object({
    account: z.string(),
    provider: z.enum(["google", "microsoft"]),
    pid: z.string(),
    unread: z.boolean(),
  }),
  depends: { accessToken, markBy, flagMessage, invalidate: mailBoard.invalidate },
  run: async ({ accessToken, markBy, flagMessage, invalidate }, { input }) => {
    const access = await accessToken.run({
      input: { account: input.account, provider: input.provider },
    });
    await markBy.run({
      input: { provider: input.provider, access, pid: input.pid, unread: input.unread },
    });
    flagMessage.run({ input: { account: input.account, pid: input.pid, unread: input.unread } });
    await invalidate.run({ input: { messages: {} } });
  },
});

/** Opens a message: its page for the frame. An unread one is marked read, if the provider lets. */
export const openMessage = operation({
  label: "mail.open.do",
  input: mailApi["mail.open"].input,
  depends: { ownerOf, sourceOf, renderMessage, setUnread },
  run: async ({ ownerOf, sourceOf, renderMessage, setUnread }, { input }) => {
    const found = ownerOf.run({ input: input.id });
    if (!found) return { kind: "gone" as const, id: input.id };
    const { owner, pid } = found;

    const mime = await sourceOf.run({
      input: { account: owner.id, provider: owner.provider, pid },
    });
    const page = await renderMessage.run({ input: { id: input.id, mime, images: input.images } });
    // Read at the provider is a courtesy: offline or signed out, the message still opens.
    if (found.unread) {
      await setUnread.settle({
        input: { account: owner.id, provider: owner.provider, pid, unread: false },
      });
    }
    return { kind: "message" as const, id: input.id, ...page };
  },
});

export const markMessage = operation({
  label: "mail.mark.do",
  input: mailApi["mail.mark"].input,
  depends: { ownerOf, setUnread },
  run: async ({ ownerOf, setUnread }, { input }) => {
    const found = ownerOf.run({ input: input.id });
    if (!found) return { kind: "gone" as const, id: input.id };
    await setUnread.run({
      input: {
        account: found.owner.id,
        provider: found.owner.provider,
        pid: found.pid,
        unread: input.unread,
      },
    });
    return { kind: "marked" as const };
  },
});

export const syncNow = operation({
  label: "mail.sync.do",
  input: mailApi["mail.sync"].input,
  depends: { syncAll },
  run: async ({ syncAll }) => syncAll.run(),
});

export const removeAccount = operation({
  label: "account.remove.do",
  input: mailApi["account.remove"].input,
  depends: { dropAccount, forgetTokens, invalidate: mailBoard.invalidate },
  run: async ({ dropAccount, forgetTokens, invalidate }, { input }) => {
    const out = dropAccount.run({ input: { id: input.id } });
    if (out.kind === "gone") return out;
    await forgetTokens.run({ input: { account: input.id } });
    await invalidate.run({ input: { accounts: {}, messages: {} } });
    return out;
  },
});

/** The server's side of `mailApi`, by address. */
export const mailOps = {
  "mail.open": openMessage,
  "mail.mark": markMessage,
  "mail.sync": syncNow,
  "account.remove": removeAccount,
} as const;

/** The board's loads: the store sorts and cuts each window. */
export const mailLoads = { accounts: loadAccounts, messages: loadMessages } as const;
