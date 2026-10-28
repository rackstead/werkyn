import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatePicker } from "./date-picker";
import { PriorityBadge } from "./priority-badge";

afterEach(cleanup);

describe("PriorityBadge", () => {
  it("is a keyboard-operable toggle button when clickable", () => {
    const onClick = vi.fn();
    render(<PriorityBadge priority="HIGH" pressed onClick={onClick} />);
    const button = screen.getByRole("button", { name: "High", pressed: true });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is plain text when not clickable", () => {
    render(<PriorityBadge priority="LOW" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Low").tagName).toBe("SPAN");
  });
});

describe("DatePicker", () => {
  it("names the date input and its clear button", () => {
    const onChange = vi.fn();
    render(<DatePicker label="Due date" value="2026-11-02" onChange={onChange} />);
    expect(screen.getByLabelText("Due date").getAttribute("type")).toBe("date");
    fireEvent.click(screen.getByRole("button", { name: "Clear due date" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("can be labelled by an associated <label>", () => {
    render(
      <>
        <label htmlFor="start">Start date</label>
        <DatePicker id="start" value={null} onChange={vi.fn()} />
      </>,
    );
    expect(screen.getByLabelText("Start date").getAttribute("type")).toBe("date");
  });
});
