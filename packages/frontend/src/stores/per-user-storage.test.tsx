import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Locally stored data that belongs to one account is kept under that
// account's key; data stored by earlier builds without an owner is removed.

function account(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    displayName: id,
    avatarUrl: null,
    jobTitle: null,
    phone: null,
    timezone: null,
    emailVerified: true,
  };
}

async function load() {
  vi.resetModules();
  const { useAuthStore } = await import("@/stores/auth-store");
  const { useRecentFiles } = await import("@/features/drive/hooks/use-recent-files");
  const { useEmojiStore } = await import("@/stores/emoji-store");
  const signIn = (id: string | null) =>
    act(() =>
      useAuthStore.setState({
        user: id ? account(id) : null,
        accessToken: id ? `${id}-token` : null,
      }),
    );
  return { useAuthStore, useRecentFiles, useEmojiStore, signIn };
}

const file = (name: string) => ({
  id: name,
  name,
  mimeType: null,
  isFolder: false,
  size: null,
  uploadedById: "uploader",
  uploadedBy: { id: "uploader", displayName: "Uploader", avatarUrl: null },
  updatedAt: "2026-10-29T00:00:00Z",
});

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it("removes recents and emoji usage stored without an owner", async () => {
  localStorage.setItem("drive-recent-ws-acme", JSON.stringify([file("old.pdf")]));
  localStorage.setItem("drive-recent-ws-beta", "[]");
  localStorage.setItem("pm-emoji", JSON.stringify({ state: { frequencyMap: { "🎉": 9 } } }));
  localStorage.setItem("pm-theme", JSON.stringify({ state: { theme: "dark" } }));
  await load();
  expect(Object.keys(localStorage).sort()).toEqual(["pm-theme"]);
});

it("keeps drive recents per account in a shared workspace", async () => {
  const { useRecentFiles, signIn } = await load();
  signIn("alice");
  const { result } = renderHook(() => useRecentFiles("ws-acme"));
  act(() => result.current.addRecent(file("alice-salary.pdf")));
  expect(result.current.recents.map((r) => r.name)).toEqual(["alice-salary.pdf"]);

  signIn(null);
  expect(result.current.recents).toEqual([]);
  signIn("bob");
  expect(result.current.recents).toEqual([]);
  act(() => result.current.addRecent(file("bob-plan.pdf")));

  signIn("alice");
  expect(result.current.recents.map((r) => r.name)).toEqual(["alice-salary.pdf"]);
  expect(Object.keys(localStorage).sort()).toEqual([
    "drive-recent:alice:ws-acme",
    "drive-recent:bob:ws-acme",
  ]);
});

it("keeps emoji usage per account", async () => {
  const { useEmojiStore, signIn } = await load();
  signIn("alice");
  act(() => {
    useEmojiStore.getState().recordUsage("🔒");
    useEmojiStore.getState().setSkinTone(3);
  });
  expect(useEmojiStore.getState().getRecentEmojis()).toEqual(["🔒"]);

  signIn("bob");
  expect(useEmojiStore.getState().getRecentEmojis()).toEqual([]);
  expect(useEmojiStore.getState().skinTone).toBe(0);
  signIn(null);
  expect(useEmojiStore.getState().getRecentEmojis()).toEqual([]);

  signIn("alice");
  expect(useEmojiStore.getState().getRecentEmojis()).toEqual(["🔒"]);
  expect(useEmojiStore.getState().skinTone).toBe(3);
});
