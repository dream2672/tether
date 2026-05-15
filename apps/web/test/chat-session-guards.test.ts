import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgeSubscription,
  createRestoreAttempt,
  createSubscriptionAckWait,
  DEFAULT_SUBSCRIPTION_ACK_TIMEOUT_MS,
  expireSubscriptionAckWait,
  shouldApplyGatewayUnavailable,
  shouldAcceptLiveFrame,
  shouldApplyAsyncRestoreResult,
  shouldApplyRestoreAttempt,
  shouldReleaseSubscription,
  shouldStartRestore
} from '../src/components/chats/flow/chat-session-guards.js';

test('createRestoreAttempt creates stable session-scoped attempt metadata', () => {
  assert.deepEqual(createRestoreAttempt('s1', 100), {
    attemptId: 'restore-s1-100',
    sessionId: 's1',
    startedAt: 100
  });
});

test('subscription ack 成功后进入 acknowledged，不触发超时失败', () => {
  const attempt = createRestoreAttempt('s1', 100);
  const waiting = createSubscriptionAckWait({ attempt, now: 100 });
  const acknowledged = acknowledgeSubscription({
    activeSessionId: 's1',
    ackSessionId: 's1',
    currentAttemptId: attempt.attemptId,
    now: 200,
    state: waiting
  });

  assert.equal(acknowledged.status, 'acknowledged');
  assert.deepEqual(
    expireSubscriptionAckWait({
      currentAttemptId: attempt.attemptId,
      now: 100 + DEFAULT_SUBSCRIPTION_ACK_TIMEOUT_MS + 1,
      state: acknowledged
    }),
    acknowledged
  );
});

test('subscription ack 等待默认 5 秒，超时后当前 attempt failed', () => {
  const attempt = createRestoreAttempt('s1', 100);
  const waiting = createSubscriptionAckWait({ attempt, now: 100 });

  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.deadlineAt, 100 + DEFAULT_SUBSCRIPTION_ACK_TIMEOUT_MS);

  const beforeDeadline = expireSubscriptionAckWait({
    currentAttemptId: attempt.attemptId,
    now: waiting.deadlineAt - 1,
    state: waiting
  });
  assert.equal(beforeDeadline.status, 'waiting');

  const failed = expireSubscriptionAckWait({
    currentAttemptId: attempt.attemptId,
    now: waiting.deadlineAt,
    state: waiting
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'ack_timeout');
});

test('subscription ack 超时只失败当前 attempt，重连后的新 attempt 可重新等待', () => {
  const firstAttempt = createRestoreAttempt('s1', 100);
  const secondAttempt = createRestoreAttempt('s1', 200);
  const firstWaiting = createSubscriptionAckWait({ attempt: firstAttempt, now: 100 });
  const secondWaiting = createSubscriptionAckWait({ attempt: secondAttempt, now: 200 });

  const staleTimeout = expireSubscriptionAckWait({
    currentAttemptId: secondAttempt.attemptId,
    now: firstWaiting.deadlineAt,
    state: firstWaiting
  });

  assert.equal(staleTimeout.status, 'waiting');
  assert.equal(secondWaiting.status, 'waiting');
  assert.equal(secondWaiting.attempt.attemptId, secondAttempt.attemptId);
});

test('shouldApplyAsyncRestoreResult accepts only matching session and current attempt', () => {
  assert.equal(
    shouldApplyAsyncRestoreResult({
      activeSessionId: 's1',
      currentAttemptId: 'r2',
      responseAttemptId: 'r2',
      responseSessionId: 's1'
    }),
    true
  );
  assert.equal(
    shouldApplyAsyncRestoreResult({
      activeSessionId: 's1',
      currentAttemptId: 'r2',
      responseAttemptId: 'r1',
      responseSessionId: 's1'
    }),
    false
  );
});

test('shouldAcceptLiveFrame drops frames from previous sessions', () => {
  assert.equal(shouldAcceptLiveFrame({ activeSessionId: 'b', frameSessionId: 'a' }), false);
  assert.equal(shouldAcceptLiveFrame({ activeSessionId: 'b', frameSessionId: 'b' }), true);
});

test('shouldApplyRestoreAttempt drops stale A -> B -> A responses', () => {
  assert.equal(shouldApplyRestoreAttempt({ currentAttemptId: 'a-2', responseAttemptId: 'a-1' }), false);
});

test('shouldReleaseSubscription releases when switching sessions', () => {
  assert.equal(shouldReleaseSubscription({ subscribedSessionId: 'a', nextSessionId: 'b' }), true);
  assert.equal(shouldReleaseSubscription({ subscribedSessionId: 'a', nextSessionId: 'a' }), false);
});

test('shouldStartRestore requires auth, metadata, and session id', () => {
  assert.equal(shouldStartRestore({ authReady: true, metadataReady: true, sessionId: 's1' }), true);
  assert.equal(shouldStartRestore({ authReady: false, metadataReady: true, sessionId: 's1' }), false);
  assert.equal(shouldStartRestore({ authReady: true, metadataReady: false, sessionId: 's1' }), false);
  assert.equal(shouldStartRestore({ authReady: true, metadataReady: true, sessionId: undefined }), false);
});

test('shouldApplyGatewayUnavailable only applies session-scoped errors to the active session', () => {
  assert.equal(shouldApplyGatewayUnavailable({ activeSessionId: 's1', frameSessionId: 's1' }), true);
  assert.equal(shouldApplyGatewayUnavailable({ activeSessionId: 's1', frameSessionId: 's2' }), false);
  assert.equal(shouldApplyGatewayUnavailable({ activeSessionId: 's1', frameSessionId: undefined }), true);
});
