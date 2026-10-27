/** Draft rendering DOM smoke tests: node test/streaming-view-tests.js */
import assert from 'node:assert/strict';
globalThis.location = { protocol: 'http:', origin: 'http://localhost' };
const { TranscriptView } = await import('../js/render/transcript.js');
const { Store } = await import('../js/store.js');

class Node {
  constructor() { this.parent = null; this.children = []; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); if (value !== '') this.appendChild(new Text(String(value))); }
  appendChild(child) {
    if (child instanceof Fragment) { for (const c of [...child.children]) this.appendChild(c); return child; }
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new Text(n) : n); }
  get parentNode() { return this.parent; }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.remove();
    child.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(node) { const parent = this.parent; parent.insertBefore(node, this); this.remove(); }
  replaceChildren(...nodes) { for (const c of [...this.children]) c.remove(); this.append(...nodes); }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
}
class Text extends Node {
  constructor(value) { super(); this.value = value; }
  get textContent() { return this.value; }
}
class Fragment extends Node {}
class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.dataset = {};
    this.listeners = {};
    this.style = {};
    this.open = false;
    const classes = () => this.className.split(' ').filter(Boolean);
    this.classList = {
      add: (name) => { if (!classes().includes(name)) this.className = [...classes(), name].join(' '); },
      contains: (name) => classes().includes(name),
      toggle: () => {},
    };
  }
  set innerHTML(html) { this.textContent = html; this.html = html; }
  get innerHTML() { return this.html ?? ''; }
  setAttribute() {}
  getBoundingClientRect() { return { top: 0, bottom: 0 }; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll(selector) {
    const match = selector.startsWith('.')
      ? (n) => n.classList?.contains(selector.slice(1))
      : (n) => n.tagName === selector.toUpperCase();
    return [...this.walk()].filter(match);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest() { return null; }
}
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createDocumentFragment: () => new Fragment(),
  createTextNode: (value) => new Text(value),
};

const frame = () => new Promise((resolve) => setTimeout(resolve, 30));
const store = new Store();
const view = Object.create(TranscriptView.prototype);
Object.assign(view, {
  sessionId: 's', store, handlers: {}, query: '', nodes: new Map(), draftViews: new Map(),
  dirtyDrafts: new Set(), draftFrame: null, list: new Element('div'), queueView: new Element('div'),
  images: { append() {}, dispose() {} }, scrolling: { followBottom: true },
  directory: { lookup: () => ({ state: 'found', session: { name: 'Recipient' } }) },
});
let restores = 0;
view.restoreScroll = () => { restores++; };
view.updateScrollButton = () => {};
store.subscribe('s', (changes) => view.applyChanges(changes));

const draft = (id, kind, extra) => ({ stream_id: id, turn_id: 't', ordinal: 0, revision: 0, kind, ...extra });
const tool = (id) => draft(id, 'tool', { call_id: 'c1', name: 'mcp__agent_ui__message_session',
  arguments_json: '', arguments_preview: {} });
const delta = (id, revision, text, preview) => store.apply('s', {
  type: 'stream_delta', stream_id: id, revision, delta: text, ...(preview ? { arguments_preview: preview } : {}) });
const buttons = (node) => node.querySelectorAll('button').length;

// A text draft is drawn once on start, then once per frame however many deltas arrive.
store.apply('s', { type: 'stream_start', draft: draft('s1', 'text', { text: '' }) });
const textNode = view.list.children[0];
assert.ok(textNode.classList.contains('draft'));
assert.equal(textNode.querySelector('.draft-tag').textContent, 'GENERATING');
restores = 0;
for (let i = 1; i <= 5; i++) delta('s1', i, `w${i} `);
assert.equal(textNode.querySelector('.md').textContent, '', 'deltas do not redraw synchronously');
await frame();
assert.ok(textNode.querySelector('.md').innerHTML.includes('w1 w2 w3 w4 w5'));
assert.equal(restores, 1, 'one batched redraw and scroll restore');

// Durable rows land above the active drafts.
store.apply('s', { type: 'bash_input', command: 'pwd', event_id: 1 });
assert.equal(view.list.children.at(-1), textNode);
assert.ok(view.list.children[0].classList.contains('bash-card'));

// A final retires the draft node synchronously; its pending frame draws nothing.
delta('s1', 6, 'tail');
store.apply('s', { type: 'output', text: 'w1 w2 w3 w4 w5 tail', stream_id: 's1', turn_id: 't', ordinal: 0,
  event_id: 2 });
assert.equal(textNode.parent, null);
assert.equal(view.draftViews.size, 0);
await frame();
assert.equal(view.list.children.filter((n) => n.classList.contains('draft')).length, 0);
assert.ok(view.list.children.at(-1).classList.contains('msg-agent'));

