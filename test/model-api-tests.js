/** Isolated model transport/dialog tests: node test/model-api-tests.js (no network). */
import assert from 'node:assert/strict';

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.listeners = {}; this.style = {};
    this.value = ''; this.textContent = ''; this.className = ''; this.disabled = false;
  }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  dispatch(name) { for (const fn of this.listeners[name] ?? []) fn({ preventDefault() {}, target: this }); }
  setAttribute() {}
  focus() {}
  showModal() {}
  close() { this.dispatch('close'); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector() { return null; }
  get all() { return [this, ...this.children.flatMap((child) => child.all)]; }
}
globalThis.document = { body: new Element('body'), createElement: (tag) => new Element(tag) };
globalThis.localStorage = {
  getItem: (key) => (key === 'agentUi.serverToken' ? 'model-test-token-with-at-least-32-characters' : null),
  setItem() {},
  removeItem() {},
};
globalThis.location = { protocol: 'http:', origin: 'http://server.test', search: '', reload() {} };

const requests = [];
let reply = { status: 200, body: {} };
globalThis.fetch = async (url, options) => {
  requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
  return { status: reply.status, ok: reply.status < 400, text: async () => JSON.stringify(reply.body) };
};

const api = await import('../js/api.js');
const { newSessionDialog } = await import('../js/dialogs.js');

// GET /models is authenticated and normalized; a failed harness does not break the other.
reply = {
  status: 200,
  body: {
    'claude-code': { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }], error: null },
    pi: { models: [], error: 'Model discovery failed: boom' },
  },
};
const catalogs = await api.listModels();
assert.equal(requests.at(-1).url, 'http://server.test/models');
assert.equal(requests.at(-1).method, 'GET');
assert.deepEqual(catalogs.pi, { models: [], error: 'Model discovery failed: boom' });
assert.deepEqual(catalogs['claude-code'].models, [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }]);

// POST /sessions always sends the model it is given.
reply = { status: 200, body: { id: 3, project_id: 1, worktree_id: null, agent: 'pi', model: 'a/b' } };
const created = await api.createSession('S', '/p', 'pi', 'a/b', null, true);
assert.deepEqual(requests.at(-1).body, {
  name: 'S', project_path: '/p', agent: 'pi', model: 'a/b', worktree_id: null, sandbox: true,
});
assert.equal(created.model, 'a/b');

// Rejections carry the server's status and detail through.
reply = { status: 400, body: { detail: 'Unknown model for this agent' } };
await assert.rejects(api.createSession('S', '/p', 'pi', 'x'),
  (error) => error.status === 400 && error.message === 'Unknown model for this agent');
reply = { status: 503, body: { detail: 'Model discovery unavailable for this agent' } };
await assert.rejects(api.createSession('S', '/p', 'pi', 'x'), (error) => error.status === 503);

const tick = () => new Promise((resolve) => setTimeout(resolve));
const agents = [
  { id: 'claude-code', name: 'Claude Code', default: true },
  { id: 'pi', name: 'Pi', default: false },
];
const project = { name: 'P', path: '/p', is_git_repo: false };
const open = (handlers, models, agentList = agents) => {
  const result = newSessionDialog(project, [], agentList, handlers, models);
  const dialog = document.body.children.at(-1);
  const [agentSelect, modelSelect] = dialog.all.filter((node) => node.tag === 'select');
  const note = modelSelect?.parent.children.find((node) => node.className.startsWith('dlg-note'));
  const create = dialog.all.find((node) => node.tag === 'button' && node.textContent === 'Create');
  const error = dialog.all.find((node) => node.className === 'dlg-error');
  const choose = (id) => { agentSelect.value = id; agentSelect.dispatch('change'); };
  const options = () => modelSelect.children.map((option) => option.value);
  return { result, dialog, agentSelect, modelSelect, note, create, error, choose, options };
};

