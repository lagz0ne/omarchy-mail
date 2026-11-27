import { useData, useRun } from "@tinkered/react";
import { memo } from "react";

import { type Swatch, themeBoard } from "@/theme/contract";
import { ui } from "@/ui";
import { PlusIcon, TrashIcon } from "@/ui/icons";

import { type Account, mailApi, mailBoard } from "./contract";
import { When } from "./inbox";

export function Accounts() {
  const list = useData(mailBoard.accounts.where({}));

  return (
    <section className="page" aria-label="Accounts">
      <small className="label">Mail · {list.length} accounts</small>
      <h1>Accounts</h1>
      <ul className="accounts">
        {list.map((a) => (
          <AccountRow key={a.id} account={a} />
        ))}
      </ul>
      <div className="actions">
        <a rel="external" className="key" href="/oauth/start/google">
          <PlusIcon />
          Gmail
        </a>
        <a rel="external" className="key" href="/oauth/start/microsoft">
          <PlusIcon />
          Outlook
        </a>
      </div>
      <Appearance />
      <Trusted />
    </section>
  );
}

const AccountRow = memo(function AccountRow({ account }: { account: Account }) {
  const remove = useRun(mailApi["account.remove"]);

  return (
    <li>
      <span>
        <strong>{account.name}</strong> {account.email}
      </span>
      <small className="label">
        {account.provider} ·{" "}
        {account.error ? (
          `Error: ${account.error}`
        ) : account.syncedAt ? (
          <When at={account.syncedAt} />
        ) : (
          "Syncing"
        )}
      </small>
      <button
        type="button"
        className="icon-key"
        title={`Remove ${account.email}`}
        aria-label={`Remove ${account.email}`}
        disabled={remove.isPending}
        onClick={() => remove.run({ input: { id: account.id } })}
      >
        <TrashIcon />
      </button>
    </li>
  );
});

function Appearance() {
  const list = useData(themeBoard.themes.where({}));
  const choice = useData(ui.themeChoice);
  const choose = useRun(ui.chooseTheme);

  return (
    <section className="settings" aria-label="Appearance">
      <small className="label">Appearance · {list.length} Omarchy themes</small>
      <div className="themes">
        <button
          type="button"
          className={choice === "desktop" ? "theme on" : "theme"}
          aria-pressed={choice === "desktop"}
          onClick={() => choose.run({ input: { name: "desktop" } })}
        >
          <span className="swatch desktop" />
          <span>Follow desktop</span>
        </button>
        {list.map((t) => (
          <ThemeTile key={t.name} swatch={t} on={choice === t.name} />
        ))}
      </div>
    </section>
  );
}

const ThemeTile = memo(function ThemeTile({ swatch, on }: { swatch: Swatch; on: boolean }) {
  const choose = useRun(ui.chooseTheme);

  return (
    <button
      type="button"
      className={on ? "theme on" : "theme"}
      aria-pressed={on}
      title={`${swatch.title} (${swatch.mode})`}
      onClick={() => choose.run({ input: { name: swatch.name } })}
    >
      <svg className="swatch" viewBox="0 0 40 24" aria-hidden="true">
        <rect width="40" height="24" rx="5" fill={swatch.bg} />
        <rect x="6" y="7" width="16" height="3" rx="1.5" fill={swatch.fg} />
        <rect x="6" y="14" width="10" height="3" rx="1.5" fill={swatch.accent} />
        <circle cx="31" cy="12" r="3.5" fill={swatch.warm} />
      </svg>
      <span>{swatch.title}</span>
    </button>
  );
});

function Trusted() {
  const list = useData(mailBoard.trusted.where({}));
  const trust = useRun(mailApi["image.trust"]);

  return (
    <section className="settings" aria-label="Trusted senders">
      <small className="label">Images load by themselves from · {list.length}</small>
      {list.length === 0 && (
        <p className="quiet flat">
          None yet. Open a mail with images and press the shield to trust its sender's domain.
        </p>
      )}
      <ul className="accounts">
        {list.map((t) => (
          <li key={t.domain}>
            <span>{t.domain}</span>
            <small className="label">
              since <When at={t.at} />
            </small>
            <button
              type="button"
              className="icon-key"
              title={`Stop trusting ${t.domain}`}
              aria-label={`Stop trusting ${t.domain}`}
              onClick={() => trust.run({ input: { domain: t.domain, trust: false } })}
            >
              <TrashIcon />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
