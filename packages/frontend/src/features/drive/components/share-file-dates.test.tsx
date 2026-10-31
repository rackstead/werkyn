import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_ZONES, useTimeZone } from "@/test/time-zone";
import { ShareFileDialog } from "./share-file-dialog";

const state = vi.hoisted(() => ({
  links: [] as Array<Record<string, unknown>>, create: vi.fn(), update: vi.fn(),
}));
vi.mock("@/features/workspaces/api", () => ({ useWorkspaceMembers: () => ({ data: { data: [] } }) }));
vi.mock("../api", () => ({
  useFileShares: () => ({ data: { data: [] } }),
  useFileShareLinks: () => ({ data: { data: state.links }, isLoading: false }),
  useCreateFileShares: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveFileShare: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateFileShareLink: () => ({ mutate: state.create, isPending: false }),
  useUpdateFileShareLink: () => ({ mutate: state.update, isPending: false }),
  useDeleteFileShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));
const LOCAL_TODAY = {
  "2026-11-01T20:00:00Z": {
    UTC: "2026-11-01", "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02", "America/Los_Angeles": "2026-11-01",
  },
  "2026-11-02T05:00:00Z": {
    UTC: "2026-11-02", "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02", "America/Los_Angeles": "2026-11-01",
  },
} as const;
const existingLink = () => ({ id: "link-1", token: "token-1", enabled: true, hasPassword: false, expiresAt: null });
function open(flow: "create" | "edit") {
  if (flow === "edit") state.links = [existingLink()];
  render(<ShareFileDialog open onClose={vi.fn()} workspaceId="w" fileIds={["file-1"]} fileName="Report" />);
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  if (flow === "edit") fireEvent.click(screen.getAllByRole("button", { name: "Change" })[1]);
  return screen.getByRole("dialog").querySelector<HTMLInputElement>('input[type="date"]')!;
}
beforeEach(() => { state.links = []; state.create.mockReset(); state.update.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const EXPIRIES = {
  UTC: [["2026-11-01", "2026-11-01T23:59:59.000Z"]],
  "Asia/Tokyo": [["2026-11-01", "2026-11-01T14:59:59.000Z"]],
  "Australia/Sydney": [
    ["2026-11-01", "2026-11-01T12:59:59.000Z"],
    ["2026-04-05", "2026-04-05T13:59:59.000Z"],
    ["2026-10-04", "2026-10-04T12:59:59.000Z"],
  ],
  "America/Los_Angeles": [
    ["2026-11-01", "2026-11-02T07:59:59.000Z"],
    ["2026-03-08", "2026-03-09T06:59:59.000Z"],
  ],
} as const;
describe.each(TIME_ZONES)("share file calendar dates in %s", (zone) => {
  useTimeZone(zone);
  for (const flow of ["create", "edit"] as const) {
    it.each(Object.keys(LOCAL_TODAY) as Array<keyof typeof LOCAL_TODAY>)(`${flow} uses the local minimum at %s`, (now) => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
      expect(open(flow).min).toBe(LOCAL_TODAY[now][zone]);
    });

    it(`${flow} preserves local end-of-day instants and clearing across DST`, () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T12:00:00Z") });
      const input = open(flow), mutation = flow === "create" ? state.create : state.update;
      const save = () => fireEvent.click(screen.getByRole("button", { name: flow === "create" ? "Create link" : "Save" }));
      for (const [date, expected] of EXPIRIES[zone]) {
        fireEvent.change(input, { target: { value: date } }); save();
        expect(mutation.mock.calls.at(-1)?.[0]).toEqual(flow === "create"
          ? { fileIds: ["file-1"], password: undefined, expiresAt: expected }
          : { linkId: "link-1", expiresAt: expected });
      }
      fireEvent.change(input, { target: { value: "" } }); save();
      expect(mutation.mock.calls.at(-1)?.[0]).toEqual(flow === "create"
        ? { fileIds: ["file-1"], password: undefined, expiresAt: undefined }
        : { linkId: "link-1", expiresAt: null });
    });
  }
});
