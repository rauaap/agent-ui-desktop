/**
 * Model output streaming: transient drafts beside durable history. Contract:
 * agent-ui-server/docs/model-streaming-client-handoff.md.
 */

import { Store, applyStream, reduce, rowText, toMarkdown } from '../js/store.js';
import { draftPreview } from '../js/tools.js';

export const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const textDraft = (id, revision = 0, text = '', ordinal = 0) => (
  { stream_id: id, turn_id: 't1', ordinal, revision, kind: 'text', text });
const toolDraft = (id, revision = 0, preview = {}, json = '', name = 'mcp__agent_ui__message_session',
  callId = 'c1') => ({
  stream_id: id, turn_id: 't1', ordinal: 1, revision, kind: 'tool', call_id: callId, name,
  arguments_json: json, arguments_preview: preview,
});
const start = (draft) => ({ type: 'stream_start', draft });
const delta = (id, revision, text, preview) => ({
  type: 'stream_delta', stream_id: id, revision, delta: text,
  ...(preview ? { arguments_preview: preview } : {}),
});
const snapshot = (...drafts) => ({ type: 'stream_snapshot', drafts });
const meta = (id, ordinal = 0) => ({ stream_id: id, turn_id: 't1', ordinal });
const message = { kind: 'other', name: 'mcp__agent_ui__message_session',
  arguments: { session_id: 42, message: 'Hello world' } };

/** A Store plus every change it emitted. */
function harness() {
  const store = new Store();
  const changes = [];
  store.subscribe('s', (batch) => changes.push(...batch));
  return { store, changes, state: () => store.session('s') };
}

await test('stream: text deltas build one draft outside rows and history', () => {
  const { store, state, changes } = harness();
  equal(store.apply('s', start(textDraft('s1'))), true);
  equal(store.apply('s', delta('s1', 1, 'Hello')), true);
  equal(store.apply('s', delta('s1', 2, ' world')), true);
  equal(state().drafts.get('s1').text, 'Hello world');
  equal(state().drafts.get('s1').revision, 2);
  equal(state().rows.length, 0);
  equal(state().history.events.length, 0, 'no delta is kept in the replay log');
  equal(changes.map((c) => c.op), ['draft', 'draft', 'draft']);
});

await test('stream: duplicate and older revisions are ignored; gaps and unknown drafts desync', () => {
  const { store, state, changes } = harness();
  store.apply('s', start(textDraft('s1', 3, 'abc')));
  equal(store.apply('s', delta('s1', 3, 'dup')), true);
  equal(store.apply('s', delta('s1', 2, 'old')), true);
  equal(store.apply('s', start(textDraft('s1', 3, 'abc'))), true, 'duplicate start');
  equal(state().drafts.get('s1').text, 'abc');
  const emitted = changes.length;
  equal(store.apply('s', delta('s1', 5, 'gap')), false);
  equal(store.apply('s', delta('nope', 1, 'x')), false);
  equal(store.apply('s', start(textDraft('s1', 4, 'abcd'))), false, 'restart of a live draft');
  equal(store.apply('s', { type: 'stream_delta', stream_id: 's1', revision: '4', delta: 'x' }), false);
  equal(store.apply('s', start({ ...textDraft('s2'), kind: 'thinking' })), false);
  equal(state().drafts.get('s1').text, 'abc', 'nothing is guessed');
  equal(changes.length, emitted);
});

await test('stream: tool deltas append raw JSON and replace, not merge, the preview', () => {
  const { store, state } = harness();
  store.apply('s', start(toolDraft('s2')));
  store.apply('s', delta('s2', 1, '{"session_id":42,"message":"Hel', { session_id: 42, message: 'Hel' }));
  store.apply('s', delta('s2', 2, 'lo"', { message: 'Hello' }));
  const draft = state().drafts.get('s2');
  equal(draft.argumentsJson, '{"session_id":42,"message":"Hello"');
  equal(draft.argumentsPreview, { message: 'Hello' });
  store.apply('s', delta('s2', 3, '}'));
  equal(draft.argumentsPreview, { message: 'Hello' }, 'an update without a preview keeps the last one');
  equal(state().pendingApprovalId, null);
  equal(state().rows.length, 0);
});

