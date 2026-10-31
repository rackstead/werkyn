import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EmailSettings } from "./email-settings";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  test: vi.fn(),
  config: {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    user: "user",
    pass: "••••••••",
    fromAddress: "sender@example.test",
  },
}));
vi.mock("../email-api", () => ({
  useEmailConfig: () => ({ data: { data: state.config }, isLoading: false }),
  useUpdateEmailConfig: () => ({ mutate: state.update, isPending: false }),
  useSendTestEmail: () => ({ mutate: state.test, isPending: false }),
}));
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

it("submits a named mailbox without the browser email-input constraint", async () => {
  render(<EmailSettings />);
  const input = screen.getByLabelText("From Address") as HTMLInputElement;
  fireEvent.change(input, {
    target: { value: '"Werkyn, Team" <sender@example.test>' },
  });
  expect(input.checkValidity()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: '"Werkyn, Team" <sender@example.test>',
        pass: "••••••••",
      }),
      expect.any(Object),
    ),
  );
});

it("shows shared mailbox guidance and prevents saving a recipient list", async () => {
  render(<EmailSettings />);
  fireEvent.change(screen.getByLabelText("From Address"), {
    target: { value: "sender@example.test, other@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/From address must be a single mailbox/);
  expect(state.update).not.toHaveBeenCalled();
});

it("keeps empty sender fallback settings valid", async () => {
  render(<EmailSettings />);
  fireEvent.change(screen.getByLabelText("From Address"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ fromAddress: "" }),
      expect.any(Object),
    ),
  );
});
