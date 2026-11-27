import { data, operation, tag } from "@tinkered/core";
import { z } from "zod";

import { provider } from "./contract";
import { googleAuthUrl, googleExchange, googleRefresh } from "./google.server";
import { keyring } from "./keyring.server";
import { microsoftAuthUrl, microsoftExchange, microsoftRefresh } from "./microsoft.server";

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

const pendingFor = tag<number>({ label: "auth.pendingFor", default: 10 * 60_000 });

const challengeOf = operation({
  label: "auth.challenge",
  input: z.string(),
  run: (_, { input }) => new Bun.CryptoHasher("sha256").update(input).digest("base64url"),
});

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

export const finishSignIn = operation({
  label: "auth.finish",
  input: z.object({ state: z.string(), code: z.string() }),
  depends: {
    list: pending.atScope.controller,
    tokens: access.atScope.controller,
    vault: keyring,
    googleExchange,
    microsoftExchange,
    pendingFor,
  },
  run: async (deps, { input, clock }) => {
    const found = deps.list.of({ state: input.state }).get();
    if (!found) return { kind: "unknown" as const };
    deps.list.delete({ state: input.state });
    if (clock.currentTimeMillis() - found.at > deps.pendingFor) return { kind: "unknown" as const };
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

const refreshBy = operation({
  label: "auth.refreshBy",
  input: z.object({ provider, refresh: z.string() }),
  depends: { googleRefresh, microsoftRefresh },
  run: async ({ googleRefresh, microsoftRefresh }, { input }) => {
    const call = { input: { refresh: input.refresh } };
    return input.provider === "google" ? googleRefresh.run(call) : microsoftRefresh.run(call);
  },
});

export const accessToken = operation({
  label: "auth.token",
  input: z.object({ account: z.string(), provider }),
  depends: { tokens: access.atScope.controller, vault: keyring, refreshBy },
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

export const forgetTokens = operation({
  label: "auth.forget",
  input: z.object({ account: z.string() }),
  depends: { tokens: access.atScope.controller, vault: keyring },
  run: async ({ tokens, vault }, { input }) => {
    tokens.delete({ account: input.account });
    await vault.delete(`refresh:${input.account}`);
  },
});
