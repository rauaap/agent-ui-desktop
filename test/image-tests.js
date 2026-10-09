import assert from 'node:assert/strict';
import { SessionDraft } from '../js/session-draft.js';
import { Store, reduce } from '../js/store.js';
import { normalizeCatalog } from '../js/models.js';
import { MessageHistory } from '../js/message-history.js';

globalThis.location = { protocol: 'http:', origin: 'http://server.test' };
const saved = new Map([['agentUi.serverToken', 'secret']]);
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: (key) => saved.delete(key),
};
const entries = new Map();
const cache = {
  delete: async (key) => entries.delete(typeof key === 'string' ? key : key.url),
  put: async (key, response) => entries.set(key, response.clone()),
  match: async (key) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
  keys: async () => [...entries.keys()].map((url) => new Request(url)),
};
globalThis.caches = { open: async () => cache };
const image = { id: 'a/b', mime_type: 'image/png', size: 3, width: 20, height: 10 };
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  assert.equal(options.headers.get('Authorization'), 'Bearer secret');
  assert.equal(options.redirect, 'error');
  return options.method === 'POST'
    ? new Response(JSON.stringify(image), { status: 201 })
    : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
};
const { uploadImage, loadImage, imageUrl, seedImage, ImageViews } = await import('../js/images.js');
const original = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
assert.deepEqual(await uploadImage(original), image);
assert.equal(calls[0].options.body, original);
assert.equal(calls[0].options.headers.get('Content-Type'), 'image/png');
assert.equal(imageUrl(image.id), 'http://server.test/images/a%2Fb');
assert.deepEqual([...new Uint8Array(await (await loadImage(image)).arrayBuffer())], [1, 2, 3]);
assert.equal(calls.length, 1, 'upload seeds cache without GET');
entries.clear();
await loadImage(image);
assert.equal(calls.length, 2);
assert.equal(calls[1].url, imageUrl(image.id));
await assert.rejects(uploadImage(new Blob(['x'], { type: 'text/plain' })), /JPEG/);
await assert.rejects(uploadImage(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' })), /10 MiB/);
for (let i = 0; i < 105; i++) await seedImage({ ...image, id: String(i) }, original);
assert.equal(entries.size, 100);
assert.equal(entries.has(imageUrl('0')), false);
// URLs from another server are distinct cache keys.
entries.set('http://other.test/images/104', new Response('other'));
assert.equal(await (await loadImage({ ...image, id: '104' })).text(), '\u0001\u0002\u0003');

const draft = new SessionDraft('images');
draft.save('caption', [image, { ...image, id: 'second' }]);
const restored = new SessionDraft('images');
assert.equal(restored.saved, 'caption');
assert.deepEqual(restored.images.map((row) => row.id), ['a/b', 'second']);
draft.save('', [image]);
assert.equal(new SessionDraft('images').images.length, 1);
draft.save('');
assert.equal(new SessionDraft('images').images.length, 0);
assert.equal(entries.size, 101, 'clearing drafts does not clear cache');
const catalog = normalizeCatalog({ models: [{ id: 'vision', name: 'Vision', reasoning_levels: [], input: ['text', 'image'] }] });
assert.deepEqual(catalog.models[0].input, ['text', 'image']);
const state = new Store().session('1');
const message = { message_id: 1, text: '', images: [image, image] };
reduce(state, { type: 'input', delivery: 'queued', ...message });
assert.deepEqual(state.queue[0].images, [image, image]);
reduce(state, { type: 'input_queue', messages: [message] });
reduce(state, { type: 'inputs_shipped', messages: [message] });
assert.deepEqual(state.rows[0].images, [image, image]);
reduce(state, { type: 'inputs_shipped', messages: [message] });
assert.equal(state.rows.length, 1);

const { SessionPane } = await import('../js/pane.js');
const pane = Object.create(SessionPane.prototype);
pane.id = '1';
pane.store = { session: () => ({ connected: true, status: 'idle' }) };
pane.input = { value: '' };
pane.attachments = [{ status: 'uploading' }, { status: 'ready', image }];
const errors = [];
pane.handlers = { onError: (message) => errors.push(message) };
const sent = [];
pane.socket = { sendInput: (...args) => { sent.push(args); return true; } };
pane.draft = draft;
pane.messageHistory = new MessageHistory();
pane.pendingHistoryEchoes = [];
pane.renderAttachments = pane.hideCompletions = pane.autoGrow = pane.paintMode = () => {};
assert.deepEqual(pane.savedImages(), [image]);
pane.send();
assert.equal(sent.length, 0);
pane.attachments[0].status = 'failed';
pane.send();
assert.equal(sent.length, 0);
pane.attachments = [{ status: 'ready', image }];
pane.input.value = '!ls';
pane.send();
assert.equal(sent.length, 0, 'shell commands reject attachments');
pane.input.value = '';
pane.attachments = [{ status: 'ready', image: { ...image, size: 20 * 1024 * 1024 + 1 } }];
pane.send();
assert.equal(sent.length, 0, 'over-budget message remains in composer');
pane.attachments = [{ status: 'ready', image }];
pane.send();
assert.deepEqual(sent, [['', ['a/b']]]);
assert.equal(pane.attachments.length, 0);
pane.input.value = 'mixed';
pane.attachments = [{ status: 'ready', image }, { status: 'ready', image: { ...image, id: 'second' } }];
pane.send();
assert.deepEqual(sent[1], ['mixed', ['a/b', 'second']]);
pane.input.value = 'offline';
pane.attachments = [{ status: 'ready', image }];
pane.socket.sendInput = () => false;
pane.send();
assert.equal(pane.attachments.length, 1, 'failed socket send retains draft references');

// View disposal prevents late results from creating object URLs.
class Node {
  constructor() { this.children = []; this.style = {}; }
  append(child) { this.children.push(child); }
  contains(child) { return child === this || this.children.some((node) => node.contains(child)); }
  replaceChildren(...children) { this.children = children; }
}
globalThis.document = { createElement: () => new Node() };
let created = 0;
const oldCreate = URL.createObjectURL;
URL.createObjectURL = () => { created++; return 'blob:test'; };
const views = new ImageViews();
const root = new Node();
views.append(root, [image]);
views.dispose(root);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(created, 0);
URL.createObjectURL = oldCreate;
console.log('Image upload/cache/draft/queue/composer/view tests passed.');
