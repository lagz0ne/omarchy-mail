import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function Go({
  to,
  className,
  title,
  exact,
  search,
  data,
  children,
}: {
  to: readonly string[];
  className: string;
  title?: string;
  exact?: boolean;
  search?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
  children: ReactNode;
}) {
  const router = useRouter();
  const here = useRouterState({
    select: (state) => state.location.pathname.split("/").filter(Boolean).map(decodeURIComponent),
  });
  const deep = here.length >= to.length && to.every((part, i) => here[i] === part);
  const on = exact ? deep && here.length === to.length : deep;
  const path = `/${to.map(encodeURIComponent).join("/")}${search ?? ""}`;

  return (
    <button
      type="button"
      className={on ? `${className} on` : className}
      aria-current={on ? "page" : undefined}
      title={title}
      onClick={() => router.history.push(path)}
      {...data}
    >
      {children}
    </button>
  );
}
