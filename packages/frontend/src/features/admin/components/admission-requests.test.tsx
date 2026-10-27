import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";

const state = vi.hoisted(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://localhost/api");
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      addEventListener() {}
      postMessage() {}
    },
  );
  return {
    requests: [] as string[],
    queue: [] as unknown[],
    approve: null as null | (() => Response),
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: state.toast }));

const { InviteSettings } = await import("./invite-settings");

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const request = (id: string, email: string, verified = true) => ({
  id,
  createdAt: "2026-10-27T00:00:00Z",
  user: { id: `${id}-user`, email, displayName: email.split("@")[0], avatarUrl: null, emailVerified: verified },
  invite: { id: "invite", role: "VIEWER", email: null, expiresAt: null, maxUses: 1, useCount: 0 },
});

beforeEach(() => {
  queryClient.clear();
  state.requests.length = 0;
  state.toast.success.mockClear();
  state.toast.error.mockClear();
  state.queue = [request("rq-1", "ada@example.test"), request("rq-2", "bob@example.test", false)];
  state.approve = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      const path = new URL(req.url).pathname;
      state.requests.push(`${req.method} ${path}`);
      if (req.method === "GET" && path === "/api/workspaces/ws-1/admission-requests")
        return json(200, { data: state.queue });
      if (req.method === "GET" && path === "/api/workspaces/ws-1/invites")
        return json(200, { data: [] });
      if (path === "/api/workspaces/ws-1/admission-requests/rq-1/approve")
        return state.approve!();
      if (path === "/api/workspaces/ws-1/admission-requests/rq-2/reject") {
        state.queue = state.queue.filter((r) => (r as { id: string }).id !== "rq-2");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected ${req.method} ${path}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function renderSettings() {
  return render(<InviteSettings workspaceId="ws-1" />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

it("lists pending join requests with the invitation role and verification state", async () => {
  renderSettings();
  expect(await screen.findByText("Join requests (2)")).toBeTruthy();
  expect(screen.getByText("ada@example.test")).toBeTruthy();
  expect(screen.getByText(/bob@example.test/)).toBeTruthy();
  expect(screen.getAllByText(/Invite role: VIEWER/)).toHaveLength(2);
  expect(screen.getByText(/Email not verified/)).toBeTruthy();
});

it("reports a refused approval and refreshes the queue and counters", async () => {
  state.approve = () =>
    json(403, { statusCode: 403, error: "Forbidden", message: "This workspace has reached its member limit" });
  renderSettings();
  fireEvent.click(await screen.findByRole("button", { name: "Approve ada@example.test" }));
  await waitFor(() =>
    expect(state.toast.error).toHaveBeenCalledWith("This workspace has reached its member limit"),
  );
  expect(state.toast.error).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(state.requests.filter((r) => r === "GET /api/workspaces/ws-1/admission-requests")).toHaveLength(2),
  );
  expect(state.requests).toContain("GET /api/workspaces/ws-1/invites");
  expect(state.toast.success).not.toHaveBeenCalled();
});

it("approves and rejects through the workspace-scoped decision endpoints", async () => {
  state.approve = () => {
    state.queue = state.queue.filter((r) => (r as { id: string }).id !== "rq-1");
    return json(200, { data: { status: "joined" } });
  };
  renderSettings();
  fireEvent.click(await screen.findByRole("button", { name: "Approve ada@example.test" }));
  await waitFor(() => expect(screen.getByText("Join requests (1)")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Reject bob@example.test" }));
  await waitFor(() => expect(screen.getByText("No pending join requests")).toBeTruthy());
  expect(state.requests).toContain("POST /api/workspaces/ws-1/admission-requests/rq-1/approve");
  expect(state.requests).toContain("POST /api/workspaces/ws-1/admission-requests/rq-2/reject");
  expect(state.toast.success).toHaveBeenCalledWith("Join request approved");
  expect(state.toast.success).toHaveBeenCalledWith("Join request rejected");
});
