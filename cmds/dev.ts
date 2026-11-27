const apiPort = process.env.API_PORT ?? "3001";
const devPort = process.env.DEV_PORT ?? "5173";

const env = {
  ...process.env,
  PORT: apiPort,
  API_PORT: apiPort,
  DEV_PORT: devPort,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || `http://localhost:${devPort}`,
};

const server = Bun.spawn([process.execPath, "--hot", "cmds/api.ts"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

const page = Bun.spawn([process.execPath, "--bun", "vp", "dev"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

const halves = [server, page];

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    for (const half of halves) half.kill(signal);
  });
}

const code = await Promise.race([server.exited, page.exited]);
for (const half of halves) half.kill();
process.exit(code);

export {};
