import { data, operation } from "@tinkered/core";
import { z } from "zod";

import { vault } from "./config.server";
import { provider } from "./contract";
import { googleAuthUrl, googleExchange, googleRefresh } from "./google.server";
import { microsoftAuthUrl, microsoftExchange, microsoftRefresh } from "./microsoft.server";

// Sign-in and tokens. Refresh tokens live in the vault (the keyring); access tokens live in a
// server cell only, and a sign-in on its way lives in another, keyed by its `state`.

const pending = data({
  label: "auth.pending",
  mode: "keyed",
  parse: z.object({ state: z.string(), provider, verifier: z.string(), at: z.number() }),
  key: (p) => ({ state: p.state }),
});

const access = data({
  label: "auth.access",
  mode: "keyed",
  parse: z.object({ account: z.string(), token: z.string(), expires: z.number() }),
  key: (a) => ({ account: a.account }),
});

/** A sign-in is good for this long after it starts. */
const pendingFor = 10 * 60_000;

/** base64url of SHA-256: the PKCE challenge of a verifier. */
const challengeOf = operation({
  label: "auth.challenge",
  input: z.string(),
  run: (_, { input }) => new Bun.CryptoHasher("sha256").update(input).digest("base64url"),
});

/** Starts a sign-in: the provider's page to send the person to. */
export const beginSignIn = operation({
  label: "auth.begin",
  input: z.object({ provider }),
  depends: {
    list: pending.atScope.controller,
    challengeOf,
    googleAuthUrl,
    microsoftAuthUrl,
  },
  run: ({ list, challengeOf, googleAuthUrl, microsoftAuthUrl }, { input, random, clock }) => {
    const state = random.uuid();
    const verifier = `${random.uuid()}-${random.uuid()}`;
    const challenge = challengeOf.run({ input: verifier });

    const url =
      input.provider === "google"
        ? googleAuthUrl.run({ input: { state, challenge } })
        : microsoftAuthUrl.run({ input: { state, challenge } });
    list.set({ state, provider: input.provider, verifier, at: clock.currentTimeMillis() });
    return url;
  },
});

/** The provider sent the person back: trade the code for tokens, keep the refresh token. */
export const finishSignIn = operation({
  label: "auth.finish",
  input: z.object({ state: z.string(), code: z.string() }),
  depends: {
    list: pending.atScope.controller,
    tokens: access.atScope.controller,
    vault,
    googleExchange,
    microsoftExchange,
  },
  run: async (deps, { input, clock }) => {
    const found = deps.list.of({ state: input.state }).get();
    if (!found) return { kind: "unknown" as const };
    deps.list.delete({ state: input.state });
    if (clock.currentTimeMillis() - found.at > pendingFor) return { kind: "unknown" as const };
    const call = { input: { code: input.code, verifier: found.verifier } };

    const got =
      found.provider === "google"
        ? await deps.googleExchange.run(call)
        : await deps.microsoftExchange.run(call);
    const id = `${found.provider === "google" ? "g" : "m"}-${new Bun.CryptoHasher("sha256")
      .update(got.email.toLowerCase())
      .digest("hex")
      .slice(0, 10)}`;
    await deps.vault.set(`refresh:${id}`, got.refresh);
    deps.tokens.set({ account: id, token: got.access, expires: got.expires });
    return {
      kind: "signed" as const,
      id,
      provider: found.provider,
      email: got.email,
      name: got.name,
    };
  },
});

/** A refresh by the account's provider. */
const refreshBy = operation({
  label: "auth.refreshBy",
  input: z.object({ provider, refresh: z.string() }),
  depends: { googleRefresh, microsoftRefresh },
  run: async ({ googleRefresh, microsoftRefresh }, { input }) => {
    const call = { input: { refresh: input.refresh } };
    return input.provider === "google" ? googleRefresh.run(call) : microsoftRefresh.run(call);
  },
});

/** A live access token for an account: the kept one, or a fresh one by its refresh token. */
export const accessToken = operation({
  label: "auth.token",
  input: z.object({ account: z.string(), provider }),
  depends: { tokens: access.atScope.controller, vault, refreshBy },
  run: async ({ tokens, vault, refreshBy }, { input, clock, raise }) => {
    const kept = tokens.of({ account: input.account }).get();
    if (kept && kept.expires - 60_000 > clock.currentTimeMillis()) return kept.token;
    const refresh = await vault.get(`refresh:${input.account}`);
    if (!refresh) return raise("SignedOut", { account: input.account });

    const got = await refreshBy.run({ input: { provider: input.provider, refresh } });
    if (got.refresh) await vault.set(`refresh:${input.account}`, got.refresh);
    tokens.set({ account: input.account, token: got.access, expires: got.expires });
    return got.access;
  },
});

/** Forgets an account's tokens. */
export const forgetTokens = operation({
  label: "auth.forget",
  input: z.object({ account: z.string() }),
  depends: { tokens: access.atScope.controller, vault },
  run: async ({ tokens, vault }, { input }) => {
    tokens.delete({ account: input.account });
    await vault.delete(`refresh:${input.account}`);
  },
});
