import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { openPalette, paletteOpen, railOpen, ui } from "@/ui";
import { keys } from "@/ui/keys";

const page = () => {
  document.body.innerHTML = `
    <nav class="rail"><a data-mailbox href="#a">all</a><a data-mailbox href="#b">sent</a></nav>
    <input class="field" />
    <ol class="rows"><li><button class="row">1</button></li><li><button class="row">2</button></li><li><button class="row">3</button></li></ol>
    <header class="reader-head">
      <button class="back">back</button>
      <button aria-label="Mark unread">u</button>
      <button class="icon-key warm">img</button>
      <button data-act="archive">e</button>
      <button data-act="trash">#</button>
      <button data-act="star">s</button>
      <button data-act="spam">!</button>
    </header>`;
  const clicked: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("a, button")) {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      clicked.push(el.textContent ?? "");
      if (el.closest(".rows")) {
        for (const row of document.querySelectorAll(".rows .row")) row.classList.remove("on");
        el.classList.add("on");
      }
    });
  }
  return clicked;
};

const press = (key: string, more: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...more }));

test("mailboxes by Ctrl+N, mail by vim keys, actions, the palette, and the sidebar", async () => {
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
  press("e");
  press("#");
  press("s");
  press("!");
  press("Escape");
  press("x");
  expect(clicked).toEqual(["u", "img", "e", "#", "s", "!", "back"]);

  press("/");
  await new Promise((r) => setTimeout(r, 20));
  expect(app.resolve(paletteOpen)).toBe(true);
  app.run(openPalette, { input: { open: false } });
  press("k", { ctrlKey: true });
  await new Promise((r) => setTimeout(r, 20));
  expect(app.resolve(paletteOpen)).toBe(true);

  document.querySelector<HTMLInputElement>(".field")?.focus();
  clicked.length = 0;
  press("j");
  expect(clicked).toEqual([]);
  document.querySelector<HTMLInputElement>(".field")?.blur();

  expect(app.resolve(railOpen)).toBe(true);
  press("\\", { ctrlKey: true });
  await new Promise((r) => setTimeout(r, 20));
  expect(app.resolve(railOpen)).toBe(false);

  await app.close();
  clicked.length = 0;
  press("j");
  expect(clicked).toEqual([]);
});
