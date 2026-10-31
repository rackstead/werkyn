import { lazyNamed } from "@/lib/lazy-import";

// BlockNote and its dependencies are the largest part of the app, so the
// editor is loaded only when a wiki page is opened.
export const WikiEditor = lazyNamed(() => import("./wiki-editor"), "WikiEditor");
