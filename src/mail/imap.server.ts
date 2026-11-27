import { capsule, tag } from "@tinkered/core";
import { ImapFlow } from "imapflow";

export type ImapLogin = {
  readonly user: string;
  readonly access: string;
  readonly signal?: AbortSignal;
};

export type ImapSession = {
  readonly usable: () => boolean;
  readonly folders: () => Promise<unknown[]>;
  readonly list: (
    box: string,
    limit: number,
  ) => Promise<{ readonly validity: string; readonly rows: unknown[] }>;
  readonly sources: (box: string, uids: readonly string[]) => Promise<unknown[]>;
  readonly flag: (box: string, uid: string, seen: boolean) => Promise<void>;
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
      folders: async () => client.list(),
      list: async (box, limit) => {
        const lock = await client.getMailboxLock(box, { readOnly: true });
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
      sources: async (box, uids) => {
        const lock = await client.getMailboxLock(box, { readOnly: true });
        try {
          const found: unknown[] = [];
          for await (const m of uids.length
            ? client.fetch(uids.join(","), { source: true }, { uid: true })
            : []) {
            found.push(m);
          }
          return found;
        } finally {
          lock.release();
        }
      },
      flag: async (box, uid, seen) => {
        const lock = await client.getMailboxLock(box);
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

          const fresh = config.open({
            user: login.user,
            access: login.access,
            host: config.host,
            port: config.port,
          });
          sessions.set(login.user, fresh);
          fresh.catch(() => sessions.delete(login.user));
          return fresh;
        },
        using: async <T>(login: ImapLogin, work: (session: ImapSession) => Promise<T>) => {
          const session = await door.session(login);
          const drop = () => {
            if (sessions.get(login.user)) sessions.delete(login.user);
            void session.close().catch(() => undefined);
          };
          login.signal?.addEventListener("abort", drop, { once: true });

          try {
            return await work(session);
          } catch (error) {
            drop();
            throw error;
          } finally {
            login.signal?.removeEventListener("abort", drop);
          }
        },
        folders: (input: ImapLogin) => door.using(input, (s) => s.folders()),
        list: (input: ImapLogin & { readonly box: string; readonly limit: number }) =>
          door.using(input, (s) => s.list(input.box, input.limit)),
        sources: (input: ImapLogin & { readonly box: string; readonly uids: readonly string[] }) =>
          door.using(input, (s) => s.sources(input.box, input.uids)),
        flag: (
          input: ImapLogin & { readonly box: string; readonly uid: string; readonly seen: boolean },
        ) => door.using(input, (s) => s.flag(input.box, input.uid, input.seen)),
      };
      return door;
    },
  },
});
