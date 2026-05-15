import assert from 'node:assert/strict';
import test from 'node:test';
import { historySnapshotLooksOlder } from '../src/components/chats/model/chat-utils.js';
import type { MessageItem } from '../src/components/chats/model/chat-types.js';

function user(id: string, content: string): MessageItem {
  return { kind: 'user', id, content, ts: 1 };
}

function agent(id: string, text: string, state: 'done' | 'streaming' | 'waiting'): MessageItem {
  return {
    kind: 'agent',
    id,
    text,
    isStreaming: state === 'streaming',
    isWaiting: state === 'waiting',
    isLost: false,
    provider: 'claude'
  };
}

test('historySnapshotLooksOlder: protects a longer live delta from an incomplete history snapshot', () => {
  const current = [user('u1', 'hello'), agent('a1', 'final answer plus live tail', 'streaming')];
  const snapshot = [user('u1', 'hello'), agent('a1', 'final answer', 'streaming')];

  assert.equal(historySnapshotLooksOlder(current, snapshot), true);
});

test('historySnapshotLooksOlder: allows completed history to close a longer catch-up stream', () => {
  const current = [user('u1', 'hello'), agent('a1', 'final answer plus duplicated catch-up text', 'streaming')];
  const snapshot = [user('u1', 'hello'), agent('a1', 'final answer', 'done')];

  assert.equal(historySnapshotLooksOlder(current, snapshot), false);
});
