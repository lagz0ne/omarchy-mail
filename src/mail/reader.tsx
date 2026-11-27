import { useNavigate, useRouter } from "@tanstack/react-router";
import { useData, useRun } from "@tinkered/react";
import type { ReactNode } from "react";

import { ui } from "@/ui";
import { Go } from "@/ui/go";
import {
  ArchiveIcon,
  BackIcon,
  ClipIcon,
  ImageIcon,
  ShieldIcon,
  SpamIcon,
  StarIcon,
  TrashIcon,
  UnreadIcon,
} from "@/ui/icons";

import {
  type ActAnswer,
  type Address,
  type MailAction,
  mailApi,
  mailBoard,
  type Opened,
} from "./contract";
import { When } from "./inbox";

type OpenAnswer = Opened | { kind: "gone"; id: string };

export function People({ list }: { list: Address[] }) {
  return (
    <>
      {list.map((p, i) => (
        <span key={`${p.address}${i}`} title={p.address}>
          {i > 0 && ", "}
          {p.name || p.address}
        </span>
      ))}
    </>
  );
}

export function Size({ bytes }: { bytes: number }) {
  const text =
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
  return <>{text}</>;
}

export function Reader({ out, box, images }: { out: OpenAnswer; box: string; images: boolean }) {
  switch (out.kind) {
    case "gone":
      return (
        <section className="reader idle" aria-label="Message">
          <small className="label">Gone</small>
          <p className="quiet">This message is no longer in the box.</p>
        </section>
      );
    case "message":
      return <Message message={out} box={box} images={images} />;
  }
}

function ImageActions({ message, box, images }: { message: Opened; box: string; images: boolean }) {
  if (message.remote === 0) return null;

  const id = message.id;
  return (
    <>
      {message.remote > 0 && !images && !message.trusted && (
        <Go
          to={["box", box, id]}
          search="?images=true"
          className="icon-key warm"
          title={`Load ${message.remote} remote images once (i)`}
        >
          <ImageIcon />
          <small>{message.remote}</small>
        </Go>
      )}
      {message.remote > 0 && message.domain && <Trust message={message} />}
    </>
  );
}

function Trust({ message }: { message: Opened }) {
  const trust = useRun(mailApi["image.trust"]);
  const router = useRouter();
  const what = message.trusted
    ? `Stop loading images from ${message.domain} by themselves`
    : `Always load images from ${message.domain}`;

  return (
    <button
      type="button"
      className={message.trusted ? "icon-key on" : "icon-key"}
      title={what}
      aria-label={what}
      aria-pressed={message.trusted}
      disabled={trust.isPending}
      onClick={() =>
        void trust
          .runAsync({ input: { domain: message.domain, trust: !message.trusted } })
          .then(() => router.invalidate())
      }
    >
      <ShieldIcon />
      <small>{message.domain}</small>
    </button>
  );
}

function ActButton({
  id,
  box,
  action,
  label,
  keyHint,
  on,
  children,
}: {
  id: string;
  box: string;
  action: MailAction;
  label: string;
  keyHint: string;
  on?: boolean;
  children: ReactNode;
}) {
  const act = useRun(mailApi["mail.act"]);
  const navigate = useNavigate();
  const router = useRouter();
  const stays = action === "star" || action === "unstar";

  return (
    <>
      <button
        type="button"
        className={`icon-key${on === undefined ? "" : " star"}${on ? " on" : ""}`}
        title={`${label} (${keyHint})`}
        aria-label={label}
        aria-pressed={on}
        data-act={stays ? "star" : action}
        disabled={act.isPending}
        onClick={() =>
          void act.runAsync({ input: { id, box, action } }).then((out) => {
            if (out.kind !== "done") return undefined;
            return stays ? router.invalidate() : navigate({ to: "/box/$box", params: { box } });
          })
        }
      >
        {children}
      </button>
      <Unsupported out={act.data} />
    </>
  );
}

