import { operation } from "@tinkered/core";
import { z } from "zod";

import { textOf } from "./render.server";
import { indexBody, keepRaw } from "./store.server";

export const keepSource = operation({
  label: "mail.keepSource",
  input: z.object({ account: z.string(), pid: z.string(), mime: z.instanceof(Uint8Array) }),
  depends: { keepRaw, textOf, indexBody },
  run: async ({ keepRaw, textOf, indexBody }, { input }) => {
    keepRaw.run({ input });
    const text = await textOf.run({ input: { mime: input.mime } });
    indexBody.run({ input: { account: input.account, pid: input.pid, text } });
  },
});
