import { cleanup, renderHook } from "@testing-library/react";
import type { FocusEvent } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useReturnFocus } from "./use-return-focus";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function setup() {
  document.body.innerHTML = `
    <div id="panel" tabindex="-1"><button id="opener">Archive</button></div>
    <button id="other">Other</button>
    <div id="content"><button id="inside">Cancel</button></div>`;
  const get = (id: string) => document.getElementById(id) as HTMLElement;
  const { result } = renderHook(() => useReturnFocus<HTMLElement>());
  // Focus enters the dialog content from the opener.
  result.current.onFocusCapture({
    relatedTarget: get("opener"),
    currentTarget: get("content"),
  } as unknown as FocusEvent<HTMLElement>);
  return { get, hook: result.current };
}

const closeEvent = () => new Event("focusScope.autoFocusOnUnmount", { cancelable: true });

describe("useReturnFocus", () => {
  it("focuses the opener when focus was lost to <body>", () => {
    const { get, hook } = setup();
    const event = closeEvent();
    hook.onCloseAutoFocus(event);
    expect(document.activeElement).toBe(get("opener"));
    expect(event.defaultPrevented).toBe(true);
  });

  it("focuses the opener when an enclosing dialog parked focus on itself", () => {
    const { get, hook } = setup();
    get("panel").focus();
    hook.onCloseAutoFocus(closeEvent());
    expect(document.activeElement).toBe(get("opener"));
  });

  it("leaves focus that moved somewhere else", () => {
    const { get, hook } = setup();
    get("other").focus();
    const event = closeEvent();
    hook.onCloseAutoFocus(event);
    expect(document.activeElement).toBe(get("other"));
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing when the opener is gone or the close was already handled", () => {
    const first = setup();
    first.get("opener").remove();
    const event = closeEvent();
    first.hook.onCloseAutoFocus(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);

    const second = setup();
    const handled = closeEvent();
    handled.preventDefault();
    second.hook.onCloseAutoFocus(handled);
    expect(document.activeElement).toBe(document.body);
  });
});
