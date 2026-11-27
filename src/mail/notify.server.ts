import { capsule, operation, tag } from "@tinkered/core";
import { z } from "zod";

import { origin } from "./config.server";
import { meta } from "./store.server";

export type Note = {
  readonly title: string;
  readonly body: string;
  readonly url: string;
};

const appName = tag<string>({ label: "notify.app", default: "Mail" });

const opener = tag<readonly string[]>({ label: "notify.open", default: ["gtk-launch", "Mail"] });

export type Send = (
  note: Note,
  how: { readonly app: string; readonly open: readonly string[] },
) => Promise<void>;

const sender = tag<Send>({
  label: "notify.send",
  default: async (note, how) => {
    const shown = Bun.spawn(
      ["notify-send", "-a", how.app, "-i", "mail-unread", "-A", "open=Open", note.title, note.body],
      { stdout: "pipe", stderr: "ignore" },
    );
    void new Response(shown.stdout).text().then((picked) => {
      if (picked.trim() === "open") {
        Bun.spawn([...how.open], { stdout: "ignore", stderr: "ignore" });
      }
    });
  },
});

const shown = tag<number>({ label: "notify.shown", default: 3 });

const enabled = tag<boolean>({ label: "notify.enabled", default: true });

export const notifier = capsule({
  label: "notifier",
  config: {
    send: sender,
    app: appName,
    open: opener,
    enabled,
  },
  hooks: {
    async start({ config, next }) {
      await next();
      return {
        send: (note: Note) =>
          config.enabled
            ? config.send(note, { app: config.app, open: config.open })
            : Promise.resolve(),
      };
    },
  },
});

export const announce = operation({
  label: "notify.announce",
  input: z.object({ account: z.string(), email: z.string(), rows: z.array(meta) }),
  depends: { notifier, origin, shown },
  run: async ({ notifier, origin, shown }, { input }) => {
    const [first] = input.rows;
    if (!first) return "none" as const;

    const url = `${origin}/box/${input.account}`;
    if (input.rows.length === 1) {
      await notifier.send({ title: first.fromName || first.fromAddr, body: first.subject, url });
      return "one" as const;
    }

    const lines = input.rows
      .slice(0, shown)
      .map((m) => `${m.fromName || m.fromAddr}: ${m.subject}`);
    const more = input.rows.length > shown ? `\n+${input.rows.length - shown} more` : "";
    await notifier.send({
      title: `${input.rows.length} new in ${input.email}`,
      body: lines.join("\n") + more,
      url,
    });
    return "many" as const;
  },
});
