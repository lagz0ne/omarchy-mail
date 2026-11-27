import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { throttle } from "@/mail/throttle.server";

const boot = async () =>
  createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      throttle({
        rules: {
          google: { concurrent: 2, perSecond: 3 },
          microsoft: { concurrent: 1, perSecond: 50 },
        },
        fallback: { concurrent: 1, perSecond: 50 },
      }),
    ],
  }).ready;

const hold = () => {
  const gate = Promise.withResolvers<void>();
  return { open: () => gate.resolve(), wait: () => gate.promise };
};

test("one family shares one budget: at most N at once, across its hosts", async () => {
  const app = await boot();
  const limiter = app.resolve(throttle);
  const gates = [hold(), hold(), hold()];
  let running = 0;
  let most = 0;
  const work = (i: number) => async () => {
    running++;
    most = Math.max(most, running);
    await gates[i]?.wait();
    running--;
    return i;
  };

  const all = Promise.all([
    limiter.run("https://gmail.googleapis.com/a", work(0)),
    limiter.run("https://oauth2.googleapis.com/token", work(1)),
    limiter.run("https://gmail.googleapis.com/b", work(2)),
  ]);
  await new Promise((r) => setTimeout(r, 20));
  expect(running).toBe(2);
  expect(limiter.state("https://gmail.googleapis.com/x").active).toBe(2);
  for (const gate of gates) gate.open();
  expect(await all).toEqual([0, 1, 2]);
  expect(most).toBe(2);
  await app.close();
});

test("families are apart; an unknown host is its own family", async () => {
  const app = await boot();
  const limiter = app.resolve(throttle);
  const gate = hold();
  const slow = limiter.run("https://gmail.googleapis.com/a", gate.wait);

  expect(await limiter.run("microsoft", async () => "outlook")).toBe("outlook");
  expect(await limiter.run("https://img.example/a.png", async () => "image")).toBe("image");
  gate.open();
  await slow;
  await app.close();
});

test("per second: the fourth start in a second waits for the window", async () => {
  const app = await boot();
  const limiter = app.resolve(throttle);
  const t0 = Date.now();
  const starts: number[] = [];

  await Promise.all(
    [0, 1, 2, 3].map(() =>
      limiter.run("https://gmail.googleapis.com/", async () => void starts.push(Date.now() - t0)),
    ),
  );
  expect(starts.filter((at) => at < 500)).toHaveLength(3);
  expect(starts.at(-1)).toBeGreaterThanOrEqual(900);
  await app.close();
});

test("a pause holds the whole family; a close lets every waiter go", async () => {
  const app = await boot();
  const limiter = app.resolve(throttle);
  limiter.pause("https://gmail.googleapis.com/x", 150);
  expect(limiter.state("https://oauth2.googleapis.com/").paused).toBeGreaterThan(100);

  const t0 = Date.now();
  await limiter.run("https://oauth2.googleapis.com/token", async () => undefined);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

  const gate = hold();
  const first = limiter.run("microsoft", gate.wait);
  let second = false;
  const queued = limiter.run("microsoft", async () => void (second = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(second).toBe(false);
  await app.close();
  await queued;
  expect(second).toBe(true);
  gate.open();
  await first;
});
