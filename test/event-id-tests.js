/** Event-card metadata DOM smoke tests: node test/event-id-tests.js */
import assert from 'node:assert/strict';
globalThis.location = { protocol: 'http:', origin: 'http://localhost' };
const { TranscriptView } = await import('../js/render/transcript.js');

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.classList = {
      add: (name) => { this.className = `${this.className || ''} ${name}`; },
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelector(selector) {
    const name = selector.slice(1);
    for (const child of this.children) {
      if (child.className?.split(' ').includes(name)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const copied = [];
globalThis.document = { createElement: (tag) => new Element(tag) };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, value: { clipboard: { writeText: async (text) => copied.push(text) } },
});
try {
  const view = Object.create(TranscriptView.prototype);
  view.images = { append() {} };
  view.handlers = {};
  view.query = '';
  // Exercise real builders, including fallback tool/approval cards.
  for (const kind of ['user', 'agent', 'tool', 'approval', 'question', 'bash', 'error']) {
    const row = { kind, key: 1, text: 'Hello', message: 'Oops', command: 'pwd',
      eventIds: [42, 43], questions: [], options: [], resolved: { answers: {} } };
    const node = view.build(row);
    const chip = node.querySelector('.id-chip');
    assert.equal(chip.textContent, '#42', `${kind} identifies its first event`);
    assert.equal(chip.type, 'button');
    assert.equal(chip.attributes['aria-label'], 'Event ID 42, click to copy');
    assert.deepEqual(node.transcriptEventIds, [42, 43]);
    const footer = node.querySelector('.event-id-footer');
    assert.ok((kind === 'user' ? node.querySelector('.msg-user') : node).children.includes(footer),
      `${kind} keeps the footer inside its card`);
    let stopped = false;
    chip.listeners.click({ preventDefault() {}, stopPropagation() { stopped = true; } });
    await Promise.resolve();
    assert.equal(copied.at(-1), '42', 'copy uses the bare event number');
    assert.ok(stopped, 'copy does not toggle a tool card');
    clearTimeout(chip.copyTimer);
  }
  for (const eventIds of [undefined, [], [0], [-1]]) {
    assert.equal(view.build({ kind: 'user', key: 2, text: 'Local', eventIds })
      .querySelector('.event-id-footer'), null, 'local/non-event rows have no label');
  }

  const row = { kind: 'agent', key: 3, text: 'First', eventIds: [70] };
  const node = view.build(row);
  view.nodes = new Map([[3, node]]);
  view.list = { scrollTop: 0 };
  Object.defineProperty(view, 'followBottom', { value: false });
  view.restoreScroll = () => {};
  view.applyQueryTo = () => {};
  view.applyChanges([{ op: 'update', row: { ...row, text: 'First, second', eventIds: [70, 71] } }]);
  assert.equal(node.querySelector('.id-chip').textContent, '#70', 'streaming preserves the first ID');
  assert.deepEqual(node.transcriptEventIds, [70, 71], 'streaming updates history-anchor metadata');
  assert.equal(node.querySelector('.md').innerHTML.includes('second'), true);
  console.log('Event ID tests passed');
} finally {
  globalThis.document = originalDocument;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}
