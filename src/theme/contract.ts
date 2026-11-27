import { data, remoteData, rpc } from "@tinkered/core";
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

export const themeChoice = data({ label: "theme.choice", initial: "desktop" });

export const themeBoard = remoteData({ themeCss, themes, themeChoice });

export const themeApi = rpc({
  "theme.choose": {
    input: z.object({ name: z.string().regex(/^[\w.-]+$/) }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("chosen"), name: z.string() }),
      z.object({ kind: z.literal("unknown"), name: z.string() }),
    ]),
  },
});
