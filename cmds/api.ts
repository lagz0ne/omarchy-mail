import { run } from "@tinkered/bun";

import { pinLoopback } from "~/base/loopback";

import main from "./server";

// The app is for this machine only: every server the process opens listens on loopback.
pinLoopback();

/**
 * Dev: the server half alone. `vp dev` serves the page and proxies /rpc and /api here.
 */
await run(main);
