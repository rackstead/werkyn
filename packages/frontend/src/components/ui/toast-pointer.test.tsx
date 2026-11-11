import { readFileSync } from "node:fs";
import path from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Slideover } from "./slideover";

const styles = path.resolve(process.cwd(), "src/styles");
const rules = readFileSync(path.join(styles, "toast-pointer.css"), "utf8");
const globals = readFileSync(path.join(styles, "globals.css"), "utf8");

beforeEach(() => {
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  document.body.style.pointerEvents = "";
});

it("lets a pointer activate toast Retry without closing the task panel or taking Tab", async () => {
  expect(rules).toMatch(
    /\[data-sonner-toaster\]\s*\{[^}]*pointer-events:\s*none/,
  );
  expect(rules).toMatch(
    /\[data-sonner-toast\]\s*\{[^}]*pointer-events:\s*auto/,
  );
  expect(globals).toContain("./toast-pointer.css");

  const style = document.createElement("style");
  style.textContent = rules;
  document.head.append(style);

  const onClose = vi.fn();
  const retry = vi.fn();
  render(
    <>
      <Toaster />
      <Slideover title="Task" onClose={onClose}>
        <button type="button">Retry save</button>
      </Slideover>
    </>,
  );
  const dialog = await screen.findByRole("dialog", { name: "Task" });
  expect(document.body.style.pointerEvents).toBe("none");

  act(() => {
    toast.error("Your changes couldn't be saved.", {
      duration: Infinity,
      action: { label: "Retry", onClick: retry },
    });
  });
  const action = await screen.findByRole("button", { name: "Retry" });
  const toaster = document.querySelector<HTMLElement>("[data-sonner-toaster]");
  const toastEl = action.closest<HTMLElement>("[data-sonner-toast]");
  expect(toaster).toBeTruthy();
  expect(toastEl).toBeTruthy();
  expect(getComputedStyle(toaster!).pointerEvents).toBe("none");
  expect(getComputedStyle(toastEl!).pointerEvents).toBe("auto");
  expect(getComputedStyle(action).pointerEvents).toBe("auto");
  expect(dialog.contains(action)).toBe(false);

  fireEvent.pointerDown(action);
  fireEvent.click(action);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Task" })).toBeTruthy();

  const inside = screen.getByRole("button", { name: "Retry save" });
  inside.focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(action);
});
