import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import type { PartState } from "@tinkered/core";
import { useData, useRun } from "@tinkered/react";
import { memo, type ReactNode } from "react";

import { ui } from "@/ui";
import {
  ArchiveIcon,
  ClipIcon,
  DraftIcon,
  FlagIcon,
  GearIcon,
  InboxIcon,
  PanelIcon,
  SearchIcon,
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

const folderNames: Record<FolderRow["kind"], string> = {
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
      <Link
        to="/box/$box"
        params={{ box: "all" }}
        className="box"
        activeProps={{ className: "box on" }}
        title="All inboxes"
        data-mailbox
      >
        <StackIcon />
        {open && <span>All inboxes</span>}
      </Link>
      <div className="rail-boxes">
        {list.map((account) => (
          <AccountBoxes key={account.id} account={account} open={open} />
        ))}
      </div>
      {open && <Grip pane="rail" />}
      <div className="rail-foot">
        <SyncState open={open} />
        <Link to="/accounts" className="box" activeProps={{ className: "box on" }} title="Accounts">
          <GearIcon />
          {open && <span>Accounts</span>}
        </Link>
      </div>
    </nav>
  );
}

const AccountBoxes = memo(function AccountBoxes({
  account,
  open,
}: {
  account: Account;
  open: boolean;
}) {
  const folders = useData(mailBoard.folders.where({ account: account.id }));
  const shown = folders.length
    ? folders
    : [{ account: account.id, id: "INBOX", name: "Inbox", kind: "inbox" as const }];

  if (!open) {
    return (
      <Link
        to="/box/$box"
        params={{ box: account.id }}
        className="box avatar"
        activeProps={{ className: "box avatar on" }}
        data-mailbox
        title={account.error ? `${account.email} · ${account.error}` : account.email}
      >
        <span className={account.error ? "initial warn" : "initial"}>
          {account.email.slice(0, 1).toUpperCase()}
        </span>
      </Link>
    );
  }

  return (
    <section className="account" aria-label={account.email}>
      <AccountHead account={account} />
      <AccountFolders account={account} folders={shown} />
    </section>
  );
});

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
        <Link
          key={folder.id}
          to="/box/$box"
          params={{ box: folder.id === "INBOX" ? account.id : `${account.id}~${folder.id}` }}
          className="box"
          activeProps={{ className: "box on" }}
          title={folderNames[folder.kind] || folder.name}
          data-mailbox
        >
          <FolderIcon kind={folder.kind} />
          <span>{folderNames[folder.kind] || folder.name}</span>
        </Link>
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
  const navigate = useNavigate();
  const query = box.startsWith("search:") ? box.slice(7) : "";

  return (
    <header className="list-head">
      <form
        role="search"
        className="search"
        onSubmit={(event) => {
          event.preventDefault();
          const q = new FormData(event.currentTarget).get("q");
          const words = typeof q === "string" ? q.trim() : "";
          void navigate({ to: "/box/$box", params: { box: words ? `search:${words}` : "all" } });
        }}
      >
        <input
          key={box}
          name="q"
          type="search"
          aria-label="Search mail"
          placeholder="Search every inbox"
          defaultValue={query}
          autoComplete="off"
        />
        <SearchIcon />
      </form>
      <BoxTitle box={box} unread={unread} count={count} />
    </header>
  );
}

function Empty({ searching }: { searching: boolean }) {
  if (searching) return <p className="quiet">No mail has these words.</p>;

  return (
    <p className="quiet">
      Nothing here. <Link to="/accounts">Add an account</Link>.
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
        <BoxState state={state} empty={list.length === 0} searching={box.startsWith("search:")} />
        <ol className="rows">
          {list.map((m) => (
            <MessageRow key={m.id} row={m} />
          ))}
        </ol>
      </section>
      <Outlet />
    </>
  );
}

const MessageRow = memo(function MessageRow({ row }: { row: Row }) {
  return (
    <li>
      <Link
        to="/box/$box/$id"
        params={{ box: row.box, id: row.id }}
        className={row.unread ? "row unread" : "row"}
        activeProps={{ className: row.unread ? "row unread on" : "row on" }}
      >
        <span className="from">{row.fromName || row.fromAddr}</span>
        <small className="date">
          <When at={row.date} />
        </small>
        <span className="subject">
          {row.attach && <ClipIcon />}
          {row.subject || "(no subject)"}
        </span>
        <span className="snippet">{row.snippet}</span>
      </Link>
    </li>
  );
});

export function Idle() {
  return (
    <section className="reader idle" aria-label="Message">
      <small className="label">No message</small>
      <p className="quiet">Pick one from the list.</p>
    </section>
  );
}
