// @vitest-environment node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { api, ApiError, mapApiErrorToForm } from "./api-client";
import { useAuthStore } from "@/stores/auth-store";
import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { queryClient } from "./query-client";

const alice = {
  id: "retry-alice",
  email: "retry@example.test",
  displayName: "Alice",
  avatarUrl: null,
  phone: null,
  jobTitle: null,
  timezone: null,
  emailVerified: true,
};
const methods = ["GET", "PUT", "DELETE", "POST", "PATCH"] as const;
const terminalStatuses = [400, 401, 403, 404, 409, 422, 429];
const conflict = {
  revision: 7,
  description: "stored description",
  updatedAt: "2026-10-31T00:00:00.000Z",
};
const errorBody = (status: number) => ({
  statusCode: status,
  error: "Request failed",
  message: "Keep the draft",
  details: [{ field: "description", message: "Invalid description" }],
  code: "REVISION_CONFLICT",
  current: conflict,
});
interface Dispatch {
  method: string;
  authorization: string | undefined;
  body: string;
  path: string;
}
let dispatches: Dispatch[];
let effects: number;
let base: string;
let handler: (request: IncomingMessage, response: ServerResponse) => void;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  dispatches.push({
    method: request.method!,
    authorization: request.headers.authorization,
    body,
    path: request.url!,
  });
  handler(request, response);
});
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Retry-After": "0",
  });
  response.end(JSON.stringify(body));
}
function send(method: string, options: Parameters<typeof api>[1] = {}) {
  // Use the exported client's real defaults. Only the destination changes.
  return api(new URL("resource", base), {
    method,
    ...(method === "GET" ? {} : { json: { description: "Alice draft" } }),
    ...options,
  }).json();
}
async function rejection(request: Promise<unknown>) {
  return request.then(
    () => {
      throw new Error("Expected rejection");
    },
    (error: unknown) => error,
  );
}
function signIn() {
  useAuthStore.setState({ user: alice, accessToken: "expired" });
}
function renew() {
  const refresh = vi.fn(async () => {
    useAuthStore.setState({ accessToken: "renewed" });
    return true;
  });
  useAuthStore.setState({ refresh });
  return refresh;
}

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  vi.stubEnv("VITE_API_BASE_URL", base.replace(/\/$/, ""));
});
beforeEach(() => {
  dispatches = [];
  effects = 0;
  useAuthStore.setState({ ...useAuthStore.getInitialState() });
});
afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe.each(methods)("%s default transport policy", (method) => {
  it.each(terminalStatuses)(
    "dispatches a terminal JSON %i once and retains error fields",
    async (status) => {
      handler = (_request, response) => {
        if (method !== "GET") effects++;
        json(response, status, errorBody(status));
      };
      const error = await rejection(send(method));
      expect({ dispatches: dispatches.length, effects }).toEqual({
        dispatches: 1,
        effects: method === "GET" ? 0 : 1,
      });
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject(errorBody(status));
      expect(mapApiErrorToForm(error)).toEqual({
        description: "Invalid description",
      });
    },
  );

  it.each([500, 502, 503, 504])(
    "does not replay after a server-applied operation returns %i",
    async (status) => {
      handler = (_request, response) => {
        if (method !== "GET") effects++;
        json(response, status, errorBody(status));
      };
      const error = await rejection(send(method));
      expect({ dispatches: dispatches.length, effects }).toEqual({
        dispatches: 1,
        effects: method === "GET" ? 0 : 1,
      });
      expect(error).toMatchObject({ statusCode: status });
    },
  );

  it("does not replay when the connection is lost after the server applies the operation", async () => {
    handler = (request) => {
      if (method !== "GET") effects++;
      request.socket.destroy();
    };
    await rejection(send(method));
    expect({ dispatches: dispatches.length, effects }).toEqual({
      dispatches: 1,
      effects: method === "GET" ? 0 : 1,
    });
  });

  it("refreshes an authenticated 401 and replays once with the same body and renewed token", async () => {
    signIn();
    const refresh = renew();
    handler = (request, response) => {
      if (request.headers.authorization === "Bearer expired")
        return json(response, 401, errorBody(401));
      if (method !== "GET") effects++;
      json(response, 200, { saved: true });
    };
    await expect(
      send(method, { context: { expectedUserId: alice.id } }),
    ).resolves.toEqual({ saved: true });
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((sent) => sent.authorization)).toEqual([
      "Bearer expired",
      "Bearer renewed",
    ]);
    expect(dispatches[1].body).toBe(dispatches[0].body);
    expect(dispatches.map((sent) => sent.method)).toEqual([method, method]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(effects).toBe(method === "GET" ? 0 : 1);
  });

  it.each([401, 403, 404, 409, 422, 503])(
    "a replay returning %i stays bounded and keeps ApiError fields",
    async (status) => {
      signIn();
      const refresh = renew();
      handler = (request, response) => {
        const expired = request.headers.authorization === "Bearer expired";
        if (!expired && method !== "GET") effects++;
        json(
          response,
          expired ? 401 : status,
          errorBody(expired ? 401 : status),
        );
      };
      const error = await rejection(send(method));
      expect(dispatches).toHaveLength(2);
      expect(effects).toBe(method === "GET" ? 0 : 1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject(errorBody(status));
      expect(mapApiErrorToForm(error)).toEqual({
        description: "Invalid description",
      });
    },
  );
});

it("keeps non-JSON failures as an ApiError without replay", async () => {
  handler = (_request, response) => {
    response.writeHead(400);
    response.end("not JSON");
  };
  const error = await rejection(send("GET"));
  expect(dispatches).toHaveLength(1);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ statusCode: 400, error: "Error" });
});

