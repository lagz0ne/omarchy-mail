import { capsule, tag } from "@tinkered/core";

import { toggleRail } from "./index";

const host = tag<Window>({ label: "keys.window" });

const twiceWithin = tag<number>({ label: "keys.twiceWithin", default: 500 });

const targets = tag<{
  readonly mailboxes: string;
  readonly rows: string;
  readonly current: string;
  readonly search: string;
  readonly typing: string;
  readonly actions: Readonly<Record<string, string>>;
}>({
  label: "keys.targets",
  default: {
    mailboxes: ".rail [data-mailbox]",
    rows: ".rows a",
    current: "on",
    search: ".search input",
    typing: "input, textarea",
    actions: {
      u: '[aria-label="Mark unread"]',
      e: '[data-act="archive"]',
      "#": '[data-act="trash"]',
      s: '[data-act="star"]',
      "!": '[data-act="spam"]',
      i: ".reader-head a.icon-key.warm",
      Escape: ".reader-head .back",
    },
  },
});

export const keys = capsule({
  label: "keys",
  config: { window: host.required, twiceWithin, targets },
  hooks: {
    async start({ config, next, run, signal }) {
      await next();
      const { window: w, targets: at } = config;
      const doc = w.document;
      const listen = { signal };
      let lastG = 0;
      let plain = false;

      w.addEventListener(
        "keydown",
        (event) => {
          const typing = doc.activeElement?.matches(at.typing) === true;
          plain = !event.ctrlKey && !event.altKey && !event.metaKey && !typing;
        },
        { signal, capture: true },
      );

      w.addEventListener(
        "keydown",
        (event) => {
          const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
          if (!digit || !(event.ctrlKey || event.altKey)) return;

          event.preventDefault();
          doc.querySelectorAll<HTMLElement>(at.mailboxes)[digit - 1]?.click();
        },
        listen,
      );

      w.addEventListener(
        "keydown",
        (event) => {
          const moves: Record<string, number> = { j: 1, k: -1, G: Infinity };
          const step = moves[event.key];
          if (step === undefined || !plain) return;

          const rows = [...doc.querySelectorAll<HTMLElement>(at.rows)];
          const now = rows.findIndex((row) => row.classList.contains(at.current));
          const row = rows[Math.max(0, Math.min(now + step, rows.length - 1))];
          event.preventDefault();
          row?.click();
          row?.scrollIntoView({ block: "nearest" });
        },
        listen,
      );

      w.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "g" || !plain) return;

          const now = Date.now();
          const twice = now - lastG < config.twiceWithin;
          lastG = twice ? 0 : now;
          const first = twice ? doc.querySelector<HTMLElement>(at.rows) : null;
          first?.click();
          first?.scrollIntoView({ block: "nearest" });
        },
        listen,
      );

      w.addEventListener(
        "keydown",
        (event) => {
          const target = at.actions[event.key];
          if (!plain || target === undefined) return;

          const button = doc.querySelector<HTMLElement>(target);
          if (button) event.preventDefault();
          button?.click();
        },
        listen,
      );

      w.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "/" || !plain) return;

          event.preventDefault();
          doc.querySelector<HTMLElement>(at.search)?.focus();
        },
        listen,
      );

      w.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "\\" || !event.ctrlKey) return;

          event.preventDefault();
          void run(toggleRail, {}, { role: "handler", explain: "Ctrl+\\ folds the sidebar" });
        },
        listen,
      );
    },
  },
});
