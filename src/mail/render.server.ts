import { operation, tag } from "@tinkered/core";
import PostalMime from "postal-mime";
import sanitize from "sanitize-html";
import { z } from "zod";

import { origin, signer } from "./config.server";
import type { Attachment } from "./contract";

const tags = tag<string[]>({
  label: "render.tags",
  default: [
    ...sanitize.defaults.allowedTags,
    "img",
    "style",
    "font",
    "center",
    "u",
    "s",
    "small",
    "big",
    "hr",
    "colgroup",
    "col",
  ],
});

const layout = tag<string[]>({
  label: "render.layout",
  default: [
    "style",
    "class",
    "id",
    "align",
    "valign",
    "width",
    "height",
    "bgcolor",
    "background",
    "border",
    "cellpadding",
    "cellspacing",
    "color",
    "face",
    "size",
    "dir",
    "lang",
    "title",
    "colspan",
    "rowspan",
  ],
});

const base = tag<string>({
  label: "render.base",
  default: `html{background:#fff}body{margin:0;padding:28px 32px;color:#16191b;background:#fff;
font:15px/1.55 "Nimbus Sans","Helvetica Neue",Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}pre.plain{white-space:pre-wrap;font:inherit;margin:0}
blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #d9d8d2;color:#3a3d40}
a{color:#b64327}`,
});

export const proxyLink = operation({
  label: "render.proxyLink",
  input: z.string(),
  depends: { origin, signer },
  run: ({ origin, signer }, { input }) => {
    const sig = new Bun.CryptoHasher("sha256", signer).update(input).digest("hex");
    const url = new URL("/api/img", origin);
    url.search = new URLSearchParams({ u: input, s: sig }).toString();
    return url.href;
  },
});

const textPage = operation({
  label: "render.text",
  input: z.string(),
  run: (_, { input }) => {
    const escaped = Bun.escapeHTML(input).replaceAll(
      /https?:\/\/[^\s<>"']+/g,
      (url) => `<a href="${url}">${url}</a>`,
    );
    return `<pre class="plain">${escaped}</pre>`;
  },
});

const addr = z.object({ name: z.string().default(""), address: z.string().default("") });

const people = z.array(addr).catch([]);

export const renderMessage = operation({
  label: "render.message",
  input: z.object({ id: z.string(), mime: z.instanceof(Uint8Array), images: z.boolean() }),
  depends: { origin, proxyLink, textPage, tags, layout, base },
  run: async ({ origin, proxyLink, textPage, tags, layout, base }, { input }) => {
    const mail = await PostalMime.parse(input.mime);
    const at = `${origin}/api/att/${encodeURIComponent(input.id)}`;
    const cids = new Set<string>();
    let remote = 0;
    const body = mail.html ?? textPage.run({ input: mail.text ?? "" });

    const clean = sanitize(body, {
      allowedTags: tags,
      allowVulnerableTags: true,
      allowedAttributes: {
        "*": layout,
        a: ["href", "name", "target", "rel"],
        img: ["src", "alt", "data-blocked", ...layout],
      },
      allowedSchemes: ["http", "https", "mailto", "tel", "cid", "data"],
      allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
      parseStyleAttributes: false,
      nonTextTags: ["script", "textarea", "option", "noscript", "title", "head"],
      transformTags: {
        a: (tagName, attribs) => ({
          tagName,
          attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
        }),
        img: (tagName, attribs) => {
          const src = attribs.src ?? "";
          if (src.startsWith("cid:")) {
            const cid = src.slice(4);
            cids.add(cid);
            return {
              tagName,
              attribs: { ...attribs, src: `${at}/cid/${encodeURIComponent(cid)}` },
            };
          }
          if (!/^https?:/i.test(src)) return { tagName, attribs };

          remote++;
          if (input.images) {
            return { tagName, attribs: { ...attribs, src: proxyLink.run({ input: src }) } };
          }
          const { src: _dropped, ...rest } = attribs;
          return { tagName, attribs: { ...rest, "data-blocked": "1" } };
        },
      },
    });
    const csp = `default-src 'none'; img-src data: ${origin}; style-src 'unsafe-inline'; font-src data:`;
    const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${base}</style></head><body>${clean}</body></html>`;
    const attachments: Attachment[] = mail.attachments.flatMap((a, part) =>
      a.contentId && cids.has(a.contentId.replace(/^<|>$/g, ""))
        ? []
        : [
            {
              part,
              name: a.filename ?? `attachment-${part + 1}`,
              type: a.mimeType,
              size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
            },
          ],
    );
    return {
      subject: mail.subject ?? "",
      from: addr.parse(mail.from ?? {}),
      to: people.parse(mail.to),
      cc: people.parse(mail.cc),
      date: Date.parse(mail.date ?? "") || 0,
      srcdoc,
      remote,
      attachments,
    };
  },
});

export const attachmentOf = operation({
  label: "render.attachment",
  input: z.object({ mime: z.instanceof(Uint8Array), part: z.string() }),
  run: async (_, { input }) => {
    const mail = await PostalMime.parse(input.mime);
    const cid = input.part.startsWith("cid/") ? decodeURIComponent(input.part.slice(4)) : undefined;
    const found =
      cid === undefined
        ? mail.attachments[Number(input.part)]
        : mail.attachments.find((a) => a.contentId?.replace(/^<|>$/g, "") === cid);

    if (!found) return null;
    const bytes =
      typeof found.content === "string" ? new TextEncoder().encode(found.content) : found.content;
    return {
      bytes: new Uint8Array(bytes),
      type: found.mimeType,
      name: found.filename ?? "attachment",
    };
  },
});

export const textOf = operation({
  label: "render.textOf",
  input: z.object({ mime: z.instanceof(Uint8Array) }),
  run: async (_, { input }) => {
    const mail = await PostalMime.parse(input.mime);
    if (mail.text) return mail.text;

    return (mail.html ?? "")
      .replaceAll(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replaceAll(/<[^>]+>/g, " ")
      .replaceAll(/&nbsp;|&#160;/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim();
  },
});
