import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { getIdentitySnapshot, subscribeIdentity } from "@/lib/identity";

/**
 * Remounts its children each time a signed-in account is left, and renders
 * the fallback until that change's resets (such as re-running route guards)
 * have finished. Component state, open dialogs and route context created for
 * the previous account therefore never render for the next one.
 */
export function IdentityBoundary({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { departures, settled } = useSyncExternalStore(
    subscribeIdentity,
    getIdentitySnapshot,
    getIdentitySnapshot,
  );
  if (!settled) return fallback;
  return <Fragment key={departures}>{children}</Fragment>;
}
