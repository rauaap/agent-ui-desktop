/** Network orchestration tests use the real module, without app source extraction. */
import assert from 'node:assert/strict';
import { fetchCatalogSnapshot } from '../js/catalog-snapshot.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const calls = [];
const pending = Object.fromEntries(['projects', 'sessions', 'worktrees', 'agents', 'existence']
  .map((name) => [name, deferred()]));
const request = (name) => { calls.push(name); return pending[name].promise; };
const api = {
  listProjects: () => request('projects'),
  listSessions: () => request('sessions'),
  listWorktrees: () => request('worktrees'),
  listAgents: () => request('agents'),
  getDirectoryExistence: () => request('existence'),
};
let published = false;
const read = fetchCatalogSnapshot(api).then((snapshot) => { published = true; return snapshot; });
assert.deepEqual(calls, ['projects', 'sessions', 'worktrees', 'agents'], 'catalogs start in parallel');
const projects = [{ id: 'p', path: '/app' }];
const worktrees = [{ id: 'w', path: '/worktree' }];
const sessions = [{ id: 's', working_dir: '/former' }];
pending.projects.resolve(projects);
pending.sessions.resolve(sessions);
pending.worktrees.resolve(worktrees);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.length, 4, 'existence waits for all catalogs');
pending.agents.resolve([{ id: 'pi' }]);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(calls, ['projects', 'sessions', 'worktrees', 'agents', 'existence']);
assert.equal(published, false, 'no partial snapshot');
pending.existence.resolve({ '/app': true, '/worktree': false, '/former': false });
const snapshot = await read;
assert.equal(snapshot.projects[0].exists, true);
assert.equal(snapshot.worktrees[0].exists, false);
assert.equal(snapshot.existence['/former'], false);
assert.deepEqual(projects, [{ id: 'p', path: '/app' }], 'presentation fields do not mutate API rows');
assert.deepEqual(worktrees, [{ id: 'w', path: '/worktree' }]);
assert.strictEqual(snapshot.sessions, sessions);

let rounds = 0;
const retryCalls = [];
const retryApi = {
  listProjects: async () => { retryCalls.push('projects'); rounds++; return projects; },
  listSessions: async () => { retryCalls.push('sessions'); return sessions; },
  listWorktrees: async () => { retryCalls.push('worktrees'); return worktrees; },
  listAgents: async () => { retryCalls.push('agents'); throw new Error('agents offline'); },
  getDirectoryExistence: async () => {
    retryCalls.push('existence');
    return rounds === 1 ? {} : { '/app': true, '/worktree': true, '/former': false };
  },
};
const fallback = [{ id: 'cached-agent' }];
const retried = await fetchCatalogSnapshot(retryApi, { agents: fallback });
assert.equal(rounds, 2);
assert.deepEqual(retryCalls, [...calls, ...calls]);
assert.strictEqual(retried.agents, fallback, 'agent failures independently retain picker choices');
assert.equal(retried.worktrees[0].exists, true);
rounds = 0;
retryApi.getDirectoryExistence = async () => ({});
const unknown = await fetchCatalogSnapshot(retryApi);
assert.equal(rounds, 2, 'persistent unknown keys have bounded retries');
assert.equal(unknown.projects[0].exists, undefined);
assert.equal(unknown.worktrees[0].exists, undefined);
assert.deepEqual(unknown.agents, []);

retryApi.getDirectoryExistence = async () => { throw new Error('existence offline'); };
await assert.rejects(fetchCatalogSnapshot(retryApi), /existence offline/);
let existenceRequested = false;
retryApi.listSessions = async () => { throw new Error('sessions offline'); };
retryApi.getDirectoryExistence = async () => { existenceRequested = true; return {}; };
await assert.rejects(fetchCatalogSnapshot(retryApi), /sessions offline/);
assert.equal(existenceRequested, false, 'failed catalogs never begin filesystem read');
console.log('Catalog snapshot: parallel catalogs, ordered existence, atomic delivery, bounded retry, agent fallback and failure propagation passed');
