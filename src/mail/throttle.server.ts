import { capsule, tag } from "@tinkered/core";

export type Rule = { readonly concurrent: number; readonly perSecond: number };

type Lane = { active: number; starts: number[]; until: number; waiting: (() => void)[] };

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
  config: { families, rules, fallback },
  hooks: {
    async start({ config, next, signal }) {
      await next();
      const lanes = new Map<string, Lane>();

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
        run: async <T>(target: string, work: () => Promise<T>) => {
          const lane = await limiter.enter(limiter.familyOf(target));
          try {
            return await work();
          } finally {
            lane.active--;
            lane.waiting.shift()?.();
          }
        },
        pause: (target: string, ms: number) => {
          const lane = limiter.laneOf(limiter.familyOf(target));
          lane.until = Math.max(lane.until, Date.now() + ms);
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
