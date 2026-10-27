import type { ComponentType, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  token: "public-test-token",
  grants: {} as Record<string, boolean>,
  unprotected: {} as Record<string, boolean>,
  failGet: {} as Record<string, boolean>,
  failAfterValidation: false,
  pendingVerification: null as Promise<void> | null,
  gets: [] as string[],
  posts: [] as string[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ token: state.token }),
  }),
}));
vi.mock("@/features/wiki/components/wiki-editor", () => ({
  WikiEditor: ({ initialContent }: { initialContent: unknown }) => (
    <div>{JSON.stringify(initialContent)}</div>
  ),
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    get: (resource: string) => ({
      json: async () => {
        state.gets.push(resource);
        const [, kind, token] = resource.split("/");
        const key = `${kind}/${token}`;
        if (state.failGet[key]) throw new Error("Metadata unavailable");
        const authorized = Boolean(state.unprotected[key] || state.grants[key]);
        if (kind === "wiki")
          return {
            data: authorized
              ? {
                  authorized: true,
                  hasPassword: !state.unprotected[key],
                  page: {
                    id: "page",
                    title: `Protected wiki ${token}`,
                    content: { secret: "wiki-body" },
                    icon: null,
                    updatedAt: "2026-10-27T00:00:00Z",
                    lastEditedBy: null,
                  },
                }
              : { authorized: false, hasPassword: true, page: null },
          };
        return {
          data: authorized
            ? {
                authorized: true,
                hasPassword: !state.unprotected[key],
                files: [
                  {
                    file: {
                      id: "file",
                      name: `Protected file ${token}`,
                      mimeType: "text/plain",
                      size: 12,
                    },
                  },
                ],
                createdBy: {
                  id: "owner",
                  displayName: "Share owner",
                  avatarUrl: null,
                },
                createdAt: "2026-10-27T00:00:00Z",
              }
            : {
                authorized: false,
                hasPassword: !state.unprotected[key],
                files: [],
                createdBy: null,
                createdAt: null,
              },
        };
      },
    }),
    post: (resource: string, options: { json: { password: string } }) => ({
      json: async () => {
        state.posts.push(resource);
        await state.pendingVerification;
        if (options.json.password !== "correct")
          throw new Error("Invalid password");
        const [, kind, token] = resource.split("/");
        state.grants[`${kind}/${token}`] = true;
        if (state.failAfterValidation) state.failGet[`${kind}/${token}`] = true;
        return { data: { valid: true } };
      },
    }),
  },
}));

import { Route as WikiRoute } from "./share.$token";
import { Route as FilesRoute } from "./share.files.$token";

beforeEach(() => {
  state.token = "public-test-token";
  state.grants = {};
  state.unprotected = {};
  state.failGet = {};
  state.failAfterValidation = false;
  state.pendingVerification = null;
  state.gets = [];
  state.posts = [];
});
afterEach(cleanup);

for (const [kind, route, queryKey, content] of [
  ["wiki", WikiRoute, "wiki-public", "Protected wiki"],
  ["files", FilesRoute, "public-file-share", "Protected file"],
] as const) {
  describe(`${kind} public password UI`, () => {
    const View = route.options.component as ComponentType;
    function setup(
      client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
    ) {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      return { ...render(<View />, { wrapper }), client };
    }

    it("renders only locked metadata until server verification refetches authorized content", async () => {
      setup();
      await screen.findByText("Password required");
      expect(screen.queryByText(`${content} ${state.token}`)).toBeNull();
      fireEvent.change(screen.getByPlaceholderText("Enter password"), {
        target: { value: "correct" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: kind === "wiki" ? "View page" : "View files",
        }),
      );
      await screen.findByText(`${content} ${state.token}`);
      expect(state.posts).toEqual([`public/${kind}/${state.token}/validate`]);
      expect(
        state.gets.filter(
          (resource) => resource === `public/${kind}/${state.token}`,
        ).length,
      ).toBeGreaterThanOrEqual(2);
      if (kind === "files")
        expect(screen.getByRole("link").getAttribute("href")).toBe(
          `/api/public/files/${state.token}/file/download`,
        );
    });

    it("wrong password preserves the server gate and shows verification error", async () => {
      setup();
      await screen.findByText("Password required");
      fireEvent.change(screen.getByPlaceholderText("Enter password"), {
        target: { value: "wrong" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: kind === "wiki" ? "View page" : "View files",
        }),
      );
      await screen.findByText("Invalid password");
      expect(screen.queryByText(`${content} ${state.token}`)).toBeNull();
      expect(state.gets).toHaveLength(1);
    });

    it("a revoked grant refetch returns to the password gate without a stale local authenticated flag", async () => {
      state.grants[`${kind}/${state.token}`] = true;
      const { client } = setup();
      await screen.findByText(`${content} ${state.token}`);
      state.grants[`${kind}/${state.token}`] = false;
      await act(async () => {
        await client.refetchQueries({ queryKey: [queryKey, state.token] });
      });
      await screen.findByText("Password required");
      expect(screen.queryByText(`${content} ${state.token}`)).toBeNull();
    });

    it("unprotected shares render without verification", async () => {
      state.unprotected[`${kind}/${state.token}`] = true;
      setup();
      await screen.findByText(`${content} ${state.token}`);
      expect(screen.queryByText("Password required")).toBeNull();
      expect(state.posts).toEqual([]);
    });

    it("verification for a previous token cannot unlock the current token", async () => {
      let release!: () => void;
      state.pendingVerification = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { rerender } = setup();
      await screen.findByText("Password required");
      const oldToken = state.token;
      fireEvent.change(screen.getByPlaceholderText("Enter password"), {
        target: { value: "correct" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: kind === "wiki" ? "View page" : "View files",
        }),
      );
      await waitFor(() => expect(state.posts).toHaveLength(1));
      state.token = "next-share-token";
      rerender(<View />);
      await screen.findByText("Password required");
      release();
      await waitFor(() =>
        expect(
          (screen.getByPlaceholderText("Enter password") as HTMLInputElement)
            .value,
        ).toBe(""),
      );
      expect(screen.queryByText(`${content} ${oldToken}`)).toBeNull();
      expect(screen.queryByText(`${content} ${state.token}`)).toBeNull();
      expect(state.grants[`${kind}/${state.token}`]).toBeUndefined();
    });

    it("a failed metadata refetch after verification reveals no protected content and can recover", async () => {
      state.failAfterValidation = true;
      const { client } = setup();
      await screen.findByText("Password required");
      fireEvent.change(screen.getByPlaceholderText("Enter password"), {
        target: { value: "correct" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: kind === "wiki" ? "View page" : "View files",
        }),
      );
      await screen.findByText(
        kind === "wiki" ? "Page not found" : "Share not found",
      );
      expect(screen.queryByText(`${content} ${state.token}`)).toBeNull();
      delete state.failGet[`${kind}/${state.token}`];
      await act(async () => {
        await client.refetchQueries({ queryKey: [queryKey, state.token] });
      });
      await screen.findByText(`${content} ${state.token}`);
    });

    it("unmount discards protected query content and reopening checks the server again", async () => {
      state.grants[`${kind}/${state.token}`] = true;
      const { client, unmount } = setup();
      await screen.findByText(`${content} ${state.token}`);
      unmount();
      await waitFor(() =>
        expect(client.getQueryData([queryKey, state.token])).toBeUndefined(),
      );
      state.grants[`${kind}/${state.token}`] = false;
      setup(client);
      await screen.findByText("Password required");
      expect(screen.queryByText(`${content} ${state.token}`)).toBeNull();
    });
  });
}
