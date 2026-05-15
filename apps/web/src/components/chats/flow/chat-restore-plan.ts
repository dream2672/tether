export type ChatRestorePlanStep =
  | { type: 'release-subscription'; sessionId: string }
  | { type: 'create-attempt'; sessionId: string }
  | { type: 'load-snapshot'; sessionId: string }
  | { type: 'subscribe'; after: 0; sessionId: string }
  | { type: 'load-catchup'; after: number; sessionId: string }
  | { type: 'drain-buffer'; sessionId: string };

export function planEnterSessionRestore(input: {
  previousSessionId?: string;
  sessionId: string;
}): ChatRestorePlanStep[] {
  return [
    ...(input.previousSessionId && input.previousSessionId !== input.sessionId
      ? [{ type: 'release-subscription' as const, sessionId: input.previousSessionId }]
      : []),
    { type: 'create-attempt', sessionId: input.sessionId },
    { type: 'load-snapshot', sessionId: input.sessionId },
    { type: 'subscribe', sessionId: input.sessionId, after: 0 }
  ];
}

export function planSnapshotCatchup(input: {
  sessionId: string;
  snapshotEventSeq: number;
}): ChatRestorePlanStep[] {
  return [
    { type: 'load-snapshot', sessionId: input.sessionId },
    { type: 'load-catchup', sessionId: input.sessionId, after: input.snapshotEventSeq },
    { type: 'drain-buffer', sessionId: input.sessionId }
  ];
}

export function planReconnectRestore(sessionId: string): ChatRestorePlanStep[] {
  return planEnterSessionRestore({ sessionId });
}
