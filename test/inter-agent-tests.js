import { SessionDirectory, inputSource, senderText, sessionText } from '../js/inter-agent.js';
import { composerEntries } from '../js/message-history.js';
import { Store, rowText, toMarkdown } from '../js/store.js';
import { actionLabel, actionSummary, sessionToolName } from '../js/tools.js';

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

const directoryWith = (...rows) => {
  const directory = new SessionDirectory();
  directory.setSessions(rows);
  return directory;
};
const other = (name, args) => ({ kind: 'other', name, arguments: args });

test('source: only a missing source or type user is the user', () => {
  equal(inputSource({ text: 'hi' }), null);
  equal(inputSource({ text: 'hi', source: { type: 'user' } }), null);
  equal(inputSource({ source: { type: 'agent', session_id: 42 } }), { type: 'agent', sessionId: '42' });
});

test('source: malformed sources are unknown, never the user', () => {
  for (const source of [null, 'agent', [], {}, { type: 'robot' }, { type: 'agent' },
    { type: 'agent', session_id: '42' }, { type: 'agent', session_id: 4.5 },
    { type: 'agent', session_id: 0 }, { type: 'agent', session_id: -3 }]) {
    equal(inputSource({ source }), { type: 'unknown' });
  }
});

test('source: live and replayed inputs keep their sender on the row', () => {
  const store = new Store();
  store.apply('1', { type: 'input', text: 'mine' });
  store.apply('1', { type: 'input', text: 'review', source: { type: 'agent', session_id: 7 } });
  const rows = store.session('1').rows;
  equal(rows.map((row) => row.from), [null, { type: 'agent', sessionId: '7' }]);
});

test('history: agent and unknown inputs are never recalled; legacy ones are', () => {
  equal(composerEntries([
    { kind: 'user', text: 'legacy', from: null },
    { kind: 'user', text: 'from agent', from: { type: 'agent', sessionId: '7' } },
    { kind: 'user', text: 'from nowhere', from: { type: 'unknown' } },
    { kind: 'user', text: 'typed' },
  ]), ['legacy', 'typed']);
});

test('directory: nothing is missing until the first list arrives', () => {
  const directory = new SessionDirectory();
  equal(directory.lookup('42'), { state: 'pending' });
  equal(sessionText(directory, '42'), '#42');
  equal(senderText({ type: 'agent', sessionId: '42' }, directory), 'session #42');
  directory.setSessions([{ id: '1', name: 'api', archived_at: null }]);
  equal(directory.lookup('42'), { state: 'missing' });
  equal(sessionText(directory, '42'), '#42 (unknown session)');
  equal(sessionText(directory, '42', 'sender'), 'session #42 (unavailable)');
  equal(sessionText(directory, '1'), 'api #1');
});

test('directory: listeners hear the first list and real changes only', () => {
  const directory = new SessionDirectory();
  let calls = 0;
  directory.subscribe(() => { calls += 1; });
  directory.setSessions([]);
  directory.setSessions([]);
  equal(calls, 1);
  directory.setSessions([{ id: 1, name: 'a' }]);
  directory.setSessions([{ id: 1, name: 'a', status: 'running' }]);
  equal(calls, 2);
  directory.setSessions([{ id: 1, name: 'b' }]);
  directory.setSessions([{ id: 1, name: 'b', archived_at: '2026-09-01T00:00:00Z' }]);
  equal(calls, 4);
  equal(directory.lookup(1).session.archived, true);
});

test('session tools: bare and agent_ui MCP names match; other servers do not', () => {
  equal(sessionToolName(other('message_session', {})), 'message_session');
  equal(sessionToolName(other('mcp__agent_ui__read_session', {})), 'read_session');
  equal(sessionToolName(other('mcp__elsewhere__read_session', {})), null);
  equal(sessionToolName(other('start_session_later', {})), null);
  equal(sessionToolName({ kind: 'command', command: 'message_session' }), null);
  equal(actionLabel(other('mcp__agent_ui__message_session', { session_id: 4, message: 'x' })),
    'MESSAGE SESSION');
});

test('session tools: summaries name targets and apply server defaults', () => {
  const directory = directoryWith({ id: '42', name: 'api refactor' });
  const name = (id) => sessionText(directory, id);
  equal(actionSummary(other('message_session', { session_id: 42, message: 'hi' }), name),
    '→ api refactor #42');
  equal(actionSummary(other('message_session', { session_id: 9, message: 'hi' }), name),
    '→ #9 (unknown session)');
  equal(actionSummary(other('read_session', { session_id: 42, after: null })),
    '#42  (limit 200)');
  equal(actionSummary(other('read_session', { session_id: 42, after: 1830, limit: 50 })),
    '#42  (after 1830 · limit 50)');
  equal(actionSummary(other('start_session', {
    name: 'db migration', project_path: '/p', message: 'go', worktree_id: 7,
  })), '"db migration" in /p  (worktree #7 · sandboxed)');
  equal(actionSummary(other('start_session', {
    name: 'x', project_path: '/p', message: 'go', agent: 'pi', sandbox: false,
  })), '"x" in /p  (pi · unsandboxed)');
  equal(actionSummary(other('message_session', { session_id: '42', message: 'hi' })),
    '→ no valid session ID');
});

test('search and export name the sender', () => {
  const directory = directoryWith({ id: '42', name: 'api refactor' });
  const row = { kind: 'user', text: 'please review', from: { type: 'agent', sessionId: '42' } };
  equal(rowText(row, directory), 'api refactor (#42) please review');
  const markdown = toMarkdown({
    name: 's', rows: [row, { kind: 'user', text: 'hm', from: { type: 'unknown' } },
      { kind: 'user', text: 'mine', from: null }],
  }, directory);
  equal(markdown.includes('### From api refactor (#42)\n\nplease review'), true);
  equal(markdown.includes('### From unknown source\n\nhm'), true);
  equal(markdown.includes('### You\n\nmine'), true);
});
