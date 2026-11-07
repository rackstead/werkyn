import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RestoreSummary } from "@pm/shared";
import { useAuthStore } from "@/stores/auth-store";
// The app's own client, so its client-wide mutation error toast is in play.
import { queryClient as client } from "@/lib/query-client";
import { BackupSettings } from "./backup-settings";

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

// The export lists are not under test; the restore hooks, ky client and
// error parsing are.
vi.mock("@/features/projects/api", () => ({ useProjects: () => ({ data: { data: [] } }) }));
vi.mock("@/features/chat/api", () => ({ useChannels: () => ({ data: { data: [] } }) }));
vi.mock("@/features/wiki/api", () => ({ useWikiSpaces: () => ({ data: { data: [] } }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

let responses: Array<Response | Promise<Response>>;
let fetchRequest: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const paused = (seconds: number) =>
  json(
    429,
    {
      statusCode: 429,
      error: "Too Many Requests",
      message: `Backup uploads from your account are paused because a recent one was too slow. Try again in ${seconds} seconds.`,
      code: "BACKUP_UPLOAD_COOLDOWN",
    },
    { "Retry-After": String(seconds) },
  );

const summary: RestoreSummary = {
  projects: 0,
  statuses: 0,
  labels: 0,
  customFields: 0,
  tasks: 0,
  subtasks: 0,
  comments: 0,
  activityLogs: 0,
  channels: 0,
  messages: 0,
  reactions: 0,
  wikiSpaces: 1,
  wikiPages: 1,
  wikiComments: 0,
  images: 0,
  userMappings: [],
  warnings: [],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
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

function renderSettings() {
  render(
    <QueryClientProvider client={client}>
      <BackupSettings workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

const fileInput = () => screen.getByLabelText("Backup file") as HTMLInputElement;
const chooseFile = () =>
  fireEvent.change(fileInput(), {
    target: { files: [new File(["{}"], "backup.zip", { type: "application/zip" })] },
  });
const pausedText = (seconds: number) =>
  `Backup uploads from your account are paused because a recent one was too slow. You can upload again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;

it("counts a paused preview's wait down and keeps uploads from being sent until it passes", async () => {
  responses.push(paused(2));
  renderSettings();
  chooseFile();
  await screen.findByText(pausedText(2));
  expect(fileInput().disabled).toBe(true);
  expect(toast.error).not.toHaveBeenCalled();
  // The chosen file is cleared, so the same one can be chosen again later.
  expect(fileInput().value).toBe("");

  // Choosing a file during the wait sends nothing.
  chooseFile();
  act(() => vi.advanceTimersByTime(1000));
  screen.getByText(pausedText(1));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByText(/uploads from your account are paused/)).toBeNull();
  expect(fileInput().disabled).toBe(false);
  expect(fetchRequest).toHaveBeenCalledTimes(1);

  // After the wait the preview is sent and shown.
  responses.push(json(200, { data: summary }));
  chooseFile();
  await screen.findByText("Restore Preview");
  expect(fetchRequest).toHaveBeenCalledTimes(2);
});

it("a paused restore keeps its preview and disables Confirm Restore until the wait passes", async () => {
  responses.push(json(200, { data: summary }));
  renderSettings();
  chooseFile();
  await screen.findByText("Restore Preview");
  const confirm = () => screen.getByRole("button", { name: /Confirm Restore/ }) as HTMLButtonElement;

  responses.push(paused(120));
  fireEvent.click(confirm());
  await screen.findByText(pausedText(120));
  expect(confirm().disabled).toBe(true);
  expect(toast.error).not.toHaveBeenCalled();
  screen.getByText("Restore Preview");
  act(() => vi.advanceTimersByTime(119_000));
  screen.getByText(pausedText(1));
  act(() => vi.advanceTimersByTime(1000));
  expect(confirm().disabled).toBe(false);

  responses.push(json(200, { data: summary }));
  fireEvent.click(confirm());
  await screen.findByText("Restore Complete");
  expect(fetchRequest).toHaveBeenCalledTimes(3);
});

it("other refusals are shown once, as a toast without a countdown", async () => {
  responses.push(
    json(
      429,
      {
        statusCode: 429,
        error: "Too Many Requests",
        message: "A backup export or restore is already running for this workspace. Try again shortly.",
      },
      { "Retry-After": "30" },
    ),
  );
  renderSettings();
  chooseFile();
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "A backup export or restore is already running for this workspace. Try again shortly.",
    ),
  );
  // Once: the client-wide mutation error toast is not added to it.
  expect(toast.error).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/uploads from your account are paused/)).toBeNull();
  expect(fileInput().disabled).toBe(false);

  responses.push(
    json(408, {
      statusCode: 408,
      error: "Request Timeout",
      message: "The backup upload was too slow and was abandoned. Uploads must average at least 16384 bytes per second.",
    }),
  );
  chooseFile();
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "The backup upload was too slow and was abandoned. Uploads must average at least 16384 bytes per second.",
    ),
  );
  expect(toast.error).toHaveBeenCalledTimes(2);
  expect(fileInput().disabled).toBe(false);
});

it("a failure is still reported once the page has gone", async () => {
  let fail!: (response: Response) => void;
  responses.push(new Promise<Response>((resolve) => (fail = resolve)));
  renderSettings();
  chooseFile();
  await vi.waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(1));
  cleanup();
  fail(
    json(400, {
      statusCode: 400,
      error: "Bad Request",
      message: "Invalid backup ZIP: the archive is damaged or uses unsupported ZIP features",
    }),
  );
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Invalid backup ZIP: the archive is damaged or uses unsupported ZIP features",
    ),
  );
  expect(toast.error).toHaveBeenCalledTimes(1);
});
