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
import { outlookImap } from "@/mail/imap.server";
import { mailServer } from "@/mail/index.server";
import { keyring } from "@/mail/keyring.server";
import { net } from "@/mail/net.server";
import { notifier } from "@/mail/notify.server";
import { mailLoads, mailOps } from "@/mail/ops.server";
import { mailRoutes } from "@/mail/routes.server";
import { store } from "@/mail/store.server";
import { runJob } from "@/mail/sync.server";
import { throttle } from "@/mail/throttle.server";
import { theme } from "@/theme";
import { themeLoads, themeServer } from "@/theme/theme.server";

import { pages } from "./pages";

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
    origin: e.PUBLIC_ORIGIN ?? `http://127.0.0.1:${e.PORT}`,
    dataDir: e.MAIL_HOME ?? join(e.XDG_DATA_HOME, "omarchy-mail"),
    colors: e.THEME_FILE ?? join(e.XDG_STATE_HOME, "omarchy/current/theme/colors.toml"),
    themeDirs: [join(e.HOME, ".config/omarchy/themes"), "/usr/share/omarchy/themes"],
    looknfeel: join(e.HOME, ".config/hypr/looknfeel.lua"),
    clients: {
      google:
        e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
          ? { id: e.GOOGLE_CLIENT_ID, secret: e.GOOGLE_CLIENT_SECRET }
          : undefined,
      microsoft: e.MICROSOFT_CLIENT_ID ? { id: e.MICROSOFT_CLIENT_ID } : undefined,
    },
    syncEvery: e.MAIL_SYNC_MS === undefined ? undefined : Number(e.MAIL_SYNC_MS),
  }));

export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: mail\n");
    exit(64);
    return { closed: Promise.resolve() };
  }

  const own = mailEnv.parse(env);
  const origin = own.origin;
  mkdirSync(own.dataDir, { recursive: true });

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
        paths: ["/", "/oauth/*"],
        websocket: socket,
        handlers: [table],
        development: env.NODE_ENV !== "production",
        stdout,
      }),
      sink,
      store({ file: join(own.dataDir, "mail.db") }),
      throttle({ work: runJob }),
      net(),
      keyring(),
      outlookImap(),
      notifier(),
      mailServer({
        clients: own.clients,
        origin,
        signer: crypto.randomUUID(),
        syncEvery: own.syncEvery,
      }),
      mail.board({ serve: true, load: mailLoads }),
      mail.api({ implement: mailOps }),
      themeServer({ file: own.colors, dirs: own.themeDirs, looknfeel: own.looknfeel }),
      theme.board({ serve: true, load: themeLoads }),
      socket,
      table,
    ],
  });

  const live = await app.ready;
  live.onClose(observeServerPanics(exit.bind(null, 1), app.closed, stderr));
  return app;
});
