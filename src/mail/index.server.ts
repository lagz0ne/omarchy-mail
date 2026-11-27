import { capsule } from "@tinkered/core";

import { clients, database, http, origin, signer, syncEvery, vault } from "./config.server";
import { initStore } from "./store.server";
import { syncAll } from "./sync.server";

const setup = { role: "setup", explain: "Makes the mail tables" } as const;
const worker = { role: "worker", explain: "Pulls every inbox on a timer" } as const;

/**
 * The mail server's config and its loop: the cmd fills the store, the network, the keyring and
 * the OAuth apps. Start makes the tables, then syncs every `syncEvery` ms (and once at once).
 */
export const mailServer = capsule({
  label: "mail.server",
  config: {
    database: database.required,
    http: http.required,
    vault: vault.required,
    clients: clients.required,
    origin: origin.required,
    signer: signer.required,
    syncEvery,
  },
  hooks: {
    async start({ config, next, run, signal }) {
      await next();
      await run(initStore, {}, setup);
      if (config.syncEvery <= 0) return;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        await run(syncAll, { signal }, worker).catch(() => undefined);
        if (!signal.aborted) timer = setTimeout(tick, config.syncEvery);
      };
      signal.addEventListener("abort", () => clearTimeout(timer));
      timer = setTimeout(tick, 1_000);
    },
  },
});
