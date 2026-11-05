import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMyTasks } from "@/features/my-tasks/api";
import { LoadMoreButton } from "@/components/shared/load-more-button";

interface TaskSelectorProps {
  workspaceId: string;
  taskId: string | null;
  onChange: (taskId: string | null, label: string | null) => void;
}

export function TaskSelector({
  workspaceId,
  taskId,
  onChange,
}: TaskSelectorProps) {
  const { tasks, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useMyTasks(workspaceId);

  // Group tasks by project
  const byProject = new Map<string, { projectName: string; color: string | null; tasks: typeof tasks }>();
  for (const task of tasks) {
    const pid = task.project?.id ?? "none";
    if (!byProject.has(pid)) {
      byProject.set(pid, {
        projectName: task.project?.name ?? "No Project",
        color: task.project?.color ?? null,
        tasks: [],
      });
    }
    byProject.get(pid)!.tasks.push(task);
  }

  function handleChange(val: string) {
    if (val === "none") {
      onChange(null, null);
    } else {
      const task = tasks.find((t) => t.id === val);
      onChange(val, task?.title ?? null);
    }
  }

  return (
    <Select
      value={taskId ?? "none"}
      onValueChange={handleChange}
    >
      <SelectTrigger className="w-64 h-8 text-sm">
        <SelectValue placeholder="Select a task" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No task (general time)</SelectItem>
        {Array.from(byProject.entries()).map(([pid, group]) => (
          <SelectGroup key={pid}>
            <SelectLabel>
              <div className="flex items-center gap-1.5">
                <div
                  className="h-2 w-2 rounded-sm shrink-0"
                  style={{ backgroundColor: group.color ?? "#6366f1" }}
                />
                {group.projectName}
              </div>
            </SelectLabel>
            {group.tasks.map((task) => (
              <SelectItem key={task.id} value={task.id}>
                <span className="truncate">{task.title}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {hasNextPage && (
          <div className="px-2 py-1.5">
            <LoadMoreButton
              label="Load more tasks"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            />
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
