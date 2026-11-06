import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/** One keystroke as Chromium reports it: the value after the key, and
 *  whether a part is left half typed (the input then reads ""). */
export type Step = [key: string, value: string, halfTyped?: boolean];

/** Sets what the input reports as bad input (jsdom always reports none). */
export function setHalfTyped(input: HTMLInputElement, halfTyped: boolean) {
  Object.defineProperty(input, "validity", {
    configurable: true,
    get: () => ({ badInput: halfTyped }),
  });
}

/** Keystrokes in a focused date input, with the values Chromium reports. */
export function type(input: HTMLInputElement, steps: Step[]) {
  for (const [key, value, halfTyped = false] of steps) {
    fireEvent.keyDown(input, { key });
    setHalfTyped(input, halfTyped);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyUp(input, { key });
  }
}

/** Focus leaving the input: Chromium first completes a half-typed part
 *  (`completed`, reported while focus is already elsewhere), then blurs. */
export function leave(input: HTMLInputElement, completed?: string) {
  if (completed !== undefined) {
    const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
    setHalfTyped(input, false);
    fireEvent.change(input, { target: { value: completed } });
    active.mockRestore();
  }
  fireEvent.blur(input);
}

/**
 * What Chromium reports while 2027-03-15 is typed over 2026-11-20, for each
 * order of the date parts (checked in Chromium 141 under the en-US, de-DE and
 * ja-JP languages). A month or day moves on after two digits; a year takes up
 * to six, so a year typed first is followed by ArrowRight. Each order passes
 * through "" (a month or day "0") and dates that mix typed and old parts.
 */
export const TYPING_OVER_2026_11_20: Record<string, Step[]> = {
  "month/day/year": [
    ["0", "", true], ["3", "2026-03-20"], ["1", "2026-03-01"], ["5", "2026-03-15"],
    ["2", "0002-03-15"], ["0", "0020-03-15"], ["2", "0202-03-15"], ["7", "2027-03-15"],
  ],
  "day/month/year": [
    ["1", "2026-11-01"], ["5", "2026-11-15"], ["0", "", true], ["3", "2026-03-15"],
    ["2", "0002-03-15"], ["0", "0020-03-15"], ["2", "0202-03-15"], ["7", "2027-03-15"],
  ],
  "year/month/day": [
    ["2", "0002-11-20"], ["0", "0020-11-20"], ["2", "0202-11-20"], ["7", "2027-11-20"],
    ["ArrowRight", "2027-11-20"], ["0", "", true], ["3", "2027-03-20"], ["1", "2027-03-01"], ["5", "2027-03-15"],
  ],
};
