import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api-client";
import { apiUrl } from "@/lib/api-url";
import {
  getIdentitySnapshot,
  identityGeneration,
  identitySignal,
  subscribeIdentity,
} from "@/lib/identity";
import { useAuthStore } from "@/stores/auth-store";

interface PreviewGrant {
  token: string;
  expiresAt: number;
  sourceExpiresAt: number;
}
interface PreviewState {
  scope: string;
  url?: string;
  error: string | null;
  isLoading: boolean;
}
const MIN_REMAINING_MS = 30_000;
const ERROR = "PDF preview could not be loaded. Try again.";

/** Keeps one native viewer for each open resource/identity, without buffering bytes. */
export function usePdfPreview(workspaceId: string, fileId: string | null) {
  const userId = useAuthStore((state) => state.user?.id);
  const signedIn = useAuthStore((state) => !!state.accessToken);
  const { generation } = useSyncExternalStore(
    subscribeIdentity,
    getIdentitySnapshot,
    getIdentitySnapshot,
  );
  const enabled = !!fileId && !!userId && signedIn;
  // A same-user token rotation must not reload an already displayed document.
  const scope = JSON.stringify([
    workspaceId,
    fileId,
    userId,
    generation,
    enabled,
  ]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>();
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const reportFrameError = useCallback(() => {
    setState((previous) =>
      previous?.scope === scope
        ? { scope, error: ERROR, isLoading: false }
        : previous,
    );
  }, [scope]);

  useEffect(() => {
    if (!enabled || !fileId || !userId) return;
    const controller = new AbortController();
    const identity = identitySignal();
    const abortIdentity = () => controller.abort();
    identity.addEventListener("abort", abortIdentity, { once: true });
    let active = true;
    const current = () =>
      active &&
      !controller.signal.aborted &&
      identityGeneration() === generation &&
      useAuthStore.getState().user?.id === userId &&
      !!useAuthStore.getState().accessToken;
    const path = `workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}`;
    const requestGrant = () =>
      api
        .post(`${path}/preview-grant`, {
          signal: controller.signal,
          context: { expectedUserId: userId },
        })
        .json<{ data: PreviewGrant }>();
    const valid = (data: PreviewGrant) =>
      data &&
      typeof data.token === "string" &&
      data.token !== "" &&
      Number.isSafeInteger(data.expiresAt) &&
      Number.isSafeInteger(data.sourceExpiresAt) &&
      data.sourceExpiresAt >= data.expiresAt;
    setState({ scope, error: null, isLoading: true });
    async function load() {
      try {
        const requestedToken = useAuthStore.getState().accessToken;
        let { data } = await requestGrant();
        if (!current()) return;
        if (!valid(data)) throw new Error("Invalid preview grant");
        if (
          data.expiresAt - Date.now() < MIN_REMAINING_MS &&
          useAuthStore.getState().accessToken === requestedToken
        ) {
          // The acquisition was slow or source-bound. Reuse the shared refresh
          // coordinator once, then require a changed token; never renew in a loop.
          await useAuthStore.getState().refresh();
          if (!current()) return;
          if (useAuthStore.getState().accessToken === requestedToken)
            throw new Error("Access token was not renewed");
        }
        // A concurrent ordinary API refresh may already have supplied the token.
        if (useAuthStore.getState().accessToken !== requestedToken) {
          ({ data } = await requestGrant());
          if (!current()) return;
        }
        if (!valid(data) || data.expiresAt - Date.now() < MIN_REMAINING_MS)
          throw new Error("Preview grant expires too soon");
        setState({
          scope,
          url: apiUrl(`${path}/preview`, { token: data.token }),
          error: null,
          isLoading: false,
        });
      } catch {
        if (current()) setState({ scope, error: ERROR, isLoading: false });
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
      identity.removeEventListener("abort", abortIdentity);
    };
  }, [workspaceId, fileId, userId, generation, enabled, scope, attempt]);

  const owned = state?.scope === scope ? state : undefined;
  return {
    url: enabled ? owned?.url : undefined,
    error: enabled ? (owned?.error ?? null) : null,
    isLoading: enabled && (owned?.isLoading ?? true),
    retry,
    reportFrameError,
  };
}
