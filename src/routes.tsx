import { createRootRouteWithContext, createRoute, Outlet, redirect } from "@tanstack/react-router";
import type { Scope } from "@tinkered/core";
import { z } from "zod";

import { mail } from "@/mail";
import { Accounts } from "@/mail/accounts";
import { Box, Idle, Rail } from "@/mail/inbox";
import { Reader } from "@/mail/reader";
import { ThemeStyle } from "@/theme/theme-style";

const root = createRootRouteWithContext<{ scope: Scope.Handle }>()({
  component: () => (
    <div className="app">
      <ThemeStyle />
      <Rail />
      <Outlet />
    </div>
  ),
});

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/box/$box", params: { box: "all" } });
  },
});

const box = createRoute({
  getParentRoute: () => root,
  path: "/box/$box",
  component: () => <Box box={box.useParams().box} />,
});

const idle = createRoute({ getParentRoute: () => box, path: "/", component: Idle });

const message = createRoute({
  getParentRoute: () => box,
  path: "$id",
  validateSearch: z.object({ images: z.boolean().optional() }),
  loaderDeps: ({ search }) => ({ images: search.images === true }),
  // The open is a call: the server fetches the source once, keeps it, and marks the mail read.
  loader: ({ context, params, deps, abortController }) =>
    context.scope.run(mail.api["mail.open"], {
      input: { id: params.id, images: deps.images },
      signal: abortController.signal,
    }),
  component: () => (
    <Reader
      out={message.useLoaderData()}
      box={message.useParams().box}
      images={message.useLoaderDeps().images}
    />
  ),
});

const accounts = createRoute({
  getParentRoute: () => root,
  path: "/accounts",
  component: Accounts,
});

export const routeTree = root.addChildren([index, box.addChildren([idle, message]), accounts]);
