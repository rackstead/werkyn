import { Suspense, useEffect, type ComponentProps } from "react";
import { lazyNamed, whenIdle } from "@/lib/lazy-import";
import { LoadingPanel } from "@/components/shared/lazy-panel";

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
      fallback={<LoadingPanel title="Loading task" onClose={props.onClose} />}
    >
      <TaskSlideoverPanel {...props} />
    </Suspense>
  );
}

/** Fetches the task panel once the view that can open it is idle. */
export function usePreloadTaskSlideover() {
  useEffect(() => whenIdle(TaskSlideoverPanel.preload), []);
}
