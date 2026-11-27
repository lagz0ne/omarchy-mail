import { capsule } from "@tinkered/core";

import { themeApi, themeBoard } from "./contract";

export const theme = capsule({ label: "theme", exports: { board: themeBoard, api: themeApi } });
