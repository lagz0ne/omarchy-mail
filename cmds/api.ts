import { run } from "@tinkered/bun";

import { pinLoopback } from "~/base/loopback";

import main from "./server";

pinLoopback();

await run(main);
