import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { railOpen, toggleRail, ui } from "@/ui";

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
