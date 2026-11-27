import { operation, tag } from "@tinkered/core";
import { z } from "zod";

import { clients, origin } from "./config.server";
import { outlookImap } from "./imap.server";
import { checkShape, sendJson } from "./net.server";
import { refreshed, signedIn } from "./provider.server";
import type { Folder, Meta } from "./store.server";
import { throttle } from "./throttle.server";

const login = tag<string>({
  label: "microsoft.login",
  default: "https://login.microsoftonline.com/consumers/oauth2/v2.0",
});

const scopes = tag<string>({
  label: "microsoft.scopes",
  default: [
    "offline_access",
    "openid",
    "email",
    "profile",
    "https://outlook.office.com/IMAP.AccessAsUser.All",
    "https://outlook.office.com/SMTP.Send",
  ].join(" "),
});

const newest = tag<number>({ label: "microsoft.newest", default: 150 });

const imapFolders = z.array(
  z
    .object({
      path: z.string(),
      name: z.string().default(""),
      specialUse: z.string().optional(),
      flags: z.instanceof(Set).default(new Set()),
    })
    .transform((f) => ({
      path: f.path,
      name: f.name || f.path,
      use: f.specialUse ?? "",
      selectable: !f.flags.has("\\Noselect"),
    })),
);

const fetchedSources = z.array(
  z
    .object({ uid: z.number(), source: z.instanceof(Uint8Array).optional() })
    .transform((m) => ({ uid: String(m.uid), mime: m.source ? new Uint8Array(m.source) : null })),
);

const fetched = z.object({
  uid: z.number(),
  envelope: z
    .object({
      messageId: z.string().default(""),
      subject: z.string().default(""),
      date: z.coerce.date().optional(),
      from: z
        .array(z.object({ name: z.string().default(""), address: z.string().default("") }))
        .default([])
        .transform((list) => list[0] ?? { name: "", address: "" }),
    })
    .default({ messageId: "", subject: "", from: { name: "", address: "" } }),
  flags: z.instanceof(Set).default(new Set()),
  bodyStructure: z.object({ type: z.string() }).optional(),
});

const tokens = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});

const claims = z.object({
  email: z.string().optional(),
  preferred_username: z.string().optional(),
  name: z.string().optional(),
});

const microsoftClient = operation({
  label: "microsoft.client",
  depends: { clients, origin },
  run: ({ clients, origin }, { raise }) => {
    const own = clients.microsoft;
    if (!own) return raise("NotConfigured", { provider: "microsoft" });

    const url = new URL("/", origin);
    url.hostname = "localhost";
    return { ...own, redirect: url.href.replace(/\/$/, "") };
  },
});

export const microsoftAuthUrl = operation({
  label: "microsoft.authUrl",
  input: z.object({ state: z.string(), challenge: z.string() }),
  depends: { microsoftClient, login, scopes },
  run: ({ microsoftClient, login, scopes }, { input }) => {
    const own = microsoftClient.run();
    const url = new URL(`${login}/authorize`);
    url.search = new URLSearchParams({
      client_id: own.id,
      redirect_uri: own.redirect,
      response_type: "code",
      response_mode: "query",
      scope: scopes,
      prompt: "select_account",
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      state: input.state,
    }).toString();
    return url.href;
  },
});

const whoFrom = operation({
  label: "microsoft.who",
  input: z.string(),
  run: (_, { input, raise }) => {
    const part = input.split(".")[1] ?? "";
    const found = claims.safeParse(JSON.parse(Buffer.from(part, "base64url").toString() || "{}"));
    const email = found.success ? (found.data.email ?? found.data.preferred_username) : undefined;
    if (!email) return raise("NoIdentity", { provider: "microsoft" });

    return { email, name: (found.success && found.data.name) || email };
  },
});

export const microsoftExchange = operation({
  label: "microsoft.exchange",
  input: z.object({ code: z.string(), verifier: z.string() }),
  depends: { microsoftClient, sendJson, whoFrom, login, scopes },
  run: async ({ microsoftClient, sendJson, whoFrom, login, scopes }, { input, clock, raise }) => {
    const own = microsoftClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          shape: tokens,
          url: `${login}/token`,
          method: "POST",
          form: {
            client_id: own.id,
            scope: scopes,
            code: input.code,
            code_verifier: input.verifier,
            grant_type: "authorization_code",
            redirect_uri: own.redirect,
          },
        },
      }),
    );
    if (!got.refresh_token) return raise("NoRefreshToken", { provider: "microsoft" });

    const who = whoFrom.run({ input: got.id_token ?? "" });
    return signedIn.parse({
      refresh: got.refresh_token,
      access: got.access_token,
      expires: clock.currentTimeMillis() + got.expires_in * 1000,
      email: who.email,
      name: who.name,
    });
  },
});

export const microsoftRefresh = operation({
  label: "microsoft.refresh",
  input: z.object({ refresh: z.string() }),
  depends: { microsoftClient, sendJson, login, scopes },
  run: async ({ microsoftClient, sendJson, login, scopes }, { input, clock }) => {
    const own = microsoftClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          shape: tokens,
          url: `${login}/token`,
          method: "POST",
          form: {
            client_id: own.id,
            scope: scopes,
            refresh_token: input.refresh,
            grant_type: "refresh_token",
          },
        },
      }),
    );
    return refreshed.parse({
      access: got.access_token,
      expires: clock.currentTimeMillis() + got.expires_in * 1000,
      refresh: got.refresh_token,
    });
  },
});

