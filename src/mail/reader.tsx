import { Link, useRouter } from "@tanstack/react-router";
import { useRun } from "@tinkered/react";

import { BackIcon, ClipIcon, ImageIcon, ShieldIcon, UnreadIcon } from "@/ui/icons";

import { type Address, mailApi, type Opened } from "./contract";
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
        <Link
          to="/box/$box/$id"
          params={{ box, id }}
          search={{ images: true }}
          className="icon-key warm"
          title={`Load ${message.remote} remote images once (i)`}
          aria-label={`Load ${message.remote} remote images once`}
        >
          <ImageIcon />
          <small>{message.remote}</small>
        </Link>
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

function Message({ message, box, images }: { message: Opened; box: string; images: boolean }) {
  const mark = useRun(mailApi["mail.mark"]);
  const id = message.id;

  return (
    <section className="reader" aria-label="Message">
      <header className="reader-head">
        <Link
          to="/box/$box"
          params={{ box }}
          className="back icon-key"
          title="Back (Esc)"
          aria-label="Back to the list"
        >
          <BackIcon />
        </Link>
        <small className="label">
          <span title={message.from.address}>{message.from.name || message.from.address}</span> ·{" "}
          <When at={message.date} />
        </small>
        <h2>{message.subject || "(no subject)"}</h2>
        <p className="meta">
          <span className="label">To</span> <People list={message.to} />
          {message.cc.length > 0 && (
            <>
              {"  "}
              <span className="label">Cc</span> <People list={message.cc} />
            </>
          )}
        </p>
        <div className="actions">
          <button
            type="button"
            className="icon-key"
            title="Mark unread"
            aria-label="Mark unread"
            onClick={() => mark.run({ input: { id, unread: true } })}
          >
            <UnreadIcon />
          </button>
          <ImageActions message={message} box={box} images={images} />
        </div>
        {message.attachments.length > 0 && (
          <ul className="files">
            {message.attachments.map((a) => (
              <li key={a.part}>
                <a
                  rel="external"
                  href={`/api/att/${encodeURIComponent(id)}/${a.part}`}
                  target="_blank"
                >
                  <ClipIcon />
                  {a.name}{" "}
                  <small className="label">
                    <Size bytes={a.size} />
                  </small>
                </a>
              </li>
            ))}
          </ul>
        )}
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
