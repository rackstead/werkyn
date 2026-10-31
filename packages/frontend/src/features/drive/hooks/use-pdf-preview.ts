import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { apiUrl } from "@/lib/api-url";
import { identityGeneration } from "@/lib/identity";
import { useAuthStore } from "@/stores/auth-store";

interface PreviewGrant {
  token: string;
  expiresAt: number;
  sourceExpiresAt: number;
}
interface PreviewState {
  scope: object;
  url?: string;
  expiresAt?: number;
  error: string | null;
  isLoading: boolean;
}
const RENEW_EARLY_MS = 30_000;
const ERROR = "PDF preview could not be loaded. Try again.";

/** Owns only a short-lived URL; PDF bytes stay in the browser's native viewer. */
export function usePdfPreview(workspaceId: string, fileId: string | null) {
  const userId = useAuthStore((state) => state.user?.id);
  const accessToken = useAuthStore((state) => state.accessToken);
  const scope = useMemo(() => ({}), [workspaceId, fileId, userId, accessToken]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>();
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!fileId || !userId || !accessToken) return;
    const controller = new AbortController();
    const generation = identityGeneration();
    let active = true;
    let pending = false;
    let grant: PreviewGrant | undefined;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      active &&
      !controller.signal.aborted &&
      identityGeneration() === generation &&
      useAuthStore.getState().user?.id === userId &&
      useAuthStore.getState().accessToken === accessToken;
    const clearTimers = () => {
      clearTimeout(renewal);
      clearTimeout(expiry);
    };
    const path = `workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}`;
    setState({ scope, error: null, isLoading: true });

    async function load(previous?: PreviewGrant) {
      if (!current() || pending) return;
      pending = true;
      try {
        if (previous && previous.expiresAt === previous.sourceExpiresAt) {
          // Reuse the shared refresh mutex and identity guards. A token update
          // starts a new effect; the old renewal must not start a second load.
          await useAuthStore.getState().refresh();
          if (!current()) return;
          // A recent-refresh shortcut may leave the same expiring token.
          // Stop here rather than repeatedly minting its same expiry.
          throw new Error("Access token was not renewed");
        }
        const { data } = await api
          .post(`${path}/preview-grant`, {
            signal: controller.signal,
          })
          .json<{ data: PreviewGrant }>();
        if (!current()) return;
        if (
          !data ||
          typeof data.token !== "string" ||
          data.token === "" ||
          !Number.isSafeInteger(data.expiresAt) ||
          !Number.isSafeInteger(data.sourceExpiresAt) ||
          data.expiresAt <= Date.now() ||
          data.sourceExpiresAt < data.expiresAt ||
          (previous && data.expiresAt <= previous.expiresAt)
        )
          throw new Error("Invalid preview expiry");
        grant = data;
        clearTimers();
        setState({
          scope,
          url: apiUrl(`${path}/preview`, { token: data.token }),
          expiresAt: data.expiresAt,
          error: null,
          isLoading: false,
        });
        renewal = setTimeout(
          () => {
            void load(data);
          },
          Math.max(0, data.expiresAt - Date.now() - RENEW_EARLY_MS),
        );
        expiry = setTimeout(
          () => {
            if (!current()) return;
            setState({ scope, error: null, isLoading: true });
            void load(data);
          },
          Math.max(0, data.expiresAt - Date.now()),
        );
      } catch {
        if (current()) {
          grant = undefined;
          clearTimers();
          setState({ scope, error: ERROR, isLoading: false });
        }
      } finally {
        pending = false;
      }
    }
    const resume = () => {
      if (document.visibilityState !== "visible" || !current() || !grant)
        return;
      if (Date.now() >= grant.expiresAt)
        setState({ scope, error: null, isLoading: true });
      if (Date.now() >= grant.expiresAt - RENEW_EARLY_MS) void load(grant);
    };
    document.addEventListener("visibilitychange", resume);
    void load();
    return () => {
      active = false;
      controller.abort();
      clearTimers();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [workspaceId, fileId, userId, accessToken, scope, attempt]);

  const owned = state?.scope === scope ? state : undefined;
  const enabled = !!fileId && !!userId && !!accessToken;
  return {
    url:
      enabled && owned?.expiresAt && owned.expiresAt > Date.now()
        ? owned.url
        : undefined,
    error: enabled ? (owned?.error ?? null) : null,
    isLoading: enabled && (owned?.isLoading ?? true),
    retry,
  };
}
