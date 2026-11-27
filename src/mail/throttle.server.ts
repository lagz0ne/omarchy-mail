import { capsule, tag } from "@tinkered/core";
import type { Operation } from "@tinkered/core";

export type Rule = { readonly concurrent: number; readonly perSecond: number };

type Lane = { active: number; starts: number[]; until: number; waiting: (() => void)[] };

export type Job = {
  readonly key: string;
  readonly family: string;
  readonly priority: number;
  readonly task: unknown;
};

const worker = tag<Operation.Handle<unknown, Job>>({ label: "throttle.work" });

const jobsPerFamily = tag<number>({ label: "throttle.jobsPerFamily", default: 1 });

const slow = tag<number>({ label: "throttle.slow", default: 5_000 });

const timeout = tag<number>({ label: "throttle.timeout", default: 30_000 });

const families = tag<Readonly<Record<string, string>>>({
  label: "throttle.families",
  default: {
    "gmail.googleapis.com": "google",
    "oauth2.googleapis.com": "google",
    "openidconnect.googleapis.com": "google",
    "login.microsoftonline.com": "microsoft",
    "outlook.office365.com": "microsoft",
  },
});

const rules = tag<Readonly<Record<string, Rule>>>({
  label: "throttle.rules",
  default: {
    google: { concurrent: 4, perSecond: 20 },
    microsoft: { concurrent: 2, perSecond: 5 },
  },
});

const fallback = tag<Rule>({
  label: "throttle.fallback",
  default: { concurrent: 2, perSecond: 5 },
});

export const throttle = capsule({
  label: "throttle",
  config: { families, rules, fallback, work: worker.optional, jobsPerFamily, slow, timeout },
  hooks: {
    async start({ config, next, signal, run, log, raise }) {
      await next();
      const lanes = new Map<string, Lane>();
      const pending = new Map<string, Job>();
      const running = new Map<string, Job | null>();
      const busyFamilies = new Map<string, number>();
      let order = 0;
      const seq = new Map<string, number>();

      const limiter = {
        familyOf: (target: string) => {
          const host = URL.canParse(target) ? new URL(target).host : target;
          return config.families[host] ?? host;
        },
        laneOf: (family: string) => {
          const found = lanes.get(family) ?? { active: 0, starts: [], until: 0, waiting: [] };
          lanes.set(family, found);
          return found;
        },
        waitFor: (family: string, now: number) => {
          const lane = limiter.laneOf(family);
          const rule = config.rules[family] ?? config.fallback;
          lane.starts = lane.starts.filter((at) => now - at < 1_000);
          if (now < lane.until) return lane.until - now;
          if (lane.active >= rule.concurrent) return -1;

          const first = lane.starts[0] ?? now;
          return lane.starts.length >= rule.perSecond ? first + 1_000 - now : 0;
        },
        enter: async (family: string) => {
          const lane = limiter.laneOf(family);

          for (let wait = limiter.waitFor(family, Date.now()); wait !== 0 && !signal.aborted;) {
            await new Promise<void>((done) =>
              wait < 0 ? lane.waiting.push(done) : setTimeout(done, wait),
            );
            wait = limiter.waitFor(family, Date.now());
          }
          lane.active++;
          lane.starts.push(Date.now());
          return lane;
        },
        run: async <T>(target: string, work: (signal: AbortSignal) => Promise<T>) => {
          const family = limiter.familyOf(target);
          const lane = await limiter.enter(family);
          if (signal.aborted) {
            lane.active--;
            return Promise.reject(signal.reason);
          }

          const started = Date.now();
          const limit = AbortSignal.timeout(config.timeout);
          const both = AbortSignal.any([limit, signal]);
          const cut = new Promise<never>((_, reject) =>
            both.addEventListener("abort", () => reject(both.reason), { once: true }),
          );
          cut.catch(() => undefined);

          try {
            return await Promise.race([work(both), cut]);
          } catch (error) {
            const ms = Date.now() - started;
            if (limit.aborted) log.error("provider.timeout", { family, target, ms });
            return limit.aborted ? raise("ProviderTimeout", { family, ms }) : Promise.reject(error);
          } finally {
            const ms = Date.now() - started;
            if (ms > config.slow) log.warn("provider.slow", { family, target, ms });
            lane.active--;
            lane.waiting.shift()?.();
          }
        },
        pause: (target: string, ms: number) => {
          const lane = limiter.laneOf(limiter.familyOf(target));
          lane.until = Math.max(lane.until, Date.now() + ms);
        },
        enqueue: (job: Job) => {
          if (running.has(job.key)) {
            running.set(job.key, job);
            return "again" as const;
          }
          const was = pending.get(job.key);
          pending.set(job.key, was && was.priority <= job.priority ? was : job);

          if (!seq.has(job.key)) seq.set(job.key, order++);
          limiter.pump();
          return was ? ("merged" as const) : ("queued" as const);
        },
        size: () => pending.size + running.size,
        jobs: () => ({ pending: [...pending.keys()], running: [...running.keys()] }),
        pump: () => {
          const ready = [...pending.values()].sort(
            (a, b) => a.priority - b.priority || (seq.get(a.key) ?? 0) - (seq.get(b.key) ?? 0),
          );
          for (const job of ready) {
            const lane = limiter.laneOf(job.family);
            const wait = lane.until - Date.now();
            if (wait > 0) setTimeout(limiter.pump, wait);
            const room = (busyFamilies.get(job.family) ?? 0) < config.jobsPerFamily;
            if (wait <= 0 && room && config.work.present && !signal.aborted) {
              limiter.start(job, config.work.value);
            }
          }
        },
        start: (job: Job, work: Operation.Handle<unknown, Job>) => {
          pending.delete(job.key);
          seq.delete(job.key);
          running.set(job.key, null);

          busyFamilies.set(job.family, (busyFamilies.get(job.family) ?? 0) + 1);
          const meta = { role: "worker", explain: `Runs the queued job ${job.key}` } as const;
          void run(work, { input: job, signal }, meta)
            .catch(() => undefined)
            .finally(() => {
              const again = running.get(job.key);
              running.delete(job.key);
              busyFamilies.set(job.family, (busyFamilies.get(job.family) ?? 1) - 1);
              if (again) limiter.enqueue(again);
              else limiter.pump();
            });
        },
        state: (target: string) => {
          const lane = limiter.laneOf(limiter.familyOf(target));
          return { active: lane.active, paused: Math.max(0, lane.until - Date.now()) };
        },
      };
      signal.addEventListener("abort", () => {
        for (const lane of lanes.values()) for (const done of lane.waiting.splice(0)) done();
      });
      return limiter;
    },
  },
});
