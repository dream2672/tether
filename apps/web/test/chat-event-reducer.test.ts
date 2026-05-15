import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyChatStreamEvent,
  applyChatStreamEvents,
  createChatEventReducerState,
  historySnapshotToReducerState,
  stateFromSnapshot,
  type ChatStreamEvent
} from '../src/components/chats/events/chat-event-reducer.js';

function agentTexts(state: ReturnType<typeof createChatEventReducerState>): string[] {
  return state.messages
    .filter((item) => item.kind === 'agent')
    .map((item) => item.text);
}

function lastAgent(state: ReturnType<typeof createChatEventReducerState>) {
  const item = [...state.messages].reverse().find((message) => message.kind === 'agent');
  assert(item?.kind === 'agent');
  return item;
}

function delta(eventSeq: number, turnId: string, text: string): ChatStreamEvent {
  return { type: 'agent.delta', eventSeq, turnId, text, provider: 'claude' };
}

function deltaForRequest(eventSeq: number, turnId: string, clientRequestId: string, text: string): ChatStreamEvent {
  return { type: 'agent.delta', eventSeq, turnId, clientRequestId, text, provider: 'claude' };
}

function result(eventSeq: number, turnId: string, text: string): ChatStreamEvent {
  return { type: 'agent.result', eventSeq, turnId, text, provider: 'claude' };
}

function resultForRequest(eventSeq: number, turnId: string, clientRequestId: string, text: string): ChatStreamEvent {
  return { type: 'agent.result', eventSeq, turnId, clientRequestId, text, provider: 'claude' };
}

function tool(eventSeq: number, turnId: string, name: string): ChatStreamEvent {
  return {
    type: 'agent.tool',
    eventSeq,
    turnId,
    name,
    input: { path: 'README.md' },
    result: 'ok',
    isError: false
  };
}

function permissionRequest(eventSeq: number, turnId: string, requestId: string): ChatStreamEvent {
  return {
    type: 'agent.permission_request',
    eventSeq,
    turnId,
    requestId,
    toolName: 'Write'
  };
}

test('history 先到，delta 后到：最后 user 生成 waiting，delta 合并到同一 turn', () => {
  let state = historySnapshotToReducerState([
    { role: 'user', content: 'hello', createdAt: '2026-05-14T00:00:00.000Z' }
  ], 'claude');

  assert.equal(lastAgent(state).isWaiting, true);

  state = applyChatStreamEvent(state, delta(1, 'turn-1', 'hi'));

  assert.deepEqual(agentTexts(state), ['hi']);
  assert.equal(lastAgent(state).isStreaming, true);
});

test('snapshot 最后一条 user 带真实 turnId 时，waiting assistant 绑定同一 turnId', () => {
  let state = historySnapshotToReducerState([
    {
      role: 'user',
      content: 'hello',
      createdAt: '2026-05-14T00:00:00.000Z',
      turnId: 'turn-real'
    }
  ], 'claude', 103);

  assert.equal(state.lastEventSeq, 103);
  assert.equal(lastAgent(state).id, 'turn-real');
  assert.equal(lastAgent(state).isWaiting, true);

  state = applyChatStreamEvent(state, delta(104, 'turn-real', 'hi'));

  assert.deepEqual(agentTexts(state), ['hi']);
  assert.equal(lastAgent(state).id, 'turn-real');
});

test('snapshot 只有 user 但无 turnId 时，只生成 legacy waiting，不声称 live turn 合并', () => {
  const state = historySnapshotToReducerState([
    { role: 'user', content: 'hello', createdAt: '2026-05-14T00:00:00.000Z' }
  ], 'claude');

  assert.equal(lastAgent(state).id, 'turn-1');
  assert.equal(lastAgent(state).isWaiting, true);
  assert.equal(state.completedTurnIds.has('turn-1'), false);
});

test('snapshot 已 completed 且带真实 turnId，不创建 waiting，并 gate 同 turn late delta', () => {
  let state = historySnapshotToReducerState([
    { role: 'user', content: 'hello', createdAt: '2026-05-14T00:00:00.000Z', turnId: 'turn-a' },
    { role: 'assistant', content: 'done', createdAt: '2026-05-14T00:00:01.000Z', turnId: 'turn-a' }
  ], 'claude', 10);

  assert.equal(lastAgent(state).id, 'turn-a');
  assert.equal(lastAgent(state).isWaiting, false);
  assert.equal(state.completedTurnIds.has('turn-a'), true);

  state = applyChatStreamEvent(state, delta(11, 'turn-a', ' late'));

  assert.deepEqual(agentTexts(state), ['done']);
  assert.equal(state.lastEventSeq, 11);
});

test('legacy completed snapshot 只能靠 snapshotEventSeq 丢旧事件，不能建真实 completed turn gate', () => {
  let state = historySnapshotToReducerState([
    { role: 'assistant', content: 'legacy done', createdAt: '2026-05-14T00:00:01.000Z' }
  ], 'claude', 10);

  assert.equal(state.completedTurnIds.has('history-agent-0'), false);

  state = applyChatStreamEvent(state, delta(10, 'history-agent-0', ' old'));
  assert.deepEqual(agentTexts(state), ['legacy done']);
});

