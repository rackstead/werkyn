import { useEffect, useLayoutEffect, useState } from "react";

interface OwnedUrl {
  blob: Blob;
  url: string;
  /** Set once the URL has been committed as this component's state. */
  committed: boolean;
}

/**
 * An object URL for `blob` owned by the calling component, revoked exactly
 * once when the blob changes or the component unmounts, and never while the
 * DOM may still show it. Every observer of a cached Blob holds its own URL.
 *
 * Cache the Blob, never the URL: a cached URL either outlives the component
 * that revokes it (a later reader gets a dead URL) or is never revoked.
 */
export function useObjectUrl(blob: Blob | null | undefined): string | undefined {
  const [owned, setOwned] = useState<OwnedUrl | null>(null);

  // Create the URL in a layout effect. Its state update is synchronous, so it
  // renders before paint and leaves no update pending. A passive-effect update
  // would stay pending while store updates keep committing, and with many
  // thumbnails loading at once React counts those commits as nested updates
  // until it throws "Maximum update depth exceeded".
  useLayoutEffect(() => {
    if (!blob) {
      setOwned(null);
      return;
    }
    const entry: OwnedUrl = { blob, url: URL.createObjectURL(blob), committed: false };
    setOwned(entry);
    return () => {
      // Never committed (StrictMode's simulated remount, or superseded before
      // it rendered): nothing shows it, so revoke it here. A committed URL is
      // revoked by the passive cleanup below instead.
      if (!entry.committed) URL.revokeObjectURL(entry.url);
    };
  }, [blob]);

  useLayoutEffect(() => {
    if (owned) owned.committed = true;
  }, [owned]);

  // Passive cleanups run after the commit that removed the URL from the DOM
  // (a newer URL, or unmount), so the URL is no longer shown when revoked.
  useEffect(() => {
    if (!owned) return;
    return () => URL.revokeObjectURL(owned.url);
  }, [owned]);

  // Until the URL for a new blob is created, the one held is for the old blob;
  // report none rather than that one.
  return owned && owned.blob === blob ? owned.url : undefined;
}
