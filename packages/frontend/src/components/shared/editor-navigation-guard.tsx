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
        // The draft stays queued in this tab for retry; never trap the user.
        return !window.confirm(
          "Your changes could not be saved. Leave anyway? You can retry the unsaved changes when you reopen this item in this tab.",
        );
      }
    },
    enableBeforeUnload: hasUnsavedChanges,
  });
  return null;
}