// Loading holds Create; the catalog then preselects each agent's first model.
let resolveCatalogs;
const pending = new Promise((resolve) => { resolveCatalogs = resolve; });
const submitted = [];
let refuse = null;
const first = open({
  onSubmit: async (spec) => {
    submitted.push(spec);
    if (refuse) throw refuse;
    return { id: '9', ...spec };
  },
}, pending);
first.choose('claude-code');
assert.deepEqual(first.options(), []);
assert.equal(first.create.disabled, true);
assert.equal(first.note.textContent, 'Loading models…');
assert.doesNotMatch(first.note.className, /warn/);

resolveCatalogs({
  'claude-code': { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }], error: null },
  pi: { models: [], error: 'Model discovery failed: boom' },
});
await tick();
// No "Default" entry: the first model is selected.
assert.deepEqual(first.options(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
assert.equal(first.modelSelect.value, 'claude-opus-5-5');
assert.equal(first.create.disabled, false);
first.modelSelect.value = 'claude-sonnet-5-5';

// A failed catalog blocks that agent, with the reason beside the picker.
first.choose('pi');
assert.deepEqual(first.options(), []);
assert.equal(first.create.disabled, true);
assert.equal(first.note.textContent, 'Model list unavailable: Model discovery failed: boom');
assert.match(first.note.className, /warn/);
first.create.dispatch('click');
await tick();
assert.equal(submitted.length, 0);

// Back to Claude Code: its first model again, not the earlier choice.
first.choose('claude-code');
assert.equal(first.modelSelect.value, 'claude-opus-5-5');
assert.equal(first.create.disabled, false);

// A refused create keeps the dialog open, the error shown, the selection kept.
first.modelSelect.value = 'claude-sonnet-5-5';
refuse = Object.assign(new Error('Unknown model for this agent'), { status: 400 });
first.create.dispatch('click');
await tick();
assert.equal(first.error.textContent, 'Unknown model for this agent');
assert.equal(first.modelSelect.value, 'claude-sonnet-5-5');
assert.equal(first.agentSelect.value, 'claude-code');
assert.equal(first.create.disabled, false);
assert.equal(document.body.children.includes(first.dialog), true);

refuse = null;
first.create.dispatch('click');
const session = await first.result;
assert.equal(session.model, 'claude-sonnet-5-5');
assert.deepEqual(submitted.map((spec) => spec.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5']);

// A failed /models request (an older server's 404 included) blocks every agent.
const failing = Promise.reject(Object.assign(new Error('Server error 404'), { status: 404 }));
const second = open({ onSubmit: async () => { throw new Error('must not submit'); } }, failing);
await tick();
for (const id of ['claude-code', 'pi']) {
  second.choose(id);
  assert.equal(second.create.disabled, true);
  assert.equal(second.note.textContent, 'Model list unavailable: Server error 404');
}

// Missing and empty catalogs block only their own agent.
const third = open({}, {
  'claude-code': { models: [], error: null },
  pi: { models: [{ id: 'openai-codex/gpt-5.5', name: 'gpt-5.5' }], error: null },
}, [...agents, { id: 'other', name: 'Other', default: false }]);
third.choose('claude-code');
assert.equal(third.note.textContent, 'The server found no models for this agent.');
assert.equal(third.create.disabled, true);
third.choose('other');
assert.equal(third.note.textContent, 'The server lists no models for this agent.');
assert.equal(third.create.disabled, true);
third.choose('pi');
assert.equal(third.create.disabled, false);
third.create.dispatch('click');
const spec = await third.result;
assert.deepEqual([spec.agent, spec.model], ['pi', 'openai-codex/gpt-5.5']);

// Without an agent list there is no catalog to choose from: creation is blocked.
const fourth = open({}, Promise.resolve({}), []);
assert.equal(fourth.agentSelect, undefined);
assert.equal(fourth.create.disabled, true);
fourth.dialog.close();
assert.equal(await fourth.result, null);

console.log('Model transport and new-session picker tests passed.');
