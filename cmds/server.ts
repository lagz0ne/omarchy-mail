import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { serve, ws } from "@tinkered/bun";
import { createScope } from "@tinkered/core";
import { z } from "zod";

import { defineMain } from "~/base/main";
import { observeServerPanics } from "~/base/panics.server";
import { health } from "~/components/health";
import { routes } from "~/components/requests/index.server";
import { telemetry } from "~/components/telemetry/index.server";

import { mail } from "@/mail";
import { keyring, netFetch } from "@/mail/host.server";
import { mailServer } from "@/mail/index.server";
import { mailLoads, mailOps } from "@/mail/ops.server";
import { mailRoutes } from "@/mail/routes.server";
import { theme } from "@/theme";
import { themeServer } from "@/theme/theme.server";

import { pages } from "./pages";

/**
 * The mail's own env, read once: the port (6245 is MAIL on a phone keypad), where the data and
 * the theme live (XDG), the OAuth apps, and the sync period. An empty value counts as unset.
 */
const set = z
  .string()
  .optional()
  .transform((v) => v || undefined);

const mailEnv = z
  .object({
    PORT: set,
    HOME: set,
    PUBLIC_ORIGIN: set,
    XDG_DATA_HOME: set,
    XDG_STATE_HOME: set,
    MAIL_HOME: set,
    THEME_FILE: set,
    GOOGLE_CLIENT_ID: set,
    GOOGLE_CLIENT_SECRET: set,
    MICROSOFT_CLIENT_ID: set,
    MAIL_SYNC_MS: set,
  })
  // The places first, then the values: each step one transform.
  .transform((e) => ({
    ...e,
    HOME: e.HOME ?? "/tmp",
    PORT: Number(e.PORT ?? "6245"),
  }))
  .transform((e) => ({
    ...e,
    XDG_DATA_HOME: e.XDG_DATA_HOME ?? join(e.HOME, ".local/share"),
    XDG_STATE_HOME: e.XDG_STATE_HOME ?? join(e.HOME, ".local/state"),
  }))
  .transform((e) => ({
    port: e.PORT,
    // The app is a page on this machine only: the host pins the socket to 127.0.0.1.
    origin: e.PUBLIC_ORIGIN ?? `http://127.0.0.1:${e.PORT}`,
    dataDir: e.MAIL_HOME ?? join(e.XDG_DATA_HOME, "omarchy-mail"),
    colors: e.THEME_FILE ?? join(e.XDG_STATE_HOME, "omarchy/current/theme/colors.toml"),
    clients: {
      google:
        e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
          ? { id: e.GOOGLE_CLIENT_ID, secret: e.GOOGLE_CLIENT_SECRET }
          : undefined,
      microsoft: e.MICROSOFT_CLIENT_ID ? { id: e.MICROSOFT_CLIENT_ID } : undefined,
    },
    syncEvery: e.MAIL_SYNC_MS === undefined ? undefined : Number(e.MAIL_SYNC_MS),
  }));

/** The host starts the server; importing this command opens nothing. */
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: mail\n");
    exit(64);
    return { closed: Promise.resolve() };
  }

  const own = mailEnv.parse(env);
  const origin = own.origin;
  mkdirSync(own.dataDir, { recursive: true });

  /** A built server sends telemetry from a worker thread; dev and tests keep it on this thread. */
  const sends = {
    service: env.OTEL_SERVICE_NAME,
    tracesUrl: env.VICTORIA_TRACES_URL === undefined ? undefined : new URL(env.VICTORIA_TRACES_URL),
    logsUrl: env.VICTORIA_LOGS_URL === undefined ? undefined : new URL(env.VICTORIA_LOGS_URL),
    console: stdout,
    level: env.LOG_LEVEL === undefined ? undefined : Number(env.LOG_LEVEL),
    history: env.SPAN_HISTORY === undefined ? undefined : Number(env.SPAN_HISTORY),
    origin,
  };
  const sink =
    env.NODE_ENV === "production"
      ? telemetry.thread({ ...sends, worker: new URL("./telemetry-worker.js", import.meta.url) })
      : telemetry.server(sends);

  const socket = ws.server({
    path: "/rpc",
    services: [mail.board, mail.api, theme.board],
    origin,
  });
  const table = routes({
    stop: signal,
    table: {
      "GET /api/health": health,
      "POST /api/telemetry": sink.route,
      ...mailRoutes,
    },
  });

  const app = createScope({
    signal,
    capsules: [
      serve({
        port: own.port,
        pages,
        paths: ["/oauth/*"],
        websocket: socket,
        handlers: [table],
        development: env.NODE_ENV !== "production",
        stdout,
      }),
      sink,
      mailServer({
        database: new Database(join(own.dataDir, "mail.db"), { create: true, strict: true }),
        http: netFetch,
        vault: keyring,
        clients: own.clients,
        origin,
        signer: crypto.randomUUID(),
        syncEvery: own.syncEvery,
      }),
      mail.board({ serve: true, load: mailLoads }),
      mail.api({ implement: mailOps }),
      themeServer({ file: own.colors }),
      theme.board({ serve: true }),
      socket,
      table,
    ],
  });

  const live = await app.ready;
  live.onClose(observeServerPanics(exit.bind(null, 1), app.closed, stderr));
  return app;
});
