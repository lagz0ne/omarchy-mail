import { Link, Outlet } from "@tanstack/react-router";
import type { PartState } from "@tinkered/core";
import { useData, useRun } from "@tinkered/react";
import { memo } from "react";

import { type Account, mailApi, mailBoard, type Row } from "./contract";

// The mail pages: the rail of boxes, a box's list, and (in the outlet) the open message.

/** A date as mail shows it: the time today, the day this year, else the full date. */
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

/** The left rail: every box, the sync button, and the accounts page. */
export function Rail() {
  const list = useData(mailBoard.accounts.where({}));
  const sync = useRun(mailApi["mail.sync"]);
  const last = Math.max(0, ...list.map((a) => a.syncedAt));

  return (
    <nav className="rail" aria-label="Boxes">
      <small className="label">Mail</small>
      <Link
        to="/box/$box"
        params={{ box: "all" }}
        className="box"
        activeProps={{ className: "box on" }}
      >
        All inboxes
      </Link>
      {list.map((account) => (
        <BoxLink key={account.id} account={account} />
      ))}
      <div className="rail-foot">
        <button
          type="button"
          className="key"
          disabled={sync.isPending}
          onClick={() => sync.run({ input: {} })}
        >
          {sync.isPending ? "Syncing" : "Sync"}
        </button>
        <small className="label">{last ? <When at={last} /> : "Never synced"}</small>
        <Link to="/accounts" className="box" activeProps={{ className: "box on" }}>
          Accounts
        </Link>
      </div>
    </nav>
  );
}

const BoxLink = memo(function BoxLink({ account }: { account: Account }) {
  return (
    <Link
      to="/box/$box"
      params={{ box: account.id }}
      className="box"
      activeProps={{ className: "box on" }}
    >
      <span>{account.email}</span>
      <small className="label">
        {account.error ? `Error · ${account.error}` : account.provider}
      </small>
    </Link>
  );
});

/** The box's name and count, above its list. */
function BoxHead({ box, unread }: { box: string; unread: number }) {
  const accounts = useData(mailBoard.accounts.where({}));
  const own = accounts.find((a) => a.id === box);

  return (
    <header className="list-head">
      <small className="label">
        {own ? own.email : "All inboxes"} · {unread} unread
      </small>
      <h1>{own ? own.name : "Inbox"}</h1>
    </header>
  );
}

/** A line for a list that is not ready, or is empty. */
function BoxState({ state, empty }: { state: PartState | undefined; empty: boolean }) {
  switch (state?.status) {
    case undefined:
    case "pending":
      return <p className="quiet">Loading.</p>;
    case "fault":
      return <p className="quiet">Could not load: {state.fault.fault}.</p>;
    case "ready":
      return empty ? (
        <p className="quiet">
          Nothing here. <Link to="/accounts">Add an account</Link>.
        </p>
      ) : null;
  }
}

/** `/box/$box`: the box's newest messages, live; the open message beside them. */
export function Box({ box }: { box: string }) {
  const part = mailBoard.messages.where({ box }, { order: "-date", limit: 200 });
  const list = useData(part);
  const state = useData(mailBoard.status(part));

  return (
    <>
      <section className="list" aria-label="Messages">
        <BoxHead box={box} unread={list.filter((m) => m.unread).length} />
        <BoxState state={state} empty={list.length === 0} />
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
          {row.attach && <span className="clip">⌁ </span>}
          {row.subject || "(no subject)"}
        </span>
        <span className="snippet">{row.snippet}</span>
      </Link>
    </li>
  );
});

/** No message open yet. */
export function Idle() {
  return (
    <section className="reader idle" aria-label="Message">
      <small className="label">No message</small>
      <p className="quiet">Pick one from the list.</p>
    </section>
  );
}
