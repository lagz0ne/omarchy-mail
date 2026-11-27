import { useData } from "@tinkered/react";

import { ui } from "@/ui";

import { themeBoard } from "./contract";

function Picked({ name, fallback }: { name: string; fallback: string }) {
  const sheet = useData(themeBoard.sheets.of({ name }));
  return <style>{sheet ? sheet.css : fallback}</style>;
}

export function ThemeStyle() {
  const choice = useData(ui.themeChoice);
  const desktop = useData(themeBoard.themeCss);
  if (choice === "desktop") return <style>{desktop}</style>;

  return <Picked name={choice} fallback={desktop} />;
}
