import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { ForgotPasswordForm } from "./forgot-password-form";

vi.hoisted(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://localhost/api");
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      addEventListener() {}
      postMessage() {}
    },
  );
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/router", () => ({ router: { invalidate: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

let client: QueryClient;
let responses: Response[];
let fetchRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  responses = [];
  fetchRequest = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  vi.stubGlobal("fetch", fetchRequest);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const disabled = () =>
  (screen.getByRole("button") as HTMLButtonElement).disabled;

it("counts a 429 Retry-After wait down, sends nothing meanwhile, then accepts the request", async () => {
  responses.push(
    new Response(
      JSON.stringify({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Too many password reset requests right now. Try again in 2 seconds.",
      }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "2" } },
    ),
  );
  render(
    <QueryClientProvider client={client}>
      <ForgotPasswordForm />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "person@example.test" },
  });
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Too many requests. Try again in 2 seconds.");
  expect(disabled()).toBe(true);
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  act(() => vi.advanceTimersByTime(1000));
  screen.getByText("Too many requests. Try again in 1 second.");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByText(/Too many requests/)).toBeNull();
  expect(disabled()).toBe(false);
  expect(fetchRequest).toHaveBeenCalledTimes(1);

  responses.push(
    new Response(
      JSON.stringify({ message: "If an account exists, a reset link has been sent." }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Check your inbox");
  expect(fetchRequest).toHaveBeenCalledTimes(2);
});
