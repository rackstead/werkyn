import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

afterEach(cleanup);

// Most dialogs in the app are opened from an ordinary button that sets state,
// not from a Radix DialogTrigger, so Radix itself has no element to return to.
function StateOpenedDialog({ autoFocus = false }: { autoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Workspace settings</DialogTitle>
          <DialogDescription>Change workspace settings.</DialogDescription>
          <label htmlFor="settings-name">Name</label>
          <input id="settings-name" autoFocus={autoFocus} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function openWithKeyboard() {
  const opener = screen.getByRole("button", { name: "Open settings" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("Dialog primitive", () => {
  it("is an announced modal dialog named by its title", async () => {
    render(<StateOpenedDialog />);
    openWithKeyboard();
    const dialog = await screen.findByRole("dialog", { name: "Workspace settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it.each([
    ["first focusable control", false],
    ["autoFocus input", true],
  ])("returns focus to the opener after Escape (%s)", async (_label, autoFocus) => {
    render(<StateOpenedDialog autoFocus={autoFocus} />);
    const opener = openWithKeyboard();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("returns focus to the opener after the Close button", async () => {
    render(<StateOpenedDialog />);
    const opener = openWithKeyboard();
    const close = await screen.findByRole("button", { name: "Close" });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("does not move focus when the opener is gone", async () => {
    function Removable() {
      const [open, setOpen] = useState(false);
      return (
        <>
          {!open && (
            <button type="button" onClick={() => setOpen(true)}>
              Open settings
            </button>
          )}
          <button type="button">Elsewhere</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>Workspace settings</DialogTitle>
              <DialogDescription>Change workspace settings.</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Removable />);
    openWithKeyboard();
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(document.body);
  });
});
