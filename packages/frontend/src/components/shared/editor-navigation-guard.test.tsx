import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { EditorNavigationGuard } from "./editor-navigation-guard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function createEditorRoute(beforeLeave: () => Promise<void>) {
  const root = createRootRoute({ component: () => <Outlet /> });
  let router: ReturnType<typeof createRouter>;
  const edit = createRoute({
    getParentRoute: () => root,
    path: "/edit",
    component: () => (
      <>
        <EditorNavigationGuard beforeLeave={beforeLeave} hasUnsavedChanges />
        <div>Editing page</div>
        <button
          onClick={() => {
            void router.navigate({ to: "/other" as never });
          }}
        >
          Leave editor
        </button>
      </>
    ),
  });
  const other = createRoute({
    getParentRoute: () => root,
    path: "/other",
    component: () => <div>Other page</div>,
  });
  router = createRouter({
    routeTree: root.addChildren([edit, other]),
    history: createMemoryHistory({ initialEntries: ["/edit"] }),
    defaultPendingMinMs: 0,
  });
  await router.load();
  const screen = render(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByText("Editing page")).toBeTruthy());
  return { screen, router };
}

it("actual router navigation waits for save completion", async () => {
  let finish!: () => void;
  const saving = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const beforeLeave = vi.fn(() => saving);
  const { screen, router } = await createEditorRoute(beforeLeave);
  fireEvent.click(screen.getByText("Leave editor"));
  await waitFor(() => expect(beforeLeave).toHaveBeenCalledTimes(1));
  expect(router.state.location.pathname).toBe("/edit");
  await act(async () => {
    finish();
  });
  await waitFor(() => expect(screen.getByText("Other page")).toBeTruthy());
});

it("a failed save keeps the actual router on the editor and allows a successful retry", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const beforeLeave = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(undefined);
  const { screen, router } = await createEditorRoute(beforeLeave);
  fireEvent.click(screen.getByText("Leave editor"));
  await waitFor(() => expect(beforeLeave).toHaveBeenCalledTimes(1));
  expect(router.state.location.pathname).toBe("/edit");
  fireEvent.click(screen.getByText("Leave editor"));
  await waitFor(() => expect(screen.getByText("Other page")).toBeTruthy());
  expect(beforeLeave).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("a save that keeps failing still lets the user choose to leave", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const beforeLeave = vi.fn().mockRejectedValue(new Error("Forbidden"));
  const { screen } = await createEditorRoute(beforeLeave);
  fireEvent.click(screen.getByText("Leave editor"));
  await waitFor(() => expect(screen.getByText("Other page")).toBeTruthy());
  expect(confirm).toHaveBeenCalledTimes(1);
});
