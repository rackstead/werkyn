import { expect, it } from "vitest";
import { stripPastedStyleSheets } from "./pasted-html";

function reparsed(html: string) {
  // As prosemirror-view reads clipboard HTML: a detached, script-less document.
  const doc = document.implementation.createHTMLDocument("title");
  doc.body.innerHTML = html;
  return doc;
}

it("leaves clipboard HTML without style, link or meta elements untouched", () => {
  const html =
    '<p class="x" style="font-weight:bold">Text &amp; <a href="https://example.com">link</a></p><!--c-->';
  expect(stripPastedStyleSheets(html)).toBe(html);
});

it("removes style, link and meta elements and keeps the content around them", () => {
  expect(
    stripPastedStyleSheets(
      "<meta charset='utf-8'><html><head><STYLE>.cb{font-weight:bold}</STYLE>" +
        '<link rel="stylesheet" href="https://attacker.example/x.css"></head>' +
        '<body><!--StartFragment--><p><span class="cb">Kept</span></p><!--EndFragment--></body></html>',
    ),
  ).toBe(
    '<!--StartFragment--><p><span class="cb">Kept</span></p><!--EndFragment-->',
  );
});

it("removes SVG style elements", () => {
  expect(
    stripPastedStyleSheets(
      "<svg><style>p{color:red}</style><rect></rect></svg>",
    ),
  ).toBe("<svg><rect></rect></svg>");
});

it("keeps a table-row fragment's structure", () => {
  expect(
    stripPastedStyleSheets("<style>td{}</style><tr><td>Cell</td></tr>"),
  ).toBe("<tr><td>Cell</td></tr>");
});

it("never lets a style sheet appear when prosemirror-view parses the result again", () => {
  const payloads = [
    "<noscript><style>p{color:red}</style></noscript><p>x</p>",
    "<template><style>p{}</style></template><p>x</p>",
    '<p title="<style>p{}</style>">x</p><style>q{}</style>',
    "<!-- <style>p{}</style> --><style>q{}</style>",
    "<xmp><style>p{}</style></xmp><meta>",
    "<math><mtext><table><mglyph><style><img></style></mglyph></table></mtext></math><link>",
    '<svg></p><style><a id="</style><p>"></a></style></svg><meta>',
    "<sty<style></style>le>p{}</style><meta>",
  ];
  for (const payload of payloads) {
    const result = stripPastedStyleSheets(payload);
    // Holds for any parser, whatever it treats as raw text.
    expect(result, payload).not.toMatch(/<(?:style|link)\b/i);
    const doc = reparsed(result);
    expect(doc.querySelectorAll("style, link"), payload).toHaveLength(0);
    for (const template of doc.querySelectorAll("template")) {
      expect(template.content.querySelectorAll("style, link")).toHaveLength(0);
    }
  }
});

it("removes a large sheet whose rules each match many elements", () => {
  const rules = Array.from(
    { length: 3000 },
    (_, i) => `.c${i}{--v${i}:${"x".repeat(20)}}`,
  ).join("");
  const body = Array.from(
    { length: 200 },
    (_, i) => `<p class="c${i}">${i}</p>`,
  ).join("");
  expect(stripPastedStyleSheets(`<style>${rules}</style>${body}`)).toBe(body);
});
