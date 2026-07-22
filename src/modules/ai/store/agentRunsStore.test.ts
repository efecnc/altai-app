import { beforeEach, describe, expect, it } from "vitest";
import type { ParsedAgentEvent } from "../lib/agentEventBridge";
import { useAgentRunsStore } from "./agentRunsStore";

const event = (seq: number, value: object, runId = "run-1") =>
  ({
    ...value,
    version: 1 as const,
    scope: "run" as const,
    chat_id: "chat-1",
    run_id: runId,
    seq,
  }) as ParsedAgentEvent;

describe("agentRunsStore lifecycle admission", () => {
  beforeEach(() => useAgentRunsStore.setState({ runs: {} }));

  it("advances sequence and rejects duplicate and out-of-order events", () => {
    const ingest = useAgentRunsStore.getState().ingest;
    expect(ingest("chat-1", event(1, { type: "run_started" }))).toBe(true);
    expect(
      ingest("chat-1", event(2, { type: "thinking", content: "one" })),
    ).toBe(true);
    expect(
      ingest("chat-1", event(2, { type: "thinking", content: "duplicate" })),
    ).toBe(false);
    expect(
      ingest("chat-1", event(1, { type: "thinking", content: "old" })),
    ).toBe(false);
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      lastSeq: 2,
      step: "one",
    });
  });

  it("rejects stale terminals and admits a new run after termination", () => {
    const ingest = useAgentRunsStore.getState().ingest;
    ingest("chat-1", event(1, { type: "run_started" }));
    expect(
      ingest(
        "chat-1",
        event(
          2,
          { type: "run_terminated", outcome: { kind: "completed" } },
          "other",
        ),
      ),
    ).toBe(false);
    expect(
      ingest(
        "chat-1",
        event(2, {
          type: "run_terminated",
          outcome: { kind: "completed" },
        }),
      ),
    ).toBe(true);
    expect(
      ingest("chat-1", event(1, { type: "run_started" }, "run-2")),
    ).toBe(true);
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      runId: "run-2",
      lastSeq: 1,
      completed: false,
    });
  });

  it("keeps assistant prose non-terminal", () => {
    const ingest = useAgentRunsStore.getState().ingest;
    ingest("chat-1", event(1, { type: "run_started" }));
    ingest(
      "chat-1",
      event(2, {
        type: "agent_message",
        role: "assistant",
        content: "done-ish",
      }),
    );
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      completed: false,
      lastResult: "done-ish",
    });
  });

  it("stores a typed warning without completing or rewriting the run", () => {
    const ingest = useAgentRunsStore.getState().ingest;
    ingest("chat-1", event(1, { type: "run_started" }));
    expect(
      ingest(
        "chat-1",
        event(2, {
          type: "run_warning",
          warning: {
            reason: { kind: "repeated_root_cause", failures: 2 },
            budget: { iterations_used: 4, iterations_limit: 50 },
          },
        }),
      ),
    ).toBe(true);
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      runId: "run-1",
      lastSeq: 2,
      completed: false,
      warning: { reason: { kind: "repeated_root_cause", failures: 2 } },
    });
  });

  it("marks only the exact live run as cancelling and waits for termination", () => {
    const store = useAgentRunsStore.getState();
    store.ingest("chat-1", event(1, { type: "run_started" }));
    expect(store.markCancelling("chat-1", "stale-run")).toBe(false);
    expect(store.markCancelling("chat-1", "run-1")).toBe(true);
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      status: "cancelling",
      completed: false,
    });
    expect(
      store.ingest(
        "chat-1",
        event(2, {
          type: "run_terminated",
          outcome: { kind: "cancelled" },
        }),
      ),
    ).toBe(true);
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      status: "idle",
      completed: true,
      outcome: { kind: "cancelled" },
    });
  });

  it("makes an accepted run cancellable before run_started arrives", () => {
    const store = useAgentRunsStore.getState();
    expect(store.admitAccepted("chat-1", "run-1")).toBe(true);
    expect(store.markCancelling("chat-1", "run-1")).toBe(true);
    expect(store.ingest("chat-1", event(1, { type: "run_started" }))).toBe(
      true,
    );
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      runId: "run-1",
      lastSeq: 1,
      status: "cancelling",
      completed: false,
    });
  });

  it("does not resurrect a run when its acknowledgement arrives after terminal", () => {
    const store = useAgentRunsStore.getState();
    store.ingest("chat-1", event(1, { type: "run_started" }));
    store.ingest(
      "chat-1",
      event(2, {
        type: "run_terminated",
        outcome: { kind: "completed" },
      }),
    );

    expect(store.admitAccepted("chat-1", "run-1")).toBe(true);
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      runId: "run-1",
      lastSeq: 2,
      completed: true,
      outcome: { kind: "completed" },
    });
  });
});
