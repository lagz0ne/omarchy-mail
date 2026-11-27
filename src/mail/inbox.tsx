import { Outlet } from "@tanstack/react-router";
import type { PartState } from "@tinkered/core";
import { useData, useRun } from "@tinkered/react";
import type { ReactNode } from "react";

import { ui } from "@/ui";
import { Go } from "@/ui/go";
import {
  ArchiveIcon,
  ClipIcon,
  DraftIcon,
  FlagIcon,
  GearIcon,
  InboxIcon,
  PanelIcon,
  SendIcon,
  SpamIcon,
  ChevronIcon,
  StackIcon,
  StarIcon,
  SyncIcon,
  TagIcon,
  TrashIcon,
} from "@/ui/icons";
import { Grip } from "@/ui/panes";

import { type Account, type FolderRow, mailBoard, type Row } from "./contract";

export function When({ at }: { at: number }) {
  const day = new Date(at);
  const now = new Date();
  const today = day.toDateString() === now.toDateString();

  const year = day.getFullYear() === now.getFullYear();
  const text = today
    ? day.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : day.toLocaleDateString(
        undefined,
        year ? { day: "numeric", month: "short" } : { dateStyle: "medium" },
      );
  return <time dateTime={day.toISOString()}>{text}</time>;
}

export const folderNames: Record<FolderRow["kind"], string> = {
  inbox: "Inbox",
  starred: "Starred",
  important: "Important",
  sent: "Sent",
  drafts: "Drafts",
  spam: "Spam",
  trash: "Trash",
  archive: "Archive",
  label: "",
};

const folderIcons: Record<FolderRow["kind"], () => ReactNode> = {
  inbox: InboxIcon,
  starred: StarIcon,
  important: FlagIcon,
  sent: SendIcon,
  drafts: DraftIcon,
  spam: SpamIcon,
  trash: TrashIcon,
  archive: ArchiveIcon,
  label: TagIcon,
};

export function FolderIcon({ kind }: { kind: FolderRow["kind"] }) {
  const Glyph = folderIcons[kind];
  return <Glyph />;
}

function SyncState({ open }: { open: boolean }) {
  const state = useData(mailBoard.syncing);
  const words = state.busy ? "Syncing" : state.at ? "Synced" : "Waiting to sync";

  return (
    <span className="sync" title={words} aria-live="polite">
      <SyncIcon busy={state.busy} />
      {open && (
        <small className="label">{state.busy || !state.at ? words : <When at={state.at} />}</small>
      )}
    </span>
  );
}

export function Rail() {
  const open = useData(ui.railOpen);
  const toggle = useRun(ui.toggleRail);
  const list = useData(mailBoard.accounts.where({}));
  const label = open ? "Collapse sidebar (Ctrl+\\)" : "Expand sidebar (Ctrl+\\)";

  return (
    <nav className={open ? "rail" : "rail shut"} aria-label="Boxes">
      <div className="rail-top">
        {open && <small className="label">Mail</small>}
        <button
          type="button"
          className="icon-key"
          title={label}
          aria-label={label}
          onClick={() => toggle.run()}
        >
          <PanelIcon open={open} />
        </button>
      </div>
      <Go
        to={["box", "all"]}
        className="box"
        title="All inboxes"
        data={{ "data-mailbox": "", "data-kind": "all" }}
      >
        <StackIcon />
        {open && <span>All inboxes</span>}
      </Go>
      <div className="rail-boxes">
        {list.map((account) => (
          <AccountBoxes key={account.id} account={account} open={open} />
        ))}
      </div>
      {open && <Grip pane="rail" />}
      <div className="rail-foot">
        <SyncState open={open} />
        <Go to={["accounts"]} className="box" title="Accounts">
          <GearIcon />
          {open && <span>Accounts</span>}
        </Go>
      </div>
    </nav>
  );
}

function AccountBoxes({ account, open }: { account: Account; open: boolean }) {
  const folders = useData(mailBoard.folders.where({ account: account.id }));
  const shown = folders.length
    ? folders
    : [{ account: account.id, id: "INBOX", name: "Inbox", kind: "inbox" as const }];

  if (!open) {
    return (
      <Go
        to={["box", account.id]}
        className="box avatar"
        data={{ "data-mailbox": "", "data-provider": account.provider }}
        title={account.error ? `${account.email} · ${account.error}` : account.email}
      >
        <span className={account.error ? "initial warn" : "initial"}>
          {account.email.slice(0, 1).toUpperCase()}
        </span>
      </Go>
    );
  }

  return (
    <section className="account" aria-label={account.email} data-provider={account.provider}>
      <AccountHead account={account} />
      <AccountFolders account={account} folders={shown} />
    </section>
  );
}

