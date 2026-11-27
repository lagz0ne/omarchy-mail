import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { memory } from "@tinkered/core/testing";
import { afterAll, expect, test } from "vite-plus/test";

import { theme } from "@/theme";
import { loadSheet, themeLoads, themeServer } from "@/theme/theme.server";

const folder = mkdtempSync(join(tmpdir(), "theme-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const until = async (ok: () => boolean) => {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("a theme switch reaches the tab; a broken file gives the Swiss defaults", async () => {
  const file = join(folder, "colors.toml");
  writeFileSync(file, 'mode = "light"\nbackground = "#f1f0ec"\nforeground = "#16191b"\n');
  const server = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      themeServer({ file, every: 10 }),
      theme.board({ serve: true }),
      memory.server({ services: [theme.board] }),
    ],
  }).ready;
  const tab = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      memory.client({ peer: server }),
      theme.board({ read: memory.client }),
    ],
  }).ready;
  const sheet = tab.resolve(theme.board.themeCss);
  sheet.watch(() => undefined);

  await until(() => sheet.get().includes("--bg:#f1f0ec"));
  expect(sheet.get()).toContain("color-scheme:light");
  expect(sheet.get()).toContain("--warm:#de6145");

  writeFileSync(file, "this is = not [toml");
  await new Promise((r) => setTimeout(r, 50));
  expect(sheet.get()).toContain("--bg:#f1f0ec");

  writeFileSync(file, 'background = "red"\n');
  await until(() => sheet.get().includes("--bg:#101315"));
  rmSync(file);
  writeFileSync(file, 'mode = "light"\n');
  await until(() => sheet.get().includes("color-scheme:light"));
  rmSync(file);
  await until(() => sheet.get().includes("color-scheme:dark"));

  await tab.close();
  await server.close();
});

test("every installed theme is listed, and each has its sheet", async () => {
  const mine = join(folder, "mine");
  const shared = join(folder, "shared");
  mkdirSync(join(mine, "swiss"), { recursive: true });
  mkdirSync(join(shared, "nord"), { recursive: true });
  mkdirSync(join(shared, "swiss"), { recursive: true });
  mkdirSync(join(shared, "empty"), { recursive: true });
  writeFileSync(join(mine, "swiss", "colors.toml"), 'background = "#101315"\n');
  writeFileSync(join(shared, "swiss", "colors.toml"), 'background = "#000000"\n');
  writeFileSync(
    join(shared, "nord", "colors.toml"),
    'mode = "dark"\nbackground = "#2e3440"\naccent = "#81a1c1"\n',
  );
  const file = join(folder, "current.toml");
  writeFileSync(file, "");
  const server = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      themeServer({ file, every: 1_000, dirs: [mine, shared, join(folder, "nowhere")] }),
      theme.board({ serve: true, load: themeLoads }),
      memory.server({ services: [theme.board] }),
    ],
  }).ready;
  const tab = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      memory.client({ peer: server }),
      theme.board({ read: memory.client }),
    ],
  }).ready;
  const list = tab.resolve(theme.board.themes.where({}));
  list.watch(() => undefined);
  await until(() => list.get().length === 2);
  expect(list.get().map((t) => `${t.title}:${t.bg}`)).toEqual(["Nord:#2e3440", "Swiss:#101315"]);

  const nord = tab.resolve(theme.board.sheets.of({ name: "nord" }));
  nord.watch(() => undefined);
  await until(() => nord.get()?.css.includes("--bg:#2e3440") ?? false);
  expect(await server.run(loadSheet, { input: { name: "../etc" } })).toEqual([]);
  expect(await server.run(loadSheet, { input: { name: "missing" } })).toEqual([]);

  await tab.close();
  await server.close();
});
