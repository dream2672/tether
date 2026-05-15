import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bufferLiveEvent,
  createRestoreBuffer,
  drainBufferedEvents,
  isRestoreBufferDrained,
  isRestoreBufferOverflowed
} from '../src/components/chats/flow/chat-restore-buffer.js';
import type { ChatStreamEvent } from '../src/components/chats/events/chat-event-reducer.js';

function delta(eventSeq: number, text = 'x'): ChatStreamEvent {
  return { type: 'agent.delta', eventSeq, turnId: 'turn-a', text, provider: 'claude' };
}

test('bufferLiveEvent stores live events while buffer is open', () => {
  let buffer = createRestoreBuffer({ attemptId: 'r1', sessionId: 's1' });
  ({ buffer } = bufferLiveEvent({ buffer, event: delta(2), maxEvents: 10, maxPayloadBytes: 1000 }));

  assert.equal(buffer.events.length, 1);
  assert.equal(buffer.events[0]?.eventSeq, 2);
});

test('drainBufferedEvents sorts catch-up plus buffered events and drops snapshot-covered events', () => {
  let buffer = createRestoreBuffer({ attemptId: 'r1', sessionId: 's1' });
  ({ buffer } = bufferLiveEvent({ buffer, event: delta(4), maxEvents: 10, maxPayloadBytes: 1000 }));
  ({ buffer } = bufferLiveEvent({ buffer, event: delta(2), maxEvents: 10, maxPayloadBytes: 1000 }));

  const drained = drainBufferedEvents({
    buffer,
    catchupEvents: [delta(3), delta(1)],
    snapshotEventSeq: 1
  });

  assert.deepEqual(drained.eventsToApply.map((event) => event.eventSeq), [2, 3, 4]);
  assert.equal(isRestoreBufferDrained(drained.buffer), true);
});

test('bufferLiveEvent returns rejectedEvent after drain', () => {
  const buffer = drainBufferedEvents({
    buffer: createRestoreBuffer({ attemptId: 'r1', sessionId: 's1' }),
    catchupEvents: [],
    snapshotEventSeq: 0
  }).buffer;

  const result = bufferLiveEvent({ buffer, event: delta(5), maxEvents: 10, maxPayloadBytes: 1000 });

  assert.equal(result.rejectedEvent?.eventSeq, 5);
  assert.equal(result.buffer.events.length, 0);
});

test('bufferLiveEvent marks overflow and rejects event when caps are exceeded', () => {
  const buffer = createRestoreBuffer({ attemptId: 'r1', sessionId: 's1' });
  const result = bufferLiveEvent({ buffer, event: delta(2, 'long-text'), maxEvents: 0, maxPayloadBytes: 1000 });

  assert.equal(isRestoreBufferOverflowed(result.buffer), true);
  assert.equal(result.rejectedEvent?.eventSeq, 2);
});
