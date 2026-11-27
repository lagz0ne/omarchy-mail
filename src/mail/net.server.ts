import { capsule, operation, tag } from "@tinkered/core";
import { z } from "zod";

import { throttle } from "./throttle.server";

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
          config.fetch(signal.aborted ? new Request(request, { signal }) : request),
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
  shape: z.custom<z.ZodType>().optional(),
  cut: z.instanceof(AbortSignal).optional(),
});

const retries = tag<number>({ label: "net.retries", default: 3 });

export const backoff = tag<number>({ label: "net.backoff", default: 500 });

const busy = tag<readonly number[]>({ label: "net.busy", default: [429, 500, 502, 503, 504] });

const sample = tag<number>({ label: "net.sample", default: 300 });

export const checkShape = operation({
  label: "net.shape",
  input: z.object({ source: z.string(), value: z.unknown(), shape: z.custom<z.ZodType>() }),
  run: (_, { input, log, raise }): unknown => {
    const found = input.shape.safeParse(input.value);
    if (found.success) return input.value;

    const issues = found.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    log.warn("provider.malformed", { source: input.source, issues });
    return raise("ProviderMalformed", { source: input.source, issues });
  },
});

const requestOf = operation({
  label: "net.request",
  input: ask,
  run: (_, { input, signal }) => {
    const headers = new Headers(input.headers);
    if (input.token) headers.set("authorization", `Bearer ${input.token}`);
    if (input.form) headers.set("content-type", "application/x-www-form-urlencoded");
    if (input.json !== undefined) headers.set("content-type", "application/json");

    const body = input.form
      ? new URLSearchParams(input.form).toString()
      : input.json === undefined
        ? undefined
        : JSON.stringify(input.json);
    return new Request(input.url, {
      method: input.method ?? "GET",
      headers,
      body,
      signal: input.cut ?? signal,
    });
  },
});

const once = operation({
  label: "net.once",
  input: ask,
  depends: { net, requestOf },
  run: async ({ net, requestOf }, { input, signal, log, raise }) => {
    const host = new URL(input.url).host;
    const request = await requestOf.run({ input, signal });
    const res = await net.fetch(request).catch((error: unknown) => {
      log.warn("provider.unreachable", { host, reason: String(error) });
      return raise("ProviderUnreachable", { host, reason: String(error) });
    });

    const bytes = await res.arrayBuffer().catch((error: unknown) => {
      log.warn("provider.incomplete", { host, status: res.status, reason: String(error) });
      return raise("ProviderIncomplete", { host, status: res.status });
    });
    return new Response(bytes, { status: res.status, headers: res.headers });
  },
});

export const send = operation({
  label: "net.send",
  input: ask,
  depends: { once, throttle, retries, backoff, busy },
  run: async ({ once, throttle, retries, backoff, busy }, { input }) => {
    let res = await throttle.run(input.url, (cut) => once.run({ input: { ...input, cut } }));
    for (let n = 0; n < retries && busy.includes(res.status); n++) {
      const after = Number(res.headers.get("retry-after"));
      throttle.pause(input.url, after > 0 ? after * 1000 : backoff * 2 ** n);
      res = await throttle.run(input.url, (cut) => once.run({ input: { ...input, cut } }));
    }
    return res;
  },
});

export const sendJson = operation({
  label: "net.json",
  input: ask,
  depends: { send, checkShape, sample },
  run: async ({ send, checkShape, sample }, { input, log, raise }): Promise<unknown> => {
    const res = await send.run({ input });
    const host = new URL(input.url).host;
    const text = await res.text();
    if (!res.ok) {
      log.warn("provider.failed", { host, status: res.status, body: text.slice(0, sample) });
      return raise("ProviderFailed", {
        status: res.status,
        url: input.url,
        body: text.slice(0, sample),
      });
    }

    const value: unknown = await Promise.resolve()
      .then(() => (res.status === 204 || text === "" ? {} : JSON.parse(text)))
      .catch((error: unknown) => {
        log.warn("provider.malformed", {
          source: host,
          issues: [String(error)],
          body: text.slice(0, sample),
        });
        return raise("ProviderMalformed", { source: host, issues: [String(error)] });
      });
    if (!input.shape) return value;

    return checkShape.run({ input: { source: host, value, shape: input.shape } });
  },
});
