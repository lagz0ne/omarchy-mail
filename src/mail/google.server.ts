import { operation } from "@tinkered/core";
import { z } from "zod";

import { clients, origin } from "./config.server";
import { send, sendJson } from "./net.server";
import { type Pulled, pullInput, refreshed, signedIn } from "./provider.server";
import type { Meta } from "./store.server";

// Gmail: OAuth (installed app, PKCE, loopback redirect) and the Gmail API.

const authorize = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = "https://oauth2.googleapis.com/token";
const api = "https://gmail.googleapis.com/gmail/v1/users/me";

const scopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

/** The first full pull takes this many of the newest inbox messages. */
const firstPull = 150;

const tokens = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

/** Google's own client, or `NotConfigured`: the cmd had no GOOGLE_CLIENT_ID. */
const googleClient = operation({
  label: "google.client",
  depends: { clients, origin },
  run: ({ clients, origin }, { raise }) => {
    const own = clients.google;
    if (!own) return raise("NotConfigured", { provider: "google" });
    return { ...own, redirect: `${origin}/oauth/callback` };
  },
});

export const googleAuthUrl = operation({
  label: "google.authUrl",
  input: z.object({ state: z.string(), challenge: z.string() }),
  depends: { googleClient },
  run: ({ googleClient }, { input }) => {
    const own = googleClient.run();
    const url = new URL(authorize);
    url.search = new URLSearchParams({
      client_id: own.id,
      redirect_uri: own.redirect,
      response_type: "code",
      scope: scopes,
      access_type: "offline",
      prompt: "consent",
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      state: input.state,
    }).toString();
    return url.href;
  },
});

export const googleExchange = operation({
  label: "google.exchange",
  input: z.object({ code: z.string(), verifier: z.string() }),
  depends: { googleClient, sendJson },
  run: async ({ googleClient, sendJson }, { input, clock, raise }) => {
    const own = googleClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          url: tokenUrl,
          method: "POST",
          form: {
            client_id: own.id,
            client_secret: own.secret,
            code: input.code,
            code_verifier: input.verifier,
            grant_type: "authorization_code",
            redirect_uri: own.redirect,
          },
        },
      }),
    );
    if (!got.refresh_token) return raise("NoRefreshToken", { provider: "google" });
    const me = z.object({ email: z.string(), name: z.string().optional() }).parse(
      await sendJson.run({
        input: { url: "https://openidconnect.googleapis.com/v1/userinfo", token: got.access_token },
      }),
    );
    return signedIn.parse({
      refresh: got.refresh_token,
      access: got.access_token,
      expires: clock.currentTimeMillis() + got.expires_in * 1000,
      email: me.email,
      name: me.name ?? me.email,
    });
  },
});

