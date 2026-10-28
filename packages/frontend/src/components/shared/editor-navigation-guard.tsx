import { useBlocker } from "@tanstack/react-router";

export function EditorNavigationGuard({
  beforeLeave,
  hasUnsavedChanges,
}: {
  beforeLeave: () => Promise<void>;
  hasUnsavedChanges: boolean;
}) {
  useBlocker({
    shouldBlockFn: async () => {
      try {
        await beforeLeave();
        return false;
      } catch {
        // The draft stays in this tab to restore later; never trap the user.
        return !window.confirm(
          "Your changes could not be saved. Leave anyway? They stay in this tab, and you can restore them when you reopen this item.",
        );
      }
    },
    enableBeforeUnload: hasUnsavedChanges,
  });
  return null;
}
