import type { TaskTemplate } from "./api";

interface ProjectOptions {
  statusIds: readonly string[];
  memberIds: readonly string[];
  labelIds: readonly string[];
}

/**
 * Form values copied from a template. A template can outlive the columns,
 * members and labels it names; the server rejects such IDs when they are sent
 * explicitly, so only references the project still offers are prefilled.
 */
export function templatePrefill(template: TaskTemplate, options: ProjectOptions) {
  const statuses = new Set(options.statusIds);
  const members = new Set(options.memberIds);
  const labels = new Set(options.labelIds);
  return {
    statusId: template.statusId && statuses.has(template.statusId) ? template.statusId : null,
    assigneeIds: [...new Set(template.assigneeIds)].filter((id) => members.has(id)),
    labelIds: [...new Set(template.labelIds)].filter((id) => labels.has(id)),
  };
}
