import { makeTestClock } from "@tinkered/core/testing";
import { afterEach, expect, test } from "vite-plus/test";

import { mail } from "@/mail";
import type { Account, Opened, Row } from "@/mail/contract";
import { proxyLink } from "@/mail/render.server";
import { foldText } from "@/mail/store.server";

import { boot, origin, until } from "./support/mail-world";

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function world(options: Parameters<typeof boot>[0] = {}) {
  const w = await boot(options);
  closers.push(w.close);

  const box = (name: string) => {
    const reader = w.tab.resolve(
      mail.board.messages.where({ box: name }, { order: "-date", limit: 50 }),
    );
    reader.watch(() => undefined);
    return { rows: (): readonly Row[] => reader.get() };
  };
  const accounts = () => {
    const reader = w.tab.resolve(mail.board.accounts.where({}));
    reader.watch(() => undefined);
    return { list: (): readonly Account[] => reader.get() };
  };
  const open = async (id: string, images = false) =>
    w.tab.run(mail.api["mail.open"], { input: { id, images } });
  return { ...w, box, accounts, open };
}

const pids = (rows: readonly Row[]) =>
  rows.map((r) => r.id.split(":")[1] ?? "").sort((a, b) => a.localeCompare(b));

test("Gmail: sign in, the first pull fills the inbox, a tab sees it live", async () => {
  const w = await world();
  const seen = w.accounts();
  const all = w.box("all");

  const { start, back } = await w.signIn("google");
  expect(start.status).toBe(302);
  expect(start.headers.get("location")).toContain("accounts.google.com");
  expect(start.headers.get("location")).toContain("code_challenge_method=S256");
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toMatch(/^http:\/\/127\.0\.0\.1:6245\/box\/g-/);

  await until(() => all.rows().length === 2);
  expect(pids(all.rows())).toEqual(["m1", "m2"]);
  const m1 = all.rows().find((r) => r.id.endsWith(":m1"));
  expect(m1).toMatchObject({ fromName: "Ann Lee", unread: true, starred: true, attach: true });
  expect(all.rows().find((r) => r.id.endsWith(":m2"))).toMatchObject({
    fromName: "bo@example.org",
  });
  await until(() => seen.list()[0]?.syncedAt !== 0);
  expect(seen.list()).toMatchObject([{ provider: "google", email: "ann@gmail.com", error: "" }]);
  expect(w.kept.get(`refresh:${seen.list()[0]?.id}`)).toBe("g-rt");
});

test("open: a safe page for the frame, marked read; images only when asked", async () => {
  const w = await world();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => all.rows().length === 2);
  const raws = () => w.world.requests.filter((r) => r.url.includes("format=raw")).length;
  await until(() => raws() === 2);
  const id = all.rows().find((r) => r.id.endsWith(":m1"))?.id ?? "";

  const out = await w.open(id);
  if (out.kind !== "message") throw new Error("not opened");
  const page: Opened = out;
  expect(page).toMatchObject({ subject: "Hello there", remote: 1, from: { name: "Ann Lee" } });
  expect(page.to.map((p) => p.name)).toEqual(["Me", "Bo"]);
  expect(page.cc.map((p) => p.address)).toEqual(["cy@example.org"]);
  expect(page.srcdoc).not.toContain("<script");
  expect(page.srcdoc).not.toContain("onclick");
  expect(page.srcdoc).toContain("Content-Security-Policy");
  expect(page.srcdoc).toContain(`${origin}/api/att/${encodeURIComponent(id)}/cid/logo%40x`);
  expect(page.srcdoc).toContain('data-blocked="1"');
  expect(page.srcdoc).toContain('target="_blank"');
  expect(page.attachments).toEqual([{ part: 1, name: "notes.txt", type: "text/plain", size: 9 }]);
  await until(() => all.rows().find((r) => r.id === id)?.unread === false);
  expect(w.world.requests.some((r) => r.url.endsWith("/messages/m1/modify"))).toBe(true);

  const shown = await w.open(id, true);
  if (shown.kind !== "message") throw new Error("not opened");
  expect(shown.srcdoc).toContain(`${origin}/api/img?u=https%3A%2F%2Fimg.example%2Fa.png`);
  expect(raws()).toBe(2);

  const text = await w.open(all.rows().find((r) => r.id.endsWith(":m2"))?.id ?? "");
  if (text.kind !== "message") throw new Error("not opened");
  expect(text.srcdoc).toContain('<a href="https://x.org/a?b=1" target="_blank"');
  expect(text.srcdoc).toContain("&lt;now&gt;");

  expect(await w.open(`${id}x`)).toEqual({ kind: "gone", id: `${id}x` });
});

