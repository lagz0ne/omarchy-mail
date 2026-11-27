import { capsule, operation, tag } from "@tinkered/core";
import { z } from "zod";

export type Run = (
  argv: readonly string[],
) => Promise<{ readonly code: number; readonly out: string }>;

export type Spawn = (argv: readonly string[]) => void;

const runner = tag<Run>({
  label: "launcher.run",
  default: async (argv) => {
    const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(child.stdout).text();
    return { code: await child.exited, out };
  },
});

const spawner = tag<Spawn>({
  label: "launcher.spawn",
  default: (argv) => {
    Bun.spawn([...argv], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  },
});

const fetcher = tag<(url: string) => Promise<boolean>>({
  label: "launcher.alive",
  default: (url) =>
    fetch(url)
      .then((res) => res.ok)
      .catch(() => false),
});

const origin = tag<string>({ label: "launcher.origin" });

const profileDir = tag<string>({ label: "launcher.profileDir" });

const profileName = tag<string>({ label: "launcher.profileName", default: "OmarchyMail" });

const browsers = tag<readonly string[]>({
  label: "launcher.browsers",
  default: ["chromium", "google-chrome-stable", "microsoft-edge-stable", "brave"],
});

const service = tag<string>({ label: "launcher.service", default: "omarchy-mail" });

const waitFor = tag<{ readonly tries: number; readonly every: number }>({
  label: "launcher.waitFor",
  default: { tries: 40, every: 150 },
});

export const launcher = capsule({
  label: "launcher",
  config: {
    run: runner,
    spawn: spawner,
    alive: fetcher,
    origin: origin.required,
    profileDir: profileDir.required,
    profileName,
    browsers,
    service,
    waitFor,
  },
  hooks: {
    async start({ config, next }) {
      await next();
      return config;
    },
  },
});

export const ensureServer = operation({
  label: "app.ensureServer",
  depends: { launcher },
  run: async ({ launcher: l }, { clock, raise }) => {
    const health = `${l.origin}/api/health`;
    if (await l.alive(health)) return "running" as const;

    await l.run(["systemctl", "--user", "start", l.service]);
    for (let n = 0; n < l.waitFor.tries; n++) {
      await clock.sleep(l.waitFor.every);
      if (await l.alive(health)) return "started" as const;
    }
    return raise("ServerDown", { origin: l.origin });
  },
});

const clients = z
  .string()
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ class: z.string(), address: z.string() })))
  .catch([]);

export const focusWindow = operation({
  label: "app.focus",
  depends: { launcher },
  run: async ({ launcher: l }) => {
    const listed = await l.run(["hyprctl", "clients", "-j"]);
    const host = new URL(l.origin).hostname;
    const mine = `${host}__-${l.profileName}`;
    const found = clients
      .parse(listed.code === 0 ? listed.out : "")
      .find((c) => c.class.endsWith(mine));
    if (!found) return "none" as const;

    await l.run(["hyprctl", "dispatch", "focuswindow", `address:${found.address}`]);
    return "focused" as const;
  },
});

export const openWindow = operation({
  label: "app.window",
  depends: { launcher },
  run: async ({ launcher: l }, { raise }) => {
    for (const browser of l.browsers) {
      const which = await l.run(["which", browser]);
      if (which.code !== 0) continue;

      l.spawn([
        browser,
        `--app=${l.origin}/`,
        `--user-data-dir=${l.profileDir}`,
        `--profile-directory=${l.profileName}`,
        "--no-first-run",
        "--no-default-browser-check",
      ]);
      return browser;
    }
    return raise("NoBrowser", { tried: l.browsers });
  },
});

export const openApp = operation({
  label: "app.open",
  depends: { ensureServer, focusWindow, openWindow },
  run: async ({ ensureServer, focusWindow, openWindow }) => {
    const server = await ensureServer.run();
    const focused = await focusWindow.run();
    if (focused === "focused") return { server, window: "focused" as const };

    const browser = await openWindow.run();
    return { server, window: "opened" as const, browser };
  },
});
