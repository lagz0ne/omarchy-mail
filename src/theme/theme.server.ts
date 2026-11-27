import { readdir } from "node:fs/promises";

import { capsule, namespace, operation, tag } from "@tinkered/core";
import { z } from "zod";

import { type Swatch, themeCss } from "./contract";

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
  red: hex.default("#565d60"),
  yellow: hex.default("#d9dbdc"),
  green: hex.default("#9fa5a9"),
  cyan: hex.default("#707070"),
  blue: hex.default("#798186"),
  magenta: hex.default("#aeaeae"),
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

export const colorsOf = operation({
  label: "theme.colors",
  input: z.string(),
  depends: { tomlOf },
  run: ({ tomlOf }, { input }) => {
    const raw = tomlOf.run({ input });
    if (raw === null) return null;

    const found = colors.safeParse(raw);
    return found.success ? found.data : colors.parse({});
  },
});

const looknfeel = tag<string>({ label: "theme.looknfeel", default: "" });

const rounding = tag<{ readonly radius: number; readonly power: number }>({
  label: "theme.rounding",
  default: { radius: 0, power: 2 },
});

const setting = z.coerce.number().min(0).max(64);

export const shapeOf = operation({
  label: "theme.shape",
  input: z.array(z.string()),
  depends: { rounding },
  run: ({ rounding }, { input }) => {
    const plain = input.map((text) => text.replaceAll(/--.*$/gm, ""));
    const [radius, power] = [/\brounding\s*=\s*([\d.]+)/, /\brounding_power\s*=\s*([\d.]+)/].map(
      (pattern) =>
        plain
          .map((text) => setting.safeParse(pattern.exec(text)?.[1]))
          .find((value) => value.success)?.data,
    );
    return { radius: radius ?? rounding.radius, power: power ?? rounding.power };
  },
});

const squircleScale = tag<number>({ label: "theme.squircleScale", default: 1.7 });

export const sheetOf = operation({
  label: "theme.sheet",
  input: z.object({
    colors: z.string(),
    shape: z.object({ radius: z.number(), power: z.number() }),
  }),
  depends: { colorsOf, squircleScale },
  run: ({ colorsOf, squircleScale }, { input }) => {
    const c = colorsOf.run({ input: input.colors });
    if (c === null) return null;

    const corner = input.shape.power > 2 ? "squircle" : "round";

    return `:root{color-scheme:${c.mode};--bg:${c.background};--bg-2:${c.dark_background};--bg-3:${c.darker_background};--bg-up:${c.lighter_background};--fg:${c.foreground};--fg-2:${c.bright_foreground};--dim:${c.dark_foreground};--muted:${c.muted};--accent:${c.accent};--sel:${c.selection};--warm:${c.bright_red};--line:color-mix(in srgb,${c.foreground} 14%,transparent);--red:${c.red};--yellow:${c.yellow};--green:${c.green};--cyan:${c.cyan};--blue:${c.blue};--magenta:${c.magenta};--radius:${input.shape.radius}px;--corner:${corner};--corner-scale:${corner === "squircle" ? squircleScale : 1}}`;
  },
});

const themeDirs = tag<readonly string[]>({
  label: "theme.dirs",
  default: ["/usr/share/omarchy/themes"],
});

const fileOf = operation({
  label: "theme.fileOf",
  input: z.object({ name: z.string().regex(/^[\w.-]+$/) }),
  depends: { themeDirs },
  run: async ({ themeDirs }, { input }) => {
    for (const dir of themeDirs) {
      const colors = await Bun.file(`${dir}/${input.name}/colors.toml`)
        .text()
        .catch(() => null);
      const hypr = await Bun.file(`${dir}/${input.name}/hyprland.lua`)
        .text()
        .catch(() => "");
      if (colors !== null) return { colors, hypr };
    }
    return null;
  },
});

export const loadThemes = operation({
  label: "theme.list.load",
  input: z.object({}),
  depends: { themeDirs, fileOf, colorsOf },
  run: async ({ themeDirs, fileOf, colorsOf }): Promise<Swatch[]> => {
    const names = new Set<string>();
    for (const dir of themeDirs) {
      const found = await readdir(dir).catch(() => []);
      for (const name of z.array(z.string()).parse(found)) names.add(name);
    }
    const out: Swatch[] = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const found = /^[\w.-]+$/.test(name) ? await fileOf.run({ input: { name } }) : null;
      const c = found === null ? null : colorsOf.run({ input: found.colors });
      const title = name.replaceAll(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
      if (c) {
        out.push({
          name,
          title,
          mode: c.mode,
          bg: c.background,
          fg: c.foreground,
          accent: c.accent,
          warm: c.bright_red,
        });
      }
    }
    return out;
  },
});

export const loadSheet = operation({
  label: "theme.sheet.load",
  input: z.object({ name: z.string() }),
  depends: { fileOf, sheetOf, shapeOf, looknfeel },
  run: async ({ fileOf, sheetOf, shapeOf, looknfeel }, { input }) => {
    const found = /^[\w.-]+$/.test(input.name) ? await fileOf.run({ input }) : null;
    const own = await Bun.file(looknfeel)
      .text()
      .catch(() => "");
    const shape = shapeOf.run({ input: found ? [found.hypr, own] : [] });
    const css = found === null ? null : sheetOf.run({ input: { colors: found.colors, shape } });
    return css === null ? [] : [{ name: input.name, css }];
  },
});

export const themeLoads = { themes: loadThemes, sheets: loadSheet } as const;

export const refreshTheme = operation({
  label: "theme.refresh",
  depends: { file: colorsFile, css: themeCss.atScope.controller, sheetOf, shapeOf, looknfeel },
  run: async ({ file, css, sheetOf, shapeOf, looknfeel }) => {
    const [colors = "", hypr = "", own = ""] = await Promise.all(
      [file, file.replace(/colors\.toml$/, "hyprland.lua"), looknfeel].map((path) =>
        Bun.file(path)
          .text()
          .catch(() => ""),
      ),
    );
    const sheet = sheetOf.run({ input: { colors, shape: shapeOf.run({ input: [hypr, own] }) } });
    if (sheet !== null && sheet !== css.get()) css.set(sheet);
  },
});

const quiet = namespace({ observe: false });

export const themeServer = capsule({
  label: "theme.server",
  config: { file: colorsFile.required, every, dirs: themeDirs, looknfeel, rounding },
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
