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
        return true;
      }
    },
    enableBeforeUnload: hasUnsavedChanges,
  });
  return null;
}
