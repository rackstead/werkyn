import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { committedDate } from "@/lib/date-input";
import { DatePicker } from "./date-picker";
import { leave, type, TYPING_OVER_2026_11_20 } from "@/test/date-typing";

afterEach(cleanup);

// Values Chromium reports while "2027" is typed into a date input.
const TYPING_2027 = ["0002-03-15", "0020-03-15", "0202-03-15", "2027-03-15"];

it("committedDate keeps complete dates and clears, and holds back partial years", () => {
  expect(TYPING_2027.map((value) => committedDate(value))).toEqual([undefined, undefined, undefined, "2027-03-15"]);
  expect(committedDate("")).toBeNull();
  expect(committedDate("2027-02-29")).toBeUndefined();
  expect(committedDate("2028-02-29")).toBe("2028-02-29");
});

it("DatePicker reports only complete dates while a year is typed, and still reports clearing", () => {
  const onChange = vi.fn();
  const { container } = render(<DatePicker value="2026-03-15" onChange={onChange} />);
  const input = container.querySelector("input")!;
  for (const value of TYPING_2027) fireEvent.change(input, { target: { value } });
  expect(onChange.mock.calls).toEqual([["2027-03-15"]]);
  expect(input.value).toBe("2027-03-15");

  fireEvent.change(input, { target: { value: "0202-03-15" } });
  // The partial value stays in the input, but nothing is saved.
  expect(input.value).toBe("0202-03-15");
  expect(onChange).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button"));
  expect(onChange).toHaveBeenLastCalledWith(null);
});

function renderPicker() {
  const onChange = vi.fn();
  render(<DatePicker label="Due date" value="2026-11-20" onChange={onChange} />);
  const input = screen.getByLabelText("Due date") as HTMLInputElement;
  input.focus();
  return { input, onChange };
}

for (const [order, steps] of Object.entries(TYPING_OVER_2026_11_20)) {
  it(`DatePicker saves a date typed over another (${order}) once, on blur, and never null`, () => {
    const { input, onChange } = renderPicker();
    type(input, steps);
    expect(onChange).not.toHaveBeenCalled();
    leave(input);
    expect(onChange.mock.calls).toEqual([["2027-03-15"]]);
  });
}

it("DatePicker keeps the saved date when focus leaves a half-typed edit", () => {
  const { input, onChange } = renderPicker();
  type(input, TYPING_OVER_2026_11_20["month/day/year"].slice(0, 1));
  leave(input, "2026-01-20");
  expect(onChange).not.toHaveBeenCalled();
  expect(input.value).toBe("2026-11-20");
});

it("DatePicker's clear button discards a date being typed and clears", () => {
  const { input, onChange } = renderPicker();
  type(input, TYPING_OVER_2026_11_20["month/day/year"]);
  const clear = screen.getByRole("button", { name: "Clear due date" });
  // The button keeps focus in the input, so no blur saves the typed date.
  expect(fireEvent.mouseDown(clear)).toBe(false);
  fireEvent.click(clear);
  expect(onChange.mock.calls).toEqual([[null]]);
  expect(input.value).toBe("");
  leave(input);
  expect(onChange).toHaveBeenCalledTimes(1);
});
