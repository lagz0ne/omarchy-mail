import { data, remoteData, rpc } from "@tinkered/core";
import { z } from "zod";

// The mail feature's contract: both sides import it. The server holds the mail in SQLite and
// serves it by part (`mailBoard`, with a `load` per cell); every change is a call (`mailApi`).

export const provider = z.enum(["google", "microsoft"]);
export type Provider = z.infer<typeof provider>;

const account = z.object({
  id: z.string(),
  provider,
  email: z.string(),
  name: z.string(),
  /** When the last sync ended, in ms; 0 before the first. */
  syncedAt: z.number(),
  /** The last sync's failure, as a line to show; "" when it went well. */
  error: z.string(),
});

export type Account = z.infer<typeof account>;

/** One message in a list. `box` is the list it sits in: "all" or an account id. */
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

/** Read: the accounts, and each box's newest messages, as windows the store sorts and cuts. */
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

/** One message, ready to show: the body is a whole document for a sandboxed frame. */
const opened = z.object({
  kind: z.literal("message"),
  id: z.string(),
  subject: z.string(),
  from: address,
  to: z.array(address),
  cc: z.array(address),
  date: z.number(),
  srcdoc: z.string(),
  /** Remote images the body asks for; shown only when the call asks for `images`. */
  remote: z.number(),
  attachments: z.array(attachment),
});

export type Opened = z.infer<typeof opened>;

/** Ask: every change is a call. Outcomes are output. */
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
