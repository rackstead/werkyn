import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "@/test/fake-websocket";
import { WebSocketClient } from "./websocket-client";

let client: WebSocketClient;
let socket: FakeWebSocket;

function subscriptionFrames() {
  return socket.sent.filter((frame) => frame.type !== "auth");
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  client = new WebSocketClient({
    url: "ws://test/api/ws",
    getToken: () => "token",
  });
  client.connect();
  socket = FakeWebSocket.latest();
  socket.accept();
});

afterEach(() => {
  client.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("event envelopes", () => {
  it("passes the whole server envelope to handlers", () => {
    const handler = vi.fn();
    client.on("task_updated", handler);
    socket.deliver({
      event: "task_updated",
      projectId: "project",
      data: { taskId: "task" },
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_updated",
        projectId: "project",
        data: { taskId: "task" },
      }),
    );
  });

  it.each([
    ["non-JSON text", "not json"],
    ["a JSON array", ["task_updated"]],
    ["a JSON string", '"task_updated"'],
    ["null", "null"],
    ["a non-string event", { event: 7, data: {} }],
    ["an empty event", { event: "", data: {} }],
    ["non-object data", { event: "task_updated", data: "task" }],
    ["null data", { event: "task_updated", data: null }],
    ["array data", { event: "task_updated", data: ["task"] }],
    ["a non-string scope", { event: "task_updated", projectId: 7, data: {} }],
  ])("ignores %s without throwing", (_label, frame) => {
    const handler = vi.fn();
    const wildcard = vi.fn();
    client.on("task_updated", handler);
    client.on("*", wildcard);
    expect(() => socket.deliver(frame)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(wildcard).not.toHaveBeenCalled();
  });

  it("ignores unknown events and keeps delivering known ones", () => {
    const handler = vi.fn();
    client.on("task_updated", handler);
    socket.deliver({ event: "made_up_event", data: { taskId: "task" } });
    socket.deliver({ event: "task_updated", projectId: "p", data: {} });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("gives an envelope without data an empty data object", () => {
    const handler = vi.fn();
    client.on("chat_message_deleted", handler);
    socket.deliver({ event: "chat_message_deleted", channelId: "c" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ data: {}, channelId: "c" }),
    );
  });

  it("isolates a failing handler from the other handlers of the event", () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(() => {
      throw new Error("broken consumer");
    });
    const healthy = vi.fn();
    client.on("wiki_page_updated", failing);
    client.on("wiki_page_updated", healthy);
    expect(() =>
      socket.deliver({
        event: "wiki_page_updated",
        workspaceId: "w",
        data: { page: { id: "page" } },
      }),
    ).not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    report.mockRestore();
  });
});

describe("shared subscriptions", () => {
  it("sends one subscribe per resource however many consumers hold it", async () => {
    client.subscribeWorkspace("workspace");
    client.subscribeWorkspace("workspace");
    client.unsubscribeWorkspace("workspace");
    await Promise.resolve();
    expect(subscriptionFrames()).toEqual([
      { type: "subscribe_workspace", workspaceId: "workspace" },
    ]);
    client.unsubscribeWorkspace("workspace");
    await Promise.resolve();
    expect(subscriptionFrames()).toEqual([
      { type: "subscribe_workspace", workspaceId: "workspace" },
      { type: "unsubscribe_workspace", workspaceId: "workspace" },
    ]);
  });

  it("does not churn when one consumer hands a resource to the next", async () => {
    client.subscribe("project");
    // A route transition releases the old view and mounts the next one in
    // the same commit.
    client.unsubscribe("project");
    client.subscribe("project");
    await Promise.resolve();
    expect(subscriptionFrames()).toEqual([
      { type: "subscribe", projectId: "project" },
    ]);
  });

  it("ignores a release of a resource nobody holds", async () => {
    client.unsubscribeChannel("channel");
    await Promise.resolve();
    client.subscribeChannel("channel");
    client.subscribeChannel("channel");
    client.unsubscribeChannel("channel");
    await Promise.resolve();
    expect(subscriptionFrames()).toEqual([
      { type: "subscribe_channel", channelId: "channel" },
    ]);
  });

  it("resubscribes only resources still held, once each, after a reconnect", async () => {
    vi.useFakeTimers();
    client.subscribe("kept");
    client.subscribe("kept");
    client.subscribe("released");
    client.unsubscribe("released");
    client.subscribeWorkspace("workspace");
    await Promise.resolve();
    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeWebSocket.latest();
    expect(next).not.toBe(socket);
    next.accept();
    expect(next.sent.filter((frame) => frame.type !== "auth")).toEqual([
      { type: "subscribe", projectId: "kept" },
      { type: "subscribe_workspace", workspaceId: "workspace" },
    ]);
  });
});
