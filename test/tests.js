/**
 * Unit tests for the pure modules — the line diff, the markdown parser, and the
 * transcript reducer. No framework: a `test()` that collects failures, matching
 * the repo's zero-build stance.
 *
 * Run them by opening `test/index.html` in a browser, or under a JS runtime:
 *   node test/run.js
 *
 * Ported from the Android client's LineDiffTest.java and MarkdownTest.java.
 * Markdown's assertions are restated against HTML output, since this port emits
 * HTML rather than Android's text-plus-spans model.
 */

import { ADD, DELETE, MAX_DIFF_LINES, diff } from '../js/render/diff.js';
import { asProject, asSession, storedIds } from '../js/ids.js';
import { toHtml } from '../js/render/markdown.js';
import { Store, parseComposerInput, reduce, rowText } from '../js/store.js';
import { toolSummary } from '../js/tools.js';
import { pathFor, slug } from '../js/worktree.js';

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

function assertEqual(actual, expected, note) {
  if (actual !== expected) {
    throw new Error(
      `${note ? note + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(value, note) {
  if (!value) throw new Error(note || 'expected true');
}

/* ------------------------------------------------------------------ */
/* diff                                                               */
/* ------------------------------------------------------------------ */

/** Render rows as gutter-prefixed lines, e.g. "  A", "- X", "+ X1". */
const render = (rows) => rows
  .map((r) => `${r.kind === ADD ? '+' : r.kind === DELETE ? '-' : ' '} ${r.text}`)
  .join('\n');

const d = (oldS, newS) => render(diff(oldS, newS));

test('diff: unchanged is all context', () => {
  assertEqual(d('a\nb', 'a\nb'), '  a\n  b');
});

test('diff: insertion keeps surrounding context', () => {
  assertEqual(d('a\nc', 'a\nb\nc'), '  a\n+ b\n  c');
});

test('diff: deletion keeps surrounding context', () => {
  assertEqual(d('a\nb\nc', 'a\nc'), '  a\n- b\n  c');
});

test('diff: interior unchanged line stays context', () => {
  // The whole point of the LCS: B is unchanged and must not show as -B/+B.
  assertEqual(
    d('A\nX\nB\nY\nC', 'A\nX1\nB\nY1\nC'),
    '  A\n- X\n+ X1\n  B\n- Y\n+ Y1\n  C',
  );
});

test('diff: replacement groups deletes before inserts', () => {
  assertEqual(d('a\nb', 'c\nd'), '- a\n- b\n+ c\n+ d');
});

test('diff: write with empty old is all additions', () => {
  assertEqual(d('', 'x\ny\nz'), '+ x\n+ y\n+ z');
});

test('diff: empty new is all deletions', () => {
  assertEqual(d('x\ny', ''), '- x\n- y');
});

test('diff: empty both produces no rows', () => {
  // A degenerate edit with neither side present yields nothing, so the caller
  // falls back to raw JSON rather than rendering an empty "+" line.
  assertEqual(diff('', '').length, 0);
});

test('diff: oversize change falls back to block diff', () => {
  const n = MAX_DIFF_LINES + 100;
  const oldS = Array.from({ length: n }, (_, i) => `o${i}`).join('\n');
  const newS = Array.from({ length: n }, (_, i) => `n${i}`).join('\n');
  const rows = diff(oldS, newS);
  assertEqual(rows.length, 2 * n, 'row count');
  assertEqual(rows[0].kind, DELETE);
  assertEqual(rows[0].text, 'o0');
  assertEqual(rows[n - 1].kind, DELETE);
  assertEqual(rows[n].kind, ADD);
  assertEqual(rows[n].text, 'n0');
});

test('diff: below cap still aligns interior', () => {
  const n = MAX_DIFF_LINES;
  const mid = Math.floor(n / 2);
  const oldS = Array.from({ length: n }, (_, i) => `x${i}`).join('\n');
  const newS = Array.from({ length: n }, (_, i) => (i === mid ? `x${i}` : `y${i}`)).join('\n');
  assertTrue(d(oldS, newS).includes(`  x${mid}`), 'shared middle line should be context');
});

/* ------------------------------------------------------------------ */
/* markdown                                                           */
/* ------------------------------------------------------------------ */

test('md: plain text is a paragraph', () => {
  assertEqual(toHtml('hello world'), '<p>hello world</p>');
});

test('md: bold strips markers', () => {
  assertEqual(toHtml('a **big** deal'), '<p>a <strong>big</strong> deal</p>');
});

test('md: italic with asterisk', () => {
  assertEqual(toHtml('an *odd* one'), '<p>an <em>odd</em> one</p>');
});

test('md: strikethrough needs a double tilde', () => {
  assertEqual(toHtml('~~gone~~'), '<p><del>gone</del></p>');
  // A lone '~' is not a marker.
  assertEqual(toHtml('a ~ b'), '<p>a ~ b</p>');
});

test('md: underscores inside words are not emphasis', () => {
  assertEqual(toHtml('snake_case_name'), '<p>snake_case_name</p>');
});

test('md: inline code wins over inner markers', () => {
  assertEqual(toHtml('use `a **b** c`'), '<p>use <code>a **b** c</code></p>');
});

test('md: heading levels', () => {
  assertEqual(toHtml('## Title'), '<h2>Title</h2>');
  // Seven hashes is not a heading.
  assertTrue(toHtml('####### nope').startsWith('<p>'));
});

test('md: bullet list groups items', () => {
  assertEqual(toHtml('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
});

test('md: numbered list groups items', () => {
  assertEqual(toHtml('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('md: fenced code block is escaped verbatim', () => {
  assertEqual(
    toHtml('```\n<b>&</b>\n```'),
    '<pre><code>&lt;b&gt;&amp;&lt;/b&gt;</code></pre>',
  );
});

test('md: html in prose is escaped', () => {
  assertEqual(toHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});

test('md: links render, unsafe schemes do not', () => {
  assertEqual(
    toHtml('[docs](https://example.com)'),
    '<p><a href="https://example.com" target="_blank" rel="noreferrer noopener">docs</a></p>',
  );
  // A javascript: URL must not become an href. The link text survives as plain
  // text; the trailing ")" does too, because the scan stops at the first close
  // paren exactly as Markdown.java does.
  const unsafe = toHtml('[x](javascript:alert(1))');
  assertTrue(!unsafe.includes('href'), `no href expected, got ${unsafe}`);
  assertTrue(!unsafe.includes('javascript:'), `scheme must not survive, got ${unsafe}`);
});

test('md: single newline is a line break within a paragraph', () => {
  assertEqual(toHtml('a\nb'), '<p>a<br>b</p>');
});

test('md: blank line separates paragraphs', () => {
  assertEqual(toHtml('a\n\nb'), '<p>a</p><p>b</p>');
});

/* ------------------------------------------------------------------ */
/* tool summary                                                       */
/* ------------------------------------------------------------------ */

test('summary: known tools pick their identifying field', () => {
  assertEqual(toolSummary('Bash', { command: 'ls -la' }), 'ls -la');
  assertEqual(toolSummary('Edit', { file_path: '/a/b.py' }), '/a/b.py');
  assertEqual(toolSummary('Grep', { pattern: 'TODO' }), 'TODO');
});

test('summary: unknown tool falls back to first non-empty string', () => {
  assertEqual(toolSummary('Mystery', { foo: '', bar: 'hi' }), 'hi');
  assertEqual(toolSummary('Mystery', {}), '');
});

/* ------------------------------------------------------------------ */
/* reducer                                                            */
/* ------------------------------------------------------------------ */

const freshState = () => ({
  id: 's1',
  name: '',
  workingDir: '',
  agent: 'claude-code',
  status: 'idle',
  autoApproveWrite: false,
  autoApproveCommand: false,
  connected: false,
  rows: [],
  nextKey: 1,
  openBubble: null,
  lastTool: null,
  pendingApprovalId: null,
  pendingQuestionId: null,
});

const feed = (state, ...events) => {
  for (const event of events) reduce(state, event);
  return state;
};

test('reducer: consecutive output chunks coalesce', () => {
  const s = feed(freshState(),
    { type: 'output', text: 'Hel' },
    { type: 'output', text: 'lo' });
  assertEqual(s.rows.length, 1);
  assertEqual(s.rows[0].text, 'Hello');
});

test('reducer: a tool_use closes the open agent message', () => {
  const s = feed(freshState(),
    { type: 'output', text: 'a' },
    { type: 'tool_use', tool: 'Bash', input: { command: 'ls' } },
    { type: 'output', text: 'b' });
  assertEqual(s.rows.length, 3);
  assertEqual(s.rows[0].text, 'a');
  assertEqual(s.rows[2].text, 'b');
});

test('reducer: approval replaces the tool_use it duplicates', () => {
  const s = feed(freshState(),
    { type: 'tool_use', tool: 'Bash', input: { command: 'ls' } },
    { type: 'approval_request', request_id: 'p1', tool: 'Bash', input: { command: 'ls' } });
  assertEqual(s.rows.length, 1, 'the tool card should have been swallowed');
  assertEqual(s.rows[0].kind, 'approval');
  assertEqual(s.pendingApprovalId, 'p1');
});

test('reducer: approval for a different call keeps both rows', () => {
  const s = feed(freshState(),
    { type: 'tool_use', tool: 'Bash', input: { command: 'ls' } },
    { type: 'approval_request', request_id: 'p1', tool: 'Bash', input: { command: 'rm -rf /' } });
  assertEqual(s.rows.length, 2);
});

test('reducer: approval_response resolves the card', () => {
  const s = feed(freshState(),
    { type: 'approval_request', request_id: 'p1', tool: 'Bash', input: { command: 'ls' } },
    { type: 'approval_response', request_id: 'p1', behavior: 'deny', message: 'no' });
  assertEqual(s.rows[0].resolved.behavior, 'deny');
  assertEqual(s.rows[0].resolved.message, 'no');
  assertEqual(s.pendingApprovalId, null);
});

test('reducer: an auto-approved request is born resolved and never pending', () => {
  const s = feed(freshState(), {
    type: 'approval_request',
    request_id: 'p1',
    tool: 'Bash',
    input: { command: 'ls' },
    category: 'command',
    auto_approved: true,
  });
  assertEqual(s.pendingApprovalId, null);
  assertEqual(s.rows[0].resolved.behavior, 'allow');
  assertTrue(s.rows[0].auto);
});

test('reducer: leaving awaiting_approval strands nothing', () => {
  // A stop, or the process dying, ends the block without a response; the card
  // must stop offering buttons.
  const s = feed(freshState(),
    { type: 'approval_request', request_id: 'p1', tool: 'Bash', input: { command: 'ls' } },
    { type: 'status', status: 'idle' });
  assertEqual(s.pendingApprovalId, null);
  assertTrue(s.rows[0].resolved, 'card should be resolved');
  assertEqual(s.rows[0].resolved.behavior, null, 'with no verdict');
});

test('reducer: question resolves by request id', () => {
  const s = feed(freshState(),
    { type: 'question', request_id: 'q1', questions: [{ question: 'Pick', options: [] }] },
    { type: 'question_response', request_id: 'q1', answers: { Pick: 'A' } });
  assertEqual(s.pendingQuestionId, null);
  assertEqual(s.rows[0].resolved.answers.Pick, 'A');
});

test('reducer: settings and renamed update metadata', () => {
  const s = feed(freshState(),
    { type: 'settings', auto_approve_write: true, auto_approve_command: false },
    { type: 'renamed', name: 'brisk-otter' });
  assertTrue(s.autoApproveWrite);
  assertEqual(s.autoApproveCommand, false);
  assertEqual(s.name, 'brisk-otter');
});

test('store: a committed replay keeps the live connection state', () => {
  // Regression: the socket opens while the replay is still being assembled, so
  // a `connected` snapshot taken when the drop happened would swap the live
  // `true` back to `false` and strand the session as "Reconnecting…".
  const store = new Store();
  store.apply('s1', { type: 'output', text: 'before' });
  store.setConnected('s1', false);

  store.beginReplay('s1');
  store.setConnected('s1', true); // the socket comes back mid-replay
  store.apply('s1', { type: 'output', text: 'replayed' });
  store.apply('s1', { type: 'status', status: 'idle' });
  store.commitReplay('s1');

  const state = store.session('s1');
  assertTrue(state.connected, 'connection state must survive the swap');
  assertEqual(state.rows.length, 1);
  assertEqual(state.rows[0].text, 'replayed');
});

test('store: an aborted replay leaves the visible transcript alone', () => {
  const store = new Store();
  store.apply('s1', { type: 'output', text: 'original' });
  store.beginReplay('s1');
  store.apply('s1', { type: 'output', text: 'partial' });
  store.abortReplay('s1');
  assertEqual(store.session('s1').rows[0].text, 'original');
});

test('reducer: rowText covers each row kind for search', () => {
  const s = feed(freshState(),
    { type: 'input', text: 'refactor db' },
    { type: 'tool_use', tool: 'Bash', input: { command: 'git status' } },
    { type: 'error', message: 'boom' });
  assertTrue(rowText(s.rows[0]).includes('refactor db'));
  assertTrue(rowText(s.rows[1]).includes('git status'));
  assertTrue(rowText(s.rows[2]).includes('boom'));
});

/* ------------------------------------------------------------------ */
/* bash mode                                                          */
/* ------------------------------------------------------------------ */

test('composer: a leading ! is a command, not a prompt', () => {
  const parsed = parseComposerInput('!df -h');
  assertEqual(parsed.kind, 'bash');
  assertEqual(parsed.command, 'df -h');
});

test('composer: the ! may be followed by a space', () => {
  assertEqual(parseComposerInput('  !  ls -la  ').command, 'ls -la');
});

test('composer: a bare ! is bash mode with nothing to run yet', () => {
  const parsed = parseComposerInput('!');
  assertEqual(parsed.kind, 'bash');
  assertEqual(parsed.command, '');
});

test('composer: \\! escapes to a prompt that starts with !', () => {
  const parsed = parseComposerInput('\\!important, read this');
  assertEqual(parsed.kind, 'input');
  assertEqual(parsed.text, '!important, read this');
});

test('composer: the escape is positional, not global', () => {
  // Only the first character is special, so a backslash anywhere else — and a
  // `!` anywhere else — travels verbatim.
  assertEqual(parseComposerInput('grep -r "\\!" .').text, 'grep -r "\\!" .');
  assertEqual(parseComposerInput('wow! ok').text, 'wow! ok');
});

test('composer: nothing typed is nothing to send', () => {
  assertEqual(parseComposerInput('   '), null);
  assertEqual(parseComposerInput(''), null);
});

test('reducer: bash_output fills in the card its echo opened', () => {
  const s = feed(freshState(),
    { type: 'bash_input', command: 'df -h' },
    {
      type: 'bash_output',
      command: 'df -h',
      stdout: 'Filesystem\n',
      stderr: '',
      exit_code: 0,
      duration_ms: 41,
      timed_out: false,
      truncated: false,
    });
  assertEqual(s.rows.length, 1, 'the echo and the result are one card');
  assertEqual(s.rows[0].kind, 'bash');
  assertEqual(s.rows[0].command, 'df -h');
  assertEqual(s.rows[0].result.stdout, 'Filesystem\n');
  assertEqual(s.rows[0].result.exitCode, 0);
  assertEqual(s.rows[0].result.durationMs, 41);
});

test('reducer: a command finishing mid-turn does not split the agent message', () => {
  // The result updates a card above rather than appending, so the streaming
  // bubble underneath stays open and keeps coalescing.
  const s = feed(freshState(),
    { type: 'bash_input', command: 'sleep 1' },
    { type: 'output', text: 'Hel' },
    { type: 'bash_output', command: 'sleep 1', stdout: '', stderr: '', exit_code: 0 },
    { type: 'output', text: 'lo' });
  assertEqual(s.rows.length, 2);
  assertEqual(s.rows[1].text, 'Hello');
});

test('reducer: an orphan bash_output stands on its own', () => {
  // Replay can begin past the echo, and another client can have started the
  // command before this one connected.
  const s = feed(freshState(),
    { type: 'bash_output', command: 'whoami', stdout: 'root\n', exit_code: 0 });
  assertEqual(s.rows.length, 1);
  assertEqual(s.rows[0].command, 'whoami');
  assertEqual(s.rows[0].result.stdout, 'root\n');
});

test('reducer: a second command does not resolve the first one still running', () => {
  const s = feed(freshState(),
    { type: 'bash_input', command: 'sleep 30' },
    { type: 'bash_input', command: 'whoami' },
    { type: 'bash_output', command: 'whoami', stdout: 'root\n', exit_code: 0 });
  assertEqual(s.rows.length, 2);
  assertEqual(s.rows[0].result, null, 'the long-running command is still open');
  assertEqual(s.rows[1].result.stdout, 'root\n');
});

test('reducer: a command that never started reports no exit code', () => {
  const s = feed(freshState(),
    { type: 'bash_input', command: 'ls' },
    { type: 'bash_output', command: 'ls', stderr: 'no such directory', exit_code: null });
  assertEqual(s.rows[0].result.exitCode, null);
  assertEqual(s.rows[0].result.stdout, '');
});

test('reducer: bash rows are searchable by command and by output', () => {
  const s = feed(freshState(),
    { type: 'bash_input', command: 'git status' },
    { type: 'bash_output', command: 'git status', stdout: 'nothing to commit', exit_code: 0 });
  assertTrue(rowText(s.rows[0]).includes('git status'));
  assertTrue(rowText(s.rows[0]).includes('nothing to commit'));
});

/* ------------------------------------------------------------------ */
/* worktree seeds                                                     */
/* ------------------------------------------------------------------ */

test('slug: a name becomes a branch-safe token', () => {
  assertEqual(slug('Fix login!'), 'fix-login');
  assertEqual(slug('quiet-harbor'), 'quiet-harbor');
});

test('slug: runs of junk collapse and never lead or trail', () => {
  assertEqual(slug('  ..a//b -- c.. '), 'a-b-c');
  assertEqual(slug('--wip--'), 'wip');
});

test('slug: a name with nothing to keep falls back', () => {
  assertEqual(slug('!!!'), 'session');
  assertEqual(slug(''), 'session');
  assertEqual(slug(null), 'session');
});

test('slug: a long name is capped without a dangling dash', () => {
  const s = slug('a'.repeat(40) + ' ' + 'b'.repeat(40));
  assertTrue(s.length <= 48, `capped, got ${s.length}`);
  assertTrue(!s.endsWith('-'), 'no trailing dash');
});

test('worktree path: a sibling of the project directory', () => {
  assertEqual(pathFor('/home/me/app', 'fix login'), '/home/me/app-fix-login');
  assertEqual(pathFor('/home/me/app/', 'fix login'), '/home/me/app-fix-login');
});

test('worktree path: a root project has no segment to suffix', () => {
  assertEqual(pathFor('/', 'fix login'), '/fix-login');
  assertEqual(pathFor('', 'fix login'), '/fix-login');
});

/* ------------------------------------------------------------------ */
/* ids                                                                */
/* ------------------------------------------------------------------ */

test('ids: a numeric session id becomes a string, with its project link', () => {
  const session = asSession({ id: 12, project_id: 3, name: 'work' });
  assertEqual(session.id, '12');
  assertEqual(session.project_id, '3');
  assertEqual(session.name, 'work', 'everything else is left alone');
});

test('ids: a uuid from an old server passes through untouched', () => {
  assertEqual(asProject({ id: 'a3f1-9c' }).id, 'a3f1-9c');
});

test('ids: a missing id is not invented', () => {
  const session = asSession({ id: 4 });
  assertTrue(!('project_id' in session), 'no project_id where the server sent none');
  assertEqual(asSession({ id: 4, project_id: null }).project_id, null);
});

test('ids: the coerced id matches what the DOM and a Set would hold', () => {
  const sessions = [{ id: 1 }, { id: 2 }].map(asSession);
  // `element.dataset.id = 1` reads back as "1", and Set keys are type-sensitive.
  const known = new Set(sessions.map((s) => s.id));
  assertTrue(known.has('1'), 'a Set of ids is testable with a string');
  assertTrue(sessions.some((s) => s.id === '2'), 'an id compares equal to its DOM form');
});

test('ids: restored tabs survive both id eras', () => {
  assertEqual(storedIds([1, '2', 'a3f1-9c']).join(), '1,2,a3f1-9c');
});

test('ids: restored junk is dropped rather than opened', () => {
  assertEqual(storedIds([null, {}, undefined, true, 7]).join(), '7');
  assertEqual(storedIds(null).length, 0);
  assertEqual(storedIds('7').length, 0, 'a bare string is not a tab list');
});

export { results };
