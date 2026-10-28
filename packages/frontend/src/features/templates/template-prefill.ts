import type { TaskTemplate } from "./api";

/** IDs the project currently offers; `undefined` while a list is still loading. */
interface ProjectOptions {
  statusIds?: readonly string[];
  memberIds?: readonly string[];
  labelIds?: readonly string[];
}

const keep = (ids: readonly string[], allowed?: readonly string[]) => {
  const unique = [...new Set(ids)];
  if (!allowed) return unique;
  const valid = new Set(allowed);
  return unique.filter((id) => valid.has(id));
};

/**
 * Form values copied from a template. A template can outlive the columns,
 * members and labels it names; the server rejects such IDs when they are sent
 * explicitly, so only references the project still offers are prefilled. A list
 * that has not loaded yet is left unfiltered rather than emptied.
 */
export function templatePrefill(template: TaskTemplate, options: ProjectOptions) {
  const [statusId = null] = template.statusId ? keep([template.statusId], options.statusIds) : [];
  return {
    statusId,
    assigneeIds: keep(template.assigneeIds, options.memberIds),
    labelIds: keep(template.labelIds, options.labelIds),
  };
}
