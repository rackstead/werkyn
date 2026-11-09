import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AVATAR_OUTPUT_SIZE } from "@/components/shared/avatar-crop";
import { useAuthStore } from "@/stores/auth-store";
import {
  blobBytes,
  encodeCropDraw,
  installAvatarCanvas,
  setDecodedSize,
  type CropDraw,
} from "@/test/avatar-crop-canvas";
import { Topbar } from "./topbar";

const transport = vi.hoisted(() => ({ upload: vi.fn(), patch: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ workspaceSlug: "acme" }),
}));
vi.mock("@/components/shared/theme-toggle", () => ({
  ThemeToggle: () => null,
}));
vi.mock("@/features/notifications/components/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("@/features/search/components/search-command", () => ({
  SearchCommand: () => null,
}));
vi.mock("@/features/uploads/api", () => ({
  useUploadFile: () => ({ mutateAsync: transport.upload, isPending: false }),
}));
vi.mock("@/lib/api-client", () => ({ api: { patch: transport.patch } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const savedUrl = "https://cdn.example.test/avatar.png";
const originalBytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
let canvas: { draws: CropDraw[]; restore: () => void };

function membership() {
  return {
    id: "mem-1",
    workspaceId: "ws-1",
    role: "MEMBER" as const,
    workspace: { id: "ws-1", name: "Acme", slug: "acme", logoUrl: null },
  };
}

function mount() {
  act(() => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "ada@example.test",
        displayName: "Ada Lovelace",
        avatarUrl: "/uploads/old.png",
        jobTitle: null,
        phone: null,
        timezone: null,
        emailVerified: true,
      },
      accessToken: "token",
      workspaces: [membership()],
      isHydrated: true,
    });
  });
  return render(<Topbar />);
}

async function choose(type: string, name: string) {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([originalBytes], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
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
  expect(dialog.querySelector("[data-avatar-crop='square']")).toBeTruthy();
  expect(dialog.querySelector("[data-avatar-preview='circle']")).toBeTruthy();
  expect(transport.upload).not.toHaveBeenCalled();
  return file;
}

function reposition() {
  const frame = screen.getByRole("group", {
    name: "Drag to position the picture",
  });
  const zoom = screen.getByRole("slider", { name: "Zoom" });
  zoom.focus();
  expect(document.activeElement).toBe(zoom);
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
  fireEvent.pointerUp(frame, {
    pointerId: 1,
    button: 0,
    clientX: 70,
    clientY: 0,
  });
  fireEvent.change(zoom, { target: { value: "2" } });
}

beforeEach(() => {
  canvas = installAvatarCanvas();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:avatar-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  transport.upload.mockReset();
  transport.patch.mockReset();
  transport.upload.mockResolvedValue({ data: { url: savedUrl } });
  transport.patch.mockImplementation(() => ({
    json: async () => ({ data: { id: "user-1", avatarUrl: savedUrl } }),
  }));
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  canvas.restore();
  vi.restoreAllMocks();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

it.each([
  ["image/gif", "photo.gif", "image/png", "avatar.png"],
  ["image/jpeg", "photo.jpg", "image/jpeg", "avatar.jpg"],
  ["image/webp", "photo.webp", "image/png", "avatar.png"],
])(
  "uploads the positioned crop on confirm, not the original %s file",
  async (type, name, output, outputName) => {
    mount();
    const original = await choose(type, name);
    reposition();
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
    expect(uploaded.file).not.toBe(original);
    expect(uploaded.file.type).toBe(output);
    expect(uploaded.file.name).toBe(outputName);
    const bytes = await blobBytes(uploaded.file);
    expect(bytes).toEqual(
      Array.from(encodeCropDraw({ sx: 100, sy: 50, sw: 100, sh: 100 }, output)),
    );
    expect(bytes).not.toEqual(Array.from(originalBytes));
    expect(canvas.draws).toHaveLength(1);
    expect(canvas.draws[0]).toMatchObject({
      sx: 100,
      sy: 50,
      sw: 100,
      sh: 100,
      dw: AVATAR_OUTPUT_SIZE,
      dh: AVATAR_OUTPUT_SIZE,
      mime: output,
    });
    expect(transport.patch).toHaveBeenCalledWith("users/me", {
      json: { avatarUrl: savedUrl },
      context: { expectedUserId: "user-1" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useAuthStore.getState().user?.avatarUrl).toBe(savedUrl);
    expect(toast.success).toHaveBeenCalledWith("Avatar updated");
  },
);

it("does not upload when the crop is cancelled", async () => {
  mount();
  await choose("image/png", "photo.png");
  reposition();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(transport.upload).not.toHaveBeenCalled();
  expect(transport.patch).not.toHaveBeenCalled();
  expect(useAuthStore.getState().user?.avatarUrl).toBe("/uploads/old.png");
});

it("does not upload when Escape closes the dialog", async () => {
  mount();
  await choose("image/png", "photo.png");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(transport.upload).not.toHaveBeenCalled();
  expect(useAuthStore.getState().user?.avatarUrl).toBe("/uploads/old.png");
});

it("does not upload when the dialog is closed", async () => {
  mount();
  await choose("image/png", "photo.png");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(transport.upload).not.toHaveBeenCalled();
});

it("does not upload the original when the picture cannot be encoded", async () => {
  mount();
  await choose("image/png", "photo.png");
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
  fireEvent.click(screen.getByRole("button", { name: "Save avatar" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Could not prepare the avatar image",
    ),
  );
  expect(transport.upload).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(useAuthStore.getState().user?.avatarUrl).toBe("/uploads/old.png");
});

it("refuses an original over the size limit without uploading", () => {
  mount();
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([Uint8Array.of(1)], "big.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 + 1 });
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(toast.error).toHaveBeenCalledWith(
    "Avatar images must be 5 MB or smaller",
  );
  expect(transport.upload).not.toHaveBeenCalled();
});

it("refuses a type the upload rejects", () => {
  mount();
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: [
        new File([Uint8Array.of(1)], "mark.svg", { type: "image/svg+xml" }),
      ],
    },
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(toast.error).toHaveBeenCalledWith(
    "Avatar must be a JPEG, PNG, GIF, or WebP image",
  );
  expect(transport.upload).not.toHaveBeenCalled();
});

it("leaves the avatar in place when the upload fails", async () => {
  transport.upload.mockRejectedValueOnce(new Error("disk full"));
  mount();
  await choose("image/png", "photo.png");
  fireEvent.click(screen.getByRole("button", { name: "Save avatar" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Failed to upload avatar"),
  );
  expect(transport.patch).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(useAuthStore.getState().user?.avatarUrl).toBe("/uploads/old.png");
});
