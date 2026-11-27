import { operation } from "@tinkered/core";
import { z } from "zod";

import { routes } from "~/components/requests/index.server";

import { beginSignIn, finishSignIn } from "./auth.server";
import { http, origin } from "./config.server";
import { provider } from "./contract";
import { sourceOf, splitId } from "./ops.server";
import { attachmentOf, proxyLink } from "./render.server";
import { listAccounts, saveAccount } from "./store.server";
import { syncAll } from "./sync.server";

// The plain HTTP side: the sign-in redirects, attachments, and the image proxy. The page links to
// them; it never fetches them itself.

/** A short page for a sign-in that could not go on. */
const notice = operation({
  label: "route.notice",
  input: z.object({ title: z.string(), text: z.string(), status: z.number() }),
  depends: { origin },
  run: ({ origin }, { input }) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>Mail</title><body style="font:16px Nimbus Sans,sans-serif;background:#101315;color:#cacccc;padding:120px"><small style="letter-spacing:.2em;text-transform:uppercase;color:#798186">Mail</small><h1 style="font-size:48px;margin:.2em 0">${Bun.escapeHTML(input.title)}</h1><p>${Bun.escapeHTML(input.text)}</p><p><a style="color:#de6145" href="${origin}/">Back</a></p>`,
      { status: input.status, headers: { "content-type": "text/html; charset=utf-8" } },
    ),
});

/** `GET /oauth/start/{provider}`: off to the provider's sign-in page. */
export const oauthStart = operation({
  label: "route.oauthStart",
  input: z.object({ provider }),
  depends: { beginSignIn, notice },
  run: ({ beginSignIn, notice }, { input }) => {
    const begun = beginSignIn.settle({ input: { provider: input.provider } });
    if (begun.status === "success") return Response.redirect(begun.value, 302);
    return notice.run({
      input: {
        title: "Not set up",
        text: `No OAuth client for ${input.provider}. Set it in ~/.config/omarchy-mail/env, then restart.`,
        status: 501,
      },
    });
  },
});

/** `GET /oauth/callback`: the provider sent the person back. Reply first, then sync. */
export const oauthCallback = operation({
  label: "route.oauthCallback",
  input: z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
  }),
  depends: { finishSignIn, saveAccount, syncAll, notice, origin, reply: routes.reply },
  run: async (deps, { input }) => {
    if (!input.code || !input.state) {
      return deps.notice.run({
        input: {
          title: "Not signed in",
          text: input.error ?? "The provider sent no code.",
          status: 400,
        },
      });
    }
    const done = await deps.finishSignIn.settle({
      input: { code: input.code, state: input.state },
    });
    if (done.status !== "success" || done.value.kind === "unknown") {
      return deps.notice.run({
        input: {
          title: "Sign-in failed",
          text: "It took too long, or it failed. Try again.",
          status: 400,
        },
      });
    }
    const who = done.value;

    deps.saveAccount.run({
      input: { id: who.id, provider: who.provider, email: who.email, name: who.name },
    });
    deps.reply(Response.redirect(`${deps.origin}/box/${who.id}`, 302));
    await deps.syncAll.run();
    return undefined;
  },
});

/** The bytes of one attachment of a message the store has. */
const serveAttachment = operation({
  label: "route.serveAttachment",
  input: z.object({ id: z.string(), part: z.string() }),
  depends: { splitId, listAccounts, sourceOf, attachmentOf },
  run: async ({ splitId, listAccounts, sourceOf, attachmentOf }, { input }) => {
    const id = decodeURIComponent(input.id);
    const { account, pid } = splitId.run({ input: id });
    const owner = listAccounts.run().find((a) => a.id === account);
    if (!owner) return new Response(null, { status: 404 });

    const mime = await sourceOf.run({ input: { account, provider: owner.provider, pid } });
    const found = await attachmentOf.run({ input: { mime, part: input.part } });
    if (!found) return new Response(null, { status: 404 });
    return new Response(found.bytes, {
      headers: {
        "content-type": found.type,
        "content-disposition": `inline; filename="${encodeURIComponent(found.name)}"`,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      },
    });
  },
});

/** `GET /api/att/{id}/{part}`: an attachment by its place. */
export const attachmentRoute = operation({
  label: "route.attachment",
  input: z.object({ id: z.string(), part: z.string() }),
  depends: { serveAttachment },
  run: async ({ serveAttachment }, { input }) => serveAttachment.run({ input }),
});

/** `GET /api/att/{id}/cid/{cid}`: an inline image by its content id. */
export const cidRoute = operation({
  label: "route.cid",
  input: z.object({ id: z.string(), cid: z.string() }),
  depends: { serveAttachment },
  run: async ({ serveAttachment }, { input }) =>
    serveAttachment.run({ input: { id: input.id, part: `cid/${input.cid}` } }),
});

/** `GET /api/img?u&s`: a remote image, fetched here, for a link this server signed. */
export const imageRoute = operation({
  label: "route.image",
  input: z.object({ u: z.string().url(), s: z.string() }),
  depends: { proxyLink, http },
  run: async ({ proxyLink, http }, { input }) => {
    const signed = new URL(proxyLink.run({ input: input.u })).searchParams.get("s");
    if (signed !== input.s || !/^https?:/i.test(input.u)) {
      return new Response(null, { status: 403 });
    }
    const res = await http(
      new Request(input.u, { headers: { accept: "image/*" }, redirect: "follow" }),
    );

    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return new Response(null, { status: 404 });
    return new Response(res.body, {
      headers: { "content-type": type, "cache-control": "private, max-age=86400" },
    });
  },
});

/** The table rows this feature adds to the cmd's routes. */
export const mailRoutes = {
  "GET /oauth/start/{provider}": oauthStart,
  "GET /oauth/callback": oauthCallback,
  "GET /api/att/{id}/cid/{cid}": cidRoute,
  "GET /api/att/{id}/{part}": attachmentRoute,
  "GET /api/img": imageRoute,
} as const;
