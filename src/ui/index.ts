import { capsule, data, operation, tag } from "@tinkered/core";
import { z } from "zod";

export type Memory = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
};

const memory = tag<Memory | null>({ label: "ui.memory", default: null });

const railKey = tag<string>({ label: "ui.railKey", default: "mail.rail" });

const shutKey = tag<string>({ label: "ui.shutKey", default: "mail.shut" });

export const railOpen = data({ label: "ui.railOpen", initial: true });

export const shutAccounts = data<readonly string[]>({ label: "ui.shutAccounts", initial: [] });

const themeKey = tag<string>({ label: "ui.themeKey", default: "mail.theme" });

const layoutKey = tag<string>({ label: "ui.layoutKey", default: "mail.layout" });

const widths = tag<{
  readonly rail: readonly [number, number];
  readonly list: readonly [number, number];
}>({
  label: "ui.widths",
  default: { rail: [180, 360], list: [260, 640] },
});

export const themeChoice = data({ label: "ui.theme", initial: "desktop" });

export const layout = data({ label: "ui.layout", initial: { rail: 224, list: 400 } });

const layoutShape = z.object({ rail: z.number(), list: z.number() });

export const chooseTheme = operation({
  label: "ui.chooseTheme",
  input: z.object({ name: z.string().regex(/^[\w.-]+$/) }),
  depends: { theme: themeChoice.atScope.controller, memory, themeKey },
  run: ({ theme, memory, themeKey }, { input }) => {
    theme.set(input.name);
    memory?.setItem(themeKey, input.name);
    return input.name;
  },
});

export const saveLayout = operation({
  label: "ui.saveLayout",
  input: layoutShape,
  depends: { kept: layout.atScope.controller, memory, layoutKey, widths },
  run: ({ kept, memory, layoutKey, widths }, { input }) => {
    const [railMin, railMax] = widths.rail;
    const [listMin, listMax] = widths.list;
    const next = {
      rail: Math.round(Math.min(railMax, Math.max(railMin, input.rail))),
      list: Math.round(Math.min(listMax, Math.max(listMin, input.list))),
    };

    kept.set(next);
    memory?.setItem(layoutKey, JSON.stringify(next));
    return next;
  },
});

const jsonOf = z.string().transform((text, ctx): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    ctx.addIssue({ code: "custom", message: "not JSON" });
    return z.NEVER;
  }
});

const shutList = jsonOf.pipe(z.array(z.string())).catch([]);

export const toggleAccount = operation({
  label: "ui.toggleAccount",
  input: z.object({ id: z.string() }),
  depends: { shut: shutAccounts.atScope.controller, memory, shutKey },
  run: ({ shut, memory, shutKey }, { input }) => {
    const was = shut.get();
    const open = was.includes(input.id);
    const next = open ? was.filter((id) => id !== input.id) : [...was, input.id];

    shut.set(next);
    memory?.setItem(shutKey, JSON.stringify(next));
    return open;
  },
});

export const toggleRail = operation({
  label: "ui.toggleRail",
  depends: { rail: railOpen.atScope.controller, memory, railKey },
  run: ({ rail, memory, railKey }) => {
    const open = !rail.get();
    rail.set(open);
    memory?.setItem(railKey, open ? "open" : "closed");
    return open;
  },
});

export const ui = capsule({
  label: "ui",
  config: { memory, railKey, shutKey, themeKey, layoutKey },
  exports: {
    railOpen,
    toggleRail,
    shutAccounts,
    toggleAccount,
    themeChoice,
    chooseTheme,
    layout,
    saveLayout,
  },
  hooks: {
    async start({ config, next, load }) {
      await next();
      const kept = z
        .enum(["open", "closed"])
        .catch("open")
        .parse(config.memory?.getItem(config.railKey));
      load(railOpen, { role: "state", explain: "The sidebar, open or closed" }).set(
        kept === "open",
      );

      const shut = shutList.parse(config.memory?.getItem(config.shutKey));
      load(shutAccounts, { role: "state", explain: "The accounts folded in the sidebar" }).set(
        shut,
      );

      const theme = z
        .string()
        .regex(/^[\w.-]+$/)
        .catch("desktop")
        .parse(config.memory?.getItem(config.themeKey));
      load(themeChoice, { role: "state", explain: "The theme picked in the app" }).set(theme);

      const sizes = jsonOf.pipe(layoutShape).safeParse(config.memory?.getItem(config.layoutKey));
      if (sizes.success) {
        load(layout, { role: "state", explain: "The pane widths" }).set(sizes.data);
      }
    },
  },
});
