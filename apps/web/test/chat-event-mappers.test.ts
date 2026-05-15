import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapClientErrorToChatFailure,
  mapGatewayCatchupFrameLegacy,
  mapHistoryResponseToSnapshot,
  mapRelayFrameToChatEvent,
  mapRuntimeEventToChatEvent,
  mapStructuredCatchupResponse,
  parseClientRequestId,
  parseEventSeq,
  parseTurnId
} from '../src/components/chats/events/chat-event-mappers.js';

test('mapHistoryResponseToSnapshot preserves snapshotEventSeq and messages', () => {
  const snapshot = mapHistoryResponseToSnapshot({
    sessionId: 's1',
    response: { snapshotEventSeq: 42, messages: [{ role: 'user', content: 'hi', createdAt: '2026-05-14T00:00:00.000Z' }] }
  });

  assert.equal(snapshot.sessionId, 's1');
  assert.equal(snapshot.snapshotEventSeq, 42);
  assert.equal(snapshot.messages.length, 1);
});

test('mapRuntimeEventToChatEvent maps user and clientRequestId', () => {
  const event = mapRuntimeEventToChatEvent({
    provider: 'claude',
    event: {
      eventId: 1,
      eventSeq: 10,
      turnId: 'turn-a',
      clientRequestId: 'req-a',
      type: 'user.message',
      payload: { message: 'hello' },
      createdAt: '2026-05-14T00:00:00.000Z'
    }
  });

  assert.equal(event?.type, 'user.message');
  assert.equal(event?.eventSeq, 10);
  assert.equal(event?.turnId, 'turn-a');
});

test('mapRelayFrameToChatEvent maps structured agent delta', () => {
  const event = mapRelayFrameToChatEvent({
    provider: 'claude',
    frame: { type: 'agent.delta', sessionId: 's1', eventSeq: 11, turnId: 'turn-a', clientRequestId: 'req-a', text: 'hi' }
  });

  assert.deepEqual(event, {
    type: 'agent.delta',
    eventSeq: 11,
    turnId: 'turn-a',
    clientRequestId: 'req-a',
    text: 'hi',
    provider: 'claude'
  });
});

test('mapRelayFrameToChatEvent maps structured tool and permission events', () => {
  assert.deepEqual(
    mapRelayFrameToChatEvent({
      provider: 'claude',
      frame: {
        type: 'agent.tool',
        sessionId: 's1',
        eventSeq: 12,
        turnId: 'turn-a',
        name: 'Read',
        input: { path: 'README.md' },
        result: 'ok',
        isError: false
      }
    }),
    {
      type: 'agent.tool',
      eventSeq: 12,
      turnId: 'turn-a',
      name: 'Read',
      input: { path: 'README.md' },
      result: 'ok',
      isError: false
    }
  );

  assert.deepEqual(
    mapRelayFrameToChatEvent({
      provider: 'claude',
      frame: {
        type: 'agent.permission_request',
        sessionId: 's1',
        eventSeq: 13,
        turnId: 'turn-a',
        requestId: 'perm-1',
        toolName: 'Write',
        input: { path: 'README.md' }
      }
    }),
    {
      type: 'agent.permission_request',
      eventSeq: 13,
      turnId: 'turn-a',
      requestId: 'perm-1',
      toolName: 'Write'
    }
  );
});

test('mapStructuredCatchupResponse drops malformed events', () => {
  const events = mapStructuredCatchupResponse({
    provider: 'claude',
    sessionId: 's1',
    events: [
      { eventId: 1, eventSeq: 1, turnId: 'turn-a', type: 'agent.delta', payload: { text: 'ok' }, createdAt: '' },
      { eventId: 2, eventSeq: 2, type: 'agent.delta', payload: { text: 'bad' }, createdAt: '' }
    ]
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventSeq, 1);
});

test('mapGatewayCatchupFrameLegacy recognizes only legacy blob catch-up', () => {
  assert.deepEqual(
    mapGatewayCatchupFrameLegacy({ type: 'gateway.chat-catchup', sessionId: 's1', text: 'blob', lastEventId: 3 }),
    { sessionId: 's1', text: 'blob', lastEventId: 3 }
  );
  assert.equal(mapGatewayCatchupFrameLegacy({ type: 'agent.delta' }), undefined);
});

test('mapClientErrorToChatFailure maps request-scoped errors', () => {
  assert.deepEqual(
    mapClientErrorToChatFailure({ type: 'error', sessionId: 's1', code: 'relay_sync_failed', message: 'failed', clientRequestId: 'req-1' }),
    { sessionId: 's1', code: 'relay_sync_failed', message: 'failed', clientRequestId: 'req-1' }
  );
});

test('parse helpers reject empty or invalid values', () => {
  assert.equal(parseEventSeq(0), undefined);
  assert.equal(parseEventSeq(1), 1);
  assert.equal(parseTurnId(''), undefined);
  assert.equal(parseTurnId('turn'), 'turn');
  assert.equal(parseClientRequestId(''), undefined);
  assert.equal(parseClientRequestId('req'), 'req');
});
