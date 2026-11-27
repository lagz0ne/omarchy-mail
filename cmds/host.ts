import { run } from "@tinkered/bun";

import { pinLoopback } from "~/base/loopback";

import open from "./open";
import serve from "./server";

pinLoopback();

await run(process.argv[2] === "serve" ? serve : open);
