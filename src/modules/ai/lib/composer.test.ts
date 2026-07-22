import { describe, expect, it } from "vitest";
import {
  getComposerActionAvailability,
  remainingTextAfterAcceptedDispatch,
  resolveComposerEnterAction,
} from "./composer";

function availability(
  overrides: Partial<Parameters<typeof getComposerActionAvailability>[0]> = {},
) {
  return getComposerActionAvailability({
    status: "idle",
    hasDraft: true,
    hasNativeAttachment: false,
    runId: null,
    submitting: false,
    ...overrides,
  });
}

describe("composer run actions", () => {
  it("maps Enter to send while idle and Queue next during an active run", () => {
    expect(
      resolveComposerEnterAction({
        availability: availability(),
        shiftKey: false,
        modifierKey: false,
      }),
    ).toBe("send");
    expect(
      resolveComposerEnterAction({
        availability: availability({ status: "streaming", runId: "run-1" }),
        shiftKey: false,
        modifierKey: false,
      }),
    ).toBe("queue");
  });

  it("maps Cmd/Ctrl+Enter to Steer now only for a steerable active run", () => {
    const running = availability({ status: "thinking", runId: "run-1" });
    expect(
      resolveComposerEnterAction({
        availability: running,
        shiftKey: false,
        modifierKey: true,
      }),
    ).toBe("steer");
    expect(
      resolveComposerEnterAction({
        availability: running,
        shiftKey: true,
        modifierKey: true,
      }),
    ).toBeNull();
  });

  it("keeps Queue next available while cancellation is acknowledged", () => {
    const cancelling = availability({ status: "cancelling", runId: "run-1" });
    expect(cancelling.isCancelling).toBe(true);
    expect(cancelling.canSteer).toBe(false);
    expect(cancelling.canQueue).toBe(true);
  });

  it("does not silently drop native attachments from steering", () => {
    const withAttachment = availability({
      status: "streaming",
      runId: "run-1",
      hasNativeAttachment: true,
    });
    expect(withAttachment.canSteer).toBe(false);
    expect(withAttachment.canQueue).toBe(true);
    expect(
      resolveComposerEnterAction({
        availability: withAttachment,
        shiftKey: false,
        modifierKey: true,
      }),
    ).toBeNull();
  });

  it("disables every action without a draft or while acceptance is pending", () => {
    expect(availability({ hasDraft: false })).toMatchObject({
      canSend: false,
      canSteer: false,
      canQueue: false,
    });
    expect(
      availability({ status: "thinking", runId: "run-1", submitting: true }),
    ).toMatchObject({ canSend: false, canSteer: false, canQueue: false });
  });

  it("clears an accepted snapshot without erasing text typed during acceptance", () => {
    expect(remainingTextAfterAcceptedDispatch("first", "first", true)).toBe("");
    expect(
      remainingTextAfterAcceptedDispatch("first then second", "first", false),
    ).toBe("then second");
    expect(
      remainingTextAfterAcceptedDispatch("edited first", "first", false),
    ).toBe("edited first");
  });
});
