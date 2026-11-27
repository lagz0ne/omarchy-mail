import { capsule, operation, tag } from "@tinkered/core";
import { z } from "zod";

export type Http = (input: Request) => Promise<Response>;

const fetcher = tag<Http>({ label: "net.fetch", default: (request) => fetch(request) });

export const net = capsule({
  label: "net",
  config: { fetch: fetcher },
  hooks: {
    async start({ config, next, signal }) {
      await next();
      return {
        fetch: (request: Request) =>
          config.fetch(new Request(request, { signal: AbortSignal.any([request.signal, signal]) })),
      };
    },
  },
});

const ask = z.object({
  url: z.string(),
  method: z.enum(["GET", "POST", "PATCH"]).optional(),
  token: z.string().optional(),
  json: z.unknown().optional(),
  form: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const retries = tag<number>({ label: "net.retries", default: 3 });

export const backoff = tag<number>({ label: "net.backoff", default: 500 });

const busy = tag<readonly number[]>({ label: "net.busy", default: [429, 500, 502, 503, 504] });

const once = operation({
  label: "net.once",
  input: ask,
  depends: { net },
  run: async ({ net }, { input, signal }) => {
    const headers = new Headers(input.headers);
    if (input.token) headers.set("authorization", `Bearer ${input.token}`);
    let body: string | undefined;
    if (input.form) body = new URLSearchParams(input.form).toString();

    if (input.form) headers.set("content-type", "application/x-www-form-urlencoded");
    if (input.json !== undefined) body = JSON.stringify(input.json);
    if (input.json !== undefined) headers.set("content-type", "application/json");
    return net.fetch(
      new Request(input.url, { method: input.method ?? "GET", headers, body, signal }),
    );
  },
});

export const send = operation({
  label: "net.send",
  input: ask,
  depends: { once, retries, backoff, busy },
  run: async ({ once, retries, backoff, busy }, { input, clock, signal }) => {
    let res = await once.run({ input });
    for (let n = 0; n < retries && busy.includes(res.status); n++) {
      const after = Number(res.headers.get("retry-after"));
      await clock.sleep(after > 0 ? after * 1000 : backoff * 2 ** n, signal);
      res = await once.run({ input });
    }
    return res;
  },
});

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
