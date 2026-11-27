export function pinLoopback() {
  const open = Bun.serve;
  Object.defineProperty(Bun, "serve", {
    value: (options: object) => Reflect.apply(open, Bun, [{ hostname: "127.0.0.1", ...options }]),
  });
}
