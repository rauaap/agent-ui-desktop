/**
 * The server-owned message queue: accepted inputs wait outside the transcript
 * and enter it at the shipment boundary. Contract:
 * agent-ui-server/docs/message_queue_client_handoff.md.
 */

import { composerEntries, composerEntry, historyRows, MessageHistory } from '../js/message-history.js';
import { Store, parseComposerInput, reduce, sendRefusal } from '../js/store.js';

export const results = [];
function test(name, fn) {
  try {
    fn();
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

const user = { type: 'user' };
const agent = (id) => ({ type: 'agent', session_id: id });
const accepted = (id, text, source = user) => (
  { type: 'input', message_id: id, text, source, delivery: 'queued' });
const shipped = (...messages) => ({
  type: 'inputs_shipped',
  messages: messages.map(([id, text, source = user]) => (
    { message_id: id, text, source, delivery: 'shipped' })),
});
const snapshot = (...messages) => ({
  type: 'input_queue',
  messages: messages.map(([id, text, source = user]) => (
    { message_id: id, text, source, delivery: 'queued' })),
});

/** Feed events through a Store, collecting the composer history a pane would. */
function session(...events) {
  const store = new Store();
  const history = new MessageHistory();
  store.subscribe('s', (changes) => {
    for (const row of historyRows(changes)) {
      const entry = composerEntry(row);
      if (entry !== null) history.add(entry);
    }
  });
  for (const event of events) store.apply('s', event);
  return { store, state: () => store.session('s'), history };
}

const transcript = (state) => state.rows.map((r) => [r.kind, r.text, r.from?.sessionId ?? null]);
const pending = (state) => state.queue.map((q) => [q.messageId, q.text, q.from?.sessionId ?? null]);

test('queue: a busy send is not refused, only archive and sandbox saves are', () => {
  const busy = { status: 'running', archivedAt: null, sandboxSaving: false };
  equal(sendRefusal(busy, parseComposerInput('next')), null);
  equal(sendRefusal({ ...busy, status: 'awaiting_approval' }, parseComposerInput('next')), null);
  equal(typeof sendRefusal({ ...busy, archivedAt: '2026-10-01' }, parseComposerInput('x')), 'string');
  equal(typeof sendRefusal({ ...busy, archivedAt: '2026-10-01' }, parseComposerInput('!ls')), 'string');
  equal(typeof sendRefusal({ ...busy, sandboxSaving: true }, parseComposerInput('x')), 'string');
  // Bash is unchanged: busy and sandbox saves never stop a command.
  equal(sendRefusal({ ...busy, sandboxSaving: true }, parseComposerInput('!ls')), null);
});

test('queue: an accepted input waits outside the transcript', () => {
  const { state } = session(accepted(1, 'Check Android too.'));
  equal(transcript(state()), []);
  equal(pending(state()), [[1, 'Check Android too.', null]]);
});

test('queue: an arrival mid-stream does not split the agent message', () => {
  const { state } = session(
    { type: 'output', text: 'Hel' },
    accepted(1, 'also this'),
    accepted(2, 'and this', agent(7)),
    { type: 'output', text: 'lo' },
  );
  equal(transcript(state()), [['agent', 'Hello', null]]);
  equal(pending(state()).length, 2);
});

test('queue: shipment appends one attributed row per message, in order', () => {
  const { state } = session(
    { type: 'output', text: 'first answer' },
    accepted(1, 'Check Android too.'),
    accepted(2, 'The API changes are ready.', agent(7)),
    { type: 'done' },
    shipped([1, 'Check Android too.'], [2, 'The API changes are ready.', agent(7)]),
    { type: 'output', text: 'second answer' },
  );
  equal(transcript(state()), [
    ['agent', 'first answer', null],
    ['user', 'Check Android too.', null],
    ['user', 'The API changes are ready.', '7'],
    ['agent', 'second answer', null],
  ]);
  equal(pending(state()), []);
});

test('queue: shipment closes the open agent message even without done', () => {
  const { state } = session(
    { type: 'output', text: 'a' },
    accepted(1, 'q'),
    shipped([1, 'q']),
    { type: 'output', text: 'b' },
  );
  equal(transcript(state()).map((r) => r[1]), ['a', 'q', 'b']);
});

test('queue: only the shipped IDs leave the pending list', () => {
  const { state } = session(accepted(1, 'a'), accepted(2, 'b'), shipped([1, 'a']), accepted(3, 'c'));
  equal(pending(state()).map((p) => p[0]), [2, 3]);
});

test('queue: user history is recorded on acceptance once, agents never', () => {
  const { history } = session(
    accepted(1, 'mine'),
    accepted(2, 'theirs', agent(7)),
    accepted(3, '!not a command'),
    shipped([1, 'mine'], [2, 'theirs', agent(7)], [3, '!not a command']),
  );
  equal(history.entries, ['mine', '\\!not a command']);
});

test('queue: a shipment whose acceptance fell outside the replay still renders', () => {
  const { state, history } = session(
    shipped([41, 'from long ago'], [42, 'peer note', agent(3)]),
    snapshot(),
    { type: 'status', status: 'running' },
  );
  equal(transcript(state()), [['user', 'from long ago', null], ['user', 'peer note', '3']]);
  equal(history.entries, ['from long ago']);
});

test('queue: the snapshot replaces, not merges, the pending list', () => {
  const { state } = session(accepted(1, 'stale'), accepted(2, 'kept'), snapshot([2, 'kept'], [9, 'older']));
  equal(pending(state()), [[2, 'kept', null], [9, 'older', null]]);
  equal(transcript(state()), []);
});

test('queue: snapshot-only entries join history once', () => {
  const { history } = session(accepted(2, 'seen'), snapshot([2, 'seen'], [9, 'unseen']), shipped([9, 'unseen']));
  equal(history.entries, ['seen', 'unseen']);
});

test('queue: repeated acceptance or shipment frames do not duplicate', () => {
  const { state, history } = session(
    accepted(1, 'once'), accepted(1, 'once'),
    shipped([1, 'once']), shipped([1, 'once']),
    accepted(1, 'once'),
  );
  equal(transcript(state()), [['user', 'once', null]]);
  equal(pending(state()), []);
  equal(history.entries, ['once']);
});

test('queue: a reconnect replay rebuilds without duplicate rows or history', () => {
  const { store, state } = session(
    accepted(1, 'a'), shipped([1, 'a']), { type: 'output', text: 'reply' }, accepted(2, 'b'),
  );
  store.beginReplay('s');
  for (const event of [
    accepted(1, 'a'), shipped([1, 'a']), { type: 'output', text: 'reply' },
    accepted(2, 'b'), accepted(3, 'from another device'),
    snapshot([2, 'b'], [3, 'from another device']),
    { type: 'status', status: 'running' },
  ]) store.apply('s', event);
  store.commitReplay('s');
  equal(transcript(state()), [['user', 'a', null], ['agent', 'reply', null]]);
  equal(pending(state()).map((p) => p[0]), [2, 3]);
  // What the pane rebuilds history from on a reset.
  equal(composerEntries([...state().rows, ...state().queue]), ['a', 'b', 'from another device']);
});

test('queue: stop, failure and idle leave pending inputs in place', () => {
  const { state } = session(
    { type: 'status', status: 'running' },
    accepted(1, 'later'),
    { type: 'error', message: 'harness died' },
    { type: 'status', status: 'idle' },
  );
  equal(pending(state()), [[1, 'later', null]]);
  equal(state().status, 'idle');
});

test('queue: historical inputs with a message_id but no delivery are transcript rows', () => {
  const { state, history } = session(
    { type: 'output', text: 'earlier' },
    { type: 'input', message_id: 3, text: 'before the queue', source: user },
    { type: 'input', message_id: 4, text: 'peer, before the queue', source: agent(7) },
    { type: 'output', text: 'reply' },
    snapshot(),
  );
  equal(transcript(state()), [
    ['agent', 'earlier', null],
    ['user', 'before the queue', null],
    ['user', 'peer, before the queue', '7'],
    ['agent', 'reply', null],
  ]);
  equal(pending(state()), []);
  equal(history.entries, ['before the queue']);
});

test('queue: an input is queued only when delivery says so', () => {
  const changes = reduce(new Store().session('x'),
    { type: 'input', message_id: 8, text: 'x', source: user, delivery: 'shipped' });
  equal(changes.filter((c) => c.op === 'append').map((c) => c.row.text), ['x']);
});

test('queue: history is reconstructed from a shipment only when acceptance was unseen', () => {
  // Seen live, seen only in the snapshot, and seen only at shipment: each once.
  const { store, history } = session(
    accepted(1, 'live'),
    snapshot([1, 'live'], [2, 'snapshot only']),
    shipped([1, 'live'], [2, 'snapshot only'], [3, 'shipment only']),
    shipped([3, 'shipment only']),
  );
  equal(history.entries, ['live', 'snapshot only', 'shipment only']);
  const state = store.session('s');
  equal(composerEntries([...state.rows, ...state.queue]), ['live', 'snapshot only', 'shipment only']);
});

test('queue: shipped rows are flagged so history is not added twice', () => {
  const store = new Store();
  const seen = [];
  store.subscribe('s', (changes) => seen.push(...historyRows(changes)));
  store.apply('s', accepted(5, 'x'));
  store.apply('s', shipped([5, 'x']));
  equal(seen.map((r) => r.text), ['x']);
});
