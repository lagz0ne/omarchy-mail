import { resource, tag } from "@tinkered/core";

import type { Http, Vault } from "./config.server";

// The real doors out, as resources the cmd puts in `mailServer`'s slots. A test puts fakes.

/** The keyring service name the refresh tokens sit under. */
const service = tag<string>({ label: "mail.keyring.service", default: "omarchy-mail" });

/** The desktop keyring (Secret Service / gnome-keyring), through `Bun.secrets`. */
export const keyring = resource({
  label: "mail.keyring",
  depends: { service },
  factory: ({ service }): Vault => ({
    get: (name) => Bun.secrets.get({ service, name }),
    set: (name, value) => Bun.secrets.set({ service, name, value }),
    delete: (name) => Bun.secrets.delete({ service, name }),
  }),
});

/** The network. */
export const netFetch = resource({
  label: "mail.fetch",
  factory: (): Http => (request) => fetch(request),
});
