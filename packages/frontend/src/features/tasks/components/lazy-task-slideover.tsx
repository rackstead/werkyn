import { Suspense, useEffect, type ComponentProps } from "react";
import { lazyNamed, whenIdle } from "@/lib/lazy-import";
import { LoadingSpinner } from "@/components/shared/lazy-load";

// The task panel brings its own dependencies (dialog and animation libraries,
// drag and drop for subtasks, comments, attachments; the description editor is
// split again inside it), so views that list tasks load it separately.
const TaskSlideoverPanel = lazyNamed(
  () => import("./task-slideover"),
  "TaskSlideover",
);

type TaskSlideoverProps = ComponentProps<typeof TaskSlideoverPanel>;

export function TaskSlideover(props: TaskSlideoverProps) {
  return (
    <Suspense
      fallback={
        <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl border-l bg-background shadow-xl">
          <LoadingSpinner label="Loading task…" />
        </div>
      }
    >
      <TaskSlideoverPanel {...props} />
    </Suspense>
  );
}

/** Fetches the task panel once the view that can open it is idle. */
export function usePreloadTaskSlideover() {
  useEffect(() => whenIdle(TaskSlideoverPanel.preload), []);
}
