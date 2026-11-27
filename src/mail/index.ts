import { capsule } from "@tinkered/core";

import { mailApi, mailBoard } from "./contract";

export const mail = capsule({ label: "mail", exports: { board: mailBoard, api: mailApi } });
