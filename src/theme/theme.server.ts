import { capsule, namespace, operation, tag } from "@tinkered/core";
import { z } from "zod";

import { themeCss } from "./contract";

/** The current theme's `colors.toml`. */
const colorsFile = tag<string>({ label: "theme.file" });

/** How often the file is read again, in ms. */
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

/** TOML text as data; null when it does not parse (a file caught mid-write). */
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

/**
 * `colors.toml` text to the sheet; a missing file or a bad value gives the Swiss defaults. Text
 * that is not TOML gives null: the sheet served stays.
 */
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

/** Reads the file; a sheet that differs from the one served is written. */
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

const worker = { role: "worker", explain: "Reads the theme file when it changes" } as const;

/** The poll runs often and finds nothing most times: no span, no log line. */
const quiet = namespace({ observe: false });

/** Reads the theme file at start and again every `every` ms; a change writes the sheet. */
export const themeServer = capsule({
  label: "theme.server",
  config: { file: colorsFile.required, every },
  hooks: {
    async start({ config, next, run, signal }) {
      await next();
      await run(refreshTheme, { ns: quiet }, worker);

      const timer = setInterval(() => void run(refreshTheme, { ns: quiet }, worker), config.every);
      signal.addEventListener("abort", () => clearInterval(timer));
    },
  },
});
