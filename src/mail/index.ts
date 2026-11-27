import { capsule } from "@tinkered/core";

import { mailApi, mailBoard } from "./contract";

/**
 * The mail feature's capsule. Others import a file of the feature by its own path (ADR 0160).
 * - `board`: the accounts and each box's newest messages, live.
 * - `api`: every change, as a call.
 */
export const mail = capsule({ label: "mail", exports: { board: mailBoard, api: mailApi } });
