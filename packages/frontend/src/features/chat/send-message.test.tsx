import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSendMessage } from "./api";
import { MessageInput } from "./components/message-input";
import { MentionInput } from "./components/mention-input";

const { http, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      public statusCode: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { http: { post: vi.fn() }, ApiError };
});

vi.mock("@/lib/api-client", () => ({ api: http, ApiError }));

const stored = (id: string) => ({
  data: { id, channelId: "channel", parentId: null, content: "hello" },
});

function respond(result: Promise<unknown>) {
  return { json: () => result };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const sentKey = (call: number) => http.post.mock.calls[call][1].headers["Idempotency-Key"];

beforeEach(() => http.post.mockReset());
afterEach(cleanup);

describe("useSendMessage", () => {
  it("leaves the failure report to the caller instead of the client-wide error toast", async () => {
    const clientWideError = vi.fn();
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false, onError: clientWideError } },
    });
    const { result } = renderHook(() => useSendMessage("wid", "channel"), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    http.post.mockReturnValueOnce(respond(Promise.reject(new ApiError(500, "boom"))));
    await act(() => expect(result.current.mutateAsync({ content: "hello" })).rejects.toThrow("boom"));
    expect(clientWideError).not.toHaveBeenCalled();
  });

  it("resends an unconfirmed message with the same key and starts a new key after success", async () => {
    const { result } = renderHook(() => useSendMessage("wid", "channel"), { wrapper });
    http.post.mockReturnValueOnce(respond(Promise.reject(new TypeError("Failed to fetch"))));
    await act(() => expect(result.current.mutateAsync({ content: "hello" })).rejects.toThrow());

    http.post.mockReturnValueOnce(respond(Promise.resolve(stored("m1"))));
    await act(() => result.current.mutateAsync({ content: "hello" }));
    expect(sentKey(1)).toBe(sentKey(0));
    expect(sentKey(0)).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);

    http.post.mockReturnValueOnce(respond(Promise.resolve(stored("m2"))));
    await act(() => result.current.mutateAsync({ content: "hello" }));
    expect(sentKey(2)).not.toBe(sentKey(1));
  });

  it("uses a new key when the unconfirmed text or thread changes", async () => {
    const { result } = renderHook(() => useSendMessage("wid", "channel"), { wrapper });
    http.post.mockReturnValue(respond(Promise.reject(new ApiError(500, "boom"))));
    await act(() => expect(result.current.mutateAsync({ content: "hello" })).rejects.toThrow());
    await act(() => expect(result.current.mutateAsync({ content: "hello!" })).rejects.toThrow());
    await act(() =>
      expect(result.current.mutateAsync({ content: "hello!", parentId: "p" })).rejects.toThrow(),
    );
    expect(new Set([sentKey(0), sentKey(1), sentKey(2)]).size).toBe(3);
  });

  it("lets transient failures retry with the key and keeps other API errors final", async () => {
    const { result } = renderHook(() => useSendMessage("wid", "channel"), { wrapper });
    http.post.mockReturnValueOnce(respond(Promise.resolve(stored("m1"))));
    await act(() => result.current.mutateAsync({ content: "hello" }));
    const retry = http.post.mock.calls[0][1].retry;
    expect(retry.methods).toEqual(["post"]);
    expect(retry.retryOnTimeout).toBe(true);
    expect(retry.shouldRetry({ error: new ApiError(503, "down") })).toBe(true);
    expect(retry.shouldRetry({ error: new ApiError(409, "conflict") })).toBe(false);
    expect(retry.shouldRetry({ error: new ApiError(429, "slow down") })).toBe(false);
    expect(retry.shouldRetry({ error: new ApiError(403, "forbidden") })).toBe(false);
    expect(retry.shouldRetry({ error: new TypeError("Failed to fetch") })).toBeUndefined();
  });
});

describe.each([
  ["MessageInput", (onSend: (c: string) => Promise<unknown>) => <MessageInput onSend={onSend} />],
  ["MentionInput", (onSend: (c: string) => Promise<unknown>) => <MentionInput onSend={onSend} members={[]} />],
])("%s", (_name, renderInput) => {
  it("keeps the draft when the send is not confirmed and clears it once it is", async () => {
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const onSend = vi.fn(
      () => new Promise<void>((resolve, reject) => (settle = { resolve, reject })),
    );
    render(renderInput(onSend));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "draft text" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("draft text");
    // Locked while pending: nothing can be typed into, or resent from, the
    // draft that is already on its way.
    expect(box.disabled).toBe(true);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => settle.reject(new Error("offline")));
    expect(box.value).toBe("draft text");
    expect(box.disabled).toBe(false);

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(2);
    await act(async () => settle.resolve());
    expect(box.value).toBe("");
    expect(box.disabled).toBe(false);
  });
});
