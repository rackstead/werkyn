import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Slideover } from "./slideover";

afterEach(cleanup);

function Panel({ onClose }: { onClose: () => void }) {
  const [nestedOpen, setNestedOpen] = useState(false);
  return (
    <Slideover title="Details" onClose={onClose}>
      <button type="button" onClick={() => setNestedOpen(true)}>
        Save as template
      </button>
      <Dialog open={nestedOpen} onOpenChange={setNestedOpen}>
        <DialogContent>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>Name the template.</DialogDescription>
          <input aria-label="Template name" autoFocus />
        </DialogContent>
      </Dialog>
    </Slideover>
  );
}

describe("Slideover", () => {
  it("closes only the top layer on Escape and returns focus inside the panel", async () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    await screen.findByRole("dialog", { name: "Details" });
    const opener = screen.getByRole("button", { name: "Save as template" });
    opener.focus();
    fireEvent.click(opener);
    const nested = await screen.findByRole("dialog", { name: "Save as template" });
    await waitFor(() => expect(nested.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save as template" })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(opener));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Escape that a control inside the panel stops", async () => {
    const onClose = vi.fn();
    render(
      <Slideover title="Details" onClose={onClose}>
        <input aria-label="Search" onKeyDown={(event) => event.stopPropagation()} />
      </Slideover>,
    );
    const input = await screen.findByRole("textbox", { name: "Search" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores pointer presses outside the panel other than on the backdrop", async () => {
    const onClose = vi.fn();
    const outside = document.createElement("button");
    outside.textContent = "Toast";
    document.body.append(outside);
    try {
      render(<Slideover title="Details" onClose={onClose}>body</Slideover>);
      await screen.findByRole("dialog", { name: "Details" });
      fireEvent.pointerDown(outside);
      fireEvent.focusIn(outside);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it("keeps the toast live region exposed while open", async () => {
    render(
      <>
        <main>
          <button type="button">Background</button>
          <Toaster />
        </main>
        <Slideover title="Details" onClose={vi.fn()}>
          body
        </Slideover>
      </>,
    );
    await screen.findByRole("dialog", { name: "Details" });
    // The page behind is hidden; the live region inside it is not.
    expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
    act(() => {
      toast.error("Failed to update task");
    });
    const message = await screen.findByText("Failed to update task");
    expect(message.closest('[aria-hidden="true"]')).toBeNull();
    expect(message.closest("[aria-live]")).toBeTruthy();
  });
});
