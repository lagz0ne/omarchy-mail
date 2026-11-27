import { run } from "@tinkered/bun";

import { pinLoopback } from "~/base/loopback";

import main from "./server";

// The app is for this machine only: every server the process opens listens on loopback.
pinLoopback();

/**
 * Built: `vp build` made the client, `bun build --compile` put it inside the one binary beside
 * the server, as bytecode. `run` owns signals and the exit code; `serve` in the root listens.
 */
await run(main);
