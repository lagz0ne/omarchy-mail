import { operation } from "@tinkered/core";
import { z } from "zod";

import { clients, origin } from "./config.server";
import { send, sendJson } from "./net.server";
import { type Pulled, pullInput, refreshed, signedIn } from "./provider.server";
import type { Meta } from "./store.server";

// Outlook.com: OAuth (public client, PKCE, personal accounts) and Microsoft Graph.

const login = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const graph = "https://graph.microsoft.com/v1.0/me";
const scopes = "offline_access User.Read Mail.ReadWrite Mail.Send";

const fields =
  "id,conversationId,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,flag,from";

/** The first pull takes the inbox of this many days back. */
const firstDays = 60;
/** A pull reads at most this many pages, so a huge first inbox cannot hold the loop. */
const maxPages = 30;

const tokens = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

/** Microsoft only takes `localhost` for a desktop app's loopback redirect. */
const microsoftClient = operation({
  label: "microsoft.client",
  depends: { clients, origin },
  run: ({ clients, origin }, { raise }) => {
    const own = clients.microsoft;
    if (!own) return raise("NotConfigured", { provider: "microsoft" });
    const url = new URL("/oauth/callback", origin);
    url.hostname = "localhost";
    return { ...own, redirect: url.href };
  },
});

export const microsoftAuthUrl = operation({
  label: "microsoft.authUrl",
  input: z.object({ state: z.string(), challenge: z.string() }),
  depends: { microsoftClient },
  run: ({ microsoftClient }, { input }) => {
    const own = microsoftClient.run();
    const url = new URL(`${login}/authorize`);
    url.search = new URLSearchParams({
      client_id: own.id,
      redirect_uri: own.redirect,
      response_type: "code",
      response_mode: "query",
      scope: scopes,
      prompt: "select_account",
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      state: input.state,
    }).toString();
    return url.href;
  },
});

export const microsoftExchange = operation({
  label: "microsoft.exchange",
  input: z.object({ code: z.string(), verifier: z.string() }),
  depends: { microsoftClient, sendJson },
  run: async ({ microsoftClient, sendJson }, { input, clock, raise }) => {
    const own = microsoftClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          url: `${login}/token`,
          method: "POST",
          form: {
            client_id: own.id,
            scope: scopes,
            code: input.code,
            code_verifier: input.verifier,
            grant_type: "authorization_code",
            redirect_uri: own.redirect,
          },
        },
      }),
    );
    if (!got.refresh_token) return raise("NoRefreshToken", { provider: "microsoft" });

    const me = z
      .object({
        displayName: z.string().nullable(),
        mail: z.string().nullable(),
        userPrincipalName: z.string(),
      })
      .parse(await sendJson.run({ input: { url: graph, token: got.access_token } }));
    const email = me.mail ?? me.userPrincipalName;
    return signedIn.parse({
      refresh: got.refresh_token,
      access: got.access_token,
      expires: clock.currentTimeMillis() + got.expires_in * 1000,
      email,
      name: me.displayName ?? email,
    });
  },
});

export const microsoftRefresh = operation({
  label: "microsoft.refresh",
  input: z.object({ refresh: z.string() }),
  depends: { microsoftClient, sendJson },
  run: async ({ microsoftClient, sendJson }, { input, clock }) => {
    const own = microsoftClient.run();
    const got = tokens.parse(
      await sendJson.run({
        input: {
          url: `${login}/token`,
          method: "POST",
          form: {
            client_id: own.id,
            scope: scopes,
            refresh_token: input.refresh,
            grant_type: "refresh_token",
          },
        },
      }),
    );
    return refreshed.parse({
      access: got.access_token,
      expires: clock.currentTimeMillis() + got.expires_in * 1000,
      refresh: got.refresh_token,
    });
  },
});

/** A text field Graph may leave out: "" then. */
const text = z
  .string()
  .nullish()
  .transform((v) => v ?? "");

const item = z.object({
  id: z.string(),
  "@removed": z.unknown().optional(),
  conversationId: text,
  subject: text,
  bodyPreview: text,
  receivedDateTime: text,
  isRead: z.boolean().nullish(),
  hasAttachments: z.boolean().nullish(),
  flag: z.object({ flagStatus: z.string() }).nullish(),
  from: z
    .object({ emailAddress: z.object({ name: text, address: text }) })
    .nullish()
    .transform((v) => v?.emailAddress ?? { name: "", address: "" }),
});

