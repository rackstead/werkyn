import { create } from "zustand";
import { persist } from "zustand/middleware";
import { onIdentityChange } from "@/lib/identity";
import { useAuthStore } from "@/stores/auth-store";

interface EmojiState {
  frequencyMap: Record<string, number>;
  skinTone: number;
  recordUsage: (emoji: string) => void;
  setSkinTone: (tone: number) => void;
  getRecentEmojis: () => string[];
}

const MAX_RECENT = 24;
const EMPTY = { frequencyMap: {}, skinTone: 0 };
// Usage was once stored for the whole browser, whoever was signed in. It has
// no owner, so it is removed rather than given to the next account.
const LEGACY_STORAGE_KEY = "pm-emoji";
const SIGNED_OUT_STORAGE_KEY = "pm-emoji:signed-out";

export const useEmojiStore = create<EmojiState>()(
  persist(
    (set, get) => ({
      ...EMPTY,
      recordUsage: (emoji: string) => {
        set((state) => ({
          frequencyMap: {
            ...state.frequencyMap,
            [emoji]: (state.frequencyMap[emoji] ?? 0) + 1,
          },
        }));
      },
      setSkinTone: (tone: number) => {
        set({ skinTone: tone });
      },
      getRecentEmojis: () => {
        const { frequencyMap } = get();
        return Object.entries(frequencyMap)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_RECENT)
          .map(([emoji]) => emoji);
      },
    }),
    {
      name: SIGNED_OUT_STORAGE_KEY,
      // Loaded per account by loadUsageFor below.
      skipHydration: true,
      // Each account starts from nothing, never from the previous account.
      merge: (persisted, current) => ({
        ...current,
        ...EMPTY,
        ...(persisted as Partial<EmojiState> | undefined),
      }),
    },
  ),
);

/** Points the store at one account's saved usage and loads it. */
function loadUsageFor(userId: string | null) {
  useEmojiStore.persist.setOptions({
    name: userId ? `pm-emoji:${userId}` : SIGNED_OUT_STORAGE_KEY,
  });
  void useEmojiStore.persist.rehydrate();
}

try {
  localStorage.removeItem(LEGACY_STORAGE_KEY);
} catch {
  // Storage unavailable
}
loadUsageFor(useAuthStore.getState().user?.id ?? null);
onIdentityChange(({ userId }) => loadUsageFor(userId));
