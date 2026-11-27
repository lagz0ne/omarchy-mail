import { capsule, data, operation, tag } from "@tinkered/core";
import { z } from "zod";

export type Memory = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
};

const memory = tag<Memory | null>({ label: "ui.memory", default: null });

const railKey = tag<string>({ label: "ui.railKey", default: "mail.rail" });

export const railOpen = data({ label: "ui.railOpen", initial: true });

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
  config: { memory, railKey },
  exports: { railOpen, toggleRail },
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
    },
  },
});
