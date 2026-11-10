import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { queryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth-store";
import {
  blobBytes,
  encodeCropDraw,
  installAvatarCanvas,
  setDecodedSize,
  type CropDraw,
} from "@/test/avatar-crop-canvas";
import { ProfileSettings } from "./profile-settings";

const transport = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  upload: vi.fn(),
}));
const route = vi.hoisted(() => ({ slug: "acme" }));

vi.mock("@/lib/api-client", () => ({
  api: { get: transport.get, patch: transport.patch },
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ workspaceSlug: route.slug }),
}));
vi.mock("@/features/uploads/api", () => ({
  useUploadFile: () => ({ mutate: transport.upload, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const originalBytes = Uint8Array.of(9, 8, 7, 6, 5, 4, 3, 2, 1);
let canvas: { draws: CropDraw[]; restore: () => void };

const profile = {
  id: "user-1",
  email: "ada@example.test",
  displayName: "Ada Lovelace",
  avatarUrl: null as string | null,
  jobTitle: null,
  phone: null,
  timezone: null,
  emailVerified: true,
};

function mount() {
  act(() => {
    useAuthStore.setState({
      user: profile,
      accessToken: "token",
      workspaces: [
        {
          id: "mem-1",
          workspaceId: "ws-1",
          role: "MEMBER",
          workspace: { id: "ws-1", name: "Acme", slug: "acme", logoUrl: null },
        },
      ],
      isHydrated: true,
    });
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProfileSettings />
    </QueryClientProvider>,
  );
}

async function choose() {
  await screen.findByRole("button", { name: "Upload" });
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: [new File([originalBytes], "photo.gif", { type: "image/gif" })],
    },
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Position your avatar",
  });
  expect(transport.upload).not.toHaveBeenCalled();
  const img = dialog.querySelector("img");
  if (!img) throw new Error("crop preview missing");
  setDecodedSize(img, 400, 200);
  fireEvent.load(img);
  await waitFor(() => {
    expect(
      (screen.getByRole("button", { name: "Save avatar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  return dialog;
}

beforeEach(() => {
  queryClient.clear();
  canvas = installAvatarCanvas();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:avatar-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  transport.get.mockReset();
  transport.patch.mockReset();
  transport.upload.mockReset();
  vi.mocked(toast.error).mockClear();
  transport.get.mockImplementation((path: string) => ({
    json: async () => {
      if (path !== "users/me") throw new Error(`unexpected ${path}`);
      return { data: profile };
    },
  }));
});

afterEach(() => {
  cleanup();
  canvas.restore();
  vi.restoreAllMocks();
  route.slug = "acme";
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

it("uploads the cropped picture from profile settings only after confirm", async () => {
  mount();
  const dialog = await choose();
  const frame = screen.getByRole("group", {
    name: "Drag or use arrow keys to position the picture",
  });
  fireEvent.pointerDown(frame, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  });
  fireEvent.pointerMove(frame, {
    pointerId: 1,
    button: 0,
    clientX: 70,
    clientY: 0,
  });
  fireEvent.pointerUp(frame, { pointerId: 1 });
  fireEvent.change(screen.getByRole("slider", { name: "Zoom" }), {
    target: { value: "2" },
  });
  expect(transport.upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save avatar" }));
  await waitFor(() => expect(transport.upload).toHaveBeenCalledTimes(1));
  const uploaded = transport.upload.mock.calls[0][0] as {
    file: File;
    purpose: string;
    workspaceId: string;
  };
  expect(uploaded.purpose).toBe("avatar");
  expect(uploaded.workspaceId).toBe("ws-1");
  expect(uploaded.file.type).toBe("image/png");
  expect(uploaded.file.name).toBe("avatar.png");
  const bytes = await blobBytes(uploaded.file);
  expect(bytes).toEqual(
    Array.from(
      encodeCropDraw({ sx: 100, sy: 50, sw: 100, sh: 100 }, "image/png"),
    ),
  );
  expect(bytes).not.toEqual(Array.from(originalBytes));
  expect(dialog.querySelector("[data-avatar-preview='circle']")).toBeTruthy();
});

it("drops an open profile crop when the workspace changes", async () => {
  mount();
  await choose();
  route.slug = "other";
  act(() => useAuthStore.setState({ workspaces: [] }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(transport.upload).not.toHaveBeenCalled();
});

it("uploads nothing when the profile crop is cancelled", async () => {
  mount();
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(transport.upload).not.toHaveBeenCalled();
  expect(canvas.draws).toHaveLength(0);
});
