/** Run with: node test/transcript-history-tests.js */
import assert from 'node:assert/strict';
import { Store, MAX_ROWS } from '../js/store.js';
import { TranscriptHistory } from '../js/transcript-history.js';

const store = new Store();
const id = '7';
store.setMeta(id, { sessionReady: true, name: 'Current name', sandbox: true });
store.apply(id, { type: 'question_response', request_id: 'q', answers: ['yes'], event_id: 900 });
store.apply(id, { type: 'output', text: 'tail', event_id: 950 });
assert.equal(store.session(id).history.oldest, 900, 'invisible events count toward the cursor');
let calls = 0;
let resolve;
const loader = new TranscriptHistory(id, store, async (session, before) => {
  calls++;
  assert.equal(session, id);
  assert.equal(before, 900);
  return await new Promise((done) => { resolve = done; });
});
const pending = loader.load();
await loader.load();
assert.equal(calls, 1, 'only one request at a time');
store.apply(id, { type: 'output', text: ' live', event_id: 980 });
resolve({ messages: [
  { id: 100, type: 'input', payload: { text: 'older', delivery: 'queued' } },
  { id: 130, type: 'inputs_shipped', payload: { messages: [{ message_id: 100, text: 'older' }] } },
  { id: 300, type: 'question', payload: { request_id: 'q', questions: [] } },
  { id: 900, type: 'question_response', payload: { request_id: 'q', answers: ['yes'] } },
], next_cursor: 100, has_more: false, queued_messages: [{ message_id: 123, text: 'not history' }] });
await pending;
const state = store.session(id);
assert.equal(state.history.oldest, 100, 'cursor is taken from the server, not arithmetic');
assert.equal(state.history.ids.size, 6, 'overlapping page events are deduplicated');
assert.deepEqual(state.rows.map((r) => r.kind), ['user', 'question', 'agent']);
assert.equal(state.rows[0].text, 'older');
assert.ok(state.acceptedIds.has(100), 'REST inputs gain message_id');
assert.deepEqual(state.rows[1].resolved.answers, ['yes'], 'resolution crosses the page boundary');
assert.equal(state.rows[2].text, 'tail live', 'live output arriving during fetch survives');
assert.equal(state.name, 'Current name');
assert.equal(state.sandbox, true);
assert.equal(state.queue.length, 0, 'REST queue snapshot is not replayed as history');
await loader.load();
assert.equal(calls, 1, 'exhausted history stops');
store.apply(id, { type: 'output', text: 'duplicate', event_id: 980 });
assert.equal(state.rows[2].text, 'tail live');

// Reconnect replaces history and invalidates any in-flight page.
state.history.hasMore = true;
const stale = loader.load();
store.beginReplay(id);
store.apply(id, { type: 'output', text: 'new replay', event_id: 1200 });
store.commitReplay(id);
resolve({ messages: [{ id: 1, type: 'input', payload: { text: 'stale' } }], next_cursor: 1, has_more: false });
await stale;
assert.equal(store.session(id).history.oldest, 1200);
assert.equal(store.session(id).history.hasMore, true);
assert.deepEqual(store.session(id).rows.map((r) => r.text), ['new replay']);

// Expanded history must not be dropped by the old live transcript cap.
store.prependHistory(id, Array.from({ length: MAX_ROWS + 10 }, (_, i) => ({
  type: 'input', text: String(i), event_id: i + 1, message_id: i + 1,
})), 1, false);
assert.equal(store.session(id).rows.length, MAX_ROWS + 11);

// Output coalesces across a page boundary.
const fragments = new Store();
fragments.apply('1', { type: 'output', text: 'end', event_id: 10 });
fragments.prependHistory('1', [{ type: 'output', text: 'start ', event_id: 2 }], 2, false);
assert.equal(fragments.session('1').rows.length, 1);
assert.equal(fragments.session('1').rows[0].text, 'start end');

// Empty history never fetches. Destroyed panes and connection epochs ignore late pages.
const empty = new Store();
empty.setMeta('1', { sessionReady: true });
let fetched = false;
const emptyLoader = new TranscriptHistory('1', empty, () => { fetched = true; });
await emptyLoader.load();
assert.equal(fetched, false);
for (const mode of ['destroy', 'disconnect']) {
  const local = new TranscriptHistory('1', empty, () => new Promise((done) => { resolve = done; }));
  empty.setMeta('1', { sessionReady: true });
  empty.apply('1', { type: 'output', text: 'visible', event_id: 100 });
  const request = local.load();
  if (mode === 'destroy') local.destroy();
  else empty.setConnected('1', true);
  resolve({ messages: [{ id: 1, type: 'input', payload: { text: 'stale' } }], next_cursor: 1, has_more: false });
  await request;
  assert.equal(empty.session('1').history.oldest, 100);
}

// Transport IDs must not cause canonical tools/approvals to become legacy JSON cards.
const tools = new Store();
const action = { kind: 'command', command: 'ls', shell: 'bash' };
tools.apply('1', { type: 'tool_use', call_id: 'c', action, event_id: 10 });
tools.apply('1', { type: 'approval_request', call_id: 'c', request_id: 'r', action, options: [], event_id: 20 });
assert.equal(tools.session('1').rows.length, 1);
assert.equal(tools.session('1').rows[0].callId, 'c');
assert.equal(tools.session('1').rows[0].rawEvent, null);
tools.prependHistory('1', [{ type: 'input', text: 'older', event_id: 1, message_id: 1 }], 1, false);
assert.equal(tools.session('1').rows[1].callId, 'c');
console.log('transcript history tests passed');
