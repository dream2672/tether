import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldApplyRequestResult,
  shouldApplySessionResult,
  shouldClearSessionViewState
} from '../src/components/chats/flow/session-switch-guards.js';

test('shouldApplySessionResult: accepts the response for the current session', () => {
  assert.equal(shouldApplySessionResult('session-b', 'session-b'), true);
});

test('shouldApplySessionResult: drops a stale history response after switching sessions', () => {
  assert.equal(shouldApplySessionResult('session-a', 'session-b'), false);
});

test('shouldApplySessionResult: drops a stale metadata error after leaving the session', () => {
  assert.equal(shouldApplySessionResult('session-a', undefined), false);
});

test('shouldClearSessionViewState: clears old view state when switching to an existing session', () => {
  assert.equal(
    shouldClearSessionViewState({
      activeSessionId: 'session-b',
      pendingCreatedSessionId: null,
      skipNextHistoryLoadSessionId: null
    }),
    true
  );
});

test('shouldClearSessionViewState: does not clear optimistic messages for a pending created session', () => {
  assert.equal(
    shouldClearSessionViewState({
      activeSessionId: 'session-new',
      pendingCreatedSessionId: 'session-new',
      skipNextHistoryLoadSessionId: null
    }),
    false
  );
});

test('shouldClearSessionViewState: does not clear optimistic messages when history load is skipped', () => {
  assert.equal(
    shouldClearSessionViewState({
      activeSessionId: 'session-new',
      pendingCreatedSessionId: null,
      skipNextHistoryLoadSessionId: 'session-new'
    }),
    false
  );
});

test('shouldClearSessionViewState: does not clear when there is no active session', () => {
  assert.equal(
    shouldClearSessionViewState({
      activeSessionId: undefined,
      pendingCreatedSessionId: null,
      skipNextHistoryLoadSessionId: null
    }),
    false
  );
});

test('shouldApplyRequestResult: accepts the latest session-list response for the current tab', () => {
  assert.equal(
    shouldApplyRequestResult({
      requestId: 3,
      latestRequestId: 3,
      requestTab: 'chats',
      currentTab: 'chats'
    }),
    true
  );
});

test('shouldApplyRequestResult: drops an older session-list response', () => {
  assert.equal(
    shouldApplyRequestResult({
      requestId: 2,
      latestRequestId: 3,
      requestTab: 'chats',
      currentTab: 'chats'
    }),
    false
  );
});

test('shouldApplyRequestResult: drops a response for a tab that is no longer active', () => {
  assert.equal(
    shouldApplyRequestResult({
      requestId: 3,
      latestRequestId: 3,
      requestTab: 'chats',
      currentTab: 'terminal'
    }),
    false
  );
});
