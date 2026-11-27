import { Database } from "bun:sqlite";

import { exits } from "@tinkered/cli/test";
import { createScope, resource } from "@tinkered/core";
import { makeTestClock, memory } from "@tinkered/core/testing";

import { routes } from "~/components/requests/index.server";

import { mail } from "@/mail";
import type { Http, Vault } from "@/mail/config.server";
import { mailServer } from "@/mail/index.server";
import { mailLoads, mailOps } from "@/mail/ops.server";
import { mailRoutes } from "@/mail/routes.server";

// A fake Google, a fake Microsoft and a fake image host, behind the `http` slot; a map behind the
// `vault` slot. Each test boots a real server scope and a tab over `memory`, as the cmds do.

export const origin = "http://127.0.0.1:6245";

/** A message as the providers give it: html with a cid image, a remote image, a script, a file. */
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

/** A text-only message. */
export const plain = [
  "From: bo@example.org",
  "Subject: Plain",
  "Content-Type: text/plain",
  "",
  "See https://x.org/a?b=1 <now>",
  "",
].join("\r\n");

const json = (value: unknown, status = 200) => Response.json(value, { status });

/** Gmail's list fields of a message, in the inbox or not. */
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

/** The world's knobs: a test turns them to reach each answer. */
export type World = {
  requests: Request[];
  /** The history page a cursor gets: "pages", "dead" (404) or "broken" (500). */
  history: "pages" | "dead" | "broken";
  /** The Graph delta answer for a cursor: "pages", "dead" (410) or "broken" (500). */
  delta: "pages" | "dead" | "broken";
  /** No refresh token from the token endpoint. */
  noRefresh: boolean;
  /** Graph's raw fetch fails. */
  rawFails: boolean;
  /** Gmail's modify (mark read) fails. */
  markFails: boolean;
};

/** One fake endpoint: a test of the request, and its answer. */
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

const graphItem = (id: string, read: boolean) => ({
  id,
  conversationId: `c-${id}`,
  subject: `Graph ${id}`,
  bodyPreview: "preview",
  receivedDateTime: "2026-11-21T10:00:00Z",
  isRead: read,
  hasAttachments: id === "o1",
  flag: { flagStatus: id === "o1" ? "flagged" : "notFlagged" },
  from:
    id === "o3"
      ? null
      : { emailAddress: { name: id === "o1" ? "Cy" : null, address: "cy@outlook.com" } },
});

const deltaPage = (world: World, url: URL) => {
  if (world.delta === "dead") return json({}, 410);
  if (world.delta === "broken") return json({}, 500);
  if (url.searchParams.get("page") !== "2") {
    return json({
      value: [graphItem("o1", false), graphItem("o2", true)],
      "@odata.nextLink": `${url.origin}${url.pathname}?page=2`,
    });
  }
  return json({
    value: [graphItem("o3", true), { id: "o9", "@removed": { reason: "deleted" } }],
    "@odata.deltaLink": `${url.origin}${url.pathname}?cursor=next`,
  });
};

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
  [at("login.microsoftonline.com"), tokens("m")],
  [
    at("graph.microsoft.com", "/v1.0/me"),
    () => json({ displayName: null, mail: null, userPrincipalName: "bo@outlook.com" }),
  ],
  [at("graph.microsoft.com", /\/delta$/), deltaPage],
  [
    at("graph.microsoft.com", /\/\$value$/),
    (world) => (world.rawFails ? new Response("no", { status: 503 }) : new Response(plain)),
  ],
  [
    (url, method) => url.host === "graph.microsoft.com" && method === "PATCH",
    () => new Response(null, { status: 204 }),
  ],
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
    delta: "pages",
    noRefresh: false,
    rawFails: false,
    markFails: false,
  };
  const kept = new Map<string, string>();
  const fake = resource({
    label: "test.http",
    factory: (): Http => async (request) => {
      world.requests.push(request.clone());
      const url = new URL(request.url);
      const body = await request.text();
      const found = fakes.find(([fits]) => fits(url, request.method));

      return found ? found[1](world, url, body) : new Response("unknown", { status: 599 });
    },
  });
  const vault = resource({
    label: "test.vault",
    factory: (): Vault => ({
      get: async (name) => kept.get(name) ?? null,
      set: async (name, value) => void kept.set(name, value),
      delete: async (name) => kept.delete(name),
    }),
  });
  const stop = new AbortController();
  const clients =
    options.clients === "none"
      ? {}
      : { google: { id: "g-id", secret: "g-secret" }, microsoft: { id: "m-id" } };
  const server = await createScope({
    clock: options.clock,
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      mailServer({
        database: new Database(":memory:", { strict: true }),
        http: fake,
        vault,
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

  /** Signs in through the real routes: start, the provider's redirect, the callback. */
  const signIn = async (provider: "google" | "microsoft") => {
    const start = await get(`/oauth/start/${provider}`);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const back = await get(`/oauth/callback?code=c-${provider}&state=${state}`);
    return { start, back };
  };

  const close = async () => {
    stop.abort();
    await tab.close();
    await server.close();
  };

  return { world, kept, server, tab, get, signIn, close };
}

/** Waits for a condition the server reaches by itself. */
export async function until(ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
