/**
 * Pins every `Bun.serve` of this process to 127.0.0.1. `serve` takes no hostname, and Bun's
 * default is 0.0.0.0: without this the mailbox would answer the whole network.
 */
export function pinLoopback() {
  const open = Bun.serve;
  Object.defineProperty(Bun, "serve", {
    value: (options: object) => Reflect.apply(open, Bun, [{ hostname: "127.0.0.1", ...options }]),
  });
}
