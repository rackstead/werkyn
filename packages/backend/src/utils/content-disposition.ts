/** RFC 6266 fallback first, then RFC 8187 UTF-8 filename*. */
export function formatContentDisposition(
  filename: string,
  disposition: "attachment" | "inline" = "attachment",
): string {
  // Avoid non-ASCII, quoted-string escapes and ambiguous percent escapes in
  // legacy clients. The extended parameter retains the actual filename.
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/gu, "_") || "download";
  // UTF-8 replaces isolated UTF-16 surrogates rather than throwing URIError.
  const encoded = encodeURIComponent(
    Buffer.from(filename, "utf8").toString("utf8"),
  ).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
