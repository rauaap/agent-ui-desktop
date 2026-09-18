import { SettingsSync, canChangeSandbox, settingsMeta } from '../js/session-settings.js';
import { Store } from '../js/store.js';

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
const ready = () => ({
  agent: 'pi', sandbox: true, status: 'idle', connected: true,
  settingsLoaded: true, sessionReady: true, sandboxSaving: false,
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

await test('sandbox: missing means unknown; false and unsupported-agent values survive', () => {
  equal(settingsMeta({}).sandbox, null);
  equal(settingsMeta({ sandbox: false }).sandbox, false);
  equal(settingsMeta({ agent: 'claude-code', sandbox: true }).sandbox, true);
});

await test('sandbox: only confirmed, idle, connected Pi sessions are editable', () => {
  equal(canChangeSandbox(ready()), true);
  for (const override of [
    { agent: 'claude-code' }, { agent: 'other' }, { sandbox: null },
    { status: 'running' }, { status: 'awaiting_approval' }, { connected: false },
    { settingsLoaded: false }, { sessionReady: false }, { sandboxSaving: true },
  ]) equal(canChangeSandbox({ ...ready(), ...override }), false);
  equal(canChangeSandbox({ ...ready(), archivedAt: '2026-01-01', sandbox: false }), true);
});

await test('settings: newer live frames win over in-flight REST, scoped to their session', () => {
  const sync = new SettingsSync();
  const start = sync.checkpoint();
  sync.record('7', { sandbox: false, auto_approve_write: true, auto_approve_command: false });
  equal(sync.reconcile({ id: 7, sandbox: true, auto_approve_write: false }, start), {
    id: 7, sandbox: false, auto_approve_write: true, auto_approve_command: false,
  });
  equal(sync.reconcile({ id: 8, sandbox: true }, start), { id: 8, sandbox: true });
  // A later read can contain changes made while no subscription was active.
  equal(sync.reconcile({ id: 7, sandbox: true }, sync.checkpoint()), { id: 7, sandbox: true });
});

await test('settings: partial frames preserve the other settings', () => {
  const sync = new SettingsSync();
  const start = sync.checkpoint();
  sync.record('7', { sandbox: false });
  equal(sync.reconcile({ id: '7', sandbox: true, auto_approve_command: true }, start), {
    id: '7', sandbox: false, auto_approve_command: true,
  });
});

await test('settings: live frames survive an aborted replay without transcript rows', () => {
  const store = new Store();
  store.setMeta('7', { sandbox: true, autoApproveWrite: true });
  store.beginReplay('7');
  store.apply('7', { type: 'settings', sandbox: false, auto_approve_command: true });
  store.abortReplay('7');
  equal(store.session('7').sandbox, false);
  equal(store.session('7').autoApproveWrite, true);
  equal(store.session('7').autoApproveCommand, true);
  equal(store.session('7').rows, []);
  store.beginReplay('7');
  store.setMeta('7', { sandbox: true, sandboxSaving: true, settingsLoaded: true });
  store.commitReplay('7');
  equal(store.session('7').sandbox, true);
  equal(store.session('7').sandboxSaving, true);
  equal(store.session('7').settingsLoaded, true);
});

await test('settings: disconnect invalidates readiness without inventing a sandbox value', () => {
  const store = new Store();
  store.setConnected('7', true);
  store.setMeta('7', { settingsLoaded: true, sessionReady: true, sandbox: false });
  store.setConnected('7', false);
  equal(store.session('7').settingsLoaded, false);
  equal(store.session('7').sessionReady, false);
  equal(store.session('7').sandbox, false);
  equal(store.session('7').connectionEpoch, 2);
});

await test('sandbox: save is pessimistic, serialized, and reconciles an overtaking frame', async () => {
  const sync = new SettingsSync();
  const state = ready();
  const response = deferred();
  let calls = 0;
  const handlers = {
    getState: () => state,
    setPending: (value) => { state.sandboxSaving = value; },
    patch: () => { calls++; return response.promise; },
    accept: (row) => { sync.record('7', row); Object.assign(state, settingsMeta(row)); },
  };
  const save = sync.saveSandbox('7', false, handlers);
  equal(state.sandbox, true);
  equal(state.sandboxSaving, true);
  let rejected = false;
  try { await sync.saveSandbox('7', false, handlers); } catch { rejected = true; }
  equal(rejected, true);
  equal(calls, 1);
  // Another device changes settings after our PATCH was applied, but before its response arrives.
  sync.record('7', { sandbox: true, auto_approve_write: true });
  response.resolve({ id: '7', sandbox: false, auto_approve_write: false, auto_approve_command: true });
  await save;
  equal(state.sandbox, true);
  equal(state.autoApproveWrite, true);
  equal(state.autoApproveCommand, true);
  equal(state.sandboxSaving, false);
  equal(sync.pending.size, 0);
});

await test('sandbox: confirmed false survives duplicate delivery, reload, and reopening', async () => {
  const sync = new SettingsSync();
  const store = new Store();
  store.setMeta('7', { ...ready(), name: 'Keep this conversation', autoApproveCommand: true });
  await sync.saveSandbox('7', false, {
    getState: () => store.session('7'),
    setPending: (sandboxSaving) => store.setMeta('7', { sandboxSaving }),
    patch: async () => ({ id: '7', sandbox: false, auto_approve_write: false, auto_approve_command: true }),
    accept: (row) => store.setMeta('7', settingsMeta(row)),
  });
  store.apply('7', { type: 'settings', sandbox: false, auto_approve_write: false, auto_approve_command: true });
  equal(store.session('7').sandbox, false);
  equal(store.session('7').autoApproveCommand, true);
  equal(store.session('7').name, 'Keep this conversation');
  equal(store.session('7').sandboxSaving, false);
  const fetched = { id: '7', sandbox: false, auto_approve_write: false, auto_approve_command: true };
  store.forget('7');
  store.setMeta('7', settingsMeta(fetched));
  equal(store.session('7').sandbox, false);
  const otherDevice = new Store();
  otherDevice.setMeta('7', settingsMeta(fetched));
  equal(otherDevice.session('7').sandbox, false);
});

await test('settings: reopening a forgotten session cannot reuse a REST connection token', () => {
  const store = new Store();
  store.setConnected('7', true);
  const oldEpoch = store.session('7').connectionEpoch;
  store.forget('7');
  store.setConnected('7', true);
  equal(store.session('7').connectionEpoch > oldEpoch, true);
  equal(store.session('7').settingsLoaded, false);
});

await test('sandbox: stale-idle 409 retains confirmation, surfaces explanation, never retries', async () => {
  const sync = new SettingsSync();
  const state = ready();
  let calls = 0;
  const error = Object.assign(new Error('Cannot change sandbox while a turn is in progress'), { status: 409 });
  let caught;
  try {
    await sync.saveSandbox('7', false, {
      getState: () => state,
      setPending: (value) => { state.sandboxSaving = value; },
      patch: async () => { calls++; throw error; },
      accept: () => { throw new Error('A failure must not be accepted'); },
    });
  } catch (failure) { caught = failure; }
  equal(caught === error, true);
  equal(state.sandbox, true);
  equal(state.sandboxSaving, false);
  equal(calls, 1);
  equal(sync.pending.size, 0);
});

// API/socket modules read location at import time. Supply it only in the Node
// runner; browser tests retain their real origin. All network traffic is mocked.
const suppliedLocation = typeof globalThis.location === 'undefined';
if (suppliedLocation) globalThis.location = { search: '', origin: 'http://localhost' };
const api = await import('../js/api.js');
const { SessionSocket } = await import('../js/socket.js');
if (suppliedLocation) delete globalThis.location;

await test('sandbox API: creation preserves false and numeric worktree ids; PATCHes stay narrow', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, text: async () => JSON.stringify({ id: 7, sandbox: false }) };
  };
  try {
    equal((await api.createSession('name', '/app', 'pi', '3', false)).sandbox, false);
    await api.createSession('name', '/app', 'pi');
    await api.setSandbox('7', false);
    await api.renameSession('7', 'renamed');
    await api.setAutoApprove('7', true, false);
    await api.setAutoApprove('7', undefined, true);
    await api.createSession('name', '/app', 'pi', null, true);
    equal(calls[0].body, { name: 'name', project_path: '/app', agent: 'pi', worktree_id: 3, sandbox: false });
    equal('sandbox' in calls[1].body, false);
    equal(calls[2], { path: '/sessions/7', method: 'PATCH', body: { sandbox: false } });
    equal(calls[3].body, { name: 'renamed' });
    equal(calls[4].body, { auto_approve_write: true, auto_approve_command: false });
    equal(calls[5].body, { auto_approve_command: true });
    equal(calls[6].body.sandbox, true);
  } finally { globalThis.fetch = original; }
});

