import { operation, tag } from "@tinkered/core";
import { z } from "zod";

import { clients, origin } from "./config.server";
import { outlookImap } from "./imap.server";
import { sendJson } from "./net.server";
import { refreshed, signedIn } from "./provider.server";
import type { Meta } from "./store.server";
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

export const microsoftPull = operation({
  label: "microsoft.pull",
  input: z.object({ access: z.string(), user: z.string() }),
  depends: { imap: outlookImap, throttle, newest },
  run: async ({ imap, throttle, newest }, { input }) => {
    const box = await throttle.run("microsoft", () =>
      imap.list({ user: input.user, access: input.access, limit: newest }),
    );
    const rows: Meta[] = z
      .array(fetched)
      .parse(box.rows)
      .map((m) => ({
        pid: String(m.uid),
        thread: m.envelope.messageId || String(m.uid),
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
  depends: { imap: outlookImap, throttle },
  run: async ({ imap, throttle }, { input, raise }) => {
    const mime = await throttle.run("microsoft", () =>
      imap.source({ user: input.user, access: input.access, uid: input.pid }),
    );
    if (!mime) return raise("ProviderFailed", { status: 404, url: `imap:${input.pid}`, body: "" });

    return mime;
  },
});

export const microsoftRaws = operation({
  label: "microsoft.raws",
  input: z.object({ access: z.string(), user: z.string(), pids: z.array(z.string()) }),
  depends: { imap: outlookImap, throttle },
  run: async ({ imap, throttle }, { input }) => {
    const found = await throttle.run("microsoft", () =>
      imap.sources({ user: input.user, access: input.access, uids: input.pids }),
    );
    return found.map((m) => ({ pid: m.uid, mime: m.mime }));
  },
});

export const microsoftMark = operation({
  label: "microsoft.mark",
  input: z.object({ access: z.string(), user: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { imap: outlookImap, throttle },
  run: async ({ imap, throttle }, { input }) => {
    await throttle.run("microsoft", () =>
      imap.flag({ user: input.user, access: input.access, uid: input.pid, seen: !input.unread }),
    );
  },
});
