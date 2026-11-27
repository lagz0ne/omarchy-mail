import { capsule, namespace, operation, tag } from "@tinkered/core";
import { z } from "zod";

import { themeCss } from "./contract";

const colorsFile = tag<string>({ label: "theme.file" });

const every = tag<number>({ label: "theme.every", default: 1_500 });

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const colors = z.object({
  mode: z.enum(["dark", "light"]).default("dark"),
  background: hex.default("#101315"),
  dark_background: hex.default("#0c0e10"),
  darker_background: hex.default("#080a0b"),
  lighter_background: hex.default("#101315"),
  foreground: hex.default("#cacccc"),
  dark_foreground: hex.default("#4b4e55"),
  bright_foreground: hex.default("#a5aeb4"),
  muted: hex.default("#4b4e55"),
  accent: hex.default("#798186"),
  selection: hex.default("#343d41"),
  bright_red: hex.default("#de6145"),
});

const tomlOf = operation({
  label: "theme.toml",
  input: z.string(),
  run: (_, { input }): unknown => {
    try {
      return Bun.TOML.parse(input);
    } catch {
      return null;
    }
  },
});

export const sheetOf = operation({
  label: "theme.sheet",
  input: z.string(),
  depends: { tomlOf },
  run: ({ tomlOf }, { input }) => {
    const raw = tomlOf.run({ input });
    if (raw === null) return null;

    const found = colors.safeParse(raw);
    const c = found.success ? found.data : colors.parse({});
    return `:root{color-scheme:${c.mode};--bg:${c.background};--bg-2:${c.dark_background};--bg-3:${c.darker_background};--bg-up:${c.lighter_background};--fg:${c.foreground};--fg-2:${c.bright_foreground};--dim:${c.dark_foreground};--muted:${c.muted};--accent:${c.accent};--sel:${c.selection};--warm:${c.bright_red};--line:color-mix(in srgb,${c.foreground} 14%,transparent)}`;
  },
});

export const refreshTheme = operation({
  label: "theme.refresh",
  depends: { file: colorsFile, css: themeCss.atScope.controller, sheetOf },
  run: async ({ file, css, sheetOf }) => {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    const sheet = sheetOf.run({ input: text });
    if (sheet !== null && sheet !== css.get()) css.set(sheet);
  },
});

const quiet = namespace({ observe: false });

export const themeServer = capsule({
  label: "theme.server",
  config: { file: colorsFile.required, every },
  hooks: {
    async start({ config, next, run, signal }) {
      await next();
      const worker = { role: "worker", explain: "Reads the theme file when it changes" } as const;
      await run(refreshTheme, { ns: quiet }, worker);

      const timer = setInterval(() => void run(refreshTheme, { ns: quiet }, worker), config.every);
      signal.addEventListener("abort", () => clearInterval(timer));
    },
  },
});
