import { describe, expect, it } from "vitest";
import { matchBinding, type KeyBinding } from "./shortcuts";

function keyboardEvent(
  key: string,
  code: string,
  modifiers: Partial<
    Pick<
      KeyboardEvent,
      "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
    >
  > = {},
): KeyboardEvent {
  return {
    key,
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

describe("matchBinding", () => {
  it("matches Latin-letter shortcuts by physical key on Turkish layouts", () => {
    const binding: KeyBinding = { ctrl: true, key: "i" };

    expect(
      matchBinding(
        keyboardEvent("ı", "KeyI", { ctrlKey: true }),
        binding,
        "ai.toggle",
      ),
    ).toBe(true);
  });

  it("does not use the physical-key fallback for punctuation", () => {
    expect(
      matchBinding(
        keyboardEvent("+", "Equal", { ctrlKey: true, shiftKey: true }),
        { ctrl: true, shift: true, key: "=" },
        "view.zoomIn",
      ),
    ).toBe(false);
  });

  it("requires an exact modifier match", () => {
    expect(
      matchBinding(
        keyboardEvent("i", "KeyI", { ctrlKey: true, shiftKey: true }),
        { ctrl: true, key: "i" },
        "ai.toggle",
      ),
    ).toBe(false);
  });

  it("accepts every digit from 1 through 9 for tab selection", () => {
    expect(
      matchBinding(
        keyboardEvent("9", "Digit9", { ctrlKey: true }),
        { ctrl: true, key: "1" },
        "tab.selectByIndex",
      ),
    ).toBe(true);
  });
});
