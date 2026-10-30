import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BACKUP_INCLUDED_CONTENT, BACKUP_OMITTED_CONTENT } from "@pm/shared";
import { BackupScopeNotice } from "./backup-scope-notice";

afterEach(cleanup);

it("labels an export as content only and lists everything it omits and includes", () => {
  render(<BackupScopeNotice action="export" />);
  expect(screen.getByText(/content export, not a full copy of the workspace/)).toBeTruthy();
  for (const item of [...BACKUP_OMITTED_CONTENT, ...BACKUP_INCLUDED_CONTENT]) {
    expect(screen.getByText(item.label)).toBeTruthy();
  }
});

it("tells a restoring admin what a backup cannot bring back", () => {
  render(<BackupScopeNotice action="restore" />);
  expect(screen.getByText(/restoring cannot bring them back/)).toBeTruthy();
  for (const item of BACKUP_OMITTED_CONTENT) expect(screen.getByText(item.label)).toBeTruthy();
  expect(screen.queryByText("Included, for what you select")).toBeNull();
});

it("lists the omissions the brief requires to be labelled", () => {
  const keys = BACKUP_OMITTED_CONTENT.map((item) => item.key);
  for (const key of ["attachments", "drive-files", "user-accounts", "time-tracking", "workspace-settings", "task-templates", "recurring-tasks", "api-keys", "sessions"])
    expect(keys).toContain(key);
});
