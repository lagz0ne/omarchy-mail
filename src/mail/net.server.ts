import { operation } from "@tinkered/core";
import { z } from "zod";

import { http } from "./config.server";

// One door to the network, so a test hands a fake `http` and sees every request.

const ask = z.object({
  url: z.string(),
  method: z.enum(["GET", "POST", "PATCH"]).optional(),
  token: z.string().optional(),
  json: z.unknown().optional(),
  form: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** Sends one request and answers the Response as it came: the caller reads its status. */
export const send = operation({
  label: "net.send",
  input: ask,
  depends: { http },
  run: async ({ http }, { input, signal }) => {
    const headers = new Headers(input.headers);
    if (input.token) headers.set("authorization", `Bearer ${input.token}`);
    let body: string | undefined;
    if (input.form) body = new URLSearchParams(input.form).toString();

    if (input.form) headers.set("content-type", "application/x-www-form-urlencoded");
    if (input.json !== undefined) body = JSON.stringify(input.json);
    if (input.json !== undefined) headers.set("content-type", "application/json");
    return http(new Request(input.url, { method: input.method ?? "GET", headers, body, signal }));
  },
});

/** Sends one request and answers its JSON; a status that is not 2xx raises `ProviderFailed`. */
export const sendJson = operation({
  label: "net.json",
  input: ask,
  depends: { send },
  run: async ({ send }, { input, raise }): Promise<unknown> => {
    const res = await send.run({ input });
    if (res.ok) return res.status === 204 ? {} : res.json();
    const text = await res.text();
    return raise("ProviderFailed", {
      status: res.status,
      url: input.url,
      body: text.slice(0, 300),
    });
  },
});
