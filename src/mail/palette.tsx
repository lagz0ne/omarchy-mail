import { useRouter } from "@tanstack/react-router";
import { useController, useData, useRun } from "@tinkered/react";
import type { ReactNode } from "react";

import { themeApi, themeBoard } from "@/theme/contract";
import { paletteAt, paletteQuery, ui } from "@/ui";
import { GearIcon, PanelIcon, SearchIcon, StackIcon, SwatchIcon } from "@/ui/icons";

import { mailBoard } from "./contract";
import { FolderIcon, folderNames } from "./inbox";

type Act =
  | { readonly kind: "go"; readonly to: readonly string[] }
  | { readonly kind: "rail" }
  | { readonly kind: "theme"; readonly name: string };

type Item = {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly act: Act;
};

function Pick({ item, on }: { item: Item; on: boolean }) {
  const router = useRouter();
  const close = useRun(ui.openPalette);
  const rail = useRun(ui.toggleRail);
  const theme = useRun(themeApi["theme.choose"]);

  return (
    <li>
      <button
        type="button"
        className={on ? "pick on" : "pick"}
        onClick={() => {
          const act = item.act;
          if (act.kind === "go") {
            router.history.push(`/${act.to.map(encodeURIComponent).join("/")}`);
          }
          if (act.kind === "rail") rail.run();
          if (act.kind === "theme") theme.run({ input: { name: act.name } });
          close.run({ input: { open: false } });
        }}
      >
        {item.icon}
        <span>{item.label}</span>
      </button>
    </li>
  );
}

function Picks({ query }: { query: string }) {
  const accounts = useData(mailBoard.accounts.where({}));
  const folders = useData(mailBoard.folders.where({}));
  const themes = useData(themeBoard.themes.where({}));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const search: Item[] = query.trim()
    ? [
        {
          id: "search",
          label: `Search mail for “${query.trim()}”`,
          icon: <SearchIcon />,
          act: { kind: "go", to: ["box", `search:${query.trim()}`] },
        },
      ]
    : [];
  const boxes: Item[] = folders.map((f) => ({
    id: `box:${f.account}:${f.id}`,
    label: `${folderNames[f.kind] || f.name} · ${accounts.find((a) => a.id === f.account)?.email ?? ""}`,
    icon: <FolderIcon kind={f.kind} />,
    act: { kind: "go", to: ["box", f.id === "INBOX" ? f.account : `${f.account}~${f.id}`] },
  }));
  const rest: Item[] = [
    {
      id: "all",
      label: "All inboxes",
      icon: <StackIcon />,
      act: { kind: "go", to: ["box", "all"] },
    },
    ...boxes,
    {
      id: "accounts",
      label: "Accounts",
      icon: <GearIcon />,
      act: { kind: "go", to: ["accounts"] },
    },
    { id: "rail", label: "Fold the sidebar", icon: <PanelIcon open />, act: { kind: "rail" } },
    ...themes.map((t) => ({
      id: `theme:${t.name}`,
      label: `Theme: ${t.title}`,
      icon: <SwatchIcon />,
      act: { kind: "theme" as const, name: t.name },
    })),
  ];
  const fits = rest.filter((item) => words.every((w) => item.label.toLowerCase().includes(w)));
  const items = [...search, ...fits].slice(0, 12);
  const at = useData(paletteAt);
  const chosen = Math.min(at, Math.max(0, items.length - 1));

  return (
    <ul className="picks" role="listbox" data-count={items.length}>
      {items.map((item, i) => (
        <Pick key={item.id} item={item} on={i === chosen} />
      ))}
      {items.length === 0 && <li className="quiet flat">Nothing matches.</li>}
    </ul>
  );
}

export function Palette() {
  const open = useData(ui.paletteOpen);
  const query = useController(paletteQuery);
  const at = useController(paletteAt);
  const close = useRun(ui.openPalette);
  const text = useData(paletteQuery);
  if (!open) return null;

  return (
    <div className="veil" role="presentation" onClick={() => close.run({ input: { open: false } })}>
      <form
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLButtonElement>(".pick.on")?.click();
        }}
      >
        <div className="palette-input">
          <SearchIcon />
          <input
            autoFocus
            value={text}
            placeholder="Go to a mailbox, search mail, switch theme…"
            aria-label="Command"
            onChange={(event) => {
              query.set(event.target.value);
              at.set(0);
            }}
            onKeyDown={(event) => {
              const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
              const step = steps[event.key];
              if (event.key === "Escape") close.run({ input: { open: false } });
              if (step === undefined) return;

              event.preventDefault();
              at.set(Math.max(0, at.get() + step));
            }}
          />
          <kbd>esc</kbd>
        </div>
        <Picks query={text} />
      </form>
    </div>
  );
}