await test('stream: final output replaces its draft; finals also stand alone', () => {
  const { store, state, changes } = harness();
  store.apply('s', start(textDraft('s1')));
  store.apply('s', delta('s1', 1, 'Hello'));
  changes.length = 0;
  store.apply('s', { type: 'output', text: 'Hello world', ...meta('s1'), event_id: 124 });
  equal(changes.map((c) => c.op), ['draft-remove', 'append']);
  equal(state().drafts.size, 0);
  equal(state().rows.map((r) => [r.kind, r.text, r.eventIds]), [['agent', 'Hello world', [124]]]);
  // A replayed duplicate is dropped by event ID; a final without a draft renders.
  store.apply('s', { type: 'output', text: 'Hello world', ...meta('s1'), event_id: 124 });
  store.apply('s', { type: 'done' });
  store.apply('s', { type: 'output', text: 'Again', ...meta('s9'), event_id: 125 });
  equal(state().rows.map((r) => r.text), ['Hello world', 'Again']);
});

await test('stream: final tool_use admits streaming metadata but stays strictly validated', () => {
  const tool = (extra) => {
    const state = new Store().session('x');
    reduce(state, { type: 'tool_use', call_id: 'c1', action: message, ...extra, event_id: 1 });
    return state.rows[0];
  };
  equal(tool(meta('s2', 1)).action, message);
  equal(tool({}).action, message, 'pre-streaming events remain canonical');
  equal(tool({ ...meta('s2'), ordinal: -1 }).action, null);
  equal(tool({ ...meta('s2'), stream_id: 7 }).action, null);
  equal(tool({ ...meta('s2'), revision: 3 }).action, null, 'no other keys are admitted');
  equal(tool({ ...meta('s2'), action: { kind: 'other', name: 'x' } }).action, null);
});

await test('stream: completed messaging card, then only its approval offers controls', () => {
  const { store, state } = harness();
  store.apply('s', start(toolDraft('s2')));
  store.apply('s', delta('s2', 1, '{"message":"Hi"', { message: 'Hi' }));
  equal(state().pendingApprovalId, null, 'drafts never become pending');
  store.apply('s', { type: 'tool_use', call_id: 'c1', action: message, ...meta('s2', 1), event_id: 10 });
  equal(state().drafts.size, 0);
  equal(state().rows.map((r) => r.kind), ['tool']);
  equal(state().pendingApprovalId, null, 'a completed call is not an approval');
  const key = state().rows[0].key;
  store.apply('s', { type: 'approval_request', request_id: 'r1', call_id: 'c1', action: message,
    options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }], event_id: 11 });
  equal(state().rows.map((r) => [r.kind, r.key]), [['approval', key]]);
  equal(state().pendingApprovalId, 'r1');
  store.apply('s', { type: 'approval_response', request_id: 'r1', behavior: 'deny', event_id: 12 });
  equal(state().pendingApprovalId, null);
  equal(state().rows[0].resolved.behavior, 'deny');
});

await test('stream: a question coalesces with its tool card by call ID', () => {
  const { store, state, changes } = harness();
  const ask = { kind: 'other', name: 'AskUserQuestion', arguments: { questions: [] } };
  store.apply('s', start(toolDraft('s3', 0, {}, '', 'AskUserQuestion', 'cq')));
  store.apply('s', { type: 'tool_use', call_id: 'cq', action: ask, ...meta('s3', 2), event_id: 20 });
  const key = state().rows[0].key;
  changes.length = 0;
  const question = { type: 'question', request_id: 'question_1', call_id: 'cq',
    questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }], event_id: 21 };
  store.apply('s', question);
  equal(changes.map((c) => c.op), ['update']);
  equal(state().rows.map((r) => [r.kind, r.key, r.callId]), [['question', key, 'cq']]);
  equal(state().pendingQuestionId, 'question_1');
  // History replay in the same order produces the same single card.
  const replayed = new Store().session('y');
  for (const event of state().history.events) reduce(replayed, event);
  equal(replayed.rows.map((r) => r.kind), ['question']);
  // An out-of-order completed call cannot add a second card.
  reduce(replayed, { type: 'tool_use', call_id: 'cq', action: ask, event_id: 22 });
  equal(replayed.rows.map((r) => r.kind), ['question']);
  // A question with no matching card, or no call ID, stands alone.
  reduce(replayed, { ...question, request_id: 'question_2', call_id: 'other', event_id: 23 });
  reduce(replayed, { type: 'question', request_id: 'question_3', questions: [], event_id: 24 });
  equal(replayed.rows.map((r) => r.kind), ['question', 'question', 'question']);
});

