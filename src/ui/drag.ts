import { capsule, tag } from "@tinkered/core";

import { layout, saveLayout } from "./index";

const host = tag<Window>({ label: "drag.window" });

const limits = tag<{ readonly min: number; readonly max: number }>({
  label: "drag.limits",
  default: { min: 56, max: 720 },
});

const grip = tag<string>({ label: "drag.grip", default: "[data-pane]" });

const surface = tag<string>({ label: "drag.surface", default: ".app" });

export const drag = capsule({
  label: "drag",
  config: { window: host.required, limits, grip, surface },
  hooks: {
    async start({ config, next, load, run, signal }) {
      await next();
      const w = config.window;
      const sizes = load(layout, { role: "state", explain: "The pane widths, while dragged" });
      const listen = { signal };
      let held: { pane: "rail" | "list"; x: number; w: number } | null = null;

      w.addEventListener(
        "pointerdown",
        (event) => {
          const target = w.document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest(config.grip);
          const pane = target?.getAttribute("data-pane");
          if (pane !== "rail" && pane !== "list") return;

          event.preventDefault();
          held = { pane, x: event.clientX, w: sizes.get()[pane] };
          w.document.querySelector(config.surface)?.setAttribute("data-dragging", "");
        },
        listen,
      );

      w.addEventListener(
        "pointermove",
        (event) => {
          if (!held) return;

          const width = held.w + event.clientX - held.x;
          sizes.set({
            ...sizes.get(),
            [held.pane]: Math.min(config.limits.max, Math.max(config.limits.min, width)),
          });
        },
        listen,
      );

      w.addEventListener(
        "pointerup",
        () => {
          if (!held) return;

          held = null;
          w.document.querySelector(config.surface)?.removeAttribute("data-dragging");
          void run(
            saveLayout,
            { input: sizes.get() },
            { role: "handler", explain: "Keeps the widths" },
          );
        },
        listen,
      );
    },
  },
});