test("open: a provider that will not mark it read still opens it", async () => {
  const w = await world();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => all.rows().length === 2);
  const id = all.rows().find((r) => r.id.endsWith(":m1"))?.id ?? "";

  w.world.markFails = true;
  expect((await w.open(id)).kind).toBe("message");
  expect(all.rows().find((r) => r.id === id)?.unread).toBe(true);
});

test("mark: unread again, or gone", async () => {
  const w = await world();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => all.rows().length === 2);
  const id = all.rows().find((r) => r.id.endsWith(":m2"))?.id ?? "";

  expect(await w.tab.run(mail.api["mail.mark"], { input: { id, unread: true } })).toEqual({
    kind: "marked",
  });
  await until(() => all.rows().find((r) => r.id === id)?.unread === true);
  expect(await w.tab.run(mail.api["mail.mark"], { input: { id: "g-0:zz", unread: true } })).toEqual(
    {
      kind: "gone",
      id: "g-0:zz",
    },
  );
});

test("attachments, inline images and the image proxy", async () => {
  const w = await world();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => all.rows().length === 2);
  const id = encodeURIComponent(all.rows().find((r) => r.id.endsWith(":m1"))?.id ?? "");

  const file = await w.get(`/api/att/${id}/1`);
  expect(file.status).toBe(200);
  expect(await file.text()).toBe("the notes");
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await w.get(`/api/att/${id}/cid/logo%40x`)).headers.get("content-type")).toBe(
    "image/png",
  );
  expect((await w.get(`/api/att/${id}/9`)).status).toBe(404);
  expect((await w.get(`/api/att/${encodeURIComponent("g-0:m1")}/1`)).status).toBe(404);

  const link = w.server.run(proxyLink, { input: "https://img.example/a.png" });
  const image = await w.get(new URL(link).pathname + new URL(link).search);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  const forged = new URL(link);
  forged.searchParams.set("s", "0");
  expect((await w.get(forged.pathname + forged.search)).status).toBe(403);
  const page = new URL(w.server.run(proxyLink, { input: "https://img.example/page" }));
  expect((await w.get(page.pathname + page.search)).status).toBe(404);
});

test("Gmail delta: added, deleted and gone messages; a dead cursor pulls the whole inbox", async () => {
  const w = await world();
  const all = w.box("all");
  const seen = w.accounts();
  await w.signIn("google");
  await until(() => all.rows().length === 2);

  expect(await w.tab.run(mail.api["mail.sync"], { input: {} })).toEqual({ accounts: 1 });
  await until(() => pids(all.rows()).join() === "m1,m4");

  w.world.history = "dead";
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => pids(all.rows()).join() === "m1,m2");

  w.world.history = "broken";
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => seen.list()[0]?.error === "ProviderFailed 500");
});

test("Gmail busy: a 429 is tried again with a pause; one that stays shows its status", async () => {
  const w = await world();
  const seen = w.accounts();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => all.rows().length === 2 && seen.list()[0]?.syncedAt !== 0);

  w.world.busy = 3;
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => w.world.busy === 0);
  await new Promise((r) => setTimeout(r, 50));
  expect(seen.list()[0]?.error).toBe("");

  w.world.busy = 1_000;
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => seen.list()[0]?.error === "ProviderFailed 429");
});

test("broken replies: each kind fails its sync with a name, and is logged", async () => {
  const w = await world();
  const seen = w.accounts();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => all.rows().length === 2 && seen.list()[0]?.syncedAt !== 0);
  const logged = (message: string) => w.world.logs.filter((l) => l.message === message);

  const cases = [
    ["garbage", "ProviderMalformed", "provider.malformed"],
    ["shape", "ProviderMalformed", "provider.malformed"],
    ["cut", "ProviderIncomplete 200", "provider.incomplete"],
    ["down", "ProviderUnreachable", "provider.unreachable"],
    ["stall", "ProviderTimeout", "provider.timeout"],
  ] as const;
  for (const [broken, error, message] of cases) {
    w.world.broken = broken;
    await w.tab.run(mail.api["mail.sync"], { input: {} });
    await until(() => seen.list()[0]?.error === error);
    expect(logged(message).length).toBeGreaterThan(0);

    w.world.broken = "none";
    await w.tab.run(mail.api["mail.sync"], { input: {} });
    await until(() => seen.list()[0]?.error === "");
  }
  expect(logged("provider.slow").length).toBeGreaterThan(0);
  expect(logged("provider.timeout")[0]?.attributes).toMatchObject({ family: "google" });
}, 15_000);

