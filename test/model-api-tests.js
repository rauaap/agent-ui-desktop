/** Isolated agent-catalog transport/dialog tests: node test/model-api-tests.js (no network). */
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
const { newSessionDialog, sessionSettingsDialog } = await import('../js/dialogs.js');

// GET /agents carries each agent's catalog, normalized; a failed harness does not break the other.
reply = {
  status: 200,
  body: [
    { id: 'claude-code', name: 'Claude Code', default: true, models: [], models_error: 'Unavailable' },
    {
      id: 'pi', name: 'Pi', default: false,
      models: [{ id: 'p/m', name: 'M', reasoning_levels: ['off', 'high'] }], models_error: null,
    },
  ],
};
const listed = await api.listAgents();
assert.equal(requests.at(-1).url, 'http://server.test/agents');
assert.equal(requests.at(-1).method, 'GET');
assert.deepEqual(listed, reply.body);
assert.equal(api.listModels, undefined);

// POST /sessions always sends the model and reasoning level it is given; null is the harness default.
reply = {
  status: 200,
  body: { id: 3, project_id: 1, worktree_id: null, agent: 'pi', model: 'a/b', reasoning_level: 'high' },
};
const created = await api.createSession('S', '/p', 'pi', 'a/b', 'high', null, true);
assert.deepEqual(requests.at(-1).body, {
  name: 'S', project_path: '/p', agent: 'pi', model: 'a/b', reasoning_level: 'high', worktree_id: null, sandbox: true,
});
assert.equal(created.model, 'a/b');
assert.equal(created.reasoning_level, 'high');
await api.createSession('S', '/p', 'pi', 'a/b', null);
assert.equal(requests.at(-1).body.reasoning_level, null);

// PATCH /sessions/{id} sends only the level.
const patched = await api.setReasoningLevel('3', 'high');
assert.equal(requests.at(-1).url, 'http://server.test/sessions/3');
assert.equal(requests.at(-1).method, 'PATCH');
assert.deepEqual(requests.at(-1).body, { reasoning_level: 'high' });
assert.equal(patched.reasoning_level, 'high');

// Rejections carry the server's status and detail through.
reply = { status: 400, body: { detail: 'Unknown model for this agent' } };
await assert.rejects(api.createSession('S', '/p', 'pi', 'x'),
  (error) => error.status === 400 && error.message === 'Unknown model for this agent');
reply = { status: 503, body: { detail: 'Model discovery unavailable for this agent' } };
await assert.rejects(api.createSession('S', '/p', 'pi', 'x'), (error) => error.status === 503);

const tick = () => new Promise((resolve) => setTimeout(resolve));
const agents = [
  {
    id: 'claude-code', name: 'Claude Code', default: true, models_error: null,
    models: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', reasoning_levels: ['low', 'high', 'max'] },
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', reasoning_levels: [] },
    ],
  },
  { id: 'pi', name: 'Pi', default: false, models: [], models_error: 'Model discovery failed: boom' },
];
const project = { name: 'P', path: '/p', is_git_repo: false };
const open = (handlers, agentList = agents) => {
  const result = newSessionDialog(project, [], agentList, handlers);
  const dialog = document.body.children.at(-1);
  const [agentSelect, modelSelect, reasoningSelect] = dialog.all.filter((node) => node.tag === 'select');
  const note = modelSelect?.parent.children.find((node) => node.className.startsWith('dlg-note'));
  const create = dialog.all.find((node) => node.tag === 'button' && node.textContent === 'Create');
  const error = dialog.all.find((node) => node.className === 'dlg-error');
  const choose = (id) => { agentSelect.value = id; agentSelect.dispatch('change'); };
  const options = () => modelSelect.children.map((option) => option.value);
  const pickModel = (id) => { modelSelect.value = id; modelSelect.dispatch('change'); };
  const levels = () => reasoningSelect.children.map((option) => option.value);
  const reasoningShown = () => reasoningSelect.parent.style.display !== 'none';
  return {
    result, dialog, agentSelect, modelSelect, reasoningSelect, note, create, error, choose, options,
    pickModel, levels, reasoningShown,
  };
};

