import { useData } from "@tinkered/react";

import { themeBoard } from "./contract";

export function ThemeStyle() {
  const css = useData(themeBoard.themeCss);
  return <style>{css}</style>;
}
