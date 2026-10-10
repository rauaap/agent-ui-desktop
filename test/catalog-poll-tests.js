/** Full-catalog polling regression tests: node test/catalog-poll-tests.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function refresh(');
const end = source.indexOf('/** The project\'s sessions,', start);
let hidden = false;
let blocked = false;
let failProjects = false;
let releaseProjects;
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
  projects: [], worktrees: [], agents: [], sessionsById: new Map(),
  document: { get visibilityState() { return hidden ? 'hidden' : 'visible'; } },
  api: {
    listProjects: async () => {
      calls.push('projects');
      if (failProjects) throw new Error('offline');
      if (releaseProjects) await releaseProjects;
      return projectRows;
    },
    listSessions: async () => { calls.push('sessions'); return [{ id: '10' }]; },
    listWorktrees: async () => { calls.push('worktrees'); return [{ id: '20' }]; },
    listAgents: async () => { calls.push('agents'); return [{ id: 'pi' }]; },
  },
  acceptSessions: (sessions) => { accepted.push(sessions); return true; },
  sidebar: { setData: () => assert.fail('unexpected fallback') },
  fail: (error) => errors.push(error),
});
vm.runInContext(source.slice(start, end), context);
await context.pollCatalog();
assert.deepEqual(calls, ['projects', 'sessions', 'worktrees', 'agents']);
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
assert.ok(!source.includes('refresh-btn'));
assert.ok(!readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes('refresh-btn'));
console.log('Catalog polling: full fetch, cross-client updates, visibility/auth guards, overlap, quiet errors, recovery, refresh button removal passed');