const page = z.object({
  value: z.array(item),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

/** One Graph message as a list row. */
const microsoftRow = operation({
  label: "microsoft.row",
  input: item,
  run: (_, { input: m }): Meta => ({
    pid: m.id,
    thread: m.conversationId || m.id,
    fromName: m.from.name || m.from.address,
    fromAddr: m.from.address,
    subject: m.subject,
    snippet: m.bodyPreview,
    date: Date.parse(m.receivedDateTime) || 0,
    unread: m.isRead === false,
    starred: m.flag?.flagStatus === "flagged",
    attach: m.hasAttachments === true,
  }),
});

/** One page of a delta query: its rows, its removals, and the link to go on with. */
const microsoftPage = operation({
  label: "microsoft.page",
  input: z.object({ access: z.string(), url: z.string() }),
  depends: { send, microsoftRow },
  run: async ({ send, microsoftRow }, { input, raise }) => {
    const res = await send.run({
      input: { url: input.url, token: input.access, headers: { prefer: "odata.maxpagesize=50" } },
    });
    if (res.status === 410 || res.status === 400) return { kind: "reset" as const };
    if (!res.ok) return raise("ProviderFailed", { status: res.status, url: input.url, body: "" });

    const got = page.parse(await res.json());
    const kept = got.value.filter((m) => m["@removed"] === undefined);
    return {
      kind: "page" as const,
      rows: kept.map((m) => microsoftRow.run({ input: m })),
      removed: got.value.filter((m) => m["@removed"] !== undefined).map((m) => m.id),
      next: got["@odata.nextLink"],
      delta: got["@odata.deltaLink"],
    };
  },
});

/**
 * A delta query of the inbox: from the cursor (a delta link), or from the first window. It
 * follows the next links until the delta link, which is the next cursor. A dead link is a reset.
 */
export const microsoftPull = operation({
  label: "microsoft.pull",
  input: pullInput,
  depends: { microsoftPage },
  run: async ({ microsoftPage }, { input, clock }): Promise<Pulled> => {
    const since = new Date(clock.currentTimeMillis() - firstDays * 86_400_000).toISOString();
    const first = `${graph}/mailFolders/inbox/messages/delta?$select=${fields}&$filter=receivedDateTime ge ${since}`;
    const rows: Meta[] = [];
    const removed: string[] = [];

    const kind = input.cursor === null ? ("full" as const) : ("delta" as const);
    let url: string | undefined = input.cursor ?? first;

    for (let n = 0; url && n < maxPages; n++) {
      const got: Awaited<ReturnType<typeof microsoftPage.run>> = await microsoftPage.run({
        input: { access: input.access, url },
      });
      if (got.kind === "reset") return got;

      rows.push(...got.rows);
      removed.push(...got.removed);
      if (got.delta) return { kind, rows, removed, cursor: got.delta };
      url = got.next;
    }

    // Past the page cap: keep what came, and start from the next link next time.
    return { kind: "delta", rows, removed, cursor: url ?? first };
  },
});

export const microsoftRaw = operation({
  label: "microsoft.raw",
  input: z.object({ access: z.string(), pid: z.string() }),
  depends: { send },
  run: async ({ send }, { input, raise }) => {
    const url = `${graph}/messages/${encodeURIComponent(input.pid)}/$value`;
    const res = await send.run({ input: { url, token: input.access } });
    if (!res.ok) return raise("ProviderFailed", { status: res.status, url, body: "" });
    return new Uint8Array(await res.arrayBuffer());
  },
});

export const microsoftMark = operation({
  label: "microsoft.mark",
  input: z.object({ access: z.string(), pid: z.string(), unread: z.boolean() }),
  depends: { sendJson },
  run: async ({ sendJson }, { input }) => {
    await sendJson.run({
      input: {
        url: `${graph}/messages/${encodeURIComponent(input.pid)}`,
        method: "PATCH",
        token: input.access,
        json: { isRead: !input.unread },
      },
    });
  },
});
