/** Ordinary retained records and missing-directory controls: node test/retained-sessions-tests.js */
import assert from 'node:assert/strict';
globalThis.location = { protocol: 'http:', origin: 'http://server.test' };
globalThis.localStorage = { getItem: () => null };
const { SessionPane } = await import('../js/pane.js');
import { projectSettingsDialog, sessionSettingsDialog } from '../js/dialogs.js';
import { parseComposerInput, sendRefusal, Store } from '../js/store.js';

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.classList = { toggle() {} };
  }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  remove() { this.parent.children = this.parent.children.filter((node) => node !== this); }
  setAttribute() {}
  addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); }
  async emit(event) { for (const fn of this.listeners[event] ?? []) await fn({ preventDefault() {} }); }
  close() { this.emit('close'); }
  showModal() {}
  focus() {}
  querySelector(selector) { return descendants(this).find((node) => selector.split(', ').includes(node.tagName.toLowerCase())); }
}
const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
const original = globalThis.document;
globalThis.document = { createElement: (tag) => new Node(tag), body: new Node('body') };
const buttons = () => descendants(document.body.children.at(-1)).filter((node) => node.tagName === 'BUTTON');
try {
  const state = { ...new Store().session('1'), id: '1', name: 'Retained', connected: true,
    projectPath: '/project', workingDir: '/project-fix', directoryExists: false, worktreeId: null };
  const pane = Object.create(SessionPane.prototype);
  Object.assign(pane, { id: '1', store: { session: () => state }, attachments: [],
    handlers: { canAttachImages: () => true } });
  for (const key of ['nameView', 'dirText', 'dirView', 'worktreeTag', 'statusPill',
    'input', 'sendButton', 'attachButton', 'stopButton']) pane[key] = new Node('span');
  pane.refresh();
  assert.equal(pane.missingTag.style.display, '');
  assert.equal(pane.worktreeTag.textContent, 'FORMER WORKTREE');
  assert.equal(pane.input.disabled, false);
  assert.equal(pane.sendButton.disabled, false);
  assert.equal(pane.attachButton.disabled, false);
  for (const text of ['prompt', '!pwd']) assert.equal(sendRefusal(state, parseComposerInput(text)), null);
  state.connected = false;
  pane.refresh();
  assert.equal(pane.input.disabled, true);
  state.connected = true;
  pane.attachments = [{ status: 'uploading' }];
  pane.refresh();
  assert.equal(pane.sendButton.disabled, true);

  const project = projectSettingsDialog({ id: '2', name: 'Project', path: '/project', is_git_repo: true }, [state]);
  assert.ok(buttons().some((node) => node.textContent === '+  New session…'));
  assert.ok(buttons().some((node) => node.textContent === '+  New worktree…'));
  assert.ok(!buttons().some((node) => /archive|detach/i.test(node.textContent)));
  await buttons().find((node) => node.textContent === 'Close').emit('click');
  await project;
  const settings = sessionSettingsDialog(state);
  assert.ok(!buttons().some((node) => /archive|detach/i.test(node.textContent)));
  await buttons().find((node) => node.textContent === 'Save').emit('click');
  assert.deepEqual(Object.keys(await settings).sort(), ['name', 'reasoningLevel', 'autoApproveWrite',
    'autoApproveCommand', 'autoApproveInterAgent', 'deleted'].sort());

  const store = new Store();
  store.setMeta('1', state);
  store.beginReplay('1');
  store.apply('1', { type: 'output', text: 'History' });
  store.apply('1', { type: 'input_queue', messages: [] });
  store.apply('1', { type: 'status', status: 'idle' });
  store.commitReplay('1');
  assert.equal(store.session('1').workingDir, '/project-fix');
  assert.equal(store.session('1').worktreeId, null);
  console.log('Retained sessions: creation/settings, missing composer, upload/offline guards and replay passed');
} finally {
  if (original === undefined) delete globalThis.document; else globalThis.document = original;
}
