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
import { useAuthStore } from "@/stores/auth-store";

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
    profileStatus: 200,
    settingsStatus: 200,
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock("sonner", () => ({ toast: state.toast }));

const { GeneralSettings } = await import("./general-settings");

const settings = {
  id: "settings-1",
  workspaceId: "ws-1",
  defaultRole: "MEMBER" as const,
  invitesEnabled: true,
  requireAdminApproval: false,
  allowedEmailDomains: [] as string[],
  maxMembers: null as number | null,
  enabledModules: ["drive"],
  updatedAt: "2026-11-08T00:00:00.000Z",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function failure(status: number, message: string) {
  return json(status, { statusCode: status, error: "Error", message });
}

beforeEach(() => {
  queryClient.clear();
  state.requests.length = 0;
  state.profileStatus = 200;
  state.settingsStatus = 200;
  state.toast.success.mockClear();
  state.toast.error.mockClear();
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "ada@example.test",
      displayName: "Ada",
      avatarUrl: null,
      jobTitle: null,
      phone: null,
      timezone: null,
      emailVerified: true,
    },
    accessToken: "token",
    workspaces: [
      {
        id: "mem-1",
        workspaceId: "ws-1",
        role: "ADMIN",
        workspace: {
          id: "ws-1",
          name: "Acme",
          slug: "acme",
          logoUrl: null,
        },
      },
    ],
    isHydrated: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      const path = new URL(req.url).pathname;
      state.requests.push(`${req.method} ${path}`);
      if (req.method === "GET" && path === "/api/workspaces/ws-1/settings")
        return json(200, { data: settings });
      if (req.method === "PATCH" && path === "/api/workspaces/ws-1") {
        if (state.profileStatus !== 200)
          return failure(
            state.profileStatus,
            "Workspace slug is already in use",
          );
        return json(200, {
          data: {
            id: "ws-1",
            name: "Acme",
            slug: "acme",
            logoUrl: null,
            createdAt: settings.updatedAt,
            updatedAt: settings.updatedAt,
          },
        });
      }
      if (req.method === "PATCH" && path === "/api/workspaces/ws-1/settings") {
        if (state.settingsStatus !== 200)
          return failure(
            state.settingsStatus,
            "Max members must be a positive number",
          );
        return json(200, { data: settings });
      }
      if (req.method === "POST" && path === "/api/auth/refresh")
        return failure(401, "No session");
      throw new Error(`Unexpected ${req.method} ${path}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function renderSettings() {
  return render(<GeneralSettings workspaceId="ws-1" />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

it("shows a failed Save Profile once, with the message the user can act on", async () => {
  state.profileStatus = 500;
  renderSettings();
  fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
  await waitFor(() =>
    expect(state.toast.error).toHaveBeenCalledWith(
      "Workspace slug is already in use",
    ),
  );
  expect(state.toast.error).toHaveBeenCalledTimes(1);
  expect(state.toast.success).not.toHaveBeenCalled();
  expect(state.requests).toContain("PATCH /api/workspaces/ws-1");
});

it("shows a failed Save Settings once, with the message the user can act on", async () => {
  state.settingsStatus = 500;
  renderSettings();
  fireEvent.click(await screen.findByRole("button", { name: "Save Settings" }));
  await waitFor(() =>
    expect(state.toast.error).toHaveBeenCalledWith(
      "Max members must be a positive number",
    ),
  );
  expect(state.toast.error).toHaveBeenCalledTimes(1);
  expect(state.toast.success).not.toHaveBeenCalled();
  expect(state.requests).toContain("PATCH /api/workspaces/ws-1/settings");
});

it("does not show an error toast when Save Profile succeeds", async () => {
  renderSettings();
  fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
  await waitFor(() =>
    expect(state.toast.success).toHaveBeenCalledWith("Workspace updated"),
  );
  expect(state.toast.error).not.toHaveBeenCalled();
});

it("does not show an error toast when Save Settings succeeds", async () => {
  renderSettings();
  fireEvent.click(await screen.findByRole("button", { name: "Save Settings" }));
  await waitFor(() =>
    expect(state.toast.success).toHaveBeenCalledWith("Settings saved"),
  );
  expect(state.toast.error).not.toHaveBeenCalled();
});
