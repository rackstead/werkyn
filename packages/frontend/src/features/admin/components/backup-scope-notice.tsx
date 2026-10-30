import {
  BACKUP_INCLUDED_CONTENT,
  BACKUP_OMITTED_CONTENT,
  type BackupContentItem,
} from "@pm/shared";

function ContentList({ items }: { items: readonly BackupContentItem[] }) {
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5">
      {items.map((item) => (
        <li key={item.key}>{item.label}</li>
      ))}
    </ul>
  );
}

/**
 * What a backup holds and what it leaves out. Backups are a content export of
 * the selected projects, channels and wiki spaces, not a full copy of the
 * workspace.
 */
export function BackupScopeNotice({ action }: { action: "export" | "restore" }) {
  return (
    <div className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p>
        {action === "export"
          ? "A backup is a content export, not a full copy of the workspace. Use database and storage backups for disaster recovery."
          : "Restoring adds the backup's content to this workspace. A backup never contains the items listed below, so restoring cannot bring them back."}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">Not included in backups</summary>
        <ContentList items={BACKUP_OMITTED_CONTENT} />
      </details>
      {action === "export" && (
        <details className="mt-2">
          <summary className="cursor-pointer font-medium">Included, for what you select</summary>
          <ContentList items={BACKUP_INCLUDED_CONTENT} />
        </details>
      )}
    </div>
  );
}
