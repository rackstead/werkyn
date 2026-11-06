import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { committedDate } from "@/lib/date-input";
import { DateInput } from "./date-input";
import { leave, setHalfTyped, type, TYPING_OVER_2026_11_20 } from "@/test/date-typing";

afterEach(cleanup);

const TYPING = TYPING_OVER_2026_11_20;

function renderInput(value: string | null = "2026-11-20") {
  const onCommit = vi.fn();
  const onParentKeyDown = vi.fn();
  render(
    <div onKeyDown={onParentKeyDown}>
      <DateInput aria-label="Due" value={value} onCommit={onCommit} />
    </div>,
  );
  const input = screen.getByLabelText("Due") as HTMLInputElement;
  input.focus();
  return { input, onCommit, onParentKeyDown };
}

describe("committedDate", () => {
  it("reads a half-typed input as incomplete, not cleared", () => {
    const input = document.createElement("input");
    input.type = "date";
    setHalfTyped(input, true);
    expect(committedDate("", input)).toBeUndefined();
    setHalfTyped(input, false);
    expect(committedDate("", input)).toBeNull();
    expect(committedDate("2027-03-15", input)).toBe("2027-03-15");
  });

  it("checks the focused date input when none is given", () => {
    const input = document.createElement("input");
    input.type = "date";
    document.body.append(input);
    input.focus();
    setHalfTyped(input, true);
    expect(committedDate("")).toBeUndefined();
    input.remove();
    expect(committedDate("")).toBeNull();
  });
});

describe("DateInput", () => {
  for (const [order, steps] of Object.entries(TYPING)) {
    it(`saves a date typed over another (${order}) once, when it is entered`, () => {
      const { input, onCommit } = renderInput();
      type(input, steps);
      expect(onCommit).not.toHaveBeenCalled();
      expect(input.value).toBe("2027-03-15");
      leave(input);
      expect(onCommit.mock.calls).toEqual([["2027-03-15"]]);
    });
  }

  it("saves on Enter, but keeps typing while a part is half typed", () => {
    const { input, onCommit } = renderInput();
    type(input, TYPING["month/day/year"].slice(0, 1));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    type(input, TYPING["month/day/year"].slice(1));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit.mock.calls).toEqual([["2027-03-15"]]);
    leave(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved date when focus leaves a half-typed part the browser then completes", () => {
    const { input, onCommit } = renderInput();
    type(input, [["0", "", true]]);
    // Chromium turns the month "0" into 01 as focus leaves.
    leave(input, "2026-01-20");
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("2026-11-20");
  });

  it("keeps the saved date when focus leaves a partial year", () => {
    const { input, onCommit } = renderInput();
    type(input, TYPING["month/day/year"].slice(0, 5));
    leave(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("2026-11-20");
  });

  it("keeps typing after the browser completes a part as focus moves to the next one", () => {
    const { input, onCommit } = renderInput();
    type(input, [["0", "", true]]);
    // Tab to the day: the month becomes 01 while focus moves within the input.
    fireEvent.keyDown(input, { key: "Tab" });
    const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
    setHalfTyped(input, false);
    fireEvent.change(input, { target: { value: "2026-01-20" } });
    active.mockRestore();
    fireEvent.keyUp(input, { key: "Tab" });
    type(input, [["1", "2026-01-01"], ["5", "2026-01-15"]]);
    leave(input);
    expect(onCommit.mock.calls).toEqual([["2026-01-15"]]);
  });

  it("discards a typed date on Escape and keeps that Escape from the panel", () => {
    const { input, onCommit, onParentKeyDown } = renderInput();
    type(input, TYPING["month/day/year"]);
    onParentKeyDown.mockClear();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(input.value).toBe("2026-11-20");
    leave(input);
    expect(onCommit).not.toHaveBeenCalled();
    // With nothing typed, Escape reaches the panel.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onParentKeyDown).toHaveBeenCalledTimes(1);
  });

  it("saves a date chosen in the picker at once, and the picker's Clear", () => {
    const { input, onCommit } = renderInput();
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    expect(onCommit.mock.calls).toEqual([["2027-05-06"]]);
    fireEvent.change(input, { target: { value: "" } });
    expect(onCommit.mock.calls).toEqual([["2027-05-06"], [null]]);
    leave(input);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("saves null for an input emptied part by part, when focus leaves", () => {
    const { input, onCommit } = renderInput();
    // Only the first deleted part changes the value ("" with bad input).
    type(input, [["Backspace", "", true]]);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "Backspace" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onCommit).not.toHaveBeenCalled();
    setHalfTyped(input, false);
    leave(input);
    expect(onCommit.mock.calls).toEqual([[null]]);
  });

  it("does not save the date it already has", () => {
    const { input, onCommit } = renderInput();
    type(input, [["ArrowUp", "2026-12-20"], ["ArrowDown", "2026-11-20"]]);
    leave(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows a newer saved date, but not over a date being typed", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DateInput aria-label="Due" value="2026-11-20" onCommit={onCommit} />);
    const input = screen.getByLabelText("Due") as HTMLInputElement;
    rerender(<DateInput aria-label="Due" value="2026-12-01" onCommit={onCommit} />);
    expect(input.value).toBe("2026-12-01");
    input.focus();
    type(input, TYPING["month/day/year"].slice(0, 4));
    rerender(<DateInput aria-label="Due" value="2026-12-02" onCommit={onCommit} />);
    expect(input.value).toBe("2026-03-15");
    leave(input);
    expect(onCommit.mock.calls).toEqual([["2026-03-15"]]);
  });
});
