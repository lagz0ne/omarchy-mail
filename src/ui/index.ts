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

const shutList = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string()))
  .catch([]);

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
  config: { memory, railKey, shutKey },
  exports: { railOpen, toggleRail, shutAccounts, toggleAccount },
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
    },
  },
});