function MoveTo({ id, box }: { id: string; box: string }) {
  const act = useRun(mailApi["mail.act"]);
  const navigate = useNavigate();
  const account = id.slice(0, id.indexOf(":"));
  const folders = useData(mailBoard.folders.where({ account }));
  const here = box.includes("~") ? box.slice(box.indexOf("~") + 1) : "INBOX";

  return (
    <select
      className="move"
      aria-label="Move to folder"
      title="Move to folder"
      value=""
      disabled={act.isPending}
      onChange={(event) => {
        const to = event.target.value;
        if (!to) return;

        void act
          .runAsync({ input: { id, box, action: "move", to } })
          .then((out) =>
            out.kind === "done" ? navigate({ to: "/box/$box", params: { box } }) : undefined,
          );
      }}
    >
      <option value="">Move…</option>
      {folders
        .filter((f) => f.id !== here)
        .map((f) => (
          <option key={f.id} value={f.id}>
            {f.kind === "label" ? f.name : f.kind[0]?.toUpperCase() + f.kind.slice(1)}
          </option>
        ))}
    </select>
  );
}

function Tools({ message, box }: { message: Opened; box: string }) {
  const mark = useRun(mailApi["mail.mark"]);
  const id = message.id;

  return (
    <div className="tools" role="toolbar" aria-label="Mail actions">
      <ActButton
        id={id}
        box={box}
        action={message.starred ? "unstar" : "star"}
        label={message.starred ? "Unstar" : "Star"}
        keyHint="s"
        on={message.starred}
      >
        <StarIcon />
      </ActButton>
      <button
        type="button"
        className="icon-key"
        title="Mark unread (u)"
        aria-label="Mark unread"
        onClick={() => mark.run({ input: { id, unread: true } })}
      >
        <UnreadIcon />
      </button>
      <span className="sep" />
      <ActButton id={id} box={box} action="archive" label="Archive" keyHint="e">
        <ArchiveIcon />
      </ActButton>
      <ActButton id={id} box={box} action="trash" label="Delete" keyHint="#">
        <TrashIcon />
      </ActButton>
      <ActButton id={id} box={box} action="spam" label="Report spam" keyHint="!">
        <SpamIcon />
      </ActButton>
      <MoveTo id={id} box={box} />
    </div>
  );
}

function Unsupported({ out }: { out: ActAnswer | undefined }) {
  switch (out?.kind) {
    case undefined:
    case "done":
      return null;
    case "unsupported":
      return <small className="label warn">No {out.action} folder here</small>;
    case "gone":
      return <small className="label warn">Gone</small>;
  }
}

function Message({ message, box, images }: { message: Opened; box: string; images: boolean }) {
  const id = message.id;
  const sender = message.from.name || message.from.address;

  return (
    <section className="reader" aria-label="Message">
      <header className="reader-head">
        <h2 title={message.subject}>
          <Go to={["box", box]} exact className="back icon-key" title="Back (Esc)">
            <BackIcon />
          </Go>
          {message.subject || "(no subject)"}
        </h2>
        <Tools message={message} box={box} />
        <div className="who">
          <span className="initial">{sender.slice(0, 1).toUpperCase()}</span>
          <b title={message.from.address}>{sender}</b>
          <span className="to">
            to <People list={message.to} />
            {message.cc.length > 0 && (
              <>
                , cc <People list={message.cc} />
              </>
            )}
          </span>
          <When at={message.date} />
        </div>
        <div className="extras">
          <ImageActions message={message} box={box} images={images} />
          {message.attachments.length > 0 && (
            <ul className="files">
              {message.attachments.map((a) => (
                <li key={a.part}>
                  <File id={id} part={a.part} name={a.name} size={a.size} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>
      <iframe
        className="body"
        title={message.subject}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={message.srcdoc}
      />
    </section>
  );
}

export function OpenFailed({ error }: { error: unknown }) {
  const fault = mailApi.fault.is(error) ? error.fault : "failed";

  return (
    <section className="reader idle" aria-label="Message">
      <small className="label warn">Could not open · {fault}</small>
      <p className="quiet flat">
        The mail could not be fetched from its provider. It will be tried again when you open it.
      </p>
    </section>
  );
}

function File({ id, part, name, size }: { id: string; part: number; name: string; size: number }) {
  const leave = useRun(ui.leave);

  return (
    <button
      type="button"
      className="file"
      title={`Open ${name}`}
      onClick={() =>
        leave.run({ input: { url: `/api/att/${encodeURIComponent(id)}/${part}`, away: true } })
      }
    >
      <ClipIcon />
      {name}
      <small className="label">
        <Size bytes={size} />
      </small>
    </button>
  );
}
