import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "sonner";
import type { ReactNode } from "react";

let projects: typeof import("@/features/projects/api");
let subtasks: typeof import("@/features/subtasks/api");
let rows: ReturnType<typeof row>[];
let requests: Array<{ method: string; path: string; ids?: string[]; token?: string }>;
let hold: { response: ServerResponse; ids: string[] } | undefined;
let holdNext = false;
function row(id: string, position: number) {
  return { id, position, name: id, title: id, projectId: "p", taskId: "t", color: null,
    isCompletion: false, type: "TEXT", options: null, required: false, completed: false,
    assigneeId: null, assignee: null, dueDate: null,
    createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z" };
}
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  const ids = raw ? JSON.parse(raw).orderedIds as string[] : undefined;
  requests.push({ method: request.method!, path: request.url!, ids, token: request.headers.authorization });
  if (request.method === "GET") return json(response, 200, { data: rows });
  if (holdNext) { holdNext = false; hold = { response, ids: ids! }; return; }
  if (!ids || ids.length !== rows.length || new Set(ids).size !== rows.length || ids.some(id => !rows.some(r => r.id === id)))
    return json(response, 400, { statusCode: 400, error: "Bad Request", message: "The order must list every current item exactly once" });
  rows = ids.map((id, position) => ({ ...rows.find(r => r.id === id)!, position }));
  return json(response, 200, { data: rows });
});
const alice = { id: "reorder-alice", email: "alice@example.test", displayName: "Alice", avatarUrl: null,
  phone: null, jobTitle: null, timezone: null, emailVerified: true };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
function definition(kind: string) {
  if (kind === "statuses") return {
    key: queryKeys.statuses("p"), path: "/api/projects/p/statuses", method: "PATCH",
    useList: () => projects.useStatuses("p"),
    useOrder: () => { const m = projects.useReorderStatuses("p"); return (ids: string[]) => m.mutateAsync({ orderedIds: ids }); },
  };
  if (kind === "custom fields") return {
    key: queryKeys.customFields("p"), path: "/api/projects/p/custom-fields", method: "PATCH",
    useList: () => projects.useCustomFields("p"),
    useOrder: () => { const m = projects.useReorderCustomFields("p"); return (ids: string[]) => m.mutateAsync({ orderedIds: ids }); },
  };
  return { key: queryKeys.subtasks("t"), path: "/api/tasks/t/subtasks", method: "POST",
    useList: () => subtasks.useSubtasks("t"),
    useOrder: () => { const m = subtasks.useReorderSubtasks("t"); return (ids: string[]) => m.mutateAsync(ids); },
  };
}
function mounted(kind: string) {
  const d = definition(kind);
  const hook = renderHook(() => ({ data: d.useList().data?.data, order: d.useOrder() }), { wrapper });
  return { ...hook, d };
}
const ids = (data: { id: string }[] | undefined) => data?.map(r => r.id);
const reads = () => requests.filter(r => r.method === "GET");
const writes = () => requests.filter(r => r.method !== "GET");
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.stubEnv("VITE_API_BASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
  projects = await import("@/features/projects/api");
  subtasks = await import("@/features/subtasks/api");
});
beforeEach(() => {
  requests = []; rows = [row("a", 0), row("b", 1)]; holdNext = false; hold = undefined;
  useAuthStore.setState({ ...useAuthStore.getInitialState(), user: alice, accessToken: "alice-token" });
  queryClient.clear();
});
afterEach(() => {
  cleanup(); queryClient.clear(); vi.restoreAllMocks();
  hold?.response.end(); hold = undefined;
});
afterAll(async () => {
  vi.unstubAllEnvs(); server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe.each(["statuses", "custom fields", "subtasks"])("%s authoritative reorder recovery", kind => {
  it("refreshes a refused stale list and sends the next complete order", async () => {
    const error = vi.spyOn(toast, "error");
    const unrelated = vi.fn(async () => ({ data: ["unchanged"] }));
    await queryClient.fetchQuery({ queryKey: ["unrelated", "resource"], queryFn: unrelated });
    const hook = mounted(kind);
    await waitFor(() => expect(ids(hook.result.current.data)).toEqual(["a", "b"]));
    rows.push(row("c", 2));
    await act(async () => {
      await expect(hook.result.current.order(["b", "a"])).rejects.toMatchObject({ statusCode: 400, message: "The order must list every current item exactly once" });
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("The order must list every current item exactly once");
    await waitFor(() => expect(ids(hook.result.current.data)).toEqual(["a", "b", "c"]));
    expect(reads()).toHaveLength(2);
    expect(writes()).toEqual([{ method: hook.d.method, path: `${hook.d.path}/reorder`, ids: ["b", "a"], token: "Bearer alice-token" }]);
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(["unrelated", "resource"])?.isInvalidated).toBe(false);
    await act(async () => { await hook.result.current.order(["c", "a", "b"]); });
    await waitFor(() => expect(ids(hook.result.current.data)).toEqual(["c", "a", "b"]));
    expect(writes().map(r => r.ids)).toEqual([["b", "a"], ["c", "a", "b"]]);
    expect(reads()).toHaveLength(3); expect(error).toHaveBeenCalledTimes(1);
  });

  it("refreshes a successful order without adding a write retry", async () => {
    const error = vi.spyOn(toast, "error");
    const hook = mounted(kind);
    await waitFor(() => expect(ids(hook.result.current.data)).toEqual(["a", "b"]));
    await act(async () => { await hook.result.current.order(["b", "a"]); });
    await waitFor(() => expect(ids(hook.result.current.data)).toEqual(["b", "a"]));
    expect(writes()).toHaveLength(1); expect(reads()).toHaveLength(2); expect(error).not.toHaveBeenCalled();
  });

  it.each([{ switchAccount: true, lateStatus: 200 }, { switchAccount: false, lateStatus: 400 }])(
    "discards an old completion after identity change: %j", async ({ switchAccount, lateStatus }) => {
      const error = vi.spyOn(toast, "error");
      const old = mounted(kind);
      await waitFor(() => expect(ids(old.result.current.data)).toEqual(["a", "b"]));
      holdNext = true;
      let result: Promise<unknown>;
      act(() => { result = old.result.current.order(["b", "a"]).catch(e => e); });
      await waitFor(() => expect(hold).toBeDefined());
      old.unmount();
      act(() => useAuthStore.setState({ user: switchAccount ? { ...alice, id: "reorder-bob" } : null, accessToken: switchAccount ? "bob-token" : null }));
      rows = [row("new-account", 0)];
      const next = mounted(kind);
      await waitFor(() => expect(ids(next.result.current.data)).toEqual(["new-account"]));
      expect(await result!).toMatchObject({ name: "IdentityChangedError" });
      json(hold!.response, lateStatus, lateStatus === 200 ? { data: [row("old-completion", 0)] } : { statusCode: 400, message: "old refusal" });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      expect(ids(next.result.current.data)).toEqual(["new-account"]);
      expect(reads()).toHaveLength(2); expect(writes()).toHaveLength(1); expect(error).not.toHaveBeenCalled();
    },
  );
});
