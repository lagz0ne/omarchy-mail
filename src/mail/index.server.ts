import { capsule, tag } from "@tinkered/core";

import { clients, origin, signer, syncEvery } from "./config.server";
import { syncAll } from "./sync.server";

const firstSync = tag<number>({ label: "mail.firstSync", default: 1_000 });

export const mailServer = capsule({
  label: "mail.server",
  config: {
    clients: clients.required,
    origin: origin.required,
    signer: signer.required,
    syncEvery,
    firstSync,
  },
  hooks: {
    async start({ config, next, run, signal }) {
      await next();
      if (config.syncEvery <= 0) return;

      const worker = { role: "worker", explain: "Pulls every inbox on a timer" } as const;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        await run(syncAll, {}, worker).catch(() => undefined);
        if (!signal.aborted) timer = setTimeout(tick, config.syncEvery);
      };
      signal.addEventListener("abort", () => clearTimeout(timer));
      timer = setTimeout(tick, config.firstSync);
    },
  },
});
