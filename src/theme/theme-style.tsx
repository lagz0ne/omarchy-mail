import { useData } from "@tinkered/react";

import { themeBoard } from "./contract";

/** The desktop's colors as a sheet: a theme switch redraws the app with no reload. */
export function ThemeStyle() {
  const css = useData(themeBoard.themeCss);
  return <style>{css}</style>;
}
