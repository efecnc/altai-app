import { useEffect } from "react";
import { flushPersist, useChatStore } from "../store/chatStore";

/**
 * Headless bridge that reacts to the native IsanAgent run lifecycle (mirrored
 * into `agentMeta` by the agent event bridge). It owns the cross-surface side
 * effects that must happen regardless of which chat surface is mounted:
 *
 *  - Auto-opens the mini-window when an approval is pending — the user has to
 *    act on it; hiding it would be hostile.
 *  - Flushes the debounced message persistence when a run goes idle and on
 *    unmount, so a closed app or session switch never loses the tail.
 *
 * Message state, persistence scheduling, and approval routing now live in the
 * store (`nativeMessages` + the persistence subscription + `respondToApproval`),
 * so this component no longer depends on the Vercel `useChat`/`Chat` helpers.
 *
 * NOTE: `openAiDiffTab` / `closeAiDiffTab` remain on the prop contract but are
 * not consumed yet — wiring the AI diff tab to the native `edit_diff` /
 * `approval_request` events is tracked as the native-approval workstream.
 */
export type DiffOpenInput = {
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  isNewFile: boolean;
};

export type AgentRunBridgeProps = {
  openAiDiffTab: (input: DiffOpenInput) => number | null;
  closeAiDiffTab: (approvalId: string) => void;
};

export function AgentRunBridge(_props: AgentRunBridgeProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  if (!sessionId) return null;
  return <Bridge sessionId={sessionId} />;
}

function Bridge({ sessionId }: { sessionId: string }) {
  const status = useChatStore((s) => s.agentMeta.status);
  const approvalsPending = useChatStore((s) => s.agentMeta.approvalsPending);
  const openMini = useChatStore((s) => s.openMini);

  // Surface pending approvals — the user must act on them.
  useEffect(() => {
    if (approvalsPending > 0) openMini();
  }, [approvalsPending, openMini]);

  // Flush the debounced persistence write whenever the run goes idle (or
  // errors), and on unmount, so a closed app or session switch never loses
  // the tail of the conversation.
  useEffect(() => {
    if (status !== "streaming" && status !== "thinking") {
      flushPersist(sessionId);
    }
  }, [sessionId, status]);
  useEffect(() => {
    return () => flushPersist(sessionId);
  }, [sessionId]);

  return null;
}