test("Outlook: sign in at the root, IMAP fills the inbox, open and flag over IMAP", async () => {
  const w = await world();
  const all = w.box("all");
  const seen = w.accounts();
  const { start, back } = await w.signIn("microsoft");
  const auth = new URL(start.headers.get("location") ?? "");
  expect(auth.host).toBe("login.microsoftonline.com");
  expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:6245");
  expect(auth.searchParams.get("scope")).toContain("IMAP.AccessAsUser.All");
  expect(back.headers.get("location")).toMatch(/\/box\/m-/);

  await until(() => all.rows().length === 2);
  expect(seen.list()).toMatchObject([
    { provider: "microsoft", email: "bo@outlook.com", name: "bo@outlook.com" },
  ]);
  const one = all.rows().find((r) => r.id.endsWith(":INBOX/11"));
  expect(one).toMatchObject({ fromName: "Cy", unread: true, starred: true, attach: true });
  expect(all.rows().find((r) => r.id.endsWith(":INBOX/12"))).toMatchObject({
    fromName: "dee@outlook.com",
    thread: "INBOX/12",
    unread: false,
  });

  await until(() => w.world.imap.includes("sources:11,12"));
  const opened = await w.open(one?.id ?? "");
  expect(opened.kind).toBe("message");
  expect(w.world.imap).toEqual([
    "login:outlook.office365.com",
    "list",
    "sources:11,12",
    "flag:11:true",
  ]);

  w.world.imapDown = true;
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => seen.list()[0]?.error !== "");
  expect(w.world.imap.slice(-2)).toEqual(["list", "logout"]);

  w.world.imapDown = false;
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => seen.list()[0]?.error === "");
  expect(w.world.imap.filter((step) => step.startsWith("login"))).toHaveLength(2);

  await w.close();
  await until(() => w.world.imap.at(-1) === "logout");
});

test("Outlook: a source the box no longer has is a failed open", async () => {
  const w = await world();
  const all = w.box("all");
  w.world.rawFails = true;
  await w.signIn("microsoft");
  await until(() => all.rows().length === 2 && w.world.imap.includes("sources:11,12"));

  const failed = await w.tab.settle(mail.api["mail.open"], {
    input: { id: all.rows().find((r) => r.id.endsWith(":INBOX/12"))?.id ?? "", images: false },
  });
  expect(failed.status).toBe("failed");
  expect(w.world.imap).toContain("source:12");

  w.world.rawFails = false;
  const later = await w.open(all.rows().find((r) => r.id.endsWith(":INBOX/12"))?.id ?? "");
  expect(later.kind).toBe("message");
});

test("search: sender, subject and body words, as prefixes, across accounts; accents fold", async () => {
  const w = await world();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => w.world.requests.filter((r) => r.url.includes("format=raw")).length >= 2);
  await w.signIn("microsoft");
  await until(() => all.rows().length === 4 && w.world.imap.includes("sources:11,12"));
  await new Promise((r) => setTimeout(r, 50));

  const found = (q: string) => w.box(`search:${q}`);
  const ann = found("ann");
  await until(() => ann.rows().length === 1);
  expect(ann.rows()[0]?.id).toMatch(/:m1$/);
  const body = found("THERE");
  await until(() => body.rows().length === 1);
  expect(pids(body.rows())).toEqual(["m1"]);
  const imap = found("imap tw");
  await until(() => imap.rows().length === 1);
  expect(imap.rows()[0]?.id).toMatch(/:INBOX\/12$/);
  const folded = found("Ånn");
  await until(() => folded.rows().length === 1);

  const none = found("zzz");
  const blank = found(" ");
  await new Promise((r) => setTimeout(r, 50));
  expect(none.rows()).toEqual([]);
  expect(blank.rows()).toEqual([]);
});

test("fold: lower case, no accents, and đ as d", async () => {
  const w = await world();
  expect(w.server.run(foldText, { input: ["Hóa ĐƠN tháng", "plain"] })).toEqual([
    "hoa don thang",
    "plain",
  ]);
});

