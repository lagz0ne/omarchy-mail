import { operation, tag } from "@tinkered/core";
import { z } from "zod";

import { clients, origin } from "./config.server";
import { mailAction, type MailAction } from "./contract";
import { checkShape, send, sendJson } from "./net.server";
import { type Pulled, pullInput, refreshed, signedIn } from "./provider.server";
import type { Folder, Meta } from "./store.server";

const authorize = tag<string>({
  label: "google.authorize",
  default: "https://accounts.google.com/o/oauth2/v2/auth",
});

const tokenUrl = tag<string>({
  label: "google.token",
  default: "https://oauth2.googleapis.com/token",
});

const userinfo = tag<string>({
  label: "google.userinfo",
  default: "https://openidconnect.googleapis.com/v1/userinfo",
});

const api = tag<string>({
  label: "google.api",
  default: "https://gmail.googleapis.com/gmail/v1/users/me",
});

const scopes = tag<string>({
  label: "google.scopes",
  default: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ].join(" "),
});

const firstPull = tag<number>({ label: "google.firstPull", default: 150 });

const parallel = tag<number>({ label: "google.parallel", default: 4 });

const folderPull = tag<number>({ label: "google.folderPull", default: 50 });

const systemLabels = tag<Readonly<Record<string, Folder["kind"]>>>({
  label: "google.systemLabels",
  default: {
    INBOX: "inbox",
    STARRED: "starred",
    IMPORTANT: "important",
    SENT: "sent",
    DRAFT: "drafts",
    SPAM: "spam",
    TRASH: "trash",
  },
});

const person = z.object({ email: z.string(), name: z.string().optional() });

const profileShape = z.object({ historyId: z.string() });

const rawShape = z.object({ raw: z.string() });

