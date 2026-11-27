import { capsule, tag } from "@tinkered/core";
import { ImapFlow } from "imapflow";

export type ImapLogin = { readonly user: string; readonly access: string };

export type ImapSession = {
  readonly usable: () => boolean;
  readonly list: (
    limit: number,
  ) => Promise<{ readonly validity: string; readonly rows: unknown[] }>;
  readonly sources: (
    uids: readonly string[],
  ) => Promise<{ readonly uid: string; readonly mime: Uint8Array<ArrayBuffer> }[]>;
  readonly flag: (uid: string, seen: boolean) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type OpenImap = (
  login: ImapLogin & { readonly host: string; readonly port: number },
) => Promise<ImapSession>;

const host = tag<string>({ label: "imap.host", default: "outlook.office365.com" });

const port = tag<number>({ label: "imap.port", default: 993 });

const opener = tag<OpenImap>({
  label: "imap.open",
  default: async (login) => {
    const client = new ImapFlow({
      host: login.host,
      port: login.port,
      secure: true,
      auth: { user: login.user, accessToken: login.access },
      logger: false,
    });
    await client.connect();

    return {
      usable: () => client.usable,
      list: async (limit) => {
        const lock = await client.getMailboxLock("INBOX", { readOnly: true });
        try {
          const box = client.mailbox;
          const exists = box ? box.exists : 0;
          const rows: unknown[] = [];
          const query = { uid: true, envelope: true, flags: true, bodyStructure: true };

          for await (const m of exists > 0
            ? client.fetch(`${Math.max(1, exists - limit + 1)}:*`, query)
            : []) {
            rows.push(m);
          }
          return { validity: box ? String(box.uidValidity) : "", rows };
        } finally {
          lock.release();
        }
      },
      sources: async (uids) => {
        const lock = await client.getMailboxLock("INBOX", { readOnly: true });
        try {
          const found = [];
          for await (const m of uids.length
            ? client.fetch(uids.join(","), { source: true }, { uid: true })
            : []) {
            if (m.source) found.push({ uid: String(m.uid), mime: new Uint8Array(m.source) });
          }
          return found;
        } finally {
          lock.release();
        }
      },
      flag: async (uid, seen) => {
        const lock = await client.getMailboxLock("INBOX");
        try {
          if (seen) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          else await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
        } finally {
          lock.release();
        }
      },
      close: async () => {
        await client.logout().catch(() => client.close());
      },
    };
  },
});

export const outlookImap = capsule({
  label: "imap",
  config: { host, port, open: opener },
  hooks: {
    async start({ config, next, signal }) {
      await next();
      const sessions = new Map<string, Promise<ImapSession>>();
      signal.addEventListener("abort", () => {
        for (const session of sessions.values()) {
          void session.then(
            (s) => s.close(),
            () => undefined,
          );
        }
        sessions.clear();
      });

      const door = {
        session: async (login: ImapLogin) => {
          const kept = sessions.get(login.user);
          const live = kept ? await kept.catch(() => undefined) : undefined;
          if (live?.usable()) return live;

          const fresh = config.open({ ...login, host: config.host, port: config.port });
          sessions.set(login.user, fresh);
          fresh.catch(() => sessions.delete(login.user));
          return fresh;
        },
        using: async <T>(login: ImapLogin, work: (session: ImapSession) => Promise<T>) => {
          const session = await door.session(login);
          try {
            return await work(session);
          } catch (error) {
            sessions.delete(login.user);
            await session.close().catch(() => undefined);
            throw error;
          }
        },
        list: (input: ImapLogin & { readonly limit: number }) =>
          door.using(input, (s) => s.list(input.limit)),
        sources: (input: ImapLogin & { readonly uids: readonly string[] }) =>
          door.using(input, (s) => s.sources(input.uids)),
        source: async (input: ImapLogin & { readonly uid: string }) => {
          const [found] = await door.using(input, (s) => s.sources([input.uid]));
          return found ? found.mime : null;
        },
        flag: (input: ImapLogin & { readonly uid: string; readonly seen: boolean }) =>
          door.using(input, (s) => s.flag(input.uid, input.seen)),
      };
      return door;
    },
  },
});
