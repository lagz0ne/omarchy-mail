import { data, remoteData, rpc } from "@tinkered/core";
import { z } from "zod";

export const provider = z.enum(["google", "microsoft"]);
export type Provider = z.infer<typeof provider>;

const account = z.object({
  id: z.string(),
  provider,
  email: z.string(),
  name: z.string(),
  syncedAt: z.number(),
  error: z.string(),
});

export type Account = z.infer<typeof account>;

const row = z.object({
  box: z.string(),
  id: z.string(),
  account: z.string(),
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

export type Row = z.infer<typeof row>;

export const accounts = data({
  label: "mail.accounts",
  mode: "keyed",
  parse: account,
  key: (a) => ({ id: a.id }),
});

export const messages = data({
  label: "mail.messages",
  mode: "keyed",
  parse: row,
  key: (m) => ({ box: m.box, id: m.id }),
});

export const mailBoard = remoteData({ accounts, messages });

const gone = z.object({ kind: z.literal("gone"), id: z.string() });

const attachment = z.object({
  part: z.number(),
  name: z.string(),
  type: z.string(),
  size: z.number(),
});

export type Attachment = z.infer<typeof attachment>;

const address = z.object({ name: z.string(), address: z.string() });
export type Address = z.infer<typeof address>;

const opened = z.object({
  kind: z.literal("message"),
  id: z.string(),
  subject: z.string(),
  from: address,
  to: z.array(address),
  cc: z.array(address),
  date: z.number(),
  srcdoc: z.string(),
  remote: z.number(),
  attachments: z.array(attachment),
});

export type Opened = z.infer<typeof opened>;

export const mailApi = rpc({
  "mail.open": {
    input: z.object({ id: z.string(), images: z.boolean() }),
    output: z.discriminatedUnion("kind", [opened, gone]),
  },
  "mail.mark": {
    input: z.object({ id: z.string(), unread: z.boolean() }),
    output: z.discriminatedUnion("kind", [z.object({ kind: z.literal("marked") }), gone]),
  },
  "mail.sync": {
    input: z.object({}),
    output: z.object({ accounts: z.number() }),
  },
  "account.remove": {
    input: z.object({ id: z.string() }),
    output: z.discriminatedUnion("kind", [z.object({ kind: z.literal("removed") }), gone]),
  },
});
