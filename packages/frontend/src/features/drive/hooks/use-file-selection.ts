import { useState, useCallback, useRef } from "react";

export interface UseFileSelectionReturn {
  selectedIds: Set<string>;
  isSelected: (id: string) => boolean;
  toggle: (id: string, fileIds: string[], event?: React.MouseEvent) => void;
  toggleAll: (fileIds: string[]) => void;
  clear: () => void;
  /** Removes these files from the selection and keeps any others selected. */
  deselect: (ids: Iterable<string>) => void;
  count: number;
  allSelected: (fileIds: string[]) => boolean;
}

export function useFileSelection(): UseFileSelectionReturn {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedRef = useRef<string | null>(null);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  const toggle = useCallback(
    (id: string, fileIds: string[], event?: React.MouseEvent) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);

        if (event?.shiftKey && lastSelectedRef.current) {
          // Range select
          const lastIndex = fileIds.indexOf(lastSelectedRef.current);
          const currentIndex = fileIds.indexOf(id);
          if (lastIndex !== -1 && currentIndex !== -1) {
            const start = Math.min(lastIndex, currentIndex);
            const end = Math.max(lastIndex, currentIndex);
            for (let i = start; i <= end; i++) {
              next.add(fileIds[i]);
            }
            return next;
          }
        }

        // Checkbox clicks always toggle individually
        if (next.has(id)) next.delete(id);
        else next.add(id);

        return next;
      });
      lastSelectedRef.current = id;
    },
    [],
  );

  const toggleAll = useCallback(
    (fileIds: string[]) => {
      setSelectedIds((prev) => {
        const allCurrentlySelected = fileIds.length > 0 && fileIds.every((id) => prev.has(id));
        if (allCurrentlySelected) {
          return new Set();
        }
        return new Set(fileIds);
      });
    },
    [],
  );

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    lastSelectedRef.current = null;
  }, []);

  const deselect = useCallback((ids: Iterable<string>) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const allSelected = useCallback(
    (fileIds: string[]) =>
      fileIds.length > 0 && fileIds.every((id) => selectedIds.has(id)),
    [selectedIds],
  );

  return {
    selectedIds,
    isSelected,
    toggle,
    toggleAll,
    clear,
    deselect,
    count: selectedIds.size,
    allSelected,
  };
}
