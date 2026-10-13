import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Sidebar } from '../js/sidebar.js';
import { directoryExists, hasUnknownDirectories, withDirectoryExistence } from '../js/directory-existence.js';

const projects = [{ path: '/app' }];
const sessions = [{ working_dir: '/former' }];
const worktrees = [{ path: '/empty-worktree' }];
assert.equal(hasUnknownDirectories({ '/app': true, '/former': false }, projects, sessions, worktrees), true);
assert.equal(hasUnknownDirectories({ '/app': true, '/former': false, '/empty-worktree': true }, projects, sessions, worktrees), false);
assert.equal(directoryExists({}, '/former'), undefined);
assert.equal(withDirectoryExistence([{ path: '/former', exists: false }], {})[0].exists, undefined);
const sidebar = Object.create(Sidebar.prototype);
sidebar.worktrees = new Map();
const former = { worktree_id: null, working_dir: '/former' };
sidebar.directoryExistence = { '/former': true };
assert.equal(sidebar.worktreeNote(former, projects[0]), 'Former worktree: /former');
sidebar.directoryExistence['/former'] = false;
assert.match(sidebar.worktreeNote(former, projects[0]), /Former worktree:.*\n.*missing/);
sidebar.directoryExistence['/former'] = true;
assert.doesNotMatch(sidebar.worktreeNote(former, projects[0]), /missing/);

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const missingPill = css.match(/\.project \.missing,[^{]+\{([^}]+)\}/);
assert.ok(missingPill, 'shared missing-pill styling exists');
assert.match(missingPill[0], /\.session \.missing/);
assert.match(missingPill[0], /\.pane-dir \.missing/);
assert.match(missingPill[1], /color: var\(--danger\)/);
assert.match(missingPill[1], /background: var\(--danger-soft\)/);
assert.match(missingPill[1], /border-radius: 999px/);

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function removeWorktree(');
const end = source.indexOf('async function createSession(', start);
let confirmation;
let deleted = 0;
let refreshed = 0;
let error;
const notices = [];
const context = vm.createContext({
  sessionsOnWorktree: () => 2,
  formerSessionsForWorktree: () => [{ id: '3' }, { id: '4' }],
  baseOf: () => 'checkout',
  confirmDialog: async (...args) => { confirmation = args; return true; },
  api: { deleteWorktree: async () => { deleted++; if (error) throw error; } },
  refresh: async () => { refreshed++; },
  noticeDialog: (...args) => notices.push(args),
  fail: () => assert.fail('unexpected error'),
});
vm.runInContext(source.slice(start, end), context);
await context.removeWorktree({ id: 'w', path: '/checkout', exists: true });
assert.match(confirmation[1], /2 attached and 2 already-detached/);
assert.match(confirmation[1], /queued inputs and settings are preserved/);
assert.match(confirmation[1], /exact working directory/);
assert.equal(deleted, 1);
assert.equal(refreshed, 1);
error = { status: 409, message: 'Sessions are busy' };
await context.removeWorktree({ id: 'w', path: '/checkout', exists: false });
assert.match(confirmation[1], /2 attached and 2 already-detached/);
assert.equal(refreshed, 2, 'failed deletion also refreshes');
assert.match(notices[0][1], /shell commands/);
assert.doesNotMatch(notices[0][1], /detach|deleted/);
console.log('Worktree removal: preserved-session confirmation, refresh, busy refusal, independent former/missing state passed');
