import { operation } from "@tinkered/core";
import { z } from "zod";

import { accessToken, forgetTokens } from "./auth.server";
import { mailApi, mailBoard } from "./contract";
import { renderMessage } from "./render.server";
import { keepSource } from "./source.server";
import {
  dropAccount,
  findMessage,
  flagMessage,
  listAccounts,
  loadAccounts,
  loadFolders,
  loadMessages,
  readRaw,
} from "./store.server";
import { markBy, pullBox, rawBy, syncAll } from "./sync.server";

export const splitId = operation({
  label: "mail.splitId",
  input: z.string(),
  run: (_, { input }) => {
    const at = input.indexOf(":");
    return { account: input.slice(0, at), pid: input.slice(at + 1) };
  },
});

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

export const sourceOf = operation({
  label: "mail.source",
  input: z.object({
    account: z.string(),
    provider: z.enum(["google", "microsoft"]),
    user: z.string(),
    pid: z.string(),
  }),
  depends: { readRaw, keepSource, accessToken, rawBy },
  run: async ({ readRaw, keepSource, accessToken, rawBy }, { input }) => {
    const kept = readRaw.run({ input: { account: input.account, pid: input.pid } });
    if (kept) return kept;
    const access = await accessToken.run({
      input: { account: input.account, provider: input.provider },
    });

    const { provider, user, pid } = input;
    const mime = await rawBy.run({ input: { provider, access, user, pid } });
    await keepSource.run({ input: { account: input.account, pid, mime } });
    return mime;
  },
});

const setUnread = operation({
  label: "mail.setUnread",
  input: z.object({
    account: z.string(),
    provider: z.enum(["google", "microsoft"]),
    user: z.string(),
    pid: z.string(),
    unread: z.boolean(),
  }),
  depends: { accessToken, markBy, flagMessage, invalidate: mailBoard.invalidate },
  run: async ({ accessToken, markBy, flagMessage, invalidate }, { input }) => {
    const access = await accessToken.run({
      input: { account: input.account, provider: input.provider },
    });
    await markBy.run({
      input: { ...input, access },
    });
    flagMessage.run({ input: { account: input.account, pid: input.pid, unread: input.unread } });
    await invalidate.run({ input: { messages: {} } });
  },
});

export const openMessage = operation({
  label: "mail.open.do",
  input: mailApi["mail.open"].input,
  depends: { ownerOf, sourceOf, renderMessage, setUnread },
  run: async ({ ownerOf, sourceOf, renderMessage, setUnread }, { input }) => {
    const found = ownerOf.run({ input: input.id });
    if (!found) return { kind: "gone" as const, id: input.id };
    const { owner, pid } = found;

    const mime = await sourceOf.run({
      input: { account: owner.id, provider: owner.provider, user: owner.email, pid },
    });
    const page = await renderMessage.run({ input: { id: input.id, mime, images: input.images } });
    if (found.unread) {
      await setUnread.settle({
        input: {
          account: owner.id,
          provider: owner.provider,
          user: owner.email,
          pid,
          unread: false,
        },
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
        user: found.owner.email,
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

export const mailOps = {
  "mail.open": openMessage,
  "mail.mark": markMessage,
  "mail.sync": syncNow,
  "mail.pull": pullBox,
  "account.remove": removeAccount,
} as const;

export const mailLoads = {
  accounts: loadAccounts,
  messages: loadMessages,
  folders: loadFolders,
} as const;