export const googleRefresh = operation({
  label: "google.refresh",
  input: z.object({ refresh: z.string() }),
  depends: { googleClient, sendJson },
  run: async ({ googleClient, sendJson }, { input, clock }) => {
    const own = googleClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          url: tokenUrl,
          method: "POST",
          form: {
            client_id: own.id,
            client_secret: own.secret,
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

const header = z.object({ name: z.string(), value: z.string() });

const gmailMeta = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  internalDate: z.string(),
  payload: z.object({ mimeType: z.string().default(""), headers: z.array(header).default([]) }),
});

/** `"Ann Lee" <ann@x.org>` → name and address; a bare address is both. */
export const splitFrom = operation({
  label: "mail.splitFrom",
  input: z.string(),
  run: (_, { input }) => {
    const angled = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(input);
    if (!angled) return { name: input.trim(), address: input.trim() };
    const address = angled[2] ?? "";
    return { name: angled[1]?.trim() || address, address };
  },
});

/** One message's list fields, or null when it is gone or left the inbox. */
const googleMeta = operation({
  label: "google.meta",
  input: z.object({ access: z.string(), pid: z.string() }),
  depends: { send, splitFrom },
  run: async ({ send, splitFrom }, { input }): Promise<Meta | null> => {
    const url = new URL(`${api}/messages/${input.pid}`);
    url.search = "format=metadata&metadataHeaders=From&metadataHeaders=Subject";
    const res = await send.run({ input: { url: url.href, token: input.access } });
    if (res.status === 404) return null;

    const m = gmailMeta.parse(await res.json());
    if (!m.labelIds.includes("INBOX")) return null;
    const head = new Map(m.payload.headers.map((h) => [h.name.toLowerCase(), h.value]));
    const from = splitFrom.run({ input: head.get("from") ?? "" });
    return {
      pid: m.id,
      thread: m.threadId,
      fromName: from.name,
      fromAddr: from.address,
      subject: head.get("subject") ?? "",
      snippet: m.snippet,
      date: Number(m.internalDate),
      unread: m.labelIds.includes("UNREAD"),
      starred: m.labelIds.includes("STARRED"),
      attach: m.payload.mimeType === "multipart/mixed",
    };
  },
});

/** The list fields of many messages, eight requests at a time; gone ones come back as ids. */
const googleMetas = operation({
  label: "google.metas",
  input: z.object({ access: z.string(), pids: z.array(z.string()) }),
  depends: { googleMeta },
  run: async ({ googleMeta }, { input }) => {
    const rows: Meta[] = [];
    const removed: string[] = [];
    for (let at = 0; at < input.pids.length; at += 8) {
      const batch = input.pids.slice(at, at + 8);
      const found = await Promise.all(
        batch.map((pid) => googleMeta.run({ input: { access: input.access, pid } })),
      );
      found.forEach((m, i) => (m ? rows.push(m) : removed.push(batch[i] ?? "")));
    }
    return { rows, removed };
  },
});

const listed = z.object({
  messages: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

/** No cursor: the newest inbox messages, and the history id to start the next pull from. */
const googleFull = operation({
  label: "google.full",
  input: z.object({ access: z.string() }),
  depends: { sendJson, googleMetas },
  run: async ({ sendJson, googleMetas }, { input }) => {
    const token = input.access;
    // The cursor first: a change while the list loads is then in the next pull.
    const profile = z
      .object({ historyId: z.string() })
      .parse(await sendJson.run({ input: { url: `${api}/profile`, token } }));
    const list = listed.parse(
      await sendJson.run({
        input: { url: `${api}/messages?labelIds=INBOX&maxResults=${firstPull}`, token },
      }),
    );
    const { rows } = await googleMetas.run({
      input: { access: token, pids: list.messages.map((m) => m.id) },
    });
    return { kind: "full" as const, rows, removed: [], cursor: profile.historyId };
  },
});

const historyPage = z.object({
  historyId: z.string(),
  nextPageToken: z.string().optional(),
  history: z
    .array(
      z.object({
        messages: z.array(z.object({ id: z.string() })).default([]),
        messagesDeleted: z.array(z.object({ message: z.object({ id: z.string() }) })).default([]),
      }),
    )
    .default([]),
});

/** With a cursor: every message the history touched, read again; a 404 cursor is a reset. */
const googleDelta = operation({
  label: "google.delta",
  input: z.object({ access: z.string(), cursor: z.string() }),
  depends: { send, googleMetas },
  run: async ({ send, googleMetas }, { input, raise }) => {
    const touched = new Set<string>();
    const deleted = new Set<string>();
    let cursor = input.cursor;
    let page: string | undefined;

    do {
      const url = new URL(`${api}/history`);
      url.searchParams.set("startHistoryId", input.cursor);
      if (page) url.searchParams.set("pageToken", page);
      const res = await send.run({ input: { url: url.href, token: input.access } });
      if (res.status === 404) return { kind: "reset" as const };

      if (!res.ok) return raise("ProviderFailed", { status: res.status, url: url.href, body: "" });
      const got = historyPage.parse(await res.json());
      for (const h of got.history) {
        for (const m of h.messages) touched.add(m.id);
        for (const d of h.messagesDeleted) deleted.add(d.message.id);
      }
      cursor = got.historyId;
      page = got.nextPageToken;
    } while (page);
    const pids = [...touched].filter((pid) => !deleted.has(pid));
    const read = await googleMetas.run({ input: { access: input.access, pids } });
    return {
      kind: "delta" as const,
      rows: read.rows,
      removed: [...deleted, ...read.removed],
      cursor,
    };
  },
});

export const googlePull = operation({
  label: "google.pull",
  input: pullInput,
  depends: { googleFull, googleDelta },
  run: async ({ googleFull, googleDelta }, { input }): Promise<Pulled> =>
    input.cursor === null
      ? googleFull.run({ input: { access: input.access } })
      : googleDelta.run({ input: { access: input.access, cursor: input.cursor } }),
});

/** A message's source, as RFC 822 bytes. */
export const googleRaw = operation({
  label: "google.raw",
  input: z.object({ access: z.string(), pid: z.string() }),
  depends: { sendJson },
  run: async ({ sendJson }, { input }) => {
    const got = z.object({ raw: z.string() }).parse(
      await sendJson.run({
        input: { url: `${api}/messages/${input.pid}?format=raw`, token: input.access },
      }),
    );
    return Buffer.from(got.raw, "base64url");
  },
});

export const googleMark = operation({
  label: "google.mark",
  input: z.object({ access: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { sendJson },
  run: async ({ sendJson }, { input }) => {
    const change = { [input.unread ? "addLabelIds" : "removeLabelIds"]: ["UNREAD"] };
    await sendJson.run({
      input: {
        url: `${api}/messages/${input.pid}/modify`,
        method: "POST",
        token: input.access,
        json: change,
      },
    });
  },
});
