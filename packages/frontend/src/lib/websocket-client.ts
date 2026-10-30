import { parseRealtimeEnvelope, type RealtimeEnvelope } from "./realtime-events";

type EventHandler = (message: RealtimeEnvelope) => void;

// Each subscription kind and the frames that open and close it on the server.
const SCOPES = {
  project: { field: "projectId", subscribe: "subscribe", unsubscribe: "unsubscribe" },
  workspace: {
    field: "workspaceId",
    subscribe: "subscribe_workspace",
    unsubscribe: "unsubscribe_workspace",
  },
  channel: {
    field: "channelId",
    subscribe: "subscribe_channel",
    unsubscribe: "unsubscribe_channel",
  },
} as const;
type Scope = keyof typeof SCOPES;

// The server closes a socket with these codes when the session behind its
// access token expired (4004) or ended (4005: logout, password change or
// reset, sign-in elsewhere, refresh-token reuse).
const SESSION_CLOSE_CODES = new Set([4004, 4005]);

interface WebSocketClientOptions {
  url: string;
  getToken: () => string | null;
  onReconnect?: () => void;
  // Called once per socket closed with a session close code. Reconnecting
  // with the same token cannot succeed, so the client waits until the
  // returned promise settles while the owner renews or ends the session.
  onSessionEnded?: (code: number) => Promise<unknown> | void;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private getToken: () => string | null;
  private onReconnect?: () => void;
  private onSessionEnded?: (code: number) => Promise<unknown> | void;
  private renewing = false;
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Consumers holding each subscription. The server keeps one subscription
  // per resource, so it is opened for the first holder and closed after the
  // last one lets go.
  private holders: Record<Scope, Map<string, number>> = {
    project: new Map(),
    workspace: new Map(),
    channel: new Map(),
  };
  // Releases waiting for the end of the current task, so a route transition
  // that hands a resource from one view to the next sends nothing.
  private pendingReleases: Record<Scope, Set<string>> = {
    project: new Set(),
    workspace: new Set(),
    channel: new Set(),
  };
  private connected = false;
  private destroyed = false;

  constructor(options: WebSocketClientOptions) {
    this.url = options.url;
    this.getToken = options.getToken;
    this.onReconnect = options.onReconnect;
    this.onSessionEnded = options.onSessionEnded;

    // Reconnect on tab focus
    this.handleVisibility = this.handleVisibility.bind(this);
    document.addEventListener("visibilitychange", this.handleVisibility);
  }

  connect(): void {
    if (this.destroyed || this.ws) return;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        const token = this.getToken();
        if (token) {
          this.ws?.send(JSON.stringify({ type: "auth", token }));
        }
      };

      this.ws.onmessage = (event) => {
        // Anything that is not a well-formed event envelope is ignored.
        const msg = parseRealtimeEnvelope(event.data);
        if (!msg) return;

        if (msg.event === "authenticated") {
          this.connected = true;
          this.reconnectAttempts = 0;
          // Re-open every subscription that is still held.
          for (const scope of Object.keys(SCOPES) as Scope[]) {
            this.pendingReleases[scope].clear();
            for (const id of this.holders[scope].keys()) {
              this.sendScopeFrame(scope, "subscribe", id);
            }
          }
          return;
        }

        if (msg.event === "pong") return;

        this.dispatch(msg.event, msg);
        this.dispatch("*", msg);
      };

      this.ws.onclose = (event) => {
        this.ws = null;
        this.connected = false;
        if (this.destroyed) return;
        if (this.onSessionEnded && SESSION_CLOSE_CODES.has(event.code)) {
          this.renewSession(this.onSessionEnded, event.code);
          return;
        }
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will be called after onerror
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.handlers.clear();
    for (const scope of Object.keys(SCOPES) as Scope[]) {
      this.holders[scope].clear();
      this.pendingReleases[scope].clear();
    }
    document.removeEventListener("visibilitychange", this.handleVisibility);
  }

  // Every subscribe call must be paired with one unsubscribe call.
  subscribe(projectId: string): void {
    this.hold("project", projectId);
  }

  unsubscribe(projectId: string): void {
    this.release("project", projectId);
  }

  subscribeWorkspace(workspaceId: string): void {
    this.hold("workspace", workspaceId);
  }

  unsubscribeWorkspace(workspaceId: string): void {
    this.release("workspace", workspaceId);
  }

  subscribeChannel(channelId: string): void {
    this.hold("channel", channelId);
  }

  unsubscribeChannel(channelId: string): void {
    this.release("channel", channelId);
  }

  private hold(scope: Scope, id: string): void {
    const count = this.holders[scope].get(id) ?? 0;
    this.holders[scope].set(id, count + 1);
    if (count > 0) return;
    // Taken back before its release was sent: the server never let it go.
    if (this.pendingReleases[scope].delete(id)) return;
    this.sendScopeFrame(scope, "subscribe", id);
  }

  private release(scope: Scope, id: string): void {
    const count = this.holders[scope].get(id);
    if (!count) return;
    if (count > 1) {
      this.holders[scope].set(id, count - 1);
      return;
    }
    this.holders[scope].delete(id);
    this.pendingReleases[scope].add(id);
    queueMicrotask(() => {
      if (!this.pendingReleases[scope].delete(id)) return;
      this.sendScopeFrame(scope, "unsubscribe", id);
    });
  }

  private sendScopeFrame(
    scope: Scope,
    action: "subscribe" | "unsubscribe",
    id: string,
  ): void {
    if (!this.connected || !this.ws) return;
    const { field, [action]: type } = SCOPES[scope];
    this.ws.send(JSON.stringify({ type, [field]: id }));
  }

  private dispatch(event: string, msg: RealtimeEnvelope): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    // A handler may remove itself or others while the event is delivered.
    for (const handler of [...handlers]) {
      try {
        handler(msg);
      } catch (error) {
        // One failing consumer must not stop the others from updating.
        console.error(`Realtime handler for "${event}" failed`, error);
      }
    }
  }

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.onReconnect?.();
    }, delay);
  }

  // One renewal at a time: neither the backoff timer nor a tab becoming
  // visible reconnects with the old token while it runs. The owner replaces
  // or disconnects this client when it gets a new token or signs out;
  // otherwise the normal backoff resumes afterwards.
  private renewSession(
    onSessionEnded: (code: number) => Promise<unknown> | void,
    code: number,
  ): void {
    this.renewing = true;
    let renewal: Promise<unknown>;
    try {
      renewal = Promise.resolve(onSessionEnded(code));
    } catch (error) {
      renewal = Promise.reject(error);
    }
    void renewal
      .catch(() => {})
      .finally(() => {
        this.renewing = false;
        this.scheduleReconnect();
      });
  }

  private handleVisibility(): void {
    if (
      document.visibilityState === "visible" &&
      !this.connected &&
      !this.renewing &&
      !this.destroyed
    ) {
      // Clear existing reconnect timer and reconnect immediately
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      this.connect();
      this.onReconnect?.();
    }
  }
}