await test('stream: interrupted drafts stay visible, labelled and non-actionable', () => {
  const { store, state } = harness();
  store.apply('s', start(toolDraft('s2', 0, {}, '')));
  store.apply('s', delta('s2', 1, '{"session_id":42,"message":"unfin', { session_id: 42, message: 'unfin' }));
  const wire = toolDraft('s2', 1, { session_id: 42, message: 'unfin' }, '{"session_id":42,"message":"unfin');
  store.apply('s', { type: 'stream_interrupted', draft: wire, reason: 'cancelled', event_id: 30 });
  equal(state().drafts.size, 0);
  const row = state().rows[0];
  equal([row.kind, row.reason, row.draft.argumentsPreview.message], ['interrupted', 'cancelled', 'unfin']);
  equal(state().pendingApprovalId, null);
  equal(rowText(row).includes('unfin'), true);
  equal(toMarkdown(state()).includes('interrupted: stopped, not run'), true);

  store.apply('s', { type: 'stream_interrupted', draft: textDraft('s4', 2, 'Half a'), reason: 'retry', event_id: 31 });
  equal(state().rows[0].draft.text, 'Half a', 'ordinal 0 sits before the ordinal 1 call');
  equal(toMarkdown(state()).includes('### Agent (interrupted: abandoned for a retry)'), true);
  store.apply('s', { type: 'stream_interrupted', draft: textDraft('s5'), reason: 'bored', event_id: 32 });
  equal([state().rows[2].draft, state().rows[2].rawEvent.reason], [null, 'bored']);
});

await test('stream: empty placeholders retire with stream_remove', () => {
  const { store, state, changes } = harness();
  store.apply('s', start(textDraft('s3')));
  equal(store.apply('s', { type: 'stream_remove', stream_id: 's3' }), true);
  equal(store.apply('s', { type: 'stream_remove', stream_id: 's3' }), true, 'idempotent');
  equal(state().drafts.size, 0);
  equal(changes.map((c) => c.op), ['draft', 'draft-remove']);
  equal(state().history.events.length, 0);
});

await test('stream: a snapshot replaces the draft collection and sets the next revision', () => {
  const { store, state } = harness();
  store.apply('s', start(textDraft('stale', 0, 'old')));
  store.apply('s', snapshot(textDraft('s1', 7, 'Hello so far'), toolDraft('s2', 2, { message: 'x' }, '{"m')));
  equal([...state().drafts.keys()], ['s1', 's2'], 'source order is kept');
  equal(store.apply('s', delta('s1', 8, '!')), true);
  equal(state().drafts.get('s1').text, 'Hello so far!');
  equal(store.apply('s', snapshot()), true);
  equal(state().drafts.size, 0);
  equal(store.apply('s', snapshot(textDraft('a'), textDraft('a'))), false, 'duplicate IDs desync');
  equal(store.apply('s', { type: 'stream_snapshot' }), false);
});

await test('stream: a reconnect replay commits history and drafts together, exactly once', () => {
  const { store, state, changes } = harness();
  store.apply('s', { type: 'output', text: 'Earlier', event_id: 1 });
  store.apply('s', { type: 'done' });
  store.apply('s', start(textDraft('s1', 0)));
  store.apply('s', delta('s1', 1, 'Partial'));
  store.apply('s', start(textDraft('gone', 0)));
  store.apply('s', { type: 'status', status: 'running' });

  store.beginReplay('s');
  changes.length = 0;
  store.apply('s', { type: 'output', text: 'Earlier', event_id: 1 });
  store.apply('s', { type: 'done' });
  store.apply('s', snapshot(textDraft('s1', 4, 'Partial and more')));
  store.apply('s', { type: 'input_queue', messages: [] });
  equal(changes.length, 0, 'buffered replay is invisible');
  equal(state().drafts.get('s1').text, 'Partial', 'the visible draft is untouched');
  store.apply('s', { type: 'status', status: 'running' });
  store.commitReplay('s');
  equal([...state().drafts.keys()], ['s1'], 'stale drafts absent from the snapshot are gone');
  equal(state().drafts.get('s1').text, 'Partial and more');
  equal(state().rows.map((r) => r.text), ['Earlier']);
  equal(state().history.events.some((e) => e.type.startsWith('stream_')), false);
  store.apply('s', delta('s1', 5, '.'));
  store.apply('s', { type: 'output', text: 'Partial and more.', ...meta('s1'), event_id: 2 });
  equal(state().drafts.size, 0);
  equal(state().rows.map((r) => r.text), ['Earlier', 'Partial and more.']);
});

