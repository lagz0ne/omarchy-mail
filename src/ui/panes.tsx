import { useData, useRun } from "@tinkered/react";

import { ui } from "@/ui";

export function PaneSizes() {
  const sizes = useData(ui.layout);
  return <style>{`.app{--rail-w:${sizes.rail}px;--list-w:${sizes.list}px}`}</style>;
}

export function Grip({ pane }: { pane: "rail" | "list" }) {
  const sizes = useData(ui.layout);
  const save = useRun(ui.saveLayout);
  const label = pane === "rail" ? "Resize the sidebar" : "Resize the message list";

  return (
    <div
      className={`grip grip-${pane}`}
      data-pane={pane}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} (double-click to reset)`}
      onDoubleClick={() => save.run({ input: { ...sizes, [pane]: pane === "rail" ? 224 : 400 } })}
    />
  );
}
