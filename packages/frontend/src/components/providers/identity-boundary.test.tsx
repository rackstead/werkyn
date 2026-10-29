import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { onIdentityChange } from "@/lib/identity";
import { IdentityBoundary } from "./identity-boundary";

function account(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    displayName: id,
    avatarUrl: null,
    jobTitle: null,
    phone: null,
    timezone: null,
    emailVerified: true,
  };
}

function signIn(id: string | null) {
  act(() =>
    useAuthStore.setState({
      user: id ? account(id) : null,
      accessToken: id ? `${id}-token` : null,
    }),
  );
}

function Draft() {
  const [text, setText] = useState("");
  return <input aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />;
}

const draft = () => (screen.getByLabelText("Draft") as HTMLInputElement).value;

afterEach(() => {
  cleanup();
  signIn(null);
});

it("remounts its children when an account is left, not when one signs in", () => {
  render(
    <IdentityBoundary>
      <Draft />
    </IdentityBoundary>,
  );
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "typed while signed out" } });
  signIn("alice");
  expect(draft()).toBe("typed while signed out");

  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Alice's note" } });
  signIn("bob");
  expect(draft()).toBe("");
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Bob's note" } });
  signIn(null);
  expect(draft()).toBe("");
});

it("shows the fallback until the resets for leaving an account finish", async () => {
  signIn("alice");
  let finish!: () => void;
  const stop = onIdentityChange(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  render(
    <IdentityBoundary fallback={<p>Switching account</p>}>
      <Draft />
    </IdentityBoundary>,
  );
  signIn(null);
  stop();
  expect(screen.getByText("Switching account")).toBeTruthy();
  expect(screen.queryByLabelText("Draft")).toBeNull();
  await act(async () => finish());
  expect(screen.getByLabelText("Draft")).toBeTruthy();
});