await test('stream: completion racing a reconnect leaves one final row', () => {
  const { store, state } = harness();
  store.apply('s', start(textDraft('s1')));
  store.beginReplay('s');
  store.apply('s', { type: 'output', text: 'Done', ...meta('s1'), event_id: 5 });
  store.apply('s', snapshot());
  store.apply('s', { type: 'status', status: 'idle' });
  store.commitReplay('s');
  equal(state().drafts.size, 0);
  equal(state().rows.map((r) => r.text), ['Done']);
});

await test('stream: history prepend keeps live drafts and replays no deltas', () => {
  const { store, state, changes } = harness();
  store.apply('s', { type: 'output', text: 'Newer', ...meta('s0'), event_id: 50 });
  store.apply('s', { type: 'status', status: 'running' });
  store.apply('s', start(toolDraft('s2', 0, {})));
  store.apply('s', delta('s2', 1, '{"message":"Grow', { message: 'Grow' }));
  changes.length = 0;
  store.prependHistory('s', [
    { type: 'output', text: 'Older', ...meta('s-1'), event_id: 40 },
    { type: 'stream_interrupted', draft: textDraft('s-2', 1, 'Cut'), reason: 'error', event_id: 41 },
  ], 40, false);
  equal(changes.map((c) => c.op), ['prepend']);
  equal(state().rows.map((r) => r.kind), ['agent', 'interrupted', 'agent']);
  equal([...state().drafts.keys()], ['s2']);
  equal(state().drafts.get('s2').argumentsPreview, { message: 'Grow' });
  equal(store.apply('s', delta('s2', 2, '!', { message: 'Grow!' })), true, 'revisions continue');
});

await test('stream: blocks keep turn source order when ordinal 1 completes first', () => {
  const { store, state, changes } = harness();
  store.apply('s', start(textDraft('a', 0, 'zero', 0)));
  store.apply('s', start(textDraft('b', 0, 'one', 1)));
  const one = { type: 'output', text: 'one', ...meta('b', 1), event_id: 71 };
  const zero = { type: 'output', text: 'zero', ...meta('a', 0), event_id: 72 };
  store.apply('s', one);
  equal([...state().drafts.keys()], ['a'], 'ordinal 0 is still generating');
  const firstKey = state().rows[0].key;
  changes.length = 0;
  store.apply('s', zero);
  equal(changes.find((c) => c.op === 'append').before, firstKey, 'the view is told where it goes');
  equal(state().rows.map((r) => r.text), ['zero', 'one'], 'separate blocks, in source order');
  // Reconnect replays in completion order and reaches the same rows.
  store.beginReplay('s');
  for (const event of [one, zero, snapshot(), { type: 'status', status: 'idle' }]) store.apply('s', event);
  store.commitReplay('s');
  equal(state().rows.map((r) => r.text), ['zero', 'one']);
  store.prependHistory('s', [{ type: 'output', text: 'older', event_id: 70 }], 70, false);
  equal(state().rows.map((r) => r.text), ['older', 'zero', 'one']);
  // Another turn's blocks, and unidentified rows, simply follow.
  store.apply('s', { type: 'output', text: 'next turn', stream_id: 'c', turn_id: 't2', ordinal: 0, event_id: 73 });
  store.apply('s', { type: 'error', message: 'x', event_id: 74 });
  equal(state().rows.map((r) => r.kind), ['agent', 'agent', 'agent', 'agent', 'error']);
});

