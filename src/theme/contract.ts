import { data, remoteData } from "@tinkered/core";

/** The Omarchy theme as CSS custom properties on `:root`; "" before the server read it. */
export const themeCss = data({ label: "theme.css", initial: "" });

/** Read: the server writes the sheet when the theme changes, and every tab redraws with it. */
export const themeBoard = remoteData({ themeCss });
