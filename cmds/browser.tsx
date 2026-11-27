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
import { toggleRail, ui } from "@/ui";

const stop = new AbortController();

const app = createScope({
  signal: stop.signal,
  capsules: [
    telemetry.browser({ service: "mail-browser", console }),
    ws.client({ url: `${location.origin.replace(/^http/, "ws")}/rpc` }),
    mail.board({ read: ws.client, refetchInterval: { messages: 60_000 } }),
    mail.api({ remote: ws.client }),
    theme.board({ read: ws.client }),
    ui({ memory: localStorage }),
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

window.addEventListener("keydown", (event) => {
  const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
  if (!digit || !(event.ctrlKey || event.altKey)) return;

  const row = document.querySelectorAll<HTMLAnchorElement>(".rows a")[digit - 1];
  event.preventDefault();
  row?.click();
  row?.focus();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.target instanceof HTMLInputElement) return;

  event.preventDefault();
  document.querySelector<HTMLInputElement>(".search input")?.focus();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "\\" || !event.ctrlKey) return;

  event.preventDefault();
  void live.run(toggleRail);
});

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
