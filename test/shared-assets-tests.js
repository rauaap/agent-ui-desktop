/** Shared-assets UI and link smoke tests: node test/shared-assets-tests.js */
import assert from 'node:assert/strict';
import { appSettingsDialog, projectSettingsDialog, sharedAssetsDialog, sharedAssetEditorDialog } from '../js/dialogs.js';
import { toHtml } from '../js/render/markdown.js';

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.value = '';
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  remove() { this.parent.children = this.parent.children.filter((node) => node !== this); }
  addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); }
  async emit(event) { for (const handler of this.listeners[event] ?? []) await handler({ target: this, preventDefault() {} }); }
  close() { this.emit('close'); }
  showModal() {}
  focus() {}
  select() {}
  querySelector(selector) { return descendants(this).find((node) => selector.split(', ').includes(node.tagName.toLowerCase())); }
}
function descendants(node) { return node.children.flatMap((child) => [child, ...descendants(child)]); }
const original = globalThis.document;
globalThis.document = { createElement: (tag) => new Node(tag), body: new Node('body') };
const dialog = () => document.body.children.at(-1);
const button = (text) => descendants(dialog()).find((node) => node.tagName === 'BUTTON' && node.textContent === text);
const inputs = () => descendants(dialog()).filter((node) => node.tagName === 'INPUT');
try {
  const root = { asset_root: 'notes', path: '/notes', project_id: null, url: '/shared-assets/notes/' };
  let opened;
  const list = sharedAssetsDialog([root], (value) => { opened = value; });
  await button('Open').emit('click');
  assert.equal(opened, root);
  await button('Edit…').emit('click');
  assert.deepEqual(await list, { action: 'edit', root });

  let reject = true;
  const calls = [];
  const editor = sharedAssetEditorDialog(root, async (value) => {
    calls.push(value);
    if (reject) throw new Error('Identifier already registered');
    return { ...root, ...value };
  });
  inputs()[0].value = 'bad name';
  await button('Save').emit('click');
  assert.equal(calls.length, 0);
  inputs()[0].value = 'research';
  inputs()[1].value = '~/notes';
  await button('Save').emit('click');
  assert.equal(calls.length, 0);
  inputs()[1].value = '/research';
  await button('Save').emit('click');
  assert.equal(descendants(dialog()).find((node) => node.className === 'dlg-error').textContent, 'Identifier already registered');
  assert.deepEqual(inputs().map((node) => node.value), ['research', '/research']);
  reject = false;
  await button('Save').emit('click');
  assert.deepEqual(await editor, { ...root, asset_root: 'research', path: '/research' });

  const remove = sharedAssetsDialog([root], () => {}, 'Project');
  await button('Unregister…').emit('click');
  assert.deepEqual(await remove, { action: 'delete', root });
  const empty = sharedAssetsDialog([], () => {});
  await button('+  Register directory…').emit('click');
  assert.deepEqual(await empty, { action: 'create' });
  let saved = false;
  const cancelled = sharedAssetEditorDialog(null, () => { saved = true; });
  await button('Cancel').emit('click');
  assert.equal(await cancelled, null);
  assert.equal(saved, false);

  const notifications = document.createElement('button');
  notifications.textContent = 'Desktop notifications: Off';
  let notificationClicks = 0;
  notifications.addEventListener('click', () => { notificationClicks++; });
  const notificationSettings = appSettingsDialog(null, '/project', [], null, notifications);
  assert.ok(descendants(dialog()).includes(notifications));
  await button('Desktop notifications: Off').emit('click');
  assert.equal(notificationClicks, 1);
  assert.equal(document.body.children.includes(dialog()), true);
  await button('Cancel').emit('click');
  assert.equal(await notificationSettings, null);

  const settings = appSettingsDialog(null, '/project');
  await button('Server shared assets…').emit('click');
  assert.equal((await settings).action, 'shared-assets');
  const project = projectSettingsDialog({ id: '42', name: 'Project', path: '/project' }, []);
  await button('Shared assets…').emit('click');
  assert.equal((await project).action, 'shared-assets');

  const base = 'https://server.example:8443';
  assert.ok(toHtml('[Report](/shared-assets/notes/report/)', base).includes('href="https://server.example:8443/shared-assets/notes/report/"'));
  assert.ok(toHtml('**[Report](/shared-assets/notes/a%20b.html?x=1&y=2#chart)**', base).includes('href="https://server.example:8443/shared-assets/notes/a%20b.html?x=1&amp;y=2#chart"'));
  assert.ok(toHtml('[External](https://example.org/report)', base).includes('href="https://example.org/report"'));
  assert.ok(toHtml('[Other](/other)', base).includes('href="/other"'));
  assert.ok(!toHtml('[Unsafe](javascript:alert)', base).includes('<a'));
  console.log('Shared assets: settings entries, list/Open/add/edit/delete/cancel, validation, error retention, Markdown server links passed');
} finally {
  if (original === undefined) delete globalThis.document;
  else globalThis.document = original;
}