await test('sandbox API: FastAPI 409, 404 and validation arrays remain readable', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, detail, expected] of [
      [409, 'Cannot change sandbox while a turn is in progress', 'Cannot change sandbox while a turn is in progress'],
      [404, 'Session not found', 'Session not found'],
      [422, [{ msg: 'Expected a boolean' }], 'Expected a boolean'],
    ]) {
      globalThis.fetch = async () => ({ ok: false, status, text: async () => JSON.stringify({ detail }) });
      let caught;
      try { await api.setSandbox('7', false); } catch (error) { caught = error; }
      equal(caught?.status, status);
      equal(caught?.message, expected);
    }
  } finally { globalThis.fetch = original; }
});

await test('sandbox socket: reconnect requests REST even without settings; pending saves block only turns', () => {
  const original = globalThis.WebSocket;
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() {}
  }
  globalThis.WebSocket = FakeSocket;
  const store = new Store();
  let refreshes = 0;
  const events = [];
  const socket = new SessionSocket('7', store, (event) => events.push(event), () => refreshes++);
  try {
    socket.open();
    sockets[0].onopen();
    equal(refreshes, 1);
    equal(store.session('7').sessionReady, false);
    sockets[0].onmessage({ data: JSON.stringify({ type: 'status', status: 'idle' }) });
    equal(store.session('7').sessionReady, true);
    store.setMeta('7', { sandboxSaving: true });
    equal(socket.sendInput('go'), false);
    equal(socket.sendBash('pwd'), true);
    equal(sockets[0].sent, [{ type: 'bash', command: 'pwd' }]);
    store.setMeta('7', { sandboxSaving: false });
    equal(socket.sendInput('go'), true);
    sockets[0].onclose();
    socket.open(); // Clears the reconnect timer, simulating its expiry.
    sockets[1].onopen();
    equal(refreshes, 2);
    equal(store.session('7').settingsLoaded, false);
    // A live settings frame can arrive before the replay's trailing status.
    sockets[1].onmessage({ data: JSON.stringify({ type: 'settings', sandbox: false }) });
    equal(events.at(-1).type, 'settings');
    sockets[1].onmessage({ data: JSON.stringify({ type: 'status', status: 'idle' }) });
    equal(store.session('7').sandbox, false);
    equal(store.session('7').sessionReady, true);
    store.setMeta('7', { sandbox: true });
    sockets[1].onmessage({ data: JSON.stringify({ type: 'error', message: 'Sandbox setup failed' }) });
    equal(store.session('7').rows.some((row) => row.message?.includes('Sandbox setup failed')), true);
    equal(store.session('7').sandbox, true);
  } finally {
    socket.close();
    globalThis.WebSocket = original;
  }
});
