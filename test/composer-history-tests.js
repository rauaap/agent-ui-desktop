/** Composer keyboard boundary regression tests: node test/composer-history-tests.js */
import assert from 'node:assert/strict';
import { MessageHistory } from '../js/message-history.js';

globalThis.location = { protocol: 'http:', origin: 'http://server.test' };
globalThis.localStorage = { getItem: () => null };
globalThis.document = {
  createElement: () => ({
    style: {}, listeners: {}, value: '',
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute() {}, append() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  }),
};
const { SessionPane } = await import('../js/pane.js');
const pane = Object.create(SessionPane.prototype);
pane.messageHistory = new MessageHistory(['older', 'newer']);
pane.autoGrow = () => {};
pane.paintMode = () => {};
pane.buildComposer();

function press(key, text, start, end = start, modifiers = {}) {
  pane.input.value = text;
  pane.input.setSelectionRange(start, end);
  let prevented = false;
  pane.input.listeners.keydown({ key, ...modifiers, preventDefault() { prevented = true; } });
  return prevented;
}

const draft = 'first line\nlast line';
for (const [key, position] of [
  ['ArrowUp', 3], ['ArrowUp', 11], ['ArrowUp', draft.length],
  ['ArrowDown', 0], ['ArrowDown', 10], ['ArrowDown', draft.length - 1],
]) {
  assert.equal(press(key, draft, position), false);
  assert.equal(pane.messageHistory.index, null);
  assert.equal(pane.input.value, draft);
}
assert.equal(press('ArrowUp', draft, 0, 3), false);
assert.equal(press('ArrowDown', draft, 3, draft.length), false);
for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey']) {
  assert.equal(press('ArrowUp', draft, 0, 0, { [modifier]: true }), false);
}
assert.equal(press('ArrowUp', draft, 0), true);
assert.equal(pane.input.value, 'newer');
assert.equal(pane.input.selectionStart, 0);
assert.equal(pane.input.selectionEnd, 0);
assert.equal(press('ArrowUp', 'newer', 2), false);
assert.equal(pane.messageHistory.index, 1);
assert.equal(press('ArrowUp', 'newer', 0), true);
assert.equal(pane.input.value, 'older');
assert.equal(pane.input.selectionStart, 0);
assert.equal(press('ArrowUp', pane.input.value, pane.input.selectionStart), true);
assert.equal(pane.input.value, 'older');
assert.equal(pane.input.selectionStart, 0);
assert.equal(press('ArrowDown', 'older', 5), true);
assert.equal(pane.input.value, 'newer');
assert.equal(pane.input.selectionStart, 5);
assert.equal(pane.input.selectionEnd, 5);
assert.equal(press('ArrowDown', pane.input.value, pane.input.selectionStart), true);
assert.equal(pane.input.value, draft);
assert.equal(pane.input.selectionStart, draft.length);
assert.equal(press('ArrowDown', draft, draft.length), false);
assert.equal(press('ArrowUp', '', 0), true);
assert.equal(press('ArrowDown', 'newer', 5), true);
assert.equal(pane.input.value, '');
pane.setComposerValue('restored draft');
assert.equal(pane.input.selectionStart, 'restored draft'.length);
assert.equal(pane.input.selectionEnd, 'restored draft'.length);
// Clipboard images use the same attachment path; ordinary and mixed text keep
// the browser's native paste behavior, and incapable/offline sessions ignore files.
pane.handlers = { canAttachImages: () => true };
pane.store = { session: () => ({}) };
const selected = [];
pane.selectImages = (files) => selected.push(files);
const image = { type: 'image/png' };
function paste(items, text = '', files = []) {
  let prevented = false;
  pane.input.listeners.paste({
    clipboardData: { items, files, getData: () => text },
    preventDefault() { prevented = true; },
  });
  return prevented;
}
const imageItem = { kind: 'file', type: 'image/png', getAsFile: () => image };
assert.equal(paste([imageItem]), true);
assert.deepEqual(selected[0], [image]);
assert.equal(paste([imageItem], 'caption'), false);
assert.deepEqual(selected[1], [image]);
assert.equal(paste([], 'text'), false);
assert.equal(selected.length, 2);
assert.equal(paste([], '', [image]), true);
assert.deepEqual(selected[2], [image]);
pane.handlers.canAttachImages = () => false;
assert.equal(paste([imageItem]), false);
pane.handlers.canAttachImages = () => true;
pane.input.disabled = true;
assert.equal(paste([imageItem]), false);
assert.equal(selected.length, 3);
console.log('Composer history keyboard and clipboard tests passed.');
