import type { Database } from "bun:sqlite";

import { tag } from "@tinkered/core";
import type { Resource } from "@tinkered/core";

// The server half's config: each key is a tag the cmd fills through `mailServer(...)`. The cmd is
// the seam: it opens the file, the keyring and the network, and the ops only see these values.

/** The SQLite file the mail lives in. */
export const database = tag<Database>({ label: "mail.database" });

/** The network: `fetch` in the cmd, a fake in a test. */
export type Http = (input: Request) => Promise<Response>;

/** A slot: the resource that gives `fetch` (`netFetch`), or a fake one in a test. */
export const http = tag<Resource.Handle<Http>>({ label: "mail.http" });

/** Where refresh tokens live: the desktop keyring in the cmd, a map in a test. */
export type Vault = {
  readonly get: (name: string) => Promise<string | null>;
  readonly set: (name: string, value: string) => Promise<void>;
  readonly delete: (name: string) => Promise<boolean>;
};

/** A slot: the resource that gives the vault (`keyring`), or a map in a test. */
export const vault = tag<Resource.Handle<Vault>>({ label: "mail.vault" });

/** The OAuth apps: each is optional, and a missing one only hides its provider. */
export type Clients = {
  readonly google?: { readonly id: string; readonly secret: string };
  readonly microsoft?: { readonly id: string };
};

export const clients = tag<Clients>({ label: "mail.clients" });

/** The origin the app is served at, as `http://127.0.0.1:6245`: redirects and the frame's CSP. */
export const origin = tag<string>({ label: "mail.origin" });

/** The key that signs image proxy links, so only links the server wrote are fetched. */
export const signer = tag<string>({ label: "mail.signer" });

/** The time between syncs, in ms; 0 turns the loop off (tests). */
export const syncEvery = tag<number>({ label: "mail.syncEvery", default: 120_000 });
