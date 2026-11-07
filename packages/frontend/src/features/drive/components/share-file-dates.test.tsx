import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_ZONES, useTimeZone } from "@/test/time-zone";

// The shared zones, plus the zones furthest ahead of and behind UTC (14 and
// 11 hours, so they are a whole day plus 1 hour apart) and New York, whose
// daylight saving days are checked.
const ZONES = [...TIME_ZONES, "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York"] as const;
type Zone = (typeof ZONES)[number];
import { formatDateISO } from "@/features/time/utils";
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
const LOCAL_TODAY: Record<string, Record<Zone, string>> = {
  "2026-11-01T20:00:00Z": {
    UTC: "2026-11-01", "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02", "America/Los_Angeles": "2026-11-01",
    "Pacific/Kiritimati": "2026-11-02", "Pacific/Pago_Pago": "2026-11-01", "America/New_York": "2026-11-01",
  },
  "2026-11-02T05:00:00Z": {
    UTC: "2026-11-02", "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02", "America/Los_Angeles": "2026-11-01",
    "Pacific/Kiritimati": "2026-11-02", "Pacific/Pago_Pago": "2026-11-01", "America/New_York": "2026-11-02",
  },
  // Kiritimati is already on the 2nd and Pago Pago still on 31 October.
  "2026-11-01T10:30:00Z": {
    UTC: "2026-11-01", "Asia/Tokyo": "2026-11-01",
    "Australia/Sydney": "2026-11-01", "America/Los_Angeles": "2026-11-01",
    "Pacific/Kiritimati": "2026-11-02", "Pacific/Pago_Pago": "2026-10-31", "America/New_York": "2026-11-01",
  },
};
const existingLink = (expiresAt: string | null = null) => ({ id: "link-1", token: "token-1", enabled: true, hasPassword: false, expiresAt });
function open(flow: "create" | "edit", expiresAt: string | null = null) {
  if (flow === "edit") state.links = [existingLink(expiresAt)];
  render(<ShareFileDialog open onClose={vi.fn()} workspaceId="w" fileIds={["file-1"]} fileName="Report" />);
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  if (flow === "edit") fireEvent.click(screen.getAllByRole("button", { name: "Change" })[1]);
  return screen.getByRole("dialog").querySelector<HTMLInputElement>('input[type="date"]')!;
}
beforeEach(() => { state.links = []; state.create.mockReset(); state.update.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const EXPIRIES: Record<Zone, ReadonlyArray<readonly [string, string]>> = {
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
  "Pacific/Kiritimati": [
    ["2026-11-01", "2026-11-01T09:59:59.000Z"],
    ["2026-12-31", "2026-12-31T09:59:59.000Z"],
  ],
  "Pacific/Pago_Pago": [
    ["2026-11-01", "2026-11-02T10:59:59.000Z"],
    ["2026-12-31", "2027-01-01T10:59:59.000Z"],
  ],
  // Both 2026 daylight saving days and the 2027 spring one: the end of the
  // day is in the offset that day ends in.
  "America/New_York": [
    ["2026-03-08", "2026-03-09T03:59:59.000Z"],
    ["2026-11-01", "2026-11-02T04:59:59.000Z"],
    ["2027-03-14", "2027-03-15T03:59:59.000Z"],
    ["2026-11-02", "2026-11-03T04:59:59.000Z"],
  ],
};
describe.each(ZONES)("share file calendar dates in %s", (zone) => {
  useTimeZone(zone);
  for (const flow of ["create", "edit"] as const) {
    it.each(Object.keys(LOCAL_TODAY))(`${flow} uses the local minimum at %s`, (now) => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
      expect(open(flow).min).toBe(LOCAL_TODAY[now][zone]);
    });

    it(`${flow} sends local end-of-day instants across DST`, () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T12:00:00Z") });
      const input = open(flow), mutation = flow === "create" ? state.create : state.update;
      const save = () => fireEvent.click(screen.getByRole("button", { name: flow === "create" ? "Create link" : "Save" }));
      for (const [date, expected] of EXPIRIES[zone]) {
        fireEvent.change(input, { target: { value: date } }); save();
        expect(mutation.mock.calls.at(-1)?.[0]).toEqual(flow === "create"
          ? { fileIds: ["file-1"], password: undefined, expiresAt: expected }
          : { linkId: "link-1", expiresAt: expected });
      }
    });

    it(`${flow} refuses the day before local today and accepts local today`, () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T10:30:00Z") });
      const today = LOCAL_TODAY["2026-11-01T10:30:00Z"][zone];
      const yesterday = new Date(`${today}T12:00:00`);
      yesterday.setDate(yesterday.getDate() - 1);
      const input = open(flow), mutation = flow === "create" ? state.create : state.update;
      const save = () => fireEvent.click(screen.getByRole("button", { name: flow === "create" ? "Create link" : "Save" }));
      fireEvent.change(input, { target: { value: formatDateISO(yesterday) } }); save();
      expect(mutation).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: today } }); save();
      const sent = mutation.mock.calls.at(-1)?.[0].expiresAt;
      // The end of local today: after now, and less than a day away.
      expect(Date.parse(sent) - Date.now()).toBeGreaterThan(0);
      expect(Date.parse(sent) - Date.now()).toBeLessThan(86_400_000);
    });
  }

  it("edit shows a stored expiry as its local day", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T12:00:00Z") });
    for (const [date, instant] of EXPIRIES[zone]) {
      cleanup();
      expect(open("edit", instant).value).toBe(date);
    }
  });

  it("creates without an expiry when the date is left empty", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T12:00:00Z") });
    const input = open("create");
    fireEvent.change(input, { target: { value: "2026-12-31" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(state.create.mock.calls.at(-1)?.[0]).toEqual({ fileIds: ["file-1"], password: undefined });
  });

  it("removes an expiry only with Remove expiration", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T12:00:00Z") });
    const input = open("edit", EXPIRIES[zone][0][1]);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(state.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove expiration" }));
    expect(state.update.mock.calls).toEqual([[{ linkId: "link-1", expiresAt: null }, expect.anything()]]);
  });
});
