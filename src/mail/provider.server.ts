import { z } from "zod";

import { meta } from "./store.server";

// What every provider answers, so sync reads one shape.

/** A sign-in's end: the tokens and who signed in. */
export const signedIn = z.object({
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
  email: z.string(),
  name: z.string(),
});

/** A refresh: a new access token, and a new refresh token when the provider turns them. */
export const refreshed = z.object({
  access: z.string(),
  expires: z.number(),
  refresh: z.string().optional(),
});

/**
 * One pull of an inbox. `full`: the whole inbox (no cursor yet). `delta`: what changed since the
 * cursor. `reset`: the cursor is too old; pull again without it.
 */
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

/** The input of a pull: the access token and the cursor, or null for a first pull. */
export const pullInput = z.object({ access: z.string(), cursor: z.string().nullable() });
