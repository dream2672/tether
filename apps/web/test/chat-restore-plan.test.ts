import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planEnterSessionRestore,
  planReconnectRestore,
  planSnapshotCatchup
} from '../src/components/chats/flow/chat-restore-plan.js';

test('planEnterSessionRestore starts server snapshot before live subscribe', () => {
  assert.deepEqual(planEnterSessionRestore({ sessionId: 's1' }), [
    { type: 'create-attempt', sessionId: 's1' },
    { type: 'load-snapshot', sessionId: 's1' },
    { type: 'subscribe', sessionId: 's1', after: 0 }
  ]);
});

test('planEnterSessionRestore releases previous subscription when switching sessions', () => {
  assert.deepEqual(planEnterSessionRestore({ previousSessionId: 'a', sessionId: 'b' }), [
    { type: 'release-subscription', sessionId: 'a' },
    { type: 'create-attempt', sessionId: 'b' },
    { type: 'load-snapshot', sessionId: 'b' },
    { type: 'subscribe', sessionId: 'b', after: 0 }
  ]);
});

test('planSnapshotCatchup loads catch-up after snapshotEventSeq then drains buffer', () => {
  assert.deepEqual(planSnapshotCatchup({ sessionId: 's1', snapshotEventSeq: 42 }), [
    { type: 'load-snapshot', sessionId: 's1' },
    { type: 'load-catchup', sessionId: 's1', after: 42 },
    { type: 'drain-buffer', sessionId: 's1' }
  ]);
});

test('planReconnectRestore reuses enter-session restore steps', () => {
  assert.deepEqual(planReconnectRestore('s1'), [
    { type: 'create-attempt', sessionId: 's1' },
    { type: 'load-snapshot', sessionId: 's1' },
    { type: 'subscribe', sessionId: 's1', after: 0 }
  ]);
});