// A messaging draft composes, names its target once known, and grows in place.
store.apply('s', { type: 'stream_start', draft: tool('s2') });
const card = view.list.children.at(-1);
assert.equal(card.querySelector('.tool').textContent, 'MESSAGE SESSION');
assert.equal(card.querySelector('.summary').textContent, '→ composing…');
delta('s2', 1, '{"message":"Hel', { message: 'Hel' });
await frame();
const body = card.querySelector('.session-message');
assert.equal(body.textContent, 'Hel');
delta('s2', 2, 'lo', { message: 'Hello' });
delta('s2', 3, '","session_id":42', { message: 'Hello', session_id: 42 });
await frame();
assert.equal(card.querySelector('.session-message'), body, 'the body element survives growth');
assert.equal(body.children.length, 2, 'growth appends a text node rather than replacing');
assert.equal(body.textContent, 'Hello');
assert.ok(card.querySelector('.summary').textContent.includes('Recipient'));
assert.equal(card.querySelectorAll('.session-message').length, 1, 'the message is shown once');
assert.equal(buttons(card), 0, 'drafts have no controls');
// An open disclosure tracks the raw provisional arguments.
const raw = card.querySelector('details');
raw.open = true;
raw.listeners.toggle();
assert.ok(raw.querySelector('pre').textContent.includes('"session_id": 42'));

// A snapshot replaces the drafts wholesale.
store.apply('s', { type: 'stream_snapshot', drafts: [draft('s3', 'text', { text: 'Fresh', revision: 4 })] });
assert.equal(card.parent, null);
assert.equal([...view.draftViews.keys()].join(), 's3');
assert.ok(view.list.children.at(-1).querySelector('.md').innerHTML.includes('Fresh'));

// Interrupted entries are labelled and offer nothing to press.
store.apply('s', { type: 'stream_interrupted', reason: 'cancelled', event_id: 3,
  draft: { ...tool('s3'), kind: 'tool', arguments_preview: { message: 'Unfinished' } } });
const interrupted = view.list.children.at(-1);
assert.ok(interrupted.classList.contains('interrupted'));
assert.equal(interrupted.querySelector('.draft-tag').textContent, 'INTERRUPTED · stopped');
assert.equal(interrupted.querySelector('.session-message').textContent, 'Unfinished');
assert.equal(buttons(interrupted), 1, 'only the event ID copy chip');
assert.ok(interrupted.querySelector('.id-chip'));
assert.equal(view.draftViews.size, 0);

// Source order within a turn survives out-of-order completion, a reconnect
// replay and a history prepend.
const order = () => view.list.children.slice(-2).map((n) => n.dataset.streamId
  ?? n.querySelector('.md')?.innerHTML ?? n.querySelector('.tool')?.textContent);
const turn = (id, ordinal, extra) => ({ stream_id: id, turn_id: 'T', ordinal, revision: 0, ...extra });
store.apply('s', { type: 'stream_start', draft: turn('o0', 0, { kind: 'text', text: 'zero' }) });
store.apply('s', { type: 'stream_start', draft: turn('o1', 1, { kind: 'tool', call_id: 'k1', name: 'bash',
  arguments_json: '', arguments_preview: { command: 'ls' } }) });
assert.deepEqual(order(), ['o0', 'o1']);
const call = { type: 'tool_use', call_id: 'k1', action: { kind: 'command', command: 'ls' },
  stream_id: 'o1', turn_id: 'T', ordinal: 1, event_id: 60 };
store.apply('s', call);
assert.deepEqual(order(), ['o0', 'COMMAND'], 'the active ordinal 0 stays before completed ordinal 1');
// An unrelated durable row lands after the completed call, not between.
store.apply('s', { type: 'bash_input', command: 'pwd', event_id: 61 });
assert.equal(view.list.children.at(-1).classList.contains('bash-card'), true);
assert.equal(view.list.children.at(-2).querySelector('.tool').textContent, 'COMMAND');
assert.equal(view.list.children.at(-3).dataset.streamId, 'o0');
const zero = { type: 'output', text: 'zero done', stream_id: 'o0', turn_id: 'T', ordinal: 0, event_id: 62 };
store.apply('s', zero);
const rowKinds = () => store.session('s').rows.slice(-3).map((r) => r.kind);
assert.deepEqual(rowKinds(), ['agent', 'tool', 'bash']);
const domKinds = () => view.list.children.slice(-3).map((n) => n.className.split(' ')[1]);
assert.deepEqual(domKinds(), ['msg-agent', 'card', 'bash-card']);
// A reconnect replays in completion order and reaches the same order.
store.beginReplay('s');
for (const event of [call, { type: 'bash_input', command: 'pwd', event_id: 61 }, zero,
  { type: 'stream_snapshot', drafts: [] }, { type: 'status', status: 'idle' }]) store.apply('s', event);
store.commitReplay('s');
assert.deepEqual(rowKinds(), ['agent', 'tool', 'bash']);
assert.deepEqual(domKinds(), ['msg-agent', 'card', 'bash-card']);
store.apply('s', { type: 'done' });
store.prependHistory('s', [{ type: 'output', text: 'older', event_id: 59 }], 59, false);
assert.deepEqual(rowKinds(), ['agent', 'tool', 'bash']);
assert.deepEqual(domKinds(), ['msg-agent', 'card', 'bash-card']);
console.log('Streaming view tests passed');
