import { afterAll, beforeAll, expect } from "vitest";

/**
 * Zones that date tests run in: UTC; east of UTC without DST (Tokyo) and with
 * DST (Sydney); west of UTC with DST (Los Angeles).
 */
export const TIME_ZONES = ["UTC", "Asia/Tokyo", "Australia/Sydney", "America/Los_Angeles"] as const;
export type TimeZone = (typeof TIME_ZONES)[number];

/**
 * Runs the enclosing describe block with the process time zone set to `zone`.
 * Node applies a TZ assignment at once; the check makes a runner that ignored
 * it fail rather than silently test the wrong zone.
 */
export function useTimeZone(zone: TimeZone) {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TZ;
    process.env.TZ = zone;
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}
