import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { committedDate } from "@/lib/date-input";
import { DatePicker } from "./date-picker";

afterEach(cleanup);

// Values Chromium reports while "2027" is typed into a date input.
const TYPING_2027 = ["0002-03-15", "0020-03-15", "0202-03-15", "2027-03-15"];

it("committedDate keeps complete dates and clears, and holds back partial years", () => {
  expect(TYPING_2027.map(committedDate)).toEqual([undefined, undefined, undefined, "2027-03-15"]);
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