const specialUses = tag<Readonly<Record<string, Folder["kind"]>>>({
  label: "microsoft.specialUses",
  default: {
    "\\Inbox": "inbox",
    "\\Flagged": "starred",
    "\\Sent": "sent",
    "\\Drafts": "drafts",
    "\\Junk": "spam",
    "\\Trash": "trash",
    "\\Archive": "archive",
  },
});

export const placeOf = operation({
  label: "microsoft.place",
  input: z.string(),
  run: (_, { input }) => {
    const at = input.lastIndexOf("/");
    return { box: input.slice(0, at), uid: input.slice(at + 1) };
  },
});

export const microsoftFolders = operation({
  label: "microsoft.folders",
  input: z.object({ access: z.string(), user: z.string() }),
  depends: { imap: outlookImap, throttle, specialUses, checkShape },
  run: async ({ imap, throttle, specialUses, checkShape }, { input }): Promise<Folder[]> => {
    const raw = await throttle.run("microsoft", (signal) => imap.folders({ ...input, signal }));
    const found = imapFolders.parse(
      await checkShape.run({ input: { source: "imap.folders", value: raw, shape: imapFolders } }),
    );
    const order = ["inbox", "starred", "sent", "drafts", "archive", "spam", "trash", "label"];
    return found
      .filter((f) => f.selectable)
      .map((f) => ({
        id: f.path.toUpperCase() === "INBOX" ? "INBOX" : f.path,
        name: f.path.toUpperCase() === "INBOX" ? "Inbox" : f.name,
        kind:
          f.path.toUpperCase() === "INBOX" ? ("inbox" as const) : (specialUses[f.use] ?? "label"),
      }))
      .sort(
        (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
      );
  },
});

export const microsoftPull = operation({
  label: "microsoft.pull",
  input: z.object({ access: z.string(), user: z.string(), folder: z.string() }),
  depends: { imap: outlookImap, throttle, newest, checkShape },
  run: async ({ imap, throttle, newest, checkShape }, { input }) => {
    const box = await throttle.run("microsoft", (signal) =>
      imap.list({
        user: input.user,
        access: input.access,
        box: input.folder,
        limit: newest,
        signal,
      }),
    );
    const listed = z.array(fetched);
    const rows: Meta[] = listed
      .parse(
        await checkShape.run({ input: { source: "imap.list", value: box.rows, shape: listed } }),
      )
      .map((m) => ({
        pid: `${input.folder}/${m.uid}`,
        thread: m.envelope.messageId || `${input.folder}/${m.uid}`,
        fromName: m.envelope.from.name || m.envelope.from.address,
        fromAddr: m.envelope.from.address,
        subject: m.envelope.subject,
        snippet: "",
        date: m.envelope.date?.getTime() ?? 0,
        unread: !m.flags.has("\\Seen"),
        starred: m.flags.has("\\Flagged"),
        attach: m.bodyStructure?.type === "multipart/mixed",
      }));
    return { kind: "full" as const, rows, removed: [], cursor: box.validity };
  },
});

export const microsoftRaw = operation({
  label: "microsoft.raw",
  input: z.object({ access: z.string(), user: z.string(), pid: z.string() }),
  depends: { imap: outlookImap, throttle, placeOf, checkShape },
  run: async ({ imap, throttle, placeOf, checkShape }, { input, raise }) => {
    const { box, uid } = placeOf.run({ input: input.pid });
    const raw = await throttle.run("microsoft", (signal) =>
      imap.sources({ user: input.user, access: input.access, box, uids: [uid], signal }),
    );
    const [found] = fetchedSources.parse(
      await checkShape.run({ input: { source: "imap.source", value: raw, shape: fetchedSources } }),
    );
    const mime = found?.mime;
    if (!mime) return raise("ProviderFailed", { status: 404, url: `imap:${input.pid}`, body: "" });

    return mime;
  },
});

export const microsoftRaws = operation({
  label: "microsoft.raws",
  input: z.object({ access: z.string(), user: z.string(), pids: z.array(z.string()) }),
  depends: { imap: outlookImap, throttle, placeOf, checkShape },
  run: async ({ imap, throttle, placeOf, checkShape }, { input }) => {
    const byBox = Map.groupBy(
      input.pids.map((pid) => placeOf.run({ input: pid })),
      (p) => p.box,
    );
    const found: { pid: string; mime: Uint8Array<ArrayBuffer> }[] = [];
    for (const [box, places] of byBox) {
      const uids = places.map((p) => p.uid);
      const raw = await throttle.run("microsoft", (signal) =>
        imap.sources({ user: input.user, access: input.access, box, uids, signal }),
      );
      const got = fetchedSources.parse(
        await checkShape.run({
          input: { source: "imap.sources", value: raw, shape: fetchedSources },
        }),
      );
      for (const m of got) if (m.mime) found.push({ pid: `${box}/${m.uid}`, mime: m.mime });
    }
    return found;
  },
});

export const microsoftMark = operation({
  label: "microsoft.mark",
  input: z.object({ access: z.string(), user: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { imap: outlookImap, throttle, placeOf },
  run: async ({ imap, throttle, placeOf }, { input }) => {
    const { box, uid } = placeOf.run({ input: input.pid });
    await throttle.run("microsoft", (signal) =>
      imap.flag({ user: input.user, access: input.access, box, uid, seen: !input.unread, signal }),
    );
  },
});
