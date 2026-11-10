import DOMPurify, { type Config } from "dompurify";

// Every task description shown or loaded in the browser goes through this
// allow-list. It mirrors the server's sanitize-html policy
// (packages/backend/src/utils/description-html.ts), so markup the server
// would never store is not rendered either, including rows stored before
// every write path sanitized descriptions. The task editor does not emit s,
// u, hr, h4-h6, or ol[start], and this list does not keep them. One
// difference, inert for stored rows: it does not keep a[target], which the
// read-only view never rendered.
// Nothing here can match or style app elements (no id, class, style), act on
// them (no command/commandfor, popover*, dialog, form, button, label[for]) or
// load anything (no img, svg, style, link).
export const DESCRIPTION_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    "b",
    "i",
    "em",
    "strong",
    "p",
    "br",
    "ul",
    "ol",
    "li",
    "a",
    "h1",
    "h2",
    "h3",
    "blockquote",
    "code",
    "pre",
  ],
  ALLOWED_ATTR: ["href", "rel"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // http, https, mailto, or no scheme (relative, fragment, protocol-relative),
  // as the server's allowedSchemes. DOMPurify's default pattern with only
  // its scheme list narrowed.
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  // Already excluded by the allow-lists above; listed so that widening them
  // later cannot quietly re-admit invokers, popovers or style sheets.
  FORBID_TAGS: ["style", "link", "dialog", "form", "button", "svg", "math"],
  FORBID_ATTR: [
    "command",
    "commandfor",
    "popover",
    "popovertarget",
    "popovertargetaction",
    "style",
    "id",
    "class",
  ],
};

export function sanitizeDescriptionHtml(html: string): string {
  return DOMPurify.sanitize(html, DESCRIPTION_SANITIZE_CONFIG);
}
