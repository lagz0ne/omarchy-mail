import { z } from "zod";

import { meta } from "./store.server";

export const signedIn = z.object({
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
  email: z.string(),
  name: z.string(),
});

export const refreshed = z.object({
  access: z.string(),
  expires: z.number(),
  refresh: z.string().optional(),
});

export const pulled = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("full"),
    rows: z.array(meta),
    removed: z.array(z.string()),
    cursor: z.string(),
  }),
  z.object({
    kind: z.literal("delta"),
    rows: z.array(meta),
    removed: z.array(z.string()),
    cursor: z.string(),
  }),
  z.object({ kind: z.literal("reset") }),
]);

export type Pulled = z.infer<typeof pulled>;

export const pullInput = z.object({ access: z.string(), cursor: z.string().nullable() });
