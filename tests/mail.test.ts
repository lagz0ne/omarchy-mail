import { makeTestClock } from "@tinkered/core/testing";
import { afterEach, expect, test } from "vite-plus/test";

import { mail } from "@/mail";
import type { Account, Opened, Row } from "@/mail/contract";
import { proxyLink } from "@/mail/render.server";

import { boot, origin, until } from "./support/mail-world";

// The mail feature end to end, as the cmds install it: sign-in through the real routes, sync
// against fake providers, the live board on a tab, and every call.

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
  // m3 left the inbox, so the list has m1 and m2.
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
  // Opening marks it read, here and at Gmail.
  await until(() => all.rows().find((r) => r.id === id)?.unread === false);
  expect(w.world.requests.some((r) => r.url.endsWith("/messages/m1/modify"))).toBe(true);

  const shown = await w.open(id, true);
  if (shown.kind !== "message") throw new Error("not opened");
  expect(shown.srcdoc).toContain(`${origin}/api/img?u=https%3A%2F%2Fimg.example%2Fa.png`);
  // The second open reads the kept source: one raw fetch in all.
  expect(w.world.requests.filter((r) => r.url.includes("format=raw"))).toHaveLength(1);

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
  // m4 is new, m2 was deleted, m5 is gone (404): the history pages say so.
  await until(() => pids(all.rows()).join() === "m1,m4");

  w.world.history = "dead";
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => pids(all.rows()).join() === "m1,m2");

  w.world.history = "broken";
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => seen.list()[0]?.error === "ProviderFailed");
});

test("Outlook: sign in, delta pages, removals, reset; a failed source is a failed open", async () => {
  const w = await world();
  const all = w.box("all");
  const seen = w.accounts();
  const { start, back } = await w.signIn("microsoft");
  expect(start.headers.get("location")).toContain("login.microsoftonline.com/consumers");
  expect(start.headers.get("location")).toContain(
    encodeURIComponent("http://localhost:6245/oauth/callback"),
  );
  expect(back.headers.get("location")).toMatch(/\/box\/m-/);

  await until(() => all.rows().length === 3);
  expect(seen.list()).toMatchObject([
    { provider: "microsoft", email: "bo@outlook.com", name: "bo@outlook.com" },
  ]);
  const o1 = all.rows().find((r) => r.id.endsWith(":o1"));
  expect(o1).toMatchObject({ fromName: "Cy", unread: true, starred: true, attach: true });
  expect(all.rows().find((r) => r.id.endsWith(":o3"))).toMatchObject({
    fromName: "",
    fromAddr: "",
  });
  const mine = w.box(seen.list()[0]?.id ?? "");
  await until(() => mine.rows().length === 3);

  await w.tab.run(mail.api["mail.sync"], { input: {} });
  expect(w.world.requests.some((r) => r.url.includes("cursor=next"))).toBe(true);

  w.world.delta = "dead";
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => seen.list()[0]?.error === "");
  w.world.delta = "broken";
  await w.tab.run(mail.api["mail.sync"], { input: {} });
  await until(() => seen.list()[0]?.error === "ProviderFailed");
  w.world.delta = "pages";

  const opened = await w.open(o1?.id ?? "");
  expect(opened.kind).toBe("message");
  expect(w.world.requests.some((r) => r.method === "PATCH")).toBe(true);
  w.world.rawFails = true;
  const failed = await w.tab.settle(mail.api["mail.open"], {
    input: { id: all.rows().find((r) => r.id.endsWith(":o2"))?.id ?? "", images: false },
  });
  expect(failed.status).toBe("failed");
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

  // The loop's first tick is a second after start, then every 30 ms; the kept token still works.
  await until(() => w.world.requests.filter((r) => r.url.includes("/history")).length >= 2, 4000);
});
