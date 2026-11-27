import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ws } from "@tinkered/bun/client";
import { createScope } from "@tinkered/core";
import { ScopeProvider } from "@tinkered/react";
import { createRoot } from "react-dom/client";

import { TinkerError, TinkerNotFound } from "~/base/fallbacks";
import { abortReasons } from "~/components/errors";
import { telemetry } from "~/components/telemetry";

import { mail } from "@/mail";
import { routeTree } from "@/routes";
import { theme } from "@/theme";

/** The tab's one root. A real page hide, or a hot swap of this module, closes it. */
const stop = new AbortController();

const app = createScope({
  signal: stop.signal,
  capsules: [
    telemetry.browser({ service: "mail-browser", console }),
    ws.client({ url: `${location.origin.replace(/^http/, "ws")}/rpc` }),
    // The mail: accounts and boxes live over the socket, every change a call. A box asks again
    // each minute, so a write no one signalled still shows.
    mail.board({ read: ws.client, refetchInterval: { messages: 60_000 } }),
    mail.api({ remote: ws.client }),
    // The desktop's colors, live.
    theme.board({ read: ws.client }),
  ],
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) stop.abort(abortReasons.closed);
});

import.meta.hot?.dispose(async () => {
  stop.abort(abortReasons.closed);
  await app.closed;
});

const live = await app.ready;

const router = createRouter({
  routeTree,
  context: { scope: live },
  scrollRestoration: true,
  defaultErrorComponent: TinkerError,
  defaultNotFoundComponent: TinkerNotFound,
  Wrap: ({ children }) => <ScopeProvider scope={live}>{children}</ScopeProvider>,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("app")!).render(<RouterProvider router={router} />);
