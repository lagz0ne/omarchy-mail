import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { railOpen, ui } from "@/ui";
import { keys } from "@/ui/keys";

const page = () => {
  document.body.innerHTML = `
    <nav class="rail"><a data-mailbox href="#a">all</a><a data-mailbox href="#b">sent</a></nav>
    <form class="search"><input /></form>
    <ol class="rows"><li><a href="#1">1</a></li><li><a href="#2">2</a></li><li><a href="#3">3</a></li></ol>
    <header class="reader-head">
      <a class="back" href="#back">back</a>
      <button aria-label="Mark unread">u</button>
      <a class="icon-key warm" href="#img">img</a>
    </header>`;
  const clicked: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("a, button")) {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      clicked.push(el.textContent ?? "");
      if (el.closest(".rows")) {
        for (const row of document.querySelectorAll(".rows a")) row.classList.remove("on");
        el.classList.add("on");
      }
    });
  }
  return clicked;
};

const press = (key: string, more: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...more }));

test("mailboxes by Ctrl+N, mail by vim keys, actions, search, and the sidebar", async () => {
  const clicked = page();
  const app = await createScope({
    capsules: [exits({ store: localStorage }), ui(), keys({ window, twiceWithin: 300 })],
  }).ready;

  press("2", { ctrlKey: true });
  press("1", { altKey: true });
  press("9", { ctrlKey: true });
  expect(clicked).toEqual(["sent", "all"]);

  clicked.length = 0;
  press("j");
  press("j");
  press("k");
  press("G");
  press("j");
  press("g");
  press("g");
  expect(clicked).toEqual(["1", "2", "1", "3", "3", "1"]);

  clicked.length = 0;
  press("u");
  press("i");
  press("Escape");
  press("x");
  expect(clicked).toEqual(["u", "img", "back"]);

  press("/");
  expect(document.activeElement).toBe(document.querySelector(".search input"));
  clicked.length = 0;
  press("j");
  expect(clicked).toEqual([]);
  document.querySelector<HTMLInputElement>(".search input")?.blur();

  expect(app.resolve(railOpen)).toBe(true);
  press("\\", { ctrlKey: true });
  await new Promise((r) => setTimeout(r, 20));
  expect(app.resolve(railOpen)).toBe(false);

  await app.close();
  clicked.length = 0;
  press("j");
  expect(clicked).toEqual([]);
});
