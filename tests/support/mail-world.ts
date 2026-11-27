import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { makeTestClock, memory } from "@tinkered/core/testing";

import { routes } from "~/components/requests/index.server";

import { mail } from "@/mail";
import { outlookImap, type OpenImap } from "@/mail/imap.server";
import { mailServer } from "@/mail/index.server";
import { keyring, type SecretStore } from "@/mail/keyring.server";
import { backoff, net, type Http } from "@/mail/net.server";
import { mailLoads, mailOps } from "@/mail/ops.server";
import { mailRoutes } from "@/mail/routes.server";
import { store } from "@/mail/store.server";
import { throttle } from "@/mail/throttle.server";

export const origin = "http://127.0.0.1:6245";

export const mime = [
  "From: Ann Lee <ann@example.org>",
  "To: Me <me@example.org>, Bo <bo@example.org>",
  "Cc: Cy <cy@example.org>",
  "Subject: Hello there",
  "Date: Wed, 25 Nov 2026 09:30:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="mix"',
  "",
  "--mix",
  'Content-Type: multipart/related; boundary="rel"',
  "",
  "--rel",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p onclick="steal()">Hi <b>there</b></p><script>alert(1)</script>',
  '<img src="cid:logo@x"><img src="https://img.example/a.png"><a href="https://x.org">link</a>',
  "--rel",
  "Content-Type: image/png",
  "Content-ID: <logo@x>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--rel--",
  "--mix",
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  "",
  "the notes",
  "--mix--",
  "",
].join("\r\n");

export const plain = [
  "From: bo@example.org",
  "Subject: Plain",
  "Content-Type: text/plain",
  "",
  "See https://x.org/a?b=1 <now>",
  "",
].join("\r\n");

const json = (value: unknown, status = 200) => Response.json(value, { status });

const gmeta = (id: string, labels: string[]) =>
  json({
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    snippet: `snippet ${id}`,
    internalDate: String(Date.UTC(2026, 10, 20) + Number(id.slice(1)) * 1000),
    payload: {
      mimeType: id === "m1" ? "multipart/mixed" : "text/plain",
      headers: [
        { name: "From", value: id === "m1" ? '"Ann Lee" <ann@example.org>' : "bo@example.org" },
        { name: "Subject", value: `Subject ${id}` },
      ],
    },
  });

export type World = {
  requests: Request[];
  history: "pages" | "dead" | "broken";
  imapDown: boolean;
  imap: string[];
  noIdentity: boolean;
  noRefresh: boolean;
  rawFails: boolean;
  markFails: boolean;
  busy: number;
};

type Fake = [
  (url: URL, method: string) => boolean,
  (world: World, url: URL, body: string) => Response,
];

const gmail = "/gmail/v1/users/me";

const at = (host: string, path?: string | RegExp) => (url: URL) =>
  url.host === host &&
  (path === undefined ||
    (typeof path === "string" ? url.pathname === path : path.test(url.pathname)));

const historyPage = (world: World, url: URL) => {
  const answers = {
    dead: () => json({}, 404),
    broken: () => json({}, 500),
    pages: () =>
      url.searchParams.get("pageToken")
        ? json({ historyId: "120", history: [{ messagesDeleted: [{ message: { id: "m2" } }] }] })
        : json({
            historyId: "110",
            nextPageToken: "p2",
            history: [{ messages: [{ id: "m1" }, { id: "m4" }, { id: "m5" }] }],
          }),
  };
  return answers[world.history]();
};

const gmailMessage = (url: URL) => {
  const id = url.pathname.split("/").at(-1) ?? "";
  if (url.searchParams.get("format") === "raw") {
    return json({ raw: Buffer.from(id === "m2" ? plain : mime).toString("base64url") });
  }
  const labels: Record<string, string[] | null> = {
    m1: ["INBOX", "UNREAD", "STARRED"],
    m3: ["CATEGORY_UPDATES"],
    m5: null,
  };
  const found = id in labels ? labels[id] : ["INBOX"];
  return found ? gmeta(id, found) : json({}, 404);
};

const tokens = (prefix: string) => (world: World, _url: URL, body: string) =>
  json({
    access_token: body.includes("grant_type=refresh_token") ? `${prefix}-at2` : `${prefix}-at`,
    expires_in: 3600,
    refresh_token: world.noRefresh ? undefined : `${prefix}-rt`,
  });

const idToken = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

const microsoftTokens = (world: World, url: URL, body: string) => {
  const answer = tokens("m")(world, url, body);
  if (body.includes("grant_type=refresh_token")) return answer;
  return json({
    access_token: "m-at",
    expires_in: 3600,
    refresh_token: world.noRefresh ? undefined : "m-rt",
    id_token: world.noIdentity ? idToken({ name: "Bo" }) : idToken({ email: "bo@outlook.com" }),
  });
};

