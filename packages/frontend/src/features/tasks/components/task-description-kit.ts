import StarterKit from "@tiptap/starter-kit";

// Stored task descriptions keep the server allow-list only. Starter Kit
// otherwise also serializes strike, underline, a horizontal rule, heading
// levels 4-6, and the ordered-list start attribute, which that allow-list
// discards on save.
export const taskDescriptionKit = StarterKit.extend({
  addExtensions() {
    const extensions = this.parent?.() ?? [];
    return extensions.map((extension) => {
      if (extension.name !== "orderedList") return extension;
      return extension.extend({
        renderHTML({
          HTMLAttributes,
        }: {
          HTMLAttributes: Record<string, unknown>;
        }) {
          const { start: _start, type, ...rest } = HTMLAttributes;
          const attrs: Record<string, unknown> = { ...rest };
          if (typeof type === "string" && type !== "1") attrs.type = type;
          return ["ol", attrs, 0];
        },
      });
    });
  },
}).configure({
  horizontalRule: false,
  heading: { levels: [1, 2, 3] },
  strike: false,
  underline: false,
});
