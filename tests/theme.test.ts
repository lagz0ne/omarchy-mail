import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { memory } from "@tinkered/core/testing";
import { afterAll, expect, test } from "vite-plus/test";

import { theme } from "@/theme";
import { themeCss } from "@/theme/contract";
import {
  loadSheet,
  shapeOf,
  themeLoads,
  themeOps,
  themeServer,
  themeSheetRoute,
} from "@/theme/theme.server";

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

  const [nord] = await server.run(loadSheet, { input: { name: "nord" } });
  expect(nord?.css).toContain("--bg:#2e3440");
  expect(await server.run(loadSheet, { input: { name: "../etc" } })).toEqual([]);
  expect(await server.run(loadSheet, { input: { name: "missing" } })).toEqual([]);

  await tab.close();
  await server.close();
});

test("corners follow the theme's Hyprland rounding, then looknfeel, then square", async () => {
  const dirs = join(folder, "shapes");
  mkdirSync(join(dirs, "round"), { recursive: true });
  mkdirSync(join(dirs, "plain"), { recursive: true });
  writeFileSync(join(dirs, "round", "colors.toml"), 'background = "#101315"\n');
  writeFileSync(
    join(dirs, "round", "hyprland.lua"),
    "hl.config({\n  decoration = {\n    rounding = 14,\n    rounding_power = 4.5,\n  },\n})\n",
  );
  writeFileSync(join(dirs, "plain", "colors.toml"), 'background = "#2e3440"\n');
  const own = join(folder, "looknfeel.lua");
  writeFileSync(own, "-- rounding = 99,\nhl.config({ decoration = { rounding = 8 } })\n");
  const file = join(dirs, "round", "colors.toml");
  const app = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      themeServer({ file, every: 1_000, dirs: [dirs], looknfeel: own }),
      theme.board({ serve: true, load: themeLoads }),
    ],
  }).ready;

  const css = (name: string) =>
    app.run(loadSheet, { input: { name } }).then((found) => found[0]?.css ?? "");
  expect(await css("round")).toContain("--radius:14px;--corner:squircle");
  expect(await css("plain")).toContain("--radius:8px;--corner:round");
  expect(app.resolve(themeCss)).toContain("--radius:14px;--corner:squircle");
  expect(app.run(shapeOf, { input: ["-- rounding = 3", ""] })).toEqual({ radius: 0, power: 2 });
  await app.close();
});

test("the picked theme is the server's: pushed live, served as a stylesheet, kept on restart", async () => {
  const dirs = join(folder, "picked");
  mkdirSync(join(dirs, "nord"), { recursive: true });
  writeFileSync(join(dirs, "nord", "colors.toml"), 'background = "#2e3440"\n');
  const file = join(folder, "desktop.toml");
  writeFileSync(file, 'background = "#101315"\n');
  const choiceFile = join(folder, "choice");
  const boot = async () => {
    const server = await createScope({
      capsules: [
        exits({ file: process.env.TINKER_EXITS }),
        themeServer({ file, every: 1_000, dirs: [dirs], choiceFile }),
        theme.board({ serve: true, load: themeLoads }),
        theme.api({ implement: themeOps }),
        memory.server({ services: [theme.board, theme.api] }),
      ],
    }).ready;
    const tab = await createScope({
      capsules: [
        exits({ file: process.env.TINKER_EXITS }),
        memory.client({ peer: server }),
        theme.board({ read: memory.client }),
        theme.api({ remote: memory.client }),
      ],
    }).ready;
    const css = tab.resolve(theme.board.themeCss);
    css.watch(() => undefined);
    return { server, tab, css };
  };

  const first = await boot();
  await until(() => first.css.get().includes("--bg:#101315"));
  const choose = (name: string) => first.tab.run(theme.api["theme.choose"], { input: { name } });
  expect(await choose("nord")).toEqual({ kind: "chosen", name: "nord" });
  await until(() => first.css.get().includes("--bg:#2e3440"));
  expect(await choose("missing")).toEqual({ kind: "unknown", name: "missing" });
  const sheet = first.server.run(themeSheetRoute);
  expect(sheet.headers.get("content-type")).toBe("text/css");
  expect(await sheet.text()).toContain("--bg:#2e3440");
  await first.tab.close();
  await first.server.close();

  const again = await boot();
  await until(() => again.css.get().includes("--bg:#2e3440"));
  expect(await again.tab.run(theme.api["theme.choose"], { input: { name: "desktop" } })).toEqual({
    kind: "chosen",
    name: "desktop",
  });
  await until(() => again.css.get().includes("--bg:#101315"));
  await again.tab.close();
  await again.server.close();
});
