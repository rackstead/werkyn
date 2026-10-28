// Rows written before task references were validated can link a task to another
// project's status, labels, custom fields or tasks. Until those rows are repaired
// (see scripts/reference-integrity-report.ts), task responses drop or redact any
// nested relation that lives outside the task's own project.

interface ProjectScoped { projectId: string }
interface StatusLike extends ProjectScoped { id: string }
interface DependencyTask extends ProjectScoped { status?: StatusLike }

interface ScopableTask extends ProjectScoped {
  status?: StatusLike;
  labels?: { label: ProjectScoped }[];
  customFieldValues?: { field: ProjectScoped }[];
  blockedBy?: { blockingTask: DependencyTask }[];
  blocking?: { blockedTask: DependencyTask }[];
}

function scopedStatus<S extends StatusLike>(status: S, projectId: string): S {
  if (status.projectId === projectId) return status;
  // The ID is already exposed as task.statusId; nothing else about the column is.
  return {
    id: status.id,
    projectId,
    name: "Unavailable status",
    color: null,
    position: 0,
    isCompletion: false,
  } as unknown as S;
}

function scopedDependencyTask<T extends DependencyTask>(task: T): T {
  return task.status ? { ...task, status: scopedStatus(task.status, task.projectId) } : task;
}

export function scopeTaskRelations<T extends ScopableTask>(task: T): T {
  const { projectId } = task;
  const scoped: ScopableTask = { ...task };
  if (task.status) scoped.status = scopedStatus(task.status, projectId);
  if (task.labels) scoped.labels = task.labels.filter((l) => l.label.projectId === projectId);
  if (task.customFieldValues) {
    scoped.customFieldValues = task.customFieldValues.filter((v) => v.field.projectId === projectId);
  }
  if (task.blockedBy) {
    scoped.blockedBy = task.blockedBy
      .filter((d) => d.blockingTask.projectId === projectId)
      .map((d) => ({ ...d, blockingTask: scopedDependencyTask(d.blockingTask) }));
  }
  if (task.blocking) {
    scoped.blocking = task.blocking
      .filter((d) => d.blockedTask.projectId === projectId)
      .map((d) => ({ ...d, blockedTask: scopedDependencyTask(d.blockedTask) }));
  }
  return scoped as T;
}

export function scopeTaskDependencyTasks<
  D extends { blockingTask: DependencyTask; blockedTask: DependencyTask },
>(dependency: D): D {
  return {
    ...dependency,
    blockingTask: scopedDependencyTask(dependency.blockingTask),
    blockedTask: scopedDependencyTask(dependency.blockedTask),
  };
}
