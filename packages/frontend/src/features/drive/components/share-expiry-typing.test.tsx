import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDateOnly } from "@pm/shared";
import {
  leave,
  setHalfTyped,
  type,
  TYPING_INTO_EMPTY,
  TYPING_OVER_2026_11_20,
} from "@/test/date-typing";
import { ShareFileDialog } from "./share-file-dialog";

// Share-link expiry in the Drive dialog: a half-typed date input reads "", so
// Create used to make a link that never expires and Save removed the expiry.
// These replay what Chromium reports while a date is typed and check that no
// request leaves a link without an expiry unless that was chosen explicitly.

const state = vi.hoisted(() => ({
  links: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
  update: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/features/workspaces/api", () => ({
  useWorkspaceMembers: () => ({ data: { data: [] } }),
}));
vi.mock("../api", () => ({
  useFileShares: () => ({ data: { data: [] } }),
  // Several files: the query is disabled and the dialog keeps its own links.
  useFileShareLinks: (_workspaceId: string, fileId: string | null) => ({
    data: fileId ? { data: state.links } : undefined,
    isLoading: false,
  }),
  useCreateFileShares: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveFileShare: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateFileShareLink: () => ({ mutate: state.create, isPending: false }),
  useUpdateFileShareLink: () => ({ mutate: state.update, isPending: false }),
  useDeleteFileShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));

/** The end of a local day, as the dialog sends it. */
const end = (date: string) => new Date(`${date}T23:59:59`).toISOString();
const SAVED = "2026-11-20";
const link = (expiresAt: string | null, id = "link-1") => ({
  id,
  token: `token-${id}`,
  enabled: true,
  hasPassword: false,
  expiresAt,
  files: [{ file: { id: "file-1" } }],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-06T12:00:00") });
  state.links = [];
  state.create.mockReset();
  state.update.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderDialog(fileIds = ["file-1"]) {
  render(
    <ShareFileDialog open onClose={vi.fn()} workspaceId="w" fileIds={fileIds} fileName="Report" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
}
function openCreate(fileIds?: string[]) {
  renderDialog(fileIds);
  const input = screen.getByLabelText("Expiration date (optional)") as HTMLInputElement;
  input.focus();
  return input;
}
function openEditor(expiresAt: string | null) {
  state.links = [link(expiresAt)];
  renderDialog();
  // The second Change button is the expiry's; the first is the password's.
  fireEvent.click(screen.getAllByRole("button", { name: "Change" })[1]);
  const input = screen.getByLabelText("New expiration date") as HTMLInputElement;
  input.focus();
  return input;
}
const createButton = () => screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement;
const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const note = (input: HTMLInputElement) =>
  document.getElementById(input.getAttribute("aria-describedby")!)!.textContent;

/**
 * A mouse click on `button`. The press comes first; then focus leaves the
 * input, where Chromium completes a half-typed part: `after` is what the input
 * then reports, bad input (true) or a completed date (a string).
 */
function click(input: HTMLInputElement, button: HTMLElement, after?: boolean | string) {
  fireEvent.pointerDown(button);
  fireEvent.mouseDown(button);
  if (typeof after === "boolean") setHalfTyped(input, after);
  leave(input, typeof after === "string" ? after : undefined);
  fireEvent.mouseUp(button);
  fireEvent.click(button);
}
/** Marked disabled: the button stays usable so a press can be checked. */
const blocked = (button: HTMLElement) => button.getAttribute("aria-disabled") === "true";

/** Whether a value read from a date input names a date that may be sent. */
const sendable = (value: string) => isDateOnly(value) && value >= "2026-11-06";

describe("creating a link while a date is typed", () => {
  for (const [order, steps] of Object.entries(TYPING_INTO_EMPTY)) {
    it(`never creates a link without the typed expiry (${order})`, () => {
      for (let n = 1; n <= steps.length; n++) {
        const input = openCreate();
        type(input, steps.slice(0, n));
        const [, shown, halfTyped = false] = steps[n - 1];
        // A lone month "0" reads as empty until focus leaves the input.
        click(input, createButton(), shown === "" ? true : halfTyped);
        const calls = state.create.mock.calls.map(([body]) => body);
        if (sendable(shown)) {
          // What the input shows: the typed date, or a whole date on the way
          // to it (the day's first digit, year/month/day order).
          expect(calls, `${order} step ${n}`).toEqual([
            { fileIds: ["file-1"], password: undefined, expiresAt: end(shown) },
          ]);
        } else {
          expect(calls, `${order} step ${n}`).toEqual([]);
          expect(blocked(createButton())).toBe(true);
          expect(note(input)).toBe("Enter a complete date.");
          expect(input.getAttribute("aria-invalid")).toBe("true");
        }
        cleanup();
        state.create.mockReset();
      }
    });
  }

  it("does not send while a lone month 0 still reads as empty and focus stays", () => {
    const input = openCreate();
    type(input, TYPING_INTO_EMPTY["month/day/year"].slice(0, 1));
    // Still focused: nothing marks the input yet, so Create looks usable.
    expect(blocked(createButton())).toBe(false);
    // The click itself moves focus, and Chromium completes the part first.
    click(input, createButton(), true);
    expect(state.create).not.toHaveBeenCalled();
    expect(blocked(createButton())).toBe(true);
  });

  it("sends nothing when the press completes a half-typed day; the date shown then needs a second click", () => {
    const input = openCreate();
    // Year/month/day: the day's "0" waits for a second digit.
    type(input, [...TYPING_INTO_EMPTY["year/month/day"].slice(0, 7), ["0", "", true]]);
    expect(blocked(createButton())).toBe(true);
    click(input, createButton(), "2027-03-01");
    expect(state.create).not.toHaveBeenCalled();
    expect(input.value).toBe("2027-03-01");
    expect(note(input)).toMatch(/^The link stops working at the end of /);
    click(input, createButton());
    expect(state.create.mock.calls.map(([body]) => body)).toEqual([
      { fileIds: ["file-1"], password: undefined, expiresAt: end("2027-03-01") },
    ]);
  });

  it("refuses a day before today", () => {
    const input = openCreate();
    fireEvent.change(input, { target: { value: "2026-11-05" } });
    fireEvent.blur(input);
    expect(blocked(createButton())).toBe(true);
    expect(note(input)).toBe("Choose today or a later date.");
    fireEvent.click(createButton());
    expect(state.create).not.toHaveBeenCalled();
    // Today is allowed: the link works until the end of it.
    fireEvent.change(input, { target: { value: "2026-11-06" } });
    fireEvent.click(createButton());
    expect(state.create.mock.calls[0][0].expiresAt).toBe(end("2026-11-06"));
  });

  it("creates a link without an expiry only with the date left empty or cleared", () => {
    const input = openCreate();
    expect(note(input)).toBe("No expiration: the link works until you disable or remove it.");
    type(input, TYPING_INTO_EMPTY["day/month/year"].slice(0, 3));
    fireEvent.blur(input);
    expect(blocked(createButton())).toBe(true);
    fireEvent.click(createButton());
    expect(state.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(input.value).toBe("");
    setHalfTyped(input, false);
    expect(blocked(createButton())).toBe(false);
    expect(screen.queryByRole("button", { name: "Clear date" })).toBeNull();
    fireEvent.click(createButton());
    expect(state.create.mock.calls).toEqual([[{ fileIds: ["file-1"], password: undefined }, expect.anything()]]);
  });

  it("states the expiry the server stored", () => {
    state.create.mockImplementation((_body, options) =>
      options.onSuccess({ data: link(end("2027-03-15")) }),
    );
    const input = openCreate(["a", "b"]);
    fireEvent.change(input, { target: { value: "2027-03-15" } });
    fireEvent.click(createButton());
    expect(toast.success).toHaveBeenCalledWith(
      `Share link created. It expires on ${new Date(end("2027-03-15")).toLocaleDateString()}.`,
    );
    state.create.mockImplementation((_body, options) =>
      options.onSuccess({ data: link(null, "link-2") }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create another link" }));
    // The form opens; nothing is created until Create link.
    expect(state.create).toHaveBeenCalledTimes(1);
    fireEvent.click(createButton());
    expect(toast.success).toHaveBeenLastCalledWith("Share link created. It never expires.");
  });

  it("reports a refused create", () => {
    state.create.mockImplementation((_body, options) =>
      options.onError(new Error("Expiration must be in the future")),
    );
    const input = openCreate();
    fireEvent.change(input, { target: { value: "2026-11-06" } });
    fireEvent.click(createButton());
    expect(toast.error).toHaveBeenCalledWith("Expiration must be in the future");
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("changing a link's expiry while a date is typed", () => {
  it("starts from the saved date, with nothing to save", () => {
    const input = openEditor(end(SAVED));
    expect(input.value).toBe(SAVED);
    expect(blocked(saveButton())).toBe(true);
    fireEvent.click(saveButton());
    expect(state.update).not.toHaveBeenCalled();
  });

  for (const [order, steps] of Object.entries(TYPING_OVER_2026_11_20)) {
    it(`never removes the expiry or saves a date the input does not show (${order})`, () => {
      for (let n = 1; n <= steps.length; n++) {
        const input = openEditor(end(SAVED));
        type(input, steps.slice(0, n));
        const [, shown, halfTyped = false] = steps[n - 1];
        click(input, saveButton(), halfTyped);
        const calls = state.update.mock.calls.map(([body]) => body);
        if (sendable(shown) && shown !== SAVED) {
          expect(calls, `${order} step ${n}`).toEqual([{ linkId: "link-1", expiresAt: end(shown) }]);
        } else {
          expect(calls, `${order} step ${n}`).toEqual([]);
          expect(blocked(saveButton())).toBe(true);
        }
        cleanup();
        state.update.mockReset();
      }
    });
  }

  it("sends nothing when the press completes a half-typed month; the date shown then needs a second click", () => {
    const input = openEditor(end("2027-11-20"));
    type(input, [["0", "", true]]);
    // Chromium turns the month "0" into 01 as the press moves focus.
    click(input, saveButton(), "2027-01-20");
    expect(state.update).not.toHaveBeenCalled();
    expect(input.value).toBe("2027-01-20");
    click(input, saveButton());
    expect(state.update.mock.calls.map(([body]) => body)).toEqual([
      { linkId: "link-1", expiresAt: end("2027-01-20") },
    ]);
  });

  it("keeps the expiry when one part is deleted", () => {
    const input = openEditor(end(SAVED));
    type(input, [["Backspace", "", true]]);
    click(input, saveButton(), true);
    expect(state.update).not.toHaveBeenCalled();
    expect(note(input)).toBe("Enter a complete date.");
  });

  it("keeps the expiry when every part is deleted", () => {
    const input = openEditor(end(SAVED));
    type(input, [["Backspace", "", true], ["Backspace", "", true], ["Backspace", ""]]);
    click(input, saveButton(), false);
    expect(state.update).not.toHaveBeenCalled();
    expect(blocked(saveButton())).toBe(true);
    expect(note(input)).toBe("Enter the last day the link works.");
  });

  it("refuses a day before today", () => {
    const input = openEditor(end(SAVED));
    fireEvent.change(input, { target: { value: "2026-11-05" } });
    click(input, saveButton());
    expect(state.update).not.toHaveBeenCalled();
    expect(note(input)).toBe("Choose today or a later date.");
  });

  it("removes the expiry only with Remove expiration, and says what the server stored", () => {
    state.update.mockImplementation((_body, options) =>
      options.onSuccess({ data: link(null) }),
    );
    const input = openEditor(end(SAVED));
    // A typed date is discarded by the removal.
    type(input, TYPING_OVER_2026_11_20["month/day/year"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove expiration" }));
    expect(state.update.mock.calls.map(([body]) => body)).toEqual([{ linkId: "link-1", expiresAt: null }]);
    expect(toast.success).toHaveBeenCalledWith("This link now never expires.");
  });

  it("offers no removal for a link without an expiry", () => {
    const input = openEditor(null);
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: "Remove expiration" })).toBeNull();
    expect(blocked(saveButton())).toBe(true);
    fireEvent.change(input, { target: { value: "2027-03-15" } });
    fireEvent.click(saveButton());
    expect(state.update.mock.calls[0][0]).toEqual({ linkId: "link-1", expiresAt: end("2027-03-15") });
  });

  it("states the stored expiry, and reports a refusal", () => {
    // The server's answer, not the request, decides what is said.
    state.update.mockImplementation((_body, options) =>
      options.onSuccess({ data: link(end("2027-03-16")) }),
    );
    const input = openEditor(end(SAVED));
    fireEvent.change(input, { target: { value: "2027-03-15" } });
    fireEvent.click(saveButton());
    expect(toast.success).toHaveBeenCalledWith(
      `This link now expires on ${new Date(end("2027-03-16")).toLocaleDateString()}.`,
    );
    cleanup();
    state.update.mockImplementation((_body, options) =>
      options.onError(new Error("Validation failed")),
    );
    const again = openEditor(end(SAVED));
    fireEvent.change(again, { target: { value: "2027-03-15" } });
    fireEvent.click(saveButton());
    expect(toast.error).toHaveBeenCalledWith("Validation failed");
    // Still open, with the date, to try again.
    expect(screen.getByLabelText("New expiration date")).toHaveProperty("value", "2027-03-15");
  });

  it("shows the stored expiry of a link made for several files", () => {
    state.create.mockImplementation((_body, options) =>
      options.onSuccess({ data: link(end(SAVED)) }),
    );
    state.update.mockImplementation((_body, options) =>
      options.onSuccess({ data: link(end("2027-03-15")) }),
    );
    openCreate(["a", "b"]);
    fireEvent.click(createButton());
    expect(screen.getByText(`Expires ${new Date(end(SAVED)).toLocaleDateString()}`)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[1]);
    fireEvent.change(screen.getByLabelText("New expiration date"), { target: { value: "2027-03-15" } });
    fireEvent.click(saveButton());
    expect(screen.getByText(`Expires ${new Date(end("2027-03-15")).toLocaleDateString()}`)).toBeTruthy();
  });

  it("labels an expiry that has passed", () => {
    state.links = [link(new Date("2026-11-01T12:00:00").toISOString())];
    renderDialog();
    expect(screen.getByText(`Expired ${new Date("2026-11-01T12:00:00").toLocaleDateString()}`)).toBeTruthy();
  });
});

/**
 * Chromium settles a half-typed part only as focus leaves the input: a lone
 * month "0" in an empty input then becomes bad input, and a half-typed part
 * of a whole date is completed (`completed`).
 */
function settleOnBlur(input: HTMLInputElement, completed?: string) {
  input.addEventListener("blur", () => {
    setHalfTyped(input, completed === undefined);
    if (completed !== undefined) input.value = completed;
  });
}

describe("a click that leaves focus in the date input", () => {
  // element.click(), as some assistive technology and automation send it:
  // no press, and focus stays in the input.
  it("creates nothing after a lone month 0, which still reads as empty", () => {
    const input = openCreate();
    settleOnBlur(input);
    type(input, TYPING_INTO_EMPTY["month/day/year"].slice(0, 1));
    expect(document.activeElement).toBe(input);
    expect(blocked(createButton())).toBe(false);
    fireEvent.click(createButton());
    expect(state.create).not.toHaveBeenCalled();
    expect(blocked(createButton())).toBe(true);
    expect(note(input)).toBe("Enter a complete date.");
  });

  it("returns focus to the date input after a refused focus-less activation", () => {
    const input = openCreate();
    settleOnBlur(input);
    type(input, TYPING_INTO_EMPTY["month/day/year"].slice(0, 1));
    expect(document.activeElement).toBe(input);
    // No press, so the click leaves focus in the input until read() settles it.
    fireEvent.click(createButton());
    expect(state.create).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(note(input)).toBe("Enter a complete date.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a complete date.");
  });

  it("creates the link with a whole date", () => {
    const input = openCreate();
    settleOnBlur(input);
    type(input, TYPING_INTO_EMPTY["month/day/year"]);
    fireEvent.click(createButton());
    expect(state.create.mock.calls.map(([body]) => body)).toEqual([
      { fileIds: ["file-1"], password: undefined, expiresAt: end("2027-03-15") },
    ]);
    // A successful create is not moved onto the date input.
    expect(document.activeElement).not.toBe(input);
  });

  it("keeps focus on a button a keyboard activation already focused", () => {
    const input = openCreate();
    settleOnBlur(input);
    type(input, TYPING_INTO_EMPTY["month/day/year"].slice(0, 1));
    const button = createButton();
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(state.create).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    expect(note(input)).toBe("Enter a complete date.");
  });

  it("leaves a successful keyboard create on the button", () => {
    const input = openCreate();
    fireEvent.change(input, { target: { value: "2027-03-15" } });
    const button = createButton();
    button.focus();
    fireEvent.click(button);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(input);
  });

  it("creates a link without an expiry when nothing was typed", () => {
    // Focused but untouched: settling leaves the input empty.
    const input = openCreate();
    expect(document.activeElement).toBe(input);
    fireEvent.click(createButton());
    expect(state.create.mock.calls.map(([body]) => body)).toEqual([{ fileIds: ["file-1"], password: undefined }]);
  });

  it("saves nothing when settling completes a half-typed month", () => {
    const input = openEditor(end("2027-11-20"));
    settleOnBlur(input, "2027-01-20");
    type(input, [["0", "", true]]);
    fireEvent.click(saveButton());
    expect(state.update).not.toHaveBeenCalled();
    // The completed date is now shown; a second click sends it.
    expect(input.value).toBe("2027-01-20");
    // Settling produced a date, not an incomplete one, so focus is not put back.
    expect(document.activeElement).not.toBe(input);
    fireEvent.click(saveButton());
    expect(state.update.mock.calls.map(([body]) => body)).toEqual([
      { linkId: "link-1", expiresAt: end("2027-01-20") },
    ]);
  });

  it("returns focus to the editor date after a refused focus-less activation", () => {
    const input = openEditor(end("2027-11-20"));
    settleOnBlur(input);
    type(input, [["0", "", true]]);
    fireEvent.click(saveButton());
    expect(state.update).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(note(input)).toBe("Enter a complete date.");
    expect(screen.getByRole("alert").textContent).toBe("Enter a complete date.");
  });
});

describe("a double-click", () => {
  it("sends one update for Save and one for Remove expiration", () => {
    const input = openEditor(end(SAVED));
    fireEvent.change(input, { target: { value: "2027-03-15" } });
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    const remove = screen.getByRole("button", { name: "Remove expiration" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(state.update.mock.calls.map(([body]) => body)).toEqual([
      { linkId: "link-1", expiresAt: end("2027-03-15") },
      { linkId: "link-1", expiresAt: null },
    ]);
  });

  it("sends one create", () => {
    const input = openCreate();
    fireEvent.change(input, { target: { value: "2027-03-15" } });
    fireEvent.click(createButton());
    fireEvent.click(createButton());
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("allows the same request again once the first has failed", () => {
    state.update.mockImplementation((_body, options) => {
      options.onError(new Error("Network error"));
      options.onSettled();
    });
    const input = openEditor(end(SAVED));
    fireEvent.change(input, { target: { value: "2027-03-15" } });
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    expect(state.update).toHaveBeenCalledTimes(2);
  });
});