// The selected agent's catalog preselects its first model.
const submitted = [];
let refuse = null;
const first = open({
  onSubmit: async (spec) => {
    submitted.push(spec);
    if (refuse) throw refuse;
    return { id: '9', ...spec };
  },
});
first.choose('claude-code');
// No "Default" entry: the first model is selected.
assert.deepEqual(first.options(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
assert.equal(first.modelSelect.value, 'claude-opus-5-5');
assert.equal(first.create.disabled, false);

// Reasoning offers "Default" (sent as null) and exactly the model's levels.
assert.equal(first.reasoningShown(), true);
assert.deepEqual(first.levels(), ['', 'low', 'high', 'max']);
assert.equal(first.reasoningSelect.children[0].textContent, 'Default');
assert.equal(first.reasoningSelect.value, '');
first.reasoningSelect.value = 'max';
// A model without levels hides the selector; changing model resets to Default.
first.pickModel('claude-sonnet-5-5');
assert.equal(first.reasoningShown(), false);
assert.equal(first.reasoningSelect.value, '');
first.pickModel('claude-opus-5-5');
assert.equal(first.reasoningShown(), true);
assert.equal(first.reasoningSelect.value, '');
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
first.pickModel('claude-opus-5-5');
first.reasoningSelect.value = 'high';
first.create.dispatch('click');
const session = await first.result;
assert.equal(session.model, 'claude-opus-5-5');
assert.equal(session.reasoningLevel, 'high');
assert.deepEqual(submitted.map((spec) => [spec.model, spec.reasoningLevel]),
  [['claude-sonnet-5-5', null], ['claude-opus-5-5', 'high']]);

// An empty catalog blocks only its own agent.
const second = open({}, [
  { id: 'claude-code', name: 'Claude Code', default: true, models: [], models_error: null },
  {
    id: 'pi', name: 'Pi', default: false, models_error: null,
    models: [{ id: 'openai-codex/gpt-5.5', name: 'gpt-5.5', reasoning_levels: ['off', 'high'] }],
  },
]);
second.choose('claude-code');
assert.equal(second.note.textContent, 'The server found no models for this agent.');
assert.equal(second.create.disabled, true);
second.choose('pi');
assert.equal(second.create.disabled, false);
second.create.dispatch('click');
const spec = await second.result;
assert.deepEqual([spec.agent, spec.model, spec.reasoningLevel], ['pi', 'openai-codex/gpt-5.5', null]);

// Without an agent list there is no catalog to choose from: creation is blocked.
const third = open({}, []);
assert.equal(third.agentSelect, undefined);
assert.equal(third.create.disabled, true);
third.dialog.close();
assert.equal(await third.result, null);

// Session settings: the current level, Default while unset, and only real levels to change to.
const settings = (state, levels) => {
  const result = sessionSettingsDialog(
    { id: '5', name: 'S', agent: 'other', status: 'idle', ...state },
    { reasoningLevels: () => levels },
  );
  const dialog = document.body.children.at(-1);
  const select = dialog.all.find((node) => node.tag === 'select');
  const save = dialog.all.find((node) => node.tag === 'button' && node.textContent === 'Save');
  const shown = dialog.all.find((node) => node.className === 'dkey' && node.textContent === 'Reasoning');
  return { result, dialog, select, save, shown };
};
const unset = settings({ reasoningLevel: null }, ['low', 'high']);
assert.deepEqual(unset.select.children.map((o) => [o.value, o.textContent]),
  [['', 'Default'], ['low', 'low'], ['high', 'high']]);
assert.equal(unset.select.value, '');
unset.select.value = 'high';
unset.save.dispatch('click');
assert.equal((await unset.result).reasoningLevel, 'high');

const set = settings({ reasoningLevel: 'low' }, ['low', 'high']);
// No way back to Default once a level is set.
assert.deepEqual(set.select.children.map((o) => o.value), ['low', 'high']);
assert.equal(set.select.value, 'low');
set.save.dispatch('click');
assert.equal((await set.result).reasoningLevel, 'low');

const none = settings({ reasoningLevel: null }, []);
assert.equal(none.select, undefined);
assert.equal(none.shown.parent.children[1].textContent, 'Default');
none.save.dispatch('click');
assert.equal((await none.result).reasoningLevel, null);

console.log('Model transport, new-session picker and reasoning tests passed.');
