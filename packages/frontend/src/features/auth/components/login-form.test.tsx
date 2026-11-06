import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { retryAfterSeconds } from "@/lib/api-error";
import { LoginForm } from "./login-form";

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

// The form's links and navigation are not under test; the real hook, ky
// client and error parsing are.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/router", () => ({ router: { invalidate: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

let client: QueryClient;
let responses: Response[];
let fetchRequest: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const tooMany = (seconds: number) =>
  json(
    429,
    {
      statusCode: 429,
      error: "Too Many Requests",
      message: `Too many sign-in attempts. Try again in ${seconds} seconds.`,
    },
    { "Retry-After": String(seconds) },
  );

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

function renderForm() {
  render(
    <QueryClientProvider client={client}>
      <LoginForm />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "person@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "Some-password-1" },
  });
}

const submit = () => fireEvent.click(screen.getByRole("button"));
const disabled = () =>
  (screen.getByRole("button") as HTMLButtonElement).disabled;

it("counts a 429 Retry-After wait down and keeps the form from sending until it passes", async () => {
  responses.push(tooMany(3));
  renderForm();
  submit();
  await screen.findByText("Too many sign-in attempts. Try again in 3 seconds.");
  expect(disabled()).toBe(true);
  // The server's own message is not shown twice.
  expect(screen.getAllByText(/Too many sign-in attempts/)).toHaveLength(1);

  // Submitting during the wait sends nothing.
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  act(() => vi.advanceTimersByTime(1000));
  screen.getByText("Too many sign-in attempts. Try again in 2 seconds.");
  act(() => vi.advanceTimersByTime(1000));
  screen.getByText("Too many sign-in attempts. Try again in 1 second.");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByText(/Too many sign-in attempts/)).toBeNull();
  expect(disabled()).toBe(false);
  expect(fetchRequest).toHaveBeenCalledTimes(1);

  // After the wait the next attempt is sent and its answer shown.
  responses.push(
    json(401, {
      statusCode: 401,
      error: "Unauthorized",
      message: "Invalid email or password",
    }),
  );
  submit();
  await screen.findByText("Invalid email or password");
  expect(fetchRequest).toHaveBeenCalledTimes(2);
  expect(disabled()).toBe(false);
});

it("a later 429 restarts the count with its own wait", async () => {
  responses.push(tooMany(2));
  renderForm();
  submit();
  await screen.findByText("Too many sign-in attempts. Try again in 2 seconds.");
  act(() => vi.advanceTimersByTime(2000));
  await waitFor(() => expect(disabled()).toBe(false));
  responses.push(tooMany(60));
  submit();
  await screen.findByText("Too many sign-in attempts. Try again in 60 seconds.");
  expect(disabled()).toBe(true);
});

it("a 429 without Retry-After shows the server's message and does not block the form", async () => {
  responses.push(
    json(429, {
      statusCode: 429,
      error: "Rate limit exceeded, retry in 1 minute",
      message: "Rate limit exceeded, retry in 1 minute",
    }),
  );
  renderForm();
  submit();
  await screen.findByText("Rate limit exceeded, retry in 1 minute");
  expect(disabled()).toBe(false);
});

it("reads Retry-After as delay seconds or an HTTP date", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(retryAfterSeconds("17", now)).toBe(17);
  expect(retryAfterSeconds(" 0 ", now)).toBe(0);
  expect(retryAfterSeconds("Thu, 05 Nov 2026 12:00:30 GMT", now)).toBe(30);
  expect(retryAfterSeconds("Thu, 05 Nov 2026 11:59:00 GMT", now)).toBe(0);
  expect(retryAfterSeconds(null, now)).toBeUndefined();
  expect(retryAfterSeconds("soon", now)).toBeUndefined();
  expect(retryAfterSeconds("-5", now)).toBeUndefined();
});