test('stateFromSnapshot 使用 snapshotEventSeq 作为水位，丢弃已覆盖事件', () => {
  let state = stateFromSnapshot({
    sessionId: 'session-1',
    snapshotEventSeq: 103,
    messages: [
      {
        role: 'user',
        content: 'hello',
        createdAt: '2026-05-14T00:00:00.000Z',
        turnId: 'turn-a'
      }
    ]
  }, 'claude');

  state = applyChatStreamEvents(state, [
    delta(103, 'turn-a', 'old'),
    delta(104, 'turn-a', 'new')
  ]);

  assert.deepEqual(agentTexts(state), ['new']);
  assert.equal(state.lastEventSeq, 104);
});

test('applyChatStreamEvents 对无序事件先排序，catch-up 与 live 重叠按 eventSeq 去重', () => {
  const state = applyChatStreamEvents(createChatEventReducerState(), [
    result(3, 'turn-a', 'final'),
    delta(1, 'turn-a', 'fi'),
    delta(2, 'turn-a', 'nal'),
    delta(2, 'turn-a', ' duplicate')
  ]);

  assert.deepEqual(agentTexts(state), ['final']);
  assert.equal(state.lastEventSeq, 3);
});

test('legacy history agent 不作为真实 completed turn gate', () => {
  const state = createChatEventReducerState([
    {
      kind: 'agent',
      id: 'history-agent-0',
      text: 'legacy final',
      isStreaming: false,
      isWaiting: false,
      isLost: false,
      provider: 'claude'
    }
  ]);

  assert.equal(state.completedTurnIds.has('history-agent-0'), false);
});

test('delta 先到，result 后到：result 替换为最终文本并关闭 streaming', () => {
  let state = createChatEventReducerState();

  state = applyChatStreamEvents(state, [
    delta(1, 'turn-a', 'hel'),
    delta(2, 'turn-a', 'lo'),
    result(3, 'turn-a', 'hello final')
  ]);

  assert.deepEqual(agentTexts(state), ['hello final']);
  assert.equal(lastAgent(state).isStreaming, false);
  assert.equal(lastAgent(state).isWaiting, false);
});

test('provider 只返回 result 时，直接生成 completed assistant', () => {
  const state = applyChatStreamEvent(createChatEventReducerState(), result(1, 'turn-a', 'final only'));

  assert.deepEqual(agentTexts(state), ['final only']);
  assert.equal(lastAgent(state).isStreaming, false);
  assert.equal(state.completedTurnIds.has('turn-a'), true);
});

test('agent.delta 带 clientRequestId 时绑定 optimistic waiting assistant', () => {
  let state = createChatEventReducerState([
    { kind: 'user', id: 'user-req-a', content: 'hello', ts: 100 },
    {
      kind: 'agent',
      id: 'agent-req-a',
      text: '',
      isStreaming: false,
      isWaiting: true,
      isLost: false,
      provider: 'claude'
    }
  ]);

  state = applyChatStreamEvent(state, deltaForRequest(1, 'turn-a', 'req-a', 'hi'));

  assert.deepEqual(agentTexts(state), ['hi']);
  assert.equal(lastAgent(state).id, 'turn-a');
  assert.equal(lastAgent(state).isWaiting, false);
  assert.equal(state.messages.filter((item) => item.kind === 'agent').length, 1);
});

test('agent.result 带 clientRequestId 时关闭 optimistic waiting assistant，不新增第二个 assistant', () => {
  let state = createChatEventReducerState([
    { kind: 'user', id: 'user-req-a', content: 'hello', ts: 100 },
    {
      kind: 'agent',
      id: 'agent-req-a',
      text: '',
      isStreaming: false,
      isWaiting: true,
      isLost: false,
      provider: 'claude'
    }
  ]);

  state = applyChatStreamEvent(state, resultForRequest(1, 'turn-a', 'req-a', 'final only'));

  assert.deepEqual(agentTexts(state), ['final only']);
  assert.equal(lastAgent(state).id, 'turn-a');
  assert.equal(lastAgent(state).isWaiting, false);
  assert.equal(state.messages.filter((item) => item.kind === 'agent').length, 1);
});

test('result 先到，旧 delta 后到：旧 delta 不污染最终文本', () => {
  let state = createChatEventReducerState();

  state = applyChatStreamEvent(state, result(10, 'turn-a', 'final answer'));
  state = applyChatStreamEvent(state, delta(11, 'turn-a', ' stale tail'));

  assert.deepEqual(agentTexts(state), ['final answer']);
  assert.equal(lastAgent(state).isStreaming, false);
});