function AccountHead({ account }: { account: Account }) {
  const shut = useData(ui.shutAccounts).includes(account.id);
  const toggle = useRun(ui.toggleAccount);
  const what = shut ? `Show ${account.email} folders` : `Hide ${account.email} folders`;

  return (
    <>
      <button
        type="button"
        className="account-head"
        title={what}
        aria-label={what}
        aria-expanded={!shut}
        onClick={() => toggle.run({ input: { id: account.id } })}
      >
        <ChevronIcon open={!shut} />
        <small className="label">{account.email}</small>
      </button>
      {account.error && (
        <small className="label warn" title={`Last sync failed: ${account.error}`}>
          {account.error}
        </small>
      )}
    </>
  );
}

function AccountFolders({ account, folders }: { account: Account; folders: readonly FolderRow[] }) {
  const shut = useData(ui.shutAccounts).includes(account.id);
  if (shut) return null;

  return (
    <>
      {folders.map((folder) => (
        <Go
          key={folder.id}
          to={["box", folder.id === "INBOX" ? account.id : `${account.id}~${folder.id}`]}
          className="box"
          title={folderNames[folder.kind] || folder.name}
          data={{ "data-mailbox": "", "data-kind": folder.kind }}
        >
          <FolderIcon kind={folder.kind} />
          <span>{folderNames[folder.kind] || folder.name}</span>
        </Go>
      ))}
    </>
  );
}

function FolderName({ account, id, fallback }: { account: string; id: string; fallback: string }) {
  const folders = useData(mailBoard.folders.where({ account }));
  const folder = folders.find((f) => f.id === id);
  if (!folder || folder.kind === "inbox") return <>{fallback}</>;

  return <>{folderNames[folder.kind] || folder.name}</>;
}

function BoxTitle({ box, unread, count }: { box: string; unread: number; count: number }) {
  const accounts = useData(mailBoard.accounts.where({}));
  const [accountId = "", folderId = "INBOX"] = box.split("~");
  const own = accounts.find((a) => a.id === accountId);

  if (box.startsWith("search:")) {
    return (
      <>
        <small className="label">Search · {count} found</small>
        <h1>{box.slice(7)}</h1>
      </>
    );
  }
  return (
    <>
      <small className="label">
        {own ? own.email : "All inboxes"} · {unread} unread
      </small>
      <h1>
        <FolderName account={accountId} id={folderId} fallback={own ? own.name : "Inbox"} />
      </h1>
    </>
  );
}

function BoxHead({ box, unread, count }: { box: string; unread: number; count: number }) {
  return (
    <header className="list-head">
      <BoxTitle box={box} unread={unread} count={count} />
    </header>
  );
}

function Empty({ searching }: { searching: boolean }) {
  if (searching) return <p className="quiet">No mail has these words.</p>;

  return (
    <p className="quiet">
      Nothing here.{" "}
      <Go to={["accounts"]} className="inline">
        Add an account
      </Go>
      .
    </p>
  );
}

function BoxState({
  state,
  empty,
  searching,
}: {
  state: PartState | undefined;
  empty: boolean;
  searching: boolean;
}) {
  switch (state?.status) {
    case undefined:
    case "pending":
      return <p className="quiet">Loading.</p>;
    case "fault":
      return <p className="quiet">Could not load: {state.fault.fault}.</p>;
    case "ready":
      return empty ? <Empty searching={searching} /> : null;
  }
}

export function Box({ box }: { box: string }) {
  const part = mailBoard.messages.where({ box }, { order: "-date", limit: 200 });
  const list = useData(part);
  const state = useData(mailBoard.status(part));

  return (
    <>
      <section className="list" aria-label="Messages">
        <Grip pane="list" />
        <BoxHead box={box} unread={list.filter((m) => m.unread).length} count={list.length} />
        <div className="list-card">
          <BoxState state={state} empty={list.length === 0} searching={box.startsWith("search:")} />
          <ol className="rows">
            {list.map((m) => (
              <MessageRow key={m.id} row={m} />
            ))}
          </ol>
        </div>
      </section>
      <Outlet />
    </>
  );
}

function MessageRow({ row }: { row: Row }) {
  return (
    <li>
      <Go to={["box", row.box, row.id]} className={row.unread ? "row unread" : "row"}>
        <span className="from">
          {row.fromName || row.fromAddr}
          {row.starred && (
            <span className="star" title="Starred">
              <StarIcon />
            </span>
          )}
        </span>
        <small className="date">
          <When at={row.date} />
        </small>
        <span className="subject">
          {row.attach && <ClipIcon />}
          {row.subject || "(no subject)"}
        </span>
        <span className="snippet">{row.snippet}</span>
      </Go>
    </li>
  );
}

export function Idle() {
  return (
    <section className="reader idle" aria-label="Message">
      <small className="label">No message</small>
      <p className="quiet">Pick one from the list.</p>
    </section>
  );
}
