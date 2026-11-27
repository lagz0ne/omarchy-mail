import { join } from "node:path";

import { createScope } from "@tinkered/core";
import { z } from "zod";

import { defineMain } from "~/base/main";

import { launcher, openApp } from "@/app/launcher.server";

const set = z
  .string()
  .optional()
  .transform((v) => v || undefined);

const openEnv = z
  .object({ HOME: set, XDG_DATA_HOME: set, MAIL_HOME: set, PORT: set, PUBLIC_ORIGIN: set })
  .transform((e) => ({
    ...e,
    XDG_DATA_HOME: e.XDG_DATA_HOME ?? join(e.HOME ?? "/tmp", ".local/share"),
  }))
  .transform((e) => ({
    origin: e.PUBLIC_ORIGIN ?? `http://127.0.0.1:${e.PORT ?? "6245"}`,
    profileDir: join(e.MAIL_HOME ?? join(e.XDG_DATA_HOME, "omarchy-mail"), "window"),
  }));

export default defineMain(async ({ env, signal, stdout, stderr, exit }) => {
  const app = createScope({ signal, capsules: [launcher(openEnv.parse(env))] });
  const live = await app.ready;
  const done = await live.settle(openApp);

  const failure = Object(Object(done).error).kind ?? done.status;
  const line =
    done.status === "success" ? JSON.stringify(done.value) : `could not open (${failure})`;
  (done.status === "success" ? stdout : stderr).write(`mail: ${line}\n`);
  exit(done.status === "success" ? 0 : 1);
  return app;
});
