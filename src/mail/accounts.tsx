import { useData, useRun } from "@tinkered/react";
import { memo } from "react";

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
