import { capsule } from "@tinkered/core";

import { themeBoard } from "./contract";

export const theme = capsule({ label: "theme", exports: { board: themeBoard } });