test("folders: each provider's own, and a folder's mail once it is opened", async () => {
  const w = await world();
  const all = w.box("all");
  const seen = w.accounts();
  const reader = w.tab.resolve(mail.board.folders.where({}));
  reader.watch(() => undefined);
  const folders = () => reader.get().map((f) => `${f.account[0]}:${f.id}:${f.kind}`);
  await w.signIn("google");
  await until(() => folders().length === 4);
  expect(folders()).toEqual(["g:INBOX:inbox", "g:SENT:sent", "g:Label_1:label", "g:Label_2:label"]);

  await until(() => seen.list().length === 1);
  const gid = seen.list()[0]?.id ?? "";
  const pull = (box: string) => w.tab.run(mail.api["mail.pull"], { input: { box } });
  const sent = w.box(`${gid}~SENT`);
  expect(await pull(`${gid}~SENT`)).toEqual({ kind: "queued" });
  await until(() => sent.rows().length === 1);
  expect(sent.rows()[0]?.subject).toBe("Subject m6");
  expect(await pull(`${gid}~SENT`)).toEqual({ kind: "fresh" });
  expect(await pull(gid)).toEqual({ kind: "fresh" });
  expect(await pull("nobody~SENT")).toEqual({ kind: "gone", id: "nobody~SENT" });
  expect(await pull("search:x")).toEqual({ kind: "gone", id: "search:x" });
  expect(all.rows().some((r) => r.id.endsWith(":m6"))).toBe(false);

  await w.signIn("microsoft");
  await until(() => folders().length === 8);
  expect(folders().filter((f) => f.startsWith("m"))).toEqual([
    "m:INBOX:inbox",
    "m:Sent Items:sent",
    "m:Archive:archive",
    "m:Projects:label",
  ]);
  const mid =
    w
      .accounts()
      .list()
      .find((a) => a.provider === "microsoft")?.id ?? "";
  const outSent = w.box(`${mid}~Sent Items`);
  await pull(`${mid}~Sent Items`);
  await until(() => outSent.rows().length === 1);
  const id = outSent.rows()[0]?.id ?? "";
  expect(id).toBe(`${mid}:Sent Items/31`);
  expect((await w.open(id)).kind).toBe("message");
  expect(w.world.imap).toContain("source:31@Sent Items");

  const before = w.world.imap.filter((step) => step === "list@Sent Items").length;
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => w.world.imap.filter((step) => step === "list@Sent Items").length > before);
});

test("the root: the app opens at the inbox; a sign-in with no address is refused", async () => {
  const w = await world();
  const home = await w.get("/");
  expect(home.status).toBe(302);
  expect(home.headers.get("location")).toBe("http://127.0.0.1:6245/box/all");

  w.world.noIdentity = true;
  expect((await w.signIn("microsoft")).back.status).toBe(400);
});

test("tokens: an old access token is refreshed; Outlook turns its refresh token", async () => {
  const clock = makeTestClock({ now: Date.UTC(2026, 10, 27) });
  const w = await world({ clock });
  const seen = w.accounts();
  await w.signIn("microsoft");
  await w.signIn("google");
  await until(() => seen.list().length === 2 && seen.list().every((a) => a.syncedAt > 0));

  clock.advance(2 * 3600_000);
  w.world.noRefresh = true;
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  const grants = w.world.requests.filter((r) => r.url.includes("token")).length;
  expect(grants).toBeGreaterThanOrEqual(4);
  const outlook = seen.list().find((a) => a.provider === "microsoft")?.id ?? "";
  expect(w.kept.get(`refresh:${outlook}`)).toBe("m-rt");
});

test("sign-in that cannot go on: no code, a bad or old state, no refresh token, no app", async () => {
  const clock = makeTestClock({ now: Date.UTC(2026, 10, 27) });
  const w = await world({ clock });
  expect((await w.get("/oauth/callback?error=access_denied")).status).toBe(400);
  expect(await (await w.get("/oauth/callback?error=access_denied")).text()).toContain(
    "access_denied",
  );
  expect((await w.get("/oauth/callback?code=x&state=nope")).status).toBe(400);

  const start = await w.get("/oauth/start/google");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  clock.advance(11 * 60_000);
  expect((await w.get(`/oauth/callback?code=x&state=${state}`)).status).toBe(400);

  w.world.noRefresh = true;
  expect((await w.signIn("google")).back.status).toBe(400);
  expect((await w.signIn("microsoft")).back.status).toBe(400);

  const bare = await world({ clients: "none" });
  expect((await bare.get("/oauth/start/google")).status).toBe(501);
  expect((await bare.get("/oauth/start/microsoft")).status).toBe(501);
});

test("remove: the account, its mail and its tokens go; a second remove is gone", async () => {
  const w = await world();
  const seen = w.accounts();
  const all = w.box("all");
  await w.signIn("google");
  await until(() => all.rows().length === 2);
  const id = seen.list()[0]?.id ?? "";

  expect(await w.tab.run(mail.api["account.remove"], { input: { id } })).toEqual({
    kind: "removed",
  });
  await until(() => all.rows().length === 0 && seen.list().length === 0);
  expect(w.kept.size).toBe(0);
  expect(await w.tab.run(mail.api["account.remove"], { input: { id } })).toEqual({
    kind: "gone",
    id,
  });
});

test("the loop syncs by itself", async () => {
  const w = await world({ syncEvery: 30 });
  const seen = w.accounts();
  await w.signIn("google");
  await until(() => seen.list()[0]?.syncedAt !== 0);

  await until(() => w.world.requests.filter((r) => r.url.includes("/history")).length >= 2, 4000);
});
