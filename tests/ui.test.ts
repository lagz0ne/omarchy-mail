import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import {
  chooseTheme,
  layout,
  railOpen,
  saveLayout,
  shutAccounts,
  themeChoice,
  toggleAccount,
  toggleRail,
  ui,
} from "@/ui";

test("the sidebar opens as it was left, and a toggle is remembered", async () => {
  const kept = new Map<string, string>([["mail.rail", "closed"]]);
  const memory = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  const app = await createScope({
    capsules: [exits({ file: process.env.TINKER_EXITS }), ui({ memory })],
  }).ready;

  expect(app.resolve(railOpen)).toBe(false);
  expect(app.run(toggleRail)).toBe(true);
  expect(kept.get("mail.rail")).toBe("open");
  expect(app.run(toggleRail)).toBe(false);
  expect(kept.get("mail.rail")).toBe("closed");
  await app.close();

  const fresh = await createScope({ capsules: [exits({ file: process.env.TINKER_EXITS }), ui()] })
    .ready;
  expect(fresh.resolve(railOpen)).toBe(true);
  expect(fresh.run(toggleRail)).toBe(false);
  await fresh.close();
});

test("an account's folders fold and unfold, remembered; a broken memory is ignored", async () => {
  const kept = new Map<string, string>([["mail.shut", "not json"]]);
  const memory = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  const app = await createScope({
    capsules: [exits({ file: process.env.TINKER_EXITS }), ui({ memory })],
  }).ready;

  expect(app.resolve(shutAccounts)).toEqual([]);
  expect(app.run(toggleAccount, { input: { id: "g-1" } })).toBe(false);
  expect(app.resolve(shutAccounts)).toEqual(["g-1"]);
  expect(kept.get("mail.shut")).toBe('["g-1"]');
  await app.close();

  const again = await createScope({
    capsules: [exits({ file: process.env.TINKER_EXITS }), ui({ memory })],
  }).ready;
  expect(again.resolve(shutAccounts)).toEqual(["g-1"]);
  expect(again.run(toggleAccount, { input: { id: "g-1" } })).toBe(true);
  expect(again.resolve(shutAccounts)).toEqual([]);
  await again.close();
});

test("a picked theme and pane widths are kept; widths stay within their limits", async () => {
  const kept = new Map<string, string>([["mail.layout", "{broken"]]);
  const memory = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  const app = await createScope({
    capsules: [exits({ file: process.env.TINKER_EXITS }), ui({ memory })],
  }).ready;

  expect(app.resolve(themeChoice)).toBe("desktop");
  expect(app.resolve(layout)).toEqual({ rail: 224, list: 400 });
  expect(app.run(chooseTheme, { input: { name: "nord" } })).toBe("nord");
  expect(app.run(saveLayout, { input: { rail: 999, list: 10.4 } })).toEqual({
    rail: 360,
    list: 260,
  });
  expect(app.run(saveLayout, { input: { rail: 250.6, list: 512 } })).toEqual({
    rail: 251,
    list: 512,
  });
  await app.close();

  const again = await createScope({
    capsules: [exits({ file: process.env.TINKER_EXITS }), ui({ memory })],
  }).ready;
  expect(again.resolve(themeChoice)).toBe("nord");
  expect(again.resolve(layout)).toEqual({ rail: 251, list: 512 });
  await again.close();
});
