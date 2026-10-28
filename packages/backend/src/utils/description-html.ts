import sanitizeHtml from "sanitize-html";

// Allow-list for rich-text task descriptions. Every path that stores a task or
// task-template description (create, update, duplicate, template instantiation,
// recurring tasks, backup restore) must store the result of
// sanitizeDescription so the stored HTML does not depend on the write path.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "b", "i", "em", "strong", "p", "br", "ul", "ol", "li", "a",
    "h1", "h2", "h3", "blockquote", "code", "pre",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  disallowedTagsMode: "discard",
};

export function sanitizeDescription(
  html: string | undefined | null,
): string | undefined | null {
  if (html === undefined || html === null) return html;
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
