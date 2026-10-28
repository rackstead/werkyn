import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("is a modal alert dialog named by its title and described by its description", () => {
    render(
      <ConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Archive task?"
        description="This task will be hidden from the board."
        confirmLabel="Archive"
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Archive task?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(
      "This task will be hidden from the board.",
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("omits aria-describedby without a description", () => {
    render(<ConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} title="Delete?" />);
    expect(screen.getByRole("alertdialog", { name: "Delete?" }).hasAttribute("aria-describedby")).toBe(false);
  });

  it("confirms, cancels, closes on Escape and returns focus to the opener", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Delete label
          </button>
          <ConfirmDialog
            open={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            onConfirm={onConfirm}
            title="Delete label?"
            confirmLabel="Delete"
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete label" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete label?" });
    // The safe action has initial focus.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(dialog.isConnected).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));

    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
