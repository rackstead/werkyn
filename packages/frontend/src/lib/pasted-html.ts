// Clipboard HTML can carry the source page's <style> sheets (and <link> or
// <meta> elements). Since 1.42, prosemirror-view appends every rule of a
// pasted sheet to the inline style of each element it matches before parsing,
// which takes time quadratic in the number of rules: a crafted paste of a few
// tens of KB can freeze the tab in engines that build sheets for its detached
// document. Chromium does not, so its pastes already keep nothing from these
// sheets; removing them makes every engine behave the same way.
// prosemirror-view runs transformPastedHTML for dropped HTML as well.
const SHEET_MARKUP = /<(?:style|link|meta)\b/i;
// The result is parsed again by prosemirror-view, and parsers need not agree
// on what is raw text (<noscript> is markup in its script-less document but
// raw text wherever scripting is on). So no "<style" or "<link" may be left
// anywhere, even in a comment, an attribute value or raw text. A tag name ends
// at a tab, LF, FF, CR, space, "/" or ">", so custom elements such as
// <link-preview> are left alone.
const SHEET_TAG_OPEN = /<(?=(?:style|link)(?:[\t\n\f\r />]|$))/gi;

export function stripPastedStyleSheets(html: string): string {
  if (!SHEET_MARKUP.test(html)) return html;
  // Template contents are inert: nothing loads, runs or applies, and table
  // fragments such as a bare <tr> keep their structure.
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content
    .querySelectorAll("style, link, meta")
    .forEach((element) => element.remove());
  return template.innerHTML.replace(SHEET_TAG_OPEN, "&lt;");
}
