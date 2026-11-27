import { capsule } from "@tinkered/core";

import { themeBoard } from "./contract";

/** The theme feature: `board.themeCss`, the desktop's colors, live. */
export const theme = capsule({ label: "theme", exports: { board: themeBoard } });
