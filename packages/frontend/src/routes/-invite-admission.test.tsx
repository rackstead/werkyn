import type { ComponentType, ReactNode } from "react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore, type WorkspaceMembership } from "@/stores/auth-store";
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
    params: { token: "invite-token" } as Record<string, string>,
    search: {} as Record<string, unknown>,
    navigate: vi.fn(),
    requests: [] as { method: string; path: string; body: unknown }[],
    responses: new Map<string, () => Response | Promise<Response>>(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => state.params,
    useSearch: () =>
      (options.validateSearch as { parse?: (v: unknown) => unknown })?.parse
        ? (options.validateSearch as { parse: (v: unknown) => unknown }).parse(
            state.search,
          )
        : state.search,
  }),
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string | undefined>;
    children: ReactNode;
  }) => {
    let href = to;
    for (const [key, value] of Object.entries(params ?? {}))
      href = href.replace(`$${key}`, value);
    const query = new URLSearchParams(
      Object.entries(search ?? {}).filter(([, v]) => v !== undefined) as [
        string,
        string,
      ][],
    ).toString();
    return <a href={query ? `${href}?${query}` : href}>{children}</a>;
  },
  useNavigate: () => state.navigate,
}));
vi.mock("@/lib/router", () => ({ router: { invalidate: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Route: InviteRoute } = await import("./invite.$token");
const { Route: VerifyRoute } = await import("./verify-email.$token");
const { useRegister } = await import("@/features/auth/api");

const workspace = { id: "ws-1", name: "Acme", slug: "acme" };

function user(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    displayName: id,
    avatarUrl: null,
    jobTitle: null,
    phone: null,
    timezone: null,
    emailVerified: false,
  };
}

function membership(slug: string): WorkspaceMembership {
  return {
    id: `${slug}-membership`,
    workspaceId: `${slug}-id`,
    role: "MEMBER",
    workspace: { id: `${slug}-id`, name: slug, slug, logoUrl: null },
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respond(method: string, path: string, reply: () => Response | Promise<Response>) {
  state.responses.set(`${method} ${path}`, reply);
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderRoute(route: { options: unknown }) {
  const Component = (route.options as { component: ComponentType })
    .component;
  return render(<Component />, { wrapper });
}

beforeEach(() => {
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  queryClient.clear();
  state.params = { token: "invite-token" };
  state.search = {};
  state.navigate.mockClear();
  state.requests.length = 0;
  state.responses.clear();
  respond("GET", "/api/invites/invite-token", () =>
    json(200, {
      data: { id: "invite", workspace: { ...workspace, logoUrl: null }, role: "MEMBER", email: null },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const text = await request.text();
      state.requests.push({
        method: request.method,
        path: url.pathname,
        body: text ? JSON.parse(text) : undefined,
      });
      const reply = state.responses.get(`${request.method} ${url.pathname}`);
      if (!reply) throw new Error(`Unexpected ${request.method} ${url.pathname}`);
      return reply();
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

function signIn(id = "applicant", workspaces: WorkspaceMembership[] = []) {
  useAuthStore.setState({ user: user(id), accessToken: `${id}-token`, workspaces });
}

it("explains verification, resends with the invitation and joins only after a committed result", async () => {
  signIn();
  respond("POST", "/api/invites/invite-token/accept", () =>
    json(202, {
      data: { status: "verification_required", workspace, email: "applicant@example.test", userId: "applicant" },
    }),
  );
  respond("POST", "/api/auth/resend-verification", () =>
    json(200, { message: "Verification email sent." }),
  );
  renderRoute(InviteRoute);
  fireEvent.click(await screen.findByRole("button", { name: "Accept invite" }));
  expect(await screen.findByText(/Open the verification link/)).toBeTruthy();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(useAuthStore.getState().workspaces).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
  await waitFor(() =>
    expect(state.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/auth/resend-verification",
      body: { inviteToken: "invite-token" },
    }),
  );

  const joined = [membership("acme")];
  respond("POST", "/api/invites/invite-token/accept", () =>
    json(200, {
      data: { status: "joined", workspace, role: "MEMBER", alreadyMember: false, userId: "applicant", workspaces: joined },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "I've verified my email" }));
  await waitFor(() =>
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$workspaceSlug",
      params: { workspaceSlug: "acme" },
    }),
  );
  expect(useAuthStore.getState().workspaces).toEqual(joined);
});

it("shows a pending approval without granting a workspace and rechecks on demand", async () => {
  const existing = [membership("other")];
  signIn("applicant", existing);
  respond("POST", "/api/invites/invite-token/accept", () =>
    json(202, {
      data: { status: "approval_pending", workspace, requestId: "rq-1", requestedAt: "2026-10-27T00:00:00Z", userId: "applicant" },
    }),
  );
  renderRoute(InviteRoute);
  fireEvent.click(await screen.findByRole("button", { name: "Accept invite" }));
  expect(await screen.findByText(/waiting for an administrator/)).toBeTruthy();
  expect(useAuthStore.getState().workspaces).toBe(existing);

  respond("POST", "/api/invites/invite-token/accept", () =>
    json(403, { statusCode: 403, error: "Forbidden", message: "Invites are currently disabled for this workspace" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Invites are currently disabled for this workspace",
  );
  // The stale pending explanation is replaced by the current refusal.
  expect(screen.queryByText(/waiting for an administrator/)).toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(useAuthStore.getState().workspaces).toBe(existing);
});

it("ignores a joined response for an account that is no longer signed in", async () => {
  signIn("first");
  let release!: () => void;
  respond("POST", "/api/invites/invite-token/accept", () =>
    new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          json(200, {
            data: { status: "joined", workspace, role: "MEMBER", alreadyMember: false, userId: "first", workspaces: [membership("acme")] },
          }),
        );
    }),
  );
  renderRoute(InviteRoute);
  fireEvent.click(await screen.findByRole("button", { name: "Accept invite" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  const second = [membership("second")];
  act(() => signIn("second", second));
  await act(async () => release());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Accept invite" })).toHaveProperty("disabled", false),
  );
  expect(useAuthStore.getState().user?.id).toBe("second");
  expect(useAuthStore.getState().workspaces).toBe(second);
  expect(state.navigate).not.toHaveBeenCalled();
});

it("routes registration by its explicit admission result", async () => {
  const cases = [
    [{ status: "joined", workspace, role: "VIEWER", alreadyMember: false }, { to: "/$workspaceSlug", params: { workspaceSlug: "acme" } }],
    [{ status: "approval_pending", workspace, requestId: "rq", requestedAt: "2026-10-27T00:00:00Z" }, { to: "/invite/$token", params: { token: "invite-token" } }],
    [{ status: "verification_required", workspace, email: "new@example.test" }, { to: "/invite/$token", params: { token: "invite-token" } }],
    [{ status: "denied", reason: "disabled", message: "Invites are currently disabled for this workspace" }, { to: "/invite/$token", params: { token: "invite-token" } }],
  ] as const;
  for (const [admission, target] of cases) {
    state.navigate.mockClear();
    respond("POST", "/api/auth/register", () =>
      json(201, {
        data: { user: user("new"), accessToken: "new-token", workspaces: admission.status === "joined" ? [membership("acme")] : [], admission },
      }),
    );
    const { result } = renderHook(() => useRegister("invite-token"), { wrapper });
    await act(() =>
      result.current.mutateAsync({ displayName: "New", email: "new@example.test", password: "Password-123" }),
    );
    expect(state.requests.at(-1)?.body).toMatchObject({ inviteToken: "invite-token" });
    expect(state.navigate).toHaveBeenCalledWith(target);
    expect(queryClient.getQueryData(["invite-admission", "new", "invite-token"])).toEqual(admission);
  }
});

it("continues from email verification only to the fixed invitation route", async () => {
  respond("POST", "/api/auth/verify-email/verify-token", () =>
    json(200, { data: { user: user("applicant") } }),
  );
  state.params = { token: "verify-token" };
  state.search = { invite: "abc123_-XYZ" };
  renderRoute(VerifyRoute);
  const link = await screen.findByRole("link", { name: "Continue to invitation" });
  expect(link.getAttribute("href")).toBe("/invite/abc123_-XYZ");
  cleanup();

  state.search = { invite: "https://attacker.example/" };
  renderRoute(VerifyRoute);
  await screen.findByText("Email verified");
  expect(screen.queryByRole("link", { name: "Continue to invitation" })).toBeNull();
});

it("keeps a pending explanation when a recheck fails for a transient reason", async () => {
  signIn();
  respond("POST", "/api/invites/invite-token/accept", () =>
    json(202, {
      data: { status: "approval_pending", workspace, requestId: "rq-1", requestedAt: "2026-10-27T00:00:00Z", userId: "applicant" },
    }),
  );
  renderRoute(InviteRoute);
  fireEvent.click(await screen.findByRole("button", { name: "Accept invite" }));
  await screen.findByText(/waiting for an administrator/);
  respond("POST", "/api/invites/invite-token/accept", () =>
    json(409, { statusCode: 409, error: "Conflict", message: "The workspace is busy. Please try again." }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "The workspace is busy. Please try again.",
  );
  expect(screen.getByText(/waiting for an administrator/)).toBeTruthy();
  expect(state.navigate).not.toHaveBeenCalled();
});

it("lets the server admit an existing member past an expired public preview", async () => {
  const joined = [membership("acme")];
  signIn("member", joined);
  respond("GET", "/api/invites/invite-token", () =>
    json(410, { statusCode: 410, error: "Gone", message: "This invite has expired" }),
  );
  respond("POST", "/api/invites/invite-token/accept", () =>
    json(200, {
      data: { status: "joined", workspace, role: "MEMBER", alreadyMember: true, userId: "member", workspaces: joined },
    }),
  );
  renderRoute(InviteRoute);
  expect(await screen.findByText("Invite expired")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check my access" }));
  await waitFor(() =>
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$workspaceSlug",
      params: { workspaceSlug: "acme" },
    }),
  );
});

it("rechecks a remembered registration refusal against current policy", async () => {
  signIn("new");
  const { rememberInviteAdmission } = await import("@/features/workspaces/api");
  rememberInviteAdmission("new", "invite-token", {
    status: "denied",
    reason: "member_limit",
    message: "This workspace has reached its member limit",
  });
  respond("POST", "/api/invites/invite-token/accept", () =>
    json(200, {
      data: { status: "joined", workspace, role: "MEMBER", alreadyMember: false, userId: "new", workspaces: [membership("acme")] },
    }),
  );
  renderRoute(InviteRoute);
  expect(await screen.findByText("This workspace has reached its member limit")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$workspaceSlug",
      params: { workspaceSlug: "acme" },
    }),
  );
});
