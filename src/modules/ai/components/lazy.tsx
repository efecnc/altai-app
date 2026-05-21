import { lazy, Suspense } from "react";
import type { AgentRunBridgeProps } from "./AgentRunBridge";
import type { SelectionAskAiProps } from "./SelectionAskAi";

const AgentRunBridgeInner = lazy(() =>
  import("./AgentRunBridge").then((m) => ({ default: m.AgentRunBridge })),
);

const AiSidePanelInner = lazy(() =>
  import("./AiSidePanel").then((m) => ({ default: m.AiSidePanel })),
);

const AiInputBarModule = () => import("./AiInputBar");

const AiInputBarInner = lazy(() =>
  AiInputBarModule().then((m) => ({ default: m.AiInputBar })),
);

const AiInputBarConnectInner = lazy(() =>
  AiInputBarModule().then((m) => ({ default: m.AiInputBarConnect })),
);

const SelectionAskAiInner = lazy(() =>
  import("./SelectionAskAi").then((m) => ({ default: m.SelectionAskAi })),
);

export function AgentRunBridge(props: AgentRunBridgeProps) {
  return (
    <Suspense fallback={null}>
      <AgentRunBridgeInner {...props} />
    </Suspense>
  );
}

export function AiSidePanel({
  onClose,
  hasComposer,
}: {
  onClose: () => void;
  hasComposer?: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <AiSidePanelInner onClose={onClose} hasComposer={hasComposer} />
    </Suspense>
  );
}

export function AiInputBar() {
  return (
    <Suspense fallback={null}>
      <AiInputBarInner />
    </Suspense>
  );
}

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <Suspense fallback={null}>
      <AiInputBarConnectInner onAdd={onAdd} />
    </Suspense>
  );
}

export function SelectionAskAi(props: SelectionAskAiProps) {
  return (
    <Suspense fallback={null}>
      <SelectionAskAiInner {...props} />
    </Suspense>
  );
}