it("does not refresh a signed-out 401 or refresh endpoint 401", async () => {
  const refresh = vi.fn(async () => true);
  useAuthStore.setState({ refresh });
  handler = (_request, response) => json(response, 401, errorBody(401));
  await rejection(send("GET"));
  signIn();
  await rejection(api(new URL("auth/refresh", base)).json());
  expect(dispatches).toHaveLength(2);
  expect(refresh).not.toHaveBeenCalled();
});

it("does not let an explicit retry override restart a failed authentication replay", async () => {
  signIn();
  const refresh = renew();
  handler = (request, response) =>
    json(
      response,
      request.headers.authorization === "Bearer expired" ? 401 : 503,
      errorBody(503),
    );
  const error = await rejection(
    send("PUT", {
      retry: {
        limit: 2,
        methods: ["put"],
        shouldRetry: () => true,
        delay: () => 0,
      },
    }),
  );
  expect(dispatches).toHaveLength(2);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(error).toMatchObject({ statusCode: 503 });
});

it("does not replay an ambiguous network failure after authentication renewal", async () => {
  signIn();
  const refresh = renew();
  handler = (request, response) => {
    if (request.headers.authorization === "Bearer expired")
      return json(response, 401, errorBody(401));
    effects++;
    request.socket.destroy();
  };
  await rejection(
    send("PUT", {
      retry: {
        limit: 2,
        methods: ["put"],
        shouldRetry: () => true,
        delay: () => 0,
      },
    }),
  );
  expect(dispatches).toHaveLength(2);
  expect(effects).toBe(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("expires the same session once when refresh fails, without redispatch", async () => {
  signIn();
  const refresh = vi.fn(async () => false);
  const expireSession = vi.spyOn(useAuthStore.getState(), "expireSession");
  useAuthStore.setState({ refresh });
  handler = (_request, response) => json(response, 401, errorBody(401));
  const error = await rejection(send("GET"));
  expect(dispatches).toHaveLength(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(expireSession).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState().user).toBeNull();
  expect(error).toMatchObject({ statusCode: 401 });
});

it("preserves deliberate bounded retries for a mutation protected by an idempotency key", async () => {
  const keys = new Set<string>();
  handler = (request, response) => {
    const key = String(request.headers["idempotency-key"]);
    if (!keys.has(key)) {
      keys.add(key);
      effects++;
    }
    json(response, 503, errorBody(503));
  };
  await rejection(
    send("POST", {
      headers: { "Idempotency-Key": "one-message" },
      retry: {
        limit: 2,
        methods: ["post"],
        shouldRetry: ({ error }) =>
          error instanceof ApiError && error.statusCode === 503,
        delay: () => 0,
      },
    }),
  );
  expect(dispatches).toHaveLength(3);
  expect(effects).toBe(1);
});

it("the real auth store deduplicates simultaneous 401 refreshes and each request replays once", async () => {
  signIn();
  let refreshes = 0;
  handler = (request, response) => {
    if (request.url === "/api/auth/refresh") {
      refreshes++;
      setTimeout(
        () =>
          json(response, 200, {
            data: { user: alice, accessToken: "renewed", workspaces: [] },
          }),
        25,
      );
    } else if (request.headers.authorization === "Bearer expired") {
      json(response, 401, errorBody(401));
    } else {
      effects++;
      json(response, 200, { saved: true });
    }
  };
  await expect(Promise.all([send("POST"), send("PATCH")])).resolves.toEqual([
    { saved: true },
    { saved: true },
  ]);
  expect(refreshes).toBe(1);
  expect(dispatches).toHaveLength(5);
  expect(effects).toBe(2);
});

it.each([400, 401, 403, 404, 409, 422])(
  "the production QueryObserver does not repeat a terminal %i",
  async (status) => {
    handler = (_request, response) => json(response, status, errorBody(status));
    const observer = new QueryObserver(queryClient, {
      queryKey: ["retry-terminal", status],
      queryFn: () => send("GET"),
    });
    const result = await observer.refetch();
    observer.destroy();
    expect(result.isError).toBe(true);
    expect(dispatches).toHaveLength(1);
    expect(result.error).toMatchObject({ statusCode: status });
  },
);

it.each(["PUT", "DELETE"])(
  "a production %s mutation reports one error and applies one server operation",
  async (method) => {
    handler = (_request, response) => {
      effects++;
      json(response, 503, errorBody(503));
    };
    const onError = vi.fn();
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => send(method),
      onError,
    });
    await rejection(observer.mutate(undefined));
    expect({ dispatches: dispatches.length, effects }).toEqual({
      dispatches: 1,
      effects: 1,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    observer.reset();
  },
);

it("the production QueryObserver discards an old identity request without sending it again", async () => {
  signIn();
  let reached!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let held!: ServerResponse;
  handler = (_request, response) => {
    held = response;
    reached();
  };
  const observer = new QueryObserver(queryClient, {
    queryKey: ["retry-identity"],
    queryFn: () => send("GET"),
  });
  const pending = observer.refetch();
  await dispatched;
  useAuthStore.setState({
    user: { ...alice, id: "retry-bob" },
    accessToken: "bob",
  });
  json(held, 200, { stale: true });
  const result = await pending;
  observer.destroy();
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0].authorization).toBe("Bearer expired");
  expect(result.data).toBeUndefined();
  expect(queryClient.getQueryData(["retry-identity"])).toBeUndefined();
});
