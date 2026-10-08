/** Minimal DOM smoke test: node test/sandbox-network-dialog-tests.js */
import assert from 'node:assert/strict';
import { sandboxNetworkDialog, appSettingsDialog, projectSettingsDialog } from '../js/dialogs.js';

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
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { this.parent.children = this.parent.children.filter((node) => node !== this); }
  addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); }
  async emit(event) { for (const handler of this.listeners[event] ?? []) await handler({ target: this }); }
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
  const calls = [];
  let reject = true;
  const entry = { ip: '100.64.0.10', port: 443 };
  const result = sandboxNetworkDialog([entry], async (entries) => {
    calls.push(entries);
    if (reject) throw new Error('Invalid destination');
    return { sandbox_network_allowlist: [entry] };
  });
  assert.deepEqual(inputs().map((node) => String(node.value)), ['100.64.0.10', '443']);
  await button('+ Add exception').emit('click');
  inputs()[2].value = '100.64.0.10';
  inputs()[3].value = '443';
  await button('Save exceptions').emit('click');
  assert.deepEqual(calls[0], [entry, entry]);
  assert.equal(descendants(dialog()).find((node) => node.className === 'dlg-error').textContent, 'Invalid destination');
  assert.equal(inputs().length, 4); // Rejected drafts remain editable.
  reject = false;
  await button('Save exceptions').emit('click');
  assert.deepEqual(await result, [entry]); // Server deduplication, not draft.
  assert.equal(document.body.children.length, 0);

  const cleared = sandboxNetworkDialog([entry], async (entries) => {
    assert.deepEqual(entries, []);
    return { sandbox_network_allowlist: [] };
  });
  await button('Remove').emit('click');
  assert.equal(inputs().length, 0);
  await button('+ Add exception').emit('click');
  await button('Clear all exceptions').emit('click');
  await button('Save exceptions').emit('click');
  assert.deepEqual(await cleared, []);

  let saved = false;
  const cancelled = sandboxNetworkDialog([], async () => { saved = true; });
  await button('Cancel').emit('click');
  assert.equal(await cancelled, null);
  assert.equal(saved, false);

  const inherited = { ip: '100.64.0.20', port: 22 };
  const projectResult = sandboxNetworkDialog([entry], async (entries) => {
    assert.deepEqual(entries, [entry, entry]); // Never submit inherited rows.
    return { sandbox_network_allowlist: [entry] };
  }, 'Example', [inherited]);
  assert.equal(inputs().length, 2);
  assert.ok(descendants(dialog()).some((node) => node.textContent === '100.64.0.20:22 (TCP)'));
  assert.ok(descendants(dialog()).some((node) => node.textContent?.includes('cannot be removed at project level')));
  await button('+ Add exception').emit('click');
  inputs()[2].value = entry.ip;
  inputs()[3].value = '443';
  await button('Save exceptions').emit('click');
  assert.deepEqual(await projectResult, [entry]);

  const reset = sandboxNetworkDialog([entry], async (entries) => {
    assert.deepEqual(entries, []);
    return { sandbox_network_allowlist: [] };
  }, 'Example', [inherited]);
  await button('Reset to server inheritance').emit('click');
  assert.equal(inputs().length, 0);
  assert.ok(descendants(dialog()).some((node) => node.textContent === '100.64.0.20:22 (TCP)'));
  await button('Save exceptions').emit('click');
  assert.deepEqual(await reset, []);

  const projectSettings = projectSettingsDialog({ id: '7', name: 'Example', path: '/project' }, []);
  await button('Sandbox network…').emit('click');
  assert.equal((await projectSettings).action, 'sandbox-network');

  const settings = appSettingsDialog(null, '/project');
  await button('Server sandbox network…').emit('click');
  assert.equal((await settings).action, 'sandbox-network');
  console.log('Sandbox network dialog: load/add/remove/clear/save, normalized response, error retention, cancel, settings entry passed');
} finally {
  if (original === undefined) delete globalThis.document;
  else globalThis.document = original;
}
