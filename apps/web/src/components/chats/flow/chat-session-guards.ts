export type ChatRestoreAttempt = {
  attemptId: string;
  sessionId: string;
  startedAt: number;
};

export type ChatSubscriptionAckState =
  | { status: 'waiting'; attempt: ChatRestoreAttempt; deadlineAt: number }
  | { status: 'acknowledged'; attempt: ChatRestoreAttempt; acknowledgedAt: number }
  | { status: 'failed'; attempt: ChatRestoreAttempt; failedAt: number; reason: 'ack_timeout' };

export const DEFAULT_SUBSCRIPTION_ACK_TIMEOUT_MS = 5000;

export function createRestoreAttempt(sessionId: string, now = Date.now()): ChatRestoreAttempt {
  return {
    attemptId: `restore-${sessionId}-${now}`,
    sessionId,
    startedAt: now
  };
}

export function createSubscriptionAckWait(input: {
  attempt: ChatRestoreAttempt;
  now?: number;
  timeoutMs?: number;
}): ChatSubscriptionAckState {
  const now = input.now ?? Date.now();
  return {
    status: 'waiting',
    attempt: input.attempt,
    deadlineAt: now + (input.timeoutMs ?? DEFAULT_SUBSCRIPTION_ACK_TIMEOUT_MS)
  };
}

export function acknowledgeSubscription(input: {
  activeSessionId: string | undefined;
  ackSessionId: string | undefined;
  currentAttemptId: string | undefined;
  now?: number;
  state: ChatSubscriptionAckState;
}): ChatSubscriptionAckState {
  if (
    input.state.status !== 'waiting' ||
    !shouldApplyAsyncRestoreResult({
      activeSessionId: input.activeSessionId,
      currentAttemptId: input.currentAttemptId,
      responseAttemptId: input.state.attempt.attemptId,
      responseSessionId: input.ackSessionId
    })
  ) {
    return input.state;
  }
  return {
    status: 'acknowledged',
    attempt: input.state.attempt,
    acknowledgedAt: input.now ?? Date.now()
  };
}

export function expireSubscriptionAckWait(input: {
  currentAttemptId: string | undefined;
  now: number;
  state: ChatSubscriptionAckState;
}): ChatSubscriptionAckState {
  if (
    input.state.status !== 'waiting' ||
    input.state.attempt.attemptId !== input.currentAttemptId ||
    input.now < input.state.deadlineAt
  ) {
    return input.state;
  }
  return {
    status: 'failed',
    attempt: input.state.attempt,
    failedAt: input.now,
    reason: 'ack_timeout'
  };
}

export function shouldApplySessionResult(input: {
  activeSessionId: string | undefined;
  responseSessionId: string | undefined;
}): boolean {
  return Boolean(input.responseSessionId && input.responseSessionId === input.activeSessionId);
}

export function shouldApplyRestoreAttempt(input: {
  currentAttemptId: string | undefined;
  responseAttemptId: string;
}): boolean {
  return Boolean(input.currentAttemptId && input.responseAttemptId === input.currentAttemptId);
}

export function shouldAcceptLiveFrame(input: {
  activeSessionId: string | undefined;
  frameSessionId: string | undefined;
}): boolean {
  return shouldApplySessionResult({
    activeSessionId: input.activeSessionId,
    responseSessionId: input.frameSessionId
  });
}

export function shouldApplyAsyncRestoreResult(input: {
  activeSessionId: string | undefined;
  currentAttemptId: string | undefined;
  responseAttemptId: string;
  responseSessionId: string | undefined;
}): boolean {
  return shouldApplySessionResult({
    activeSessionId: input.activeSessionId,
    responseSessionId: input.responseSessionId
  }) && shouldApplyRestoreAttempt({
    currentAttemptId: input.currentAttemptId,
    responseAttemptId: input.responseAttemptId
  });
}

export function shouldReleaseSubscription(input: {
  nextSessionId: string | undefined;
  subscribedSessionId: string | undefined;
}): boolean {
  return Boolean(input.subscribedSessionId && input.subscribedSessionId !== input.nextSessionId);
}

export function shouldStartRestore(input: {
  authReady: boolean;
  metadataReady?: boolean;
  sessionId: string | undefined;
}): boolean {
  return Boolean(input.authReady && input.metadataReady !== false && input.sessionId);
}

export function shouldApplyGatewayUnavailable(input: {
  activeSessionId: string | undefined;
  frameSessionId: string | undefined;
}): boolean {
  return input.frameSessionId === undefined || shouldAcceptLiveFrame({
    activeSessionId: input.activeSessionId,
    frameSessionId: input.frameSessionId
  });
}
