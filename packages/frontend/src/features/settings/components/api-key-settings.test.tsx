import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeySettings } from "./api-key-settings";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  reset: vi.fn(),
  revoke: vi.fn(),
  copy: vi.fn(),
  refetch: vi.fn(),
  isError: false,
}));
const secret = `wk_${"a".repeat(64)}`;

vi.mock("../api-keys", () => ({
  useApiKeys: () => ({
    data: {
      data: [
        {
          id: "key-1",
          name: "CI pipeline",
          prefix: "wk_aaaaaaaa",
          createdAt: "2026-01-01",
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        },
        {
          id: "key-2",
          name: "Old key",
          prefix: "wk_bbbbbbbb",
          createdAt: "2026-01-01",
          expiresAt: "2000-01-01",
          lastUsedAt: null,
          revokedAt: "2000-01-02",
        },
      ],
    },
    isLoading: false,
    isError: state.isError,
    refetch: state.refetch,
  }),
  useCreateApiKey: () => ({
    mutateAsync: state.create,
    reset: state.reset,
    isPending: false,
  }),
  useRevokeApiKey: () => ({ mutate: state.revoke, isPending: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.isError = false;
  state.create.mockResolvedValue({ data: { key: secret } });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: state.copy },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("API key settings", () => {
  it("defaults to 30 days", async () => {
    render(<ApiKeySettings />);
    expect(
      (screen.getByLabelText("Expires after") as HTMLSelectElement).value,
    ).toBe("30");
    fireEvent.change(screen.getByLabelText("Key name"), {
      target: { value: "Automation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith({
        name: "Automation",
        expiresInDays: 30,
      }),
    );
    await screen.findByLabelText("Your new API key");
  });

  it.each(["1", "7", "30", "90", "365", "never"])(
    "submits the selected %s lifetime",
    async (duration) => {
      render(<ApiKeySettings />);
      fireEvent.change(screen.getByLabelText("Key name"), {
        target: { value: " Agent " },
      });
      fireEvent.change(screen.getByLabelText("Expires after"), {
        target: { value: duration },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
      await waitFor(() =>
        expect(state.create).toHaveBeenCalledWith({
          name: "Agent",
          expiresInDays: duration === "never" ? null : Number(duration),
        }),
      );
      await screen.findByLabelText("Your new API key");
    },
  );

  it("shows the key once, supports copying, and clears the mutation result", async () => {
    render(<ApiKeySettings />);
    expect(screen.queryByLabelText("Your new API key")).toBeNull();
    fireEvent.change(screen.getByLabelText("Key name"), {
      target: { value: "Automation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    const input = (await screen.findByLabelText(
      "Your new API key",
    )) as HTMLInputElement;
    expect(input.value).toBe(secret);
    expect(input.readOnly).toBe(true);
    expect(state.reset).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));
    await waitFor(() => expect(state.copy).toHaveBeenCalledWith(secret));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Your new API key")).toBeNull();
    expect(document.body.textContent).not.toContain(secret);
  });

  it("requires confirmation before revoking and hides revoke for revoked keys", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ApiKeySettings />);
    expect(screen.queryByRole("button", { name: "Revoke Old key" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke CI pipeline" }));
    expect(state.revoke).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Revoke CI pipeline" }));
    expect(state.revoke).toHaveBeenCalledWith("key-1", expect.any(Object));
  });

  it("keeps the form usable after a failed creation", async () => {
    state.create.mockRejectedValue(new Error("Server unavailable"));
    render(<ApiKeySettings />);
    fireEvent.change(screen.getByLabelText("Key name"), {
      target: { value: "Retry me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("Your new API key")).toBeNull();
    expect((screen.getByLabelText("Key name") as HTMLInputElement).value).toBe(
      "Retry me",
    );
  });

  it("offers a retry when listing keys fails", () => {
    state.isError = true;
    render(<ApiKeySettings />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not load API keys",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.refetch).toHaveBeenCalledOnce();
  });
});
