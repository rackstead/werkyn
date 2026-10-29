import { useEffect, useState } from "react";

/**
 * An object URL for `blob` owned by the calling component. It is created once
 * the blob is available and revoked exactly once, when the blob changes or the
 * component unmounts, so every observer of a cached Blob holds its own URL.
 *
 * Cache the Blob, never the URL: a cached URL either outlives the component
 * that revokes it (a later reader gets a dead URL) or is never revoked.
 */
export function useObjectUrl(blob: Blob | null | undefined): string | undefined {
  const [owned, setOwned] = useState<{ blob: Blob; url: string } | null>(null);

  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setOwned({ blob, url });
    return () => {
      URL.revokeObjectURL(url);
      setOwned((current) => (current?.url === url ? null : current));
    };
  }, [blob]);

  // Until the effect for a new blob runs, the URL held is for the old one
  // (and may already be revoked); report none rather than that one.
  return owned && owned.blob === blob ? owned.url : undefined;
}
