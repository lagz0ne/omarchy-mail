import { Link } from "@tanstack/react-router";
import { useRun } from "@tinkered/react";

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

function Message({ message, box, images }: { message: Opened; box: string; images: boolean }) {
  const mark = useRun(mailApi["mail.mark"]);
  const id = message.id;

  return (
    <section className="reader" aria-label="Message">
      <header className="reader-head">
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
            className="key"
            onClick={() => mark.run({ input: { id, unread: true } })}
          >
            Mark unread
          </button>
          {message.remote > 0 && !images && (
            <Link
              to="/box/$box/$id"
              params={{ box, id }}
              search={{ images: true }}
              className="key warm"
            >
              Load {message.remote} images
            </Link>
          )}
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
