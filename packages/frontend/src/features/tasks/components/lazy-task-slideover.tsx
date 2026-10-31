import { Suspense, useEffect, type ComponentProps } from "react";
import { lazyNamed, whenIdle } from "@/lib/lazy-import";
import { LoadingPanel, useLazyPanelFocus } from "@/components/shared/lazy-panel";

// The task panel brings its own dependencies (dialog and animation libraries,
// drag and drop for subtasks, comments, attachments; the description editor is
// split again inside it), so views that list tasks load it separately.
const TaskSlideoverPanel = lazyNamed(
  () => import("./task-slideover"),
  "TaskSlideover",
);

type TaskSlideoverProps = Omit<ComponentProps<typeof TaskSlideoverPanel>, "onCloseAutoFocus">;

export function TaskSlideover(props: TaskSlideoverProps) {
  const focus = useLazyPanelFocus(props.onClose);
  return (
    <Suspense
      fallback={<LoadingPanel title="Loading task" {...focus} />}
    >
      <TaskSlideoverPanel {...props} {...focus} />
    </Suspense>
  );
}

/** Fetches the task panel once the view that can open it is idle. */
export function usePreloadTaskSlideover() {
  useEffect(() => whenIdle(TaskSlideoverPanel.preload), []);
}
