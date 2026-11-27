import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { layout, ui } from "@/ui";
import { drag } from "@/ui/drag";

test("a grip drags its pane's width, within limits, and keeps it on release", async () => {
  localStorage.removeItem("mail.layout");
  document.body.innerHTML = `<div class="app"><div data-pane="list" style="position:fixed;left:100px;top:0;width:10px;height:100px"></div></div>`;
  const app = await createScope({
    capsules: [exits({ store: localStorage }), ui({ memory: localStorage }), drag({ window })],
  }).ready;
  const at = (type: string, x: number) =>
    window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 50, bubbles: true }));

  at("pointermove", 300);
  expect(app.resolve(layout)).toEqual({ rail: 224, list: 400 });

  at("pointerdown", 105);
  expect(document.querySelector(".app")?.hasAttribute("data-dragging")).toBe(true);
  at("pointermove", 165);
  expect(app.resolve(layout).list).toBe(460);
  at("pointermove", 5_000);
  expect(app.resolve(layout).list).toBe(720);
  at("pointerup", 5_000);
  await new Promise((r) => setTimeout(r, 20));
  expect(app.resolve(layout).list).toBe(640);
  expect(localStorage.getItem("mail.layout")).toBe('{"rail":224,"list":640}');
  expect(document.querySelector(".app")?.hasAttribute("data-dragging")).toBe(false);

  at("pointerdown", 20);
  at("pointermove", 400);
  expect(app.resolve(layout).list).toBe(640);
  at("pointerup", 400);
  await app.close();
});
