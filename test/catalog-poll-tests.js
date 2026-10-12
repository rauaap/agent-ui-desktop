/** App wiring/visibility guards: node test/catalog-poll-tests.js.
 * Network orchestration is tested directly in catalog-snapshot-tests.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fetchCatalogSnapshot } from '../js/catalog-snapshot.js';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function refresh(');
const end = source.indexOf('/** The project\'s sessions,', start);
let hidden = false;
let blocked = false;
let failProjects = false;
let releaseProjects;
let failExistence = false;
let existenceRows = {};
let sessionRows = [{ id: '10' }];
let projectRows = [{ id: '1', name: 'Original' }];
const calls = [];
const accepted = [];
const errors = [];
const context = vm.createContext({
  authBlocked: () => blocked,
  connectionSnapshot: () => null,
  settingsSync: { checkpoint: () => 0 },
  catalogRequest: 0,
  projectsAccepted: 0,
  projects: [], worktrees: [], agents: [], sessionsById: new Map(), directoryExistence: {},
  fetchCatalogSnapshot,
  document: { get visibilityState() { return hidden ? 'hidden' : 'visible'; } },
  api: {
    listProjects: async () => {
      calls.push('projects');
      if (failProjects) throw new Error('offline');
      if (releaseProjects) await releaseProjects;
      return projectRows;
    },
    listSessions: async () => { calls.push('sessions'); return sessionRows; },
    listWorktrees: async () => { calls.push('worktrees'); return [{ id: '20' }]; },
    listAgents: async () => { calls.push('agents'); return [{ id: 'pi' }]; },
    getDirectoryExistence: async () => {
      calls.push('existence');
      if (failExistence) throw new Error('existence offline');
      return existenceRows;
    },
  },
  acceptSessions: (sessions) => { accepted.push(sessions); return true; },
  sidebar: { setData: () => assert.fail('unexpected fallback') },
  fail: (error) => errors.push(error),
});
vm.runInContext(source.slice(start, end), context);
await context.pollCatalog();
assert.deepEqual(calls, ['projects', 'sessions', 'worktrees', 'agents', 'existence']);
assert.equal(context.projects[0].name, 'Original');
projectRows = [{ id: '1', name: 'Renamed' }, { id: '2', name: 'From another client' }];
await context.pollCatalog();
assert.equal(context.projects[1].name, 'From another client');
assert.equal(context.projects[0].name, 'Renamed');
assert.equal(accepted.length, 2);

const count = calls.length;
hidden = true;
await context.pollCatalog();
hidden = false;
blocked = true;
await context.pollCatalog();
blocked = false;
assert.equal(calls.length, count);

let release;
releaseProjects = new Promise((resolve) => { release = resolve; });
const pending = context.pollCatalog();
await context.pollCatalog();
assert.equal(calls.length, count + 4, 'skip overlapping background polls');
release();
await pending;
releaseProjects = null;

failProjects = true;
await context.pollCatalog();
assert.equal(errors.length, 0, 'background errors are quiet');
assert.equal(context.projects[1].name, 'From another client', 'keep the last good catalog');
await context.refresh();
assert.equal(errors.length, 1, 'action refresh errors remain visible');
failProjects = false;
await context.pollCatalog();
assert.equal(accepted.length, 4, 'polling resumes after failure');
const beforeUnknown = calls.length;
projectRows = [{ id: '1', path: '/new' }];
sessionRows = [{ id: '10', working_dir: '/former' }];
await context.pollCatalog();
assert.equal(calls.length, beforeUnknown + 10, 'unknown paths retry catalogs then existence once');
assert.equal(context.projects[0].exists, undefined, 'unknown is not missing');
existenceRows = { '/new': true, '/former': false };
await context.pollCatalog();
assert.equal(context.projects[0].exists, true);
assert.equal(context.directoryExistence['/former'], false);
projectRows = [{ id: '2', path: '/other' }];
failExistence = true;
const acceptedBeforeFailure = accepted.length;
await context.pollCatalog();
assert.equal(context.projects[0].path, '/new', 'existence failure does not publish partial catalogs');
assert.equal(accepted.length, acceptedBeforeFailure);
failExistence = false;
// Application request identity must survive retries and ignore late older reads.
const realFetch = context.fetchCatalogSnapshot;
const older = {};
const newer = {};
older.promise = new Promise((resolve) => { older.resolve = resolve; });
newer.promise = new Promise((resolve) => { newer.resolve = resolve; });
let reads = 0;
context.fetchCatalogSnapshot = () => ++reads === 1 ? older.promise : newer.promise;
const oldRefresh = context.refresh();
const newRefresh = context.refresh();
const completeSnapshot = (name) => ({
  projects: [{ id: 'p', name }], sessions: [], worktrees: [], agents: [], existence: {},
});
newer.resolve(completeSnapshot('Newer'));
await newRefresh;
const acceptedBeforeOlder = accepted.length;
older.resolve(completeSnapshot('Older'));
await oldRefresh;
assert.equal(context.projects[0].name, 'Newer');
assert.equal(accepted.length, acceptedBeforeOlder, 'older snapshot cannot publish sessions either');
context.fetchCatalogSnapshot = realFetch;
assert.ok(!source.includes('refresh-btn'));
assert.ok(!readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes('refresh-btn'));
console.log('Catalog polling: full fetch, cross-client updates, visibility/auth guards, overlap, quiet errors, recovery, refresh button removal passed');
