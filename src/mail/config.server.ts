import { tag } from "@tinkered/core";

export type Clients = {
  readonly google?: { readonly id: string; readonly secret: string };
  readonly microsoft?: { readonly id: string };
};

export const clients = tag<Clients>({ label: "mail.clients" });

export const origin = tag<string>({ label: "mail.origin" });

export const signer = tag<string>({ label: "mail.signer" });

export const syncEvery = tag<number>({ label: "mail.syncEvery", default: 120_000 });
