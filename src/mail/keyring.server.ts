import { capsule, tag } from "@tinkered/core";

export type SecretStore = {
  readonly get: (key: { service: string; name: string }) => Promise<string | null>;
  readonly set: (key: { service: string; name: string; value: string }) => Promise<void>;
  readonly delete: (key: { service: string; name: string }) => Promise<boolean>;
};

const service = tag<string>({ label: "keyring.service", default: "omarchy-mail" });

const store = tag<SecretStore>({ label: "keyring.store", default: Bun.secrets });

export const keyring = capsule({
  label: "keyring",
  config: { service, store },
  hooks: {
    async start({ config, next }) {
      await next();
      const { service, store } = config;
      return {
        get: (name: string) => store.get({ service, name }),
        set: (name: string, value: string) => store.set({ service, name, value }),
        delete: (name: string) => store.delete({ service, name }),
      };
    },
  },
});