const tokens = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

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
  depends: { googleClient, authorize, scopes },
  run: ({ googleClient, authorize, scopes }, { input }) => {
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
  depends: { googleClient, sendJson, tokenUrl, userinfo },
  run: async ({ googleClient, sendJson, tokenUrl, userinfo }, { input, clock, raise }) => {
    const own = googleClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          shape: tokens,
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
    const me = person.parse(
      await sendJson.run({
        input: { url: userinfo, token: got.access_token, shape: person },
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
  depends: { googleClient, sendJson, tokenUrl },
  run: async ({ googleClient, sendJson, tokenUrl }, { input, clock }) => {
    const own = googleClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          shape: tokens,
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

const googleMeta = operation({
  label: "google.meta",
  input: z.object({ access: z.string(), pid: z.string(), label: z.string() }),
  depends: { send, splitFrom, api, checkShape },
  run: async ({ send, splitFrom, api, checkShape }, { input }): Promise<Meta | null> => {
    const url = new URL(`${api}/messages/${input.pid}`);
    url.search = "format=metadata&metadataHeaders=From&metadataHeaders=Subject";
    const res = await send.run({ input: { url: url.href, token: input.access } });
    if (res.status === 404) return null;

    const m = gmailMeta.parse(
      await checkShape.run({
        input: {
          source: "gmail.meta",
          value: await res.json().catch(() => null),
          shape: gmailMeta,
        },
      }),
    );
    if (!m.labelIds.includes(input.label)) return null;
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

const googleMetas = operation({
  label: "google.metas",
  input: z.object({
    access: z.string(),
    pids: z.array(z.string()),
    label: z.string(),
  }),
  depends: { googleMeta, parallel },
  run: async ({ googleMeta, parallel }, { input }) => {
    const rows: Meta[] = [];
    const removed: string[] = [];
    for (let at = 0; at < input.pids.length; at += parallel) {
      const batch = input.pids.slice(at, at + parallel);
      const found = await Promise.all(
        batch.map((pid) =>
          googleMeta.run({ input: { access: input.access, pid, label: input.label } }),
        ),
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

const googleFull = operation({
  label: "google.full",
  input: z.object({ access: z.string() }),
  depends: { sendJson, googleMetas, api, firstPull },
  run: async ({ sendJson, googleMetas, api, firstPull }, { input }) => {
    const token = input.access;
    const profile = z
      .object({ historyId: z.string() })
      .parse(await sendJson.run({ input: { url: `${api}/profile`, token, shape: profileShape } }));
    const list = listed.parse(
      await sendJson.run({
        input: {
          shape: listed,
          url: `${api}/messages?labelIds=INBOX&maxResults=${firstPull}`,
          token,
        },
      }),
    );
    const { rows } = await googleMetas.run({
      input: { access: token, pids: list.messages.map((m) => m.id), label: "INBOX" },
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

const googleDelta = operation({
  label: "google.delta",
  input: z.object({ access: z.string(), cursor: z.string() }),
  depends: { send, googleMetas, api, checkShape },
  run: async ({ send, googleMetas, api, checkShape }, { input, raise }) => {
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
      const got = historyPage.parse(
        await checkShape.run({
          input: {
            source: "gmail.history",
            value: await res.json().catch(() => null),
            shape: historyPage,
          },
        }),
      );
      for (const h of got.history) {
        for (const m of h.messages) touched.add(m.id);
        for (const d of h.messagesDeleted) deleted.add(d.message.id);
      }
      cursor = got.historyId;
      page = got.nextPageToken;
    } while (page);
    const pids = [...touched].filter((pid) => !deleted.has(pid));
    const read = await googleMetas.run({ input: { access: input.access, pids, label: "INBOX" } });
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

export const googleRaw = operation({
  label: "google.raw",
  input: z.object({ access: z.string(), pid: z.string() }),
  depends: { sendJson, api },
  run: async ({ sendJson, api }, { input }) => {
    const got = rawShape.parse(
      await sendJson.run({
        input: {
          url: `${api}/messages/${input.pid}?format=raw`,
          token: input.access,
          shape: rawShape,
        },
      }),
    );
    return Buffer.from(got.raw, "base64url");
  },
});

export const googleRaws = operation({
  label: "google.raws",
  input: z.object({ access: z.string(), pids: z.array(z.string()) }),
  depends: { googleRaw, parallel },
  run: async ({ googleRaw, parallel }, { input }) => {
    const found: { pid: string; mime: Uint8Array<ArrayBuffer> }[] = [];
    for (let at = 0; at < input.pids.length; at += parallel) {
      const batch = input.pids.slice(at, at + parallel);
      const got = await Promise.all(
        batch.map((pid) => googleRaw.settle({ input: { access: input.access, pid } })),
      );
      got.forEach(
        (r, i) => r.status === "success" && found.push({ pid: batch[i] ?? "", mime: r.value }),
      );
    }
    return found;
  },
});

export const googleMark = operation({
  label: "google.mark",
  input: z.object({ access: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { sendJson, api },
  run: async ({ sendJson, api }, { input }) => {
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

const labels = z.object({
  labels: z
    .array(z.object({ id: z.string(), name: z.string(), type: z.string().default("user") }))
    .default([]),
});

export const googleFolders = operation({
  label: "google.folders",
  input: z.object({ access: z.string() }),
  depends: { sendJson, api, systemLabels },
  run: async ({ sendJson, api, systemLabels }, { input }): Promise<Folder[]> => {
    const got = labels.parse(
      await sendJson.run({ input: { shape: labels, url: `${api}/labels`, token: input.access } }),
    );
    const order = Object.keys(systemLabels);
    const system = got.labels
      .filter((l) => l.id in systemLabels)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((l) => ({ id: l.id, name: l.name, kind: systemLabels[l.id] ?? "label" }));
    const own = got.labels
      .filter((l) => l.type === "user")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({ id: l.id, name: l.name, kind: "label" as const }));
    return [...system, ...own];
  },
});

export const googleFolderPull = operation({
  label: "google.folderPull",
  input: z.object({ access: z.string(), folder: z.string() }),
  depends: { sendJson, googleMetas, api, folderPull },
  run: async ({ sendJson, googleMetas, api, folderPull }, { input }) => {
    const url = new URL(`${api}/messages`);
    url.search = new URLSearchParams({
      labelIds: input.folder,
      maxResults: String(folderPull),
      includeSpamTrash: "true",
    }).toString();
    const list = listed.parse(
      await sendJson.run({ input: { shape: listed, url: url.href, token: input.access } }),
    );
    const { rows } = await googleMetas.run({
      input: { access: input.access, pids: list.messages.map((m) => m.id), label: input.folder },
    });
    return rows;
  },
});

const labelChanges = tag<
  Readonly<Record<Exclude<MailAction, "trash" | "move">, { add: string[]; remove: string[] }>>
>({
  label: "google.labelChanges",
  default: {
    archive: { add: [], remove: ["INBOX"] },
    spam: { add: ["SPAM"], remove: ["INBOX"] },
    inbox: { add: ["INBOX"], remove: ["SPAM", "TRASH"] },
    star: { add: ["STARRED"], remove: [] },
    unstar: { add: [], remove: ["STARRED"] },
  },
});

export const googleAct = operation({
  label: "google.act",
  input: z.object({
    access: z.string(),
    pid: z.string(),
    action: mailAction,
    from: z.string(),
    to: z.string().optional(),
  }),
  depends: { sendJson, api, labelChanges },
  run: async ({ sendJson, api, labelChanges }, { input }) => {
    const at = `${api}/messages/${input.pid}`;
    const token = input.access;
    if (input.action === "trash") {
      await sendJson.run({ input: { url: `${at}/trash`, method: "POST", token } });
      return "done" as const;
    }

    const change =
      input.action === "move"
        ? { add: input.to ? [input.to] : [], remove: [input.from] }
        : labelChanges[input.action];
    const json = { addLabelIds: change.add, removeLabelIds: change.remove };
    await sendJson.run({ input: { url: `${at}/modify`, method: "POST", token, json } });
    return "done" as const;
  },
});
