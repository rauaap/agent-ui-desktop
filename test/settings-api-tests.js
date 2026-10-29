import assert from 'node:assert/strict';

globalThis.location = { protocol: 'file:', origin: 'null', search: '?api=https://server.example/' };
globalThis.localStorage = { getItem: () => 'test-token' };
const calls = [];
let status = 200;
let body = { worktree_path_template: '%P/%N-%B', default_working_directory: '/projects/', default_agent: null };
globalThis.fetch = async (url, options) => {
  calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
  return { status, ok: status < 400, text: async () => JSON.stringify(body) };
};
const api = await import('../js/api.js');
assert.deepEqual(await api.getSettings(), body);
body = { worktree_path_template: '/trees/%b' };
assert.deepEqual(await api.getSettings(), body); // No cached template.
assert.equal(calls.length, 2);
assert.equal(calls[0].url, 'https://server.example/settings');
assert.equal(calls[0].method, 'GET');
assert.deepEqual(await api.patchSettings(body), body);
assert.deepEqual(calls.at(-1), { url: 'https://server.example/settings', method: 'PATCH', body });
await api.patchSettings({ default_agent: null });
assert.deepEqual(calls.at(-1).body, { default_agent: null });
await api.patchSettings({ default_working_directory: '/shared/' });
assert.deepEqual(calls.at(-1).body, { default_working_directory: '/shared/' });
status = 422;
body = { detail: 'Template cannot be blank' };
await assert.rejects(api.patchSettings({ worktree_path_template: '' }), /Template cannot be blank/);
status = 500;
await assert.rejects(api.getSettings());
console.log('Server settings REST: fresh reads, PATCH payload, fetch/save errors passed');
