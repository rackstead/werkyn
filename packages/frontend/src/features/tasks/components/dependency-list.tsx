import { useState, useRef, useEffect } from "react";
import { Link2, X, Plus, Search } from "lucide-react";
import {
  useAddDependency,
  useRemoveDependency,
  useProjectTasks,
  type TaskDetail,
} from "../api";

interface DependencyListProps {
  task: TaskDetail;
  canEdit: boolean;
}

export function DependencyList({ task, canEdit }: DependencyListProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addDep = useAddDependency(task.id, task.projectId);
  const removeDep = useRemoveDependency(task.id, task.projectId);

  const { data: tasksData } = useProjectTasks(task.projectId);
  const allTasks = tasksData?.data ?? [];

  // Focus input when picker opens
  useEffect(() => {
    if (showPicker) {
      inputRef.current?.focus();
    }
  }, [showPicker]);

  // Close picker on escape (stop propagation so slideover doesn't also close)
  useEffect(() => {
    if (!showPicker) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowPicker(false);
        setSearch("");
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [showPicker]);

  // Existing dependency task IDs
  const blockedByIds = new Set(
    (task.blockedBy ?? []).map((d) => d.blockingTask.id),
  );
  const blockingIds = new Set(
    (task.blocking ?? []).map((d) => d.blockedTask.id),
  );

  // Filter picker results
  const pickerTasks = allTasks.filter((t) => {
    if (t.id === task.id) return false;
    if (blockedByIds.has(t.id)) return false;
    if (!search) return true;
    return t.title.toLowerCase().includes(search.toLowerCase());
  });

  const handleAdd = (blockingTaskId: string) => {
    addDep.mutate(blockingTaskId);
    setShowPicker(false);
    setSearch("");
  };

  const blockedBy = task.blockedBy ?? [];
  const blocking = task.blocking ?? [];

  if (!canEdit && blockedBy.length === 0 && blocking.length === 0) {
    return null;
  }

  return (
    <div>
      <h3 className="text-sm font-medium mb-2 text-muted-foreground flex items-center gap-1.5">
        <Link2 className="h-3.5 w-3.5" />
        Dependencies
      </h3>

      {/* Blocked by */}
      {blockedBy.length > 0 && (
        <div className="mb-2">
          <p className="text-xs text-muted-foreground mb-1">Blocked by</p>
          <div className="space-y-1">
            {blockedBy.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{dep.blockingTask.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dep.blockingTask.status.name}
                  </span>
                </div>
                {canEdit && (
                  <button
                    onClick={() =>
                      removeDep.mutate({
                        depId: dep.id,
                        blockingTaskId: dep.blockingTask.id,
                      })
                    }
                    className="shrink-0 ml-2 rounded p-0.5 hover:bg-accent transition-colors"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blocking */}
      {blocking.length > 0 && (
        <div className="mb-2">
          <p className="text-xs text-muted-foreground mb-1">Blocking</p>
          <div className="space-y-1">
            {blocking.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
              >
                <span className="truncate">{dep.blockedTask.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {dep.blockedTask.status.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add button / picker */}
      {canEdit && (
        <div className="relative">
          {!showPicker ? (
            <button
              onClick={() => setShowPicker(true)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add dependency
            </button>
          ) : (
            <div className="rounded-md border bg-popover shadow-md">
              <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  ref={inputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tasks..."
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  onClick={() => {
                    setShowPicker(false);
                    setSearch("");
                  }}
                  className="rounded p-0.5 hover:bg-accent transition-colors"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto p-1">
                {pickerTasks.length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    No tasks found
                  </p>
                ) : (
                  pickerTasks.slice(0, 20).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => handleAdd(t.id)}
                      className="w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                    >
                      {t.title}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
