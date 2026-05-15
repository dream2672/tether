import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOptimisticTurn,
  reconcileOptimisticTurn,
  rollbackOptimisticTurn
} from '../src/components/chats/flow/chat-create-flow.js';
import type { MessageItem } from '../src/components/chats/model/chat-types.js';

test('createOptimisticTurn creates paired user and waiting assistant by clientRequestId', () => {
  const turn = createOptimisticTurn({
    clientRequestId: 'req-1',
    now: 100,
    provider: 'claude',
    text: 'hello'
  });

  assert.deepEqual(turn.user, { kind: 'user', id: 'user-req-1', content: 'hello', ts: 100 });
  assert.equal(turn.agent.kind, 'agent');
  assert.equal(turn.agent.id, 'agent-req-1');
  assert.equal(turn.agent.isWaiting, true);
});

test('reconcileOptimisticTurn binds both optimistic user and waiting agent to real turnId', () => {
  const optimistic = createOptimisticTurn({
    clientRequestId: 'req-1',
    now: 100,
    provider: 'claude',
    text: 'hello'
  });
  const messages = reconcileOptimisticTurn({
    clientRequestId: 'req-1',
    content: 'hello',
    eventSeq: 10,
    messages: [optimistic.user, optimistic.agent],
    ts: 120,
    turnId: 'turn-a'
  });

  assert.equal(messages.find((item) => item.kind === 'user')?.id, 'turn-a-user');
  assert.equal(messages.find((item) => item.kind === 'agent')?.id, 'turn-a');
});

test('reconcileOptimisticTurn 后续 delta 只更新原 waiting assistant，不新增第二个 assistant', () => {
  const optimistic = createOptimisticTurn({
    clientRequestId: 'req-1',
    now: 100,
    provider: 'claude',
    text: 'hello'
  });
  const messages = reconcileOptimisticTurn({
    clientRequestId: 'req-1',
    content: 'hello',
    eventSeq: 10,
    messages: [optimistic.user, optimistic.agent],
    ts: 120,
    turnId: 'turn-a'
  });

  assert.equal(messages.filter((item) => item.kind === 'agent' && item.id === 'turn-a').length, 1);
  assert.equal(messages.filter((item) => item.kind === 'agent').length, 1);
});

test('reconcileOptimisticTurn keeps same-text different request turns separate', () => {
  const first = createOptimisticTurn({ clientRequestId: 'req-1', now: 100, provider: 'claude', text: 'same' });
  const second = createOptimisticTurn({ clientRequestId: 'req-2', now: 101, provider: 'claude', text: 'same' });
  const messages = reconcileOptimisticTurn({
    clientRequestId: 'req-1',
    content: 'same',
    eventSeq: 10,
    messages: [first.user, first.agent, second.user, second.agent],
    ts: 120,
    turnId: 'turn-a'
  });

  assert.deepEqual(
    messages.filter((item) => item.kind === 'user').map((item) => item.id),
    ['turn-a-user', 'user-req-2']
  );
  assert.equal(messages.filter((item) => item.kind === 'user').length, 2);
});

test('rollbackOptimisticTurn removes pending pair and appends system reason', () => {
  const optimistic = createOptimisticTurn({
    clientRequestId: 'req-1',
    now: 100,
    provider: 'claude',
    text: 'hello'
  });
  const stable: MessageItem = { kind: 'user', id: 'turn-old-user', content: 'old', ts: 1 };

  const messages = rollbackOptimisticTurn({
    clientRequestId: 'req-1',
    messages: [stable, optimistic.user, optimistic.agent],
    reason: 'busy'
  });

  assert.deepEqual(messages.map((item) => item.id), ['turn-old-user', 'rollback-req-1']);
  assert.equal(messages.at(-1)?.kind, 'system');
});
