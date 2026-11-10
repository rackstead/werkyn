import { Editor } from "@tiptap/react";
import { afterEach, expect, it } from "vitest";
import { taskDescriptionKit } from "./task-description-kit";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors.length = 0;
});

function editor(content: string) {
  const created = new Editor({ extensions: [taskDescriptionKit], content });
  editors.push(created);
  return created;
}

it("serializes only the server description allow-list", () => {
  const html = editor(
    "<h1>Heading 1</h1><h2>Heading 2</h2><h3>Heading 3</h3>" +
      "<h4>Heading 4</h4><h5>Heading 5</h5><h6>Heading 6</h6>" +
      "<p><strong>bold</strong> <em>italic</em> <s>strike</s> <u>underline</u> <code>code</code></p>" +
      '<ol start="3"><li><p>Third</p></li></ol><hr>' +
      "<blockquote><p>Quote</p></blockquote>",
  ).getHTML();
  expect(html).not.toMatch(/<\/?(?:s|u|hr|h4|h5|h6)\b|start\s*=/i);
  expect(html).toContain("<h1>Heading 1</h1>");
  expect(html).toContain("<h2>Heading 2</h2>");
  expect(html).toContain("<h3>Heading 3</h3>");
  expect(html).toContain("Heading 4");
  expect(html).toContain("Heading 5");
  expect(html).toContain("Heading 6");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>italic</em>");
  expect(html).toContain("strike");
  expect(html).toContain("underline");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain("<ol><li><p>Third</p></li></ol>");
  expect(html).toContain("<blockquote><p>Quote</p></blockquote>");
  expect(html).not.toContain("<hr");
});

it("does not offer strike, underline, a rule, or heading levels past 3", () => {
  const current = editor("<p>Text</p>");
  expect(current.schema.marks.strike).toBeUndefined();
  expect(current.schema.marks.underline).toBeUndefined();
  expect(current.schema.nodes.horizontalRule).toBeUndefined();
  expect(current.schema.nodes.heading).toBeDefined();
  expect(current.commands.toggleHeading({ level: 4 })).toBe(false);
  expect(current.commands.toggleHeading({ level: 1 })).toBe(true);
  expect(current.getHTML()).toContain("<h1>Text</h1>");
  expect(current.getHTML()).not.toContain("<h4");
});

function typeText(current: Editor, text: string) {
  for (const char of text) {
    const view = current.view;
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, char, () =>
        view.state.tr.insertText(char, from, to),
      ),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

it("an ordered list typed from a number does not emit start", () => {
  const current = editor("<p></p>");
  current.commands.focus("start");
  typeText(current, "3. Third");
  const html = current.getHTML();
  expect(html).toContain("<ol><li><p>Third</p></li></ol>");
  expect(html).not.toMatch(/start\s*=/i);
});