const imapRows = [
  {
    uid: 11,
    envelope: {
      messageId: "<t11@x>",
      subject: "IMAP one",
      date: new Date(Date.UTC(2026, 10, 21)),
      from: [{ name: "Cy", address: "cy@outlook.com" }],
    },
    flags: new Set(["\\Flagged"]),
    bodyStructure: { type: "multipart/mixed" },
  },
  {
    uid: 12,
    envelope: {
      subject: "IMAP two",
      date: "2026-11-22T00:00:00Z",
      from: [{ address: "dee@outlook.com" }],
    },
    flags: new Set(["\\Seen"]),
    bodyStructure: { type: "text/plain" },
  },
];

const fakes: Fake[] = [
  [at("oauth2.googleapis.com"), tokens("g")],
  [at("openidconnect.googleapis.com"), () => json({ email: "ann@gmail.com", name: "Ann" })],
  [at("gmail.googleapis.com", `${gmail}/profile`), () => json({ historyId: "100" })],
  [
    at("gmail.googleapis.com", `${gmail}/messages`),
    () => json({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }),
  ],
  [at("gmail.googleapis.com", `${gmail}/history`), historyPage],
  [at("gmail.googleapis.com", /\/modify$/), (world) => json({}, world.markFails ? 500 : 200)],
  [at("gmail.googleapis.com", /\/messages\/\w+$/), (_w, url) => gmailMessage(url)],
  [at("login.microsoftonline.com"), microsoftTokens],
  [
    at("img.example", "/a.png"),
    () => new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } }),
  ],
  [at("img.example"), () => new Response("<html>", { headers: { "content-type": "text/html" } })],
];

export async function boot(
  options: {
    clients?: "both" | "none";
    syncEvery?: number;
    clock?: ReturnType<typeof makeTestClock>;
  } = {},
) {
  const world: World = {
    requests: [],
    history: "pages",
    imapDown: false,
    imap: [],
    noIdentity: false,
    noRefresh: false,
    rawFails: false,
    markFails: false,
    busy: 0,
  };
  const kept = new Map<string, string>();
  const http: Http = async (request) => {
    world.requests.push(request.clone());
    const url = new URL(request.url);
    const body = await request.text();
    const found = fakes.find(([fits]) => fits(url, request.method));
    if (url.host === "gmail.googleapis.com" && world.busy > 0) {
      world.busy--;
      return new Response("{}", {
        status: 429,
        headers: { "retry-after": world.busy > 1 ? "0" : "" },
      });
    }

    return found ? found[1](world, url, body) : new Response("unknown", { status: 599 });
  };
  const secrets: SecretStore = {
    get: async ({ name }) => kept.get(name) ?? null,
    set: async ({ name, value }) => void kept.set(name, value),
    delete: async ({ name }) => kept.delete(name),
  };
  const open: OpenImap = async (login) => {
    if (world.imapDown || login.user !== "bo@outlook.com") throw new Error("AUTHENTICATE failed");
    world.imap.push(`login:${login.host}`);
    let usable = true;
    return {
      usable: () => usable,
      list: async (limit) => {
        world.imap.push("list");
        if (world.imapDown) throw new Error("connection lost");
        return { validity: "7", rows: imapRows.slice(0, limit) };
      },
      sources: async (uids) => {
        world.imap.push(uids.length === 1 ? `source:${uids[0]}` : `sources:${uids.join(",")}`);
        const known = world.rawFails
          ? []
          : uids.filter((uid) => imapRows.some((r) => String(r.uid) === uid));
        return known.map((uid) => ({ uid, mime: new TextEncoder().encode(plain) }));
      },
      flag: async (uid, seen) => {
        world.imap.push(`flag:${uid}:${seen}`);
      },
      close: async () => {
        usable = false;
        world.imap.push("logout");
      },
    };
  };
  const stop = new AbortController();
  const clients =
    options.clients === "none"
      ? {}
      : { google: { id: "g-id", secret: "g-secret" }, microsoft: { id: "m-id" } };
  const server = await createScope({
    clock: options.clock,
    tags: [backoff(1)],
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      store({ file: ":memory:" }),
      throttle(),
      net({ fetch: http }),
      keyring({ store: secrets }),
      outlookImap({ open }),
      mailServer({
        clients,
        origin,
        signer: "test-key",
        syncEvery: options.syncEvery ?? 0,
      }),
      mail.board({ serve: true, load: mailLoads }),
      mail.api({ implement: mailOps }),
      routes({ stop: stop.signal, table: mailRoutes }),
      memory.server({ services: [mail.board, mail.api] }),
    ],
  }).ready;
  const tab = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      memory.client({ peer: server }),
      mail.board({ read: memory.client }),
      mail.api({ remote: memory.client }),
    ],
  }).ready;

  const fetchRoute = server.resolve(routes).fetch;
  const get = async (path: string) => {
    const reply = await fetchRoute(new Request(new URL(path, origin)), server);
    if (!reply) throw new Error(`no route: ${path}`);
    return reply;
  };

  const signIn = async (provider: "google" | "microsoft") => {
    const start = await get(`/oauth/start/${provider}`);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const path = provider === "google" ? "/oauth/callback" : "/";
    const back = await get(`${path}?code=c-${provider}&state=${state}`);
    return { start, back };
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stop.abort();
    await tab.close();
    await server.close();
  };

  return { world, kept, server, tab, get, signIn, close };
}

export async function until(ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