test('低 seq 旧 delta 被游标丢弃，高 seq 同 turn late delta 被 completed gate 丢弃', () => {
  let state = createChatEventReducerState();

  state = applyChatStreamEvent(state, result(10, 'turn-a', 'final answer'));
  state = applyChatStreamEvent(state, delta(9, 'turn-a', ' old'));
  state = applyChatStreamEvent(state, delta(11, 'turn-a', ' late'));

  assert.deepEqual(agentTexts(state), ['final answer']);
  assert.equal(state.lastEventSeq, 11);
});

test('result 文本与 delta 累计一致时，不重复插入 assistant', () => {
  const state = applyChatStreamEvents(createChatEventReducerState(), [
    delta(1, 'turn-a', 'hello'),
    result(2, 'turn-a', 'hello')
  ]);

  assert.deepEqual(agentTexts(state), ['hello']);
  assert.equal(state.messages.filter((item) => item.kind === 'agent').length, 1);
});

test('多轮 delta id 重复：按 turnId 分离，不串轮', () => {
  let state = createChatEventReducerState();

  state = applyChatStreamEvents(state, [
    delta(1, 'turn-a', 'first '),
    delta(2, 'turn-a', 'answer'),
    result(3, 'turn-a', 'first answer'),
    delta(4, 'turn-b', 'second '),
    delta(5, 'turn-b', 'answer')
  ]);

  assert.deepEqual(agentTexts(state), ['first answer', 'second answer']);
});

test('第一轮 late delta/result 不污染第二轮', () => {
  let state = applyChatStreamEvents(createChatEventReducerState(), [
    delta(1, 'turn-a', 'first draft'),
    delta(2, 'turn-b', 'second ')
  ]);

  state = applyChatStreamEvent(state, delta(3, 'turn-a', ' stale'));
  state = applyChatStreamEvent(state, result(4, 'turn-a', 'first final'));
  state = applyChatStreamEvent(state, result(5, 'turn-b', 'second final'));

  assert.deepEqual(agentTexts(state), ['first final', 'second final']);
});

test('多轮 eventSeq 重复时 first-wins，重复事件不会覆盖当前状态', () => {
  const state = applyChatStreamEvents(createChatEventReducerState(), [
    delta(1, 'turn-a', 'first'),
    delta(1, 'turn-b', 'duplicate seq'),
    delta(2, 'turn-b', 'second')
  ]);

  assert.deepEqual(agentTexts(state), ['first', 'second']);
});

test('reconnect catch-up 后不重复、不串轮', () => {
  let state = createChatEventReducerState();
  const catchup: ChatStreamEvent[] = [
    delta(1, 'turn-a', 'first'),
    result(2, 'turn-a', 'first final'),
    delta(3, 'turn-b', 'second')
  ];

  state = applyChatStreamEvents(state, catchup);
  state = applyChatStreamEvents(state, catchup);
  state = applyChatStreamEvent(state, result(4, 'turn-b', 'second final'));

  assert.deepEqual(agentTexts(state), ['first final', 'second final']);
  assert.equal(state.messages.filter((item) => item.kind === 'agent').length, 2);
});

test('agent.tool 在 delta 中间到达时追加 tool，不打断当前 turn 文本', () => {
  const state = applyChatStreamEvents(createChatEventReducerState(), [
    delta(1, 'turn-a', 'before '),
    tool(2, 'turn-a', 'Read'),
    delta(3, 'turn-a', 'after')
  ]);

  assert.deepEqual(agentTexts(state), ['before after']);
  const toolItem = state.messages.find((item) => item.kind === 'tool');
  assert.equal(toolItem?.kind, 'tool');
  assert.equal(toolItem?.id, 'tool-turn-a-2');
});

test('agent.permission_request 让当前 turn 保持 waiting，不丢已有 delta', () => {
  const state = applyChatStreamEvents(createChatEventReducerState(), [
    delta(1, 'turn-a', 'needs permission'),
    permissionRequest(2, 'turn-a', 'perm-1')
  ]);

  const agent = lastAgent(state);
  assert.equal(agent.text, 'needs permission');
  assert.equal(agent.isWaiting, true);
  assert.equal(agent.isStreaming, false);
  const permission = state.messages.find((item) => item.kind === 'permission');
  assert.equal(permission?.kind, 'permission');
  assert.equal(permission?.id, 'permission-perm-1');
});

test('permission deny 后收到 session.error，当前 turn failed，不继续 loading', () => {
  const state = applyChatStreamEvents(createChatEventReducerState(), [
    delta(1, 'turn-a', 'partial'),
    permissionRequest(2, 'turn-a', 'perm-1'),
    { type: 'session.error', eventSeq: 3, turnId: 'turn-a', message: 'denied', provider: 'claude' }
  ]);

  const agent = lastAgent(state);
  assert.equal(agent.text, 'partial');
  assert.equal(agent.isLost, true);
  assert.equal(agent.isWaiting, false);
  assert.equal(agent.isStreaming, false);
  assert.equal(state.messages.at(-1)?.kind, 'system');
});
