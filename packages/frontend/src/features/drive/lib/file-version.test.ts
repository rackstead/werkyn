import { describe, expect, it } from "vitest";
import type { DriveFile, SortBy } from "../api";
import { fileVersion } from "./file-version";

const file = {
  id: "f1", name: "Report", isFolder: false, size: 42,
  updatedAt: "2026-11-01T00:00:00Z",
  uploadedBy: { id: "u1", displayName: "Ana", avatarUrl: null },
} as DriveFile;
const edits: Record<SortBy, Partial<DriveFile>> = {
  name: { name: "Renamed" },
  size: { size: 99 },
  updatedAt: { updatedAt: "2026-11-02T00:00:00Z" },
  uploadedBy: { uploadedBy: { ...file.uploadedBy, displayName: "Bea" } },
};

describe("fileVersion", () => {
  for (const sort of Object.keys(edits) as SortBy[]) {
    it(`depends on the ${sort} key and ignores changes to other columns`, () => {
      expect(fileVersion({ ...file, ...edits[sort] }, sort)).not.toBe(fileVersion(file, sort));
      for (const other of Object.keys(edits) as SortBy[]) {
        if (other !== sort) expect(fileVersion({ ...file, ...edits[other] }, sort)).toBe(fileVersion(file, sort));
      }
    });

    it(`retains folders-first and unique-ID ordering under ${sort}`, () => {
      expect(fileVersion({ ...file, isFolder: true }, sort)).not.toBe(fileVersion(file, sort));
      expect(fileVersion({ ...file, id: "f2" }, sort)).not.toBe(fileVersion(file, sort));
    });
  }

  it("defaults to name and distinguishes a null sort value from text", () => {
    expect(fileVersion(file)).toBe(fileVersion(file, "name"));
    expect(fileVersion({ ...file, size: null }, "size")).not.toBe(fileVersion({ ...file, size: 0 }, "size"));
    expect(fileVersion({ ...file, uploadedBy: undefined } as unknown as DriveFile, "uploadedBy"))
      .not.toBe(fileVersion({ ...file, uploadedBy: { ...file.uploadedBy, displayName: "" } }, "uploadedBy"));
  });
});
