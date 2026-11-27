import { data, remoteData } from "@tinkered/core";
import { z } from "zod";

export const themeCss = data({ label: "theme.css", initial: "" });

const swatch = z.object({
  name: z.string(),
  title: z.string(),
  mode: z.enum(["dark", "light"]),
  bg: z.string(),
  fg: z.string(),
  accent: z.string(),
  warm: z.string(),
});

export type Swatch = z.infer<typeof swatch>;

export const themes = data({
  label: "theme.list",
  mode: "keyed",
  parse: swatch,
  key: (t) => ({ name: t.name }),
});

export const sheets = data({
  label: "theme.sheets",
  mode: "keyed",
  parse: z.object({ name: z.string(), css: z.string() }),
  key: (s) => ({ name: s.name }),
});

export const themeBoard = remoteData({ themeCss, themes, sheets });
