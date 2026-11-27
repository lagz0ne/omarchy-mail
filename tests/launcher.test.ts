import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { ensureServer, focusWindow, launcher, openApp, openWindow } from "@/app/launcher.server";

type World = {
  up: boolean;
  startsAfter: number;
  installed: string[];
  windows: { class: string; address: string }[];
  ran: string[];
  spawned: string[][];
  clients: string;
};

const boot = async (world: World) =>
  createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      launcher({
        origin: "http://127.0.0.1:6245",
        profileDir: "/data/window",
        waitFor: { tries: 3, every: 1 },
        alive: async () =>
          world.up ||
          (world.ran.includes("systemctl --user start omarchy-mail") && --world.startsAfter <= 0),
        spawn: (argv) => void world.spawned.push([...argv]),
        run: async (argv) => {
          const line = argv.join(" ");
          world.ran.push(line);
          if (argv[0] === "which") {
            return { code: world.installed.includes(argv[1] ?? "") ? 0 : 1, out: "" };
          }
          if (line === "hyprctl clients -j") {
            return { code: 0, out: world.clients || JSON.stringify(world.windows) };
          }
          return { code: 0, out: "" };
        },
      }),
    ],
  }).ready;

const fresh = (more: Partial<World> = {}): World => ({
  up: true,
  startsAfter: 1,
  installed: ["chromium"],
  windows: [],
  ran: [],
  spawned: [],
  clients: "",
  ...more,
});

test("open: a running server and an open window: the window is focused", async () => {
  const world = fresh({ windows: [{ class: "chrome-127.0.0.1__-OmarchyMail", address: "0xa" }] });
  const app = await boot(world);

  expect(await app.run(openApp)).toEqual({ server: "running", window: "focused" });
  expect(world.ran).toContain("hyprctl dispatch focuswindow address:0xa");
  expect(world.spawned).toEqual([]);
  await app.close();
});

test("open: no server yet, no window: the service starts and a window opens", async () => {
  const world = fresh({
    up: false,
    startsAfter: 2,
    installed: ["microsoft-edge-stable"],
    windows: [{ class: "msedge-127.0.0.1__-Default", address: "0xb" }],
  });
  const app = await boot(world);
  expect(await app.run(openApp)).toEqual({
    server: "started",
    window: "opened",
    browser: "microsoft-edge-stable",
  });
  expect(world.spawned[0]).toEqual([
    "microsoft-edge-stable",
    "--app=http://127.0.0.1:6245/",
    "--user-data-dir=/data/window",
    "--profile-directory=OmarchyMail",
    "--no-first-run",
    "--no-default-browser-check",
  ]);
  await app.close();
});

test("a server that never comes up, no browser, and broken hyprctl output", async () => {
  const world = fresh({ up: false, startsAfter: 99, installed: [], clients: "not json" });
  const app = await boot(world);

  expect((await app.settle(ensureServer)).status).toBe("failed");
  expect(await app.run(focusWindow)).toBe("none");
  const none = await app.settle(openWindow);
  expect(none.status === "failed" && Object(none.error).kind).toBe("NoBrowser");
  await app.close();
});