await test('stream: streamed blocks never coalesce; unidentified chunks still do', () => {
  const state = new Store().session('x');
  reduce(state, { type: 'output', text: 'a', ...meta('s1', 0) });
  reduce(state, { type: 'output', text: 'b', ...meta('s2', 1) });
  reduce(state, { type: 'output', text: 'c' });
  reduce(state, { type: 'output', text: 'd' });
  equal(state.rows.map((r) => r.text), ['a', 'b', 'cd']);
});

await test('stream: draft previews read only strings and normalize prefixes', () => {
  const preview = (name, args) => draftPreview({ name, argumentsPreview: args });
  equal(preview('mcp__agent_ui__message_session', { message: 'Hi' }),
    { label: 'MESSAGE SESSION', sessionTool: 'message_session', target: null, summary: '', body: 'Hi' });
  equal(preview('message_session', { session_id: 42, message: 5 }).target, '42');
  equal(preview('message_session', { session_id: '42' }).target, null, 'not a session ID yet');
  equal(preview('Write', { file_path: '/a', content: 'x' }),
    { label: 'WRITE', sessionTool: null, target: null, summary: '/a', body: 'x' });
  equal(preview('bash', { command: 'ls\npwd' }).summary, 'ls');
  equal(preview('mcp__some_server__do_thing', { anything: [1] }).label, 'DO THING');
  equal(preview('x', null).body, null);
});

await test('stream: reducer-only states without drafts still accept final metadata', () => {
  const state = { rows: [], nextKey: 1, openBubble: null };
  reduce(state, { type: 'output', text: 'x', ...meta('s1') });
  equal(state.rows.length, 1);
  equal(applyStream({ drafts: new Map() }, { type: 'stream_remove', stream_id: 'x' }).desync, false);
});

// The socket module reads location and storage at import time.
const suppliedLocation = typeof globalThis.location === 'undefined';
if (suppliedLocation) globalThis.location = { search: '', origin: 'http://localhost' };
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true,
  value: { getItem: () => 'test-only-token-not-a-real-secret' } });
const { SessionSocket } = await import('../js/socket.js');
if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
else delete globalThis.localStorage;
if (suppliedLocation) delete globalThis.location;

await test('stream socket: a revision gap reconnects for history and a fresh snapshot', async () => {
  const original = globalThis.WebSocket;
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.closed = null; sockets.push(this); }
    addEventListener() {}
    send() {}
    close(code) { this.closed = code; }
  }
  globalThis.WebSocket = FakeSocket;
  const store = new Store();
  const live = [];
  const socket = new SessionSocket('7', store, (event) => live.push(event.type));
  const frame = (ws, event) => ws.onmessage({ data: JSON.stringify(event) });
  try {
    socket.open();
    sockets[0].onopen();
    frame(sockets[0], snapshot(textDraft('s1', 1, 'A')));
    frame(sockets[0], { type: 'status', status: 'running' });
    frame(sockets[0], delta('s1', 2, 'B'));
    equal(store.session('7').drafts.get('s1').text, 'AB');
    frame(sockets[0], delta('s1', 4, 'D'));
    equal(sockets[0].closed, 4000);
    equal(store.session('7').connected, false);
    equal(sockets[0].onmessage, null, 'the dropped connection is ignored');
    await new Promise((resolve) => setTimeout(resolve, 5));
    equal(sockets.length, 2, 'the first resync reconnects at once');
    sockets[1].onopen();
    frame(sockets[1], { type: 'output', text: 'Old', event_id: 1 });
    frame(sockets[1], snapshot(textDraft('s1', 4, 'ABCD')));
    equal(store.session('7').drafts.get('s1').text, 'AB', 'reconnect replay is buffered');
    frame(sockets[1], { type: 'status', status: 'running' });
    equal(store.session('7').drafts.get('s1').text, 'ABCD');
    equal(store.session('7').rows.map((r) => r.text), ['Old']);
    frame(sockets[1], delta('s1', 5, 'E'));
    equal(store.session('7').drafts.get('s1').text, 'ABCDE');
    equal(live.includes('stream_delta'), true);
  } finally {
    socket.close();
    globalThis.WebSocket = original;
  }
});
