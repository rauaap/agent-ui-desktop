/** Run with: node test/scroll-follow-tests.js */
import assert from 'node:assert/strict';
import { ScrollFollow } from '../js/render/scroll-follow.js';

class Target {
  constructor() { this.handlers = new Map(); }
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
  emit(type, extra = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler({ target: this, isTrusted: true, ...extra });
    }
  }
}
class List extends Target {
  scrollHeight = 2000;
  clientHeight = 500;
  clientWidth = 400;
  offsetWidth = 415;
  clientLeft = 0;
  top = 1500;
  get scrollTop() { return this.top; }
  set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  getBoundingClientRect() { return { left: 0, right: 415 }; }
}
const originalWindow = globalThis.window;
globalThis.window = new Target();
try {
  const list = new List();
  const follow = new ScrollFollow(list);
  // Header/queue shrinking the viewport must not change following intent.
  list.clientHeight = 425;
  list.emit('scroll');
  assert.equal(follow.followBottom, true);
  follow.restore(follow.followBottom, list.scrollTop);
  assert.equal(list.scrollTop, 1575);
  // Programmatic events are trusted too, but must not detach following.
  list.emit('scroll');
  assert.equal(follow.followBottom, true);

  list.emit('wheel', { deltaY: -100 });
  assert.equal(follow.followBottom, false, 'upward input stops following before native scrolling');
  list.scrollTop = 1400;
  list.emit('scroll');
  assert.equal(follow.followBottom, false);
  list.scrollHeight = 2200;
  follow.restore(follow.followBottom, list.scrollTop);
  assert.equal(list.scrollTop, 1400, 'output preserves the reader offset');

  list.emit('wheel', { deltaY: 400 });
  list.scrollTop = 2200;
  list.emit('scroll');
  assert.equal(follow.followBottom, true, 'user scrolling to the bottom resumes following');

  list.emit('keydown', { key: 'PageUp' });
  assert.equal(follow.followBottom, false);
  follow.jumpToBottom();
  list.emit('keydown', { key: 'ArrowUp', target: { closest: () => ({}) } });
  assert.equal(follow.followBottom, true, 'keys inside form controls are not transcript navigation');
  list.emit('wheel', { deltaY: -100, ctrlKey: true });
  assert.equal(follow.followBottom, true, 'zoom is not user scrolling');

  list.emit('pointerdown', { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 410, clientY: 200 });
  window.emit('pointermove', { pointerId: 1, clientY: 150 });
  list.scrollTop = 1300;
  list.emit('scroll');
  assert.equal(follow.followBottom, false, 'scrollbar dragging updates following');
  window.emit('pointerup', { pointerId: 1 });

  follow.jumpToBottom();
  list.emit('pointerdown', { button: 0, pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 100 });
  window.emit('pointermove', { pointerId: 2, clientY: 160 });
  assert.equal(follow.followBottom, false, 'touch scrolling upward stops following');
  window.emit('pointercancel', { pointerId: 2 });
  list.scrollTop = 1400;
  list.emit('scroll');
  assert.equal(follow.followBottom, false, 'native touch cancellation retains the gesture window');

  follow.jumpToBottom();
  list.emit('wheel', { deltaY: -100 });
  follow.jumpToBottom();
  list.emit('scroll');
  assert.equal(follow.followBottom, true, 'jump-to-latest cancels previous navigation intent');
  list.clientHeight = 600;
  list.scrollTop = list.scrollTop; // Browser clamps the offset after growth.
  list.emit('scroll');
  assert.equal(follow.followBottom, true, 'resize clamping is not user navigation');

  list.scrollHeight = 300;
  list.clientHeight = 500;
  list.scrollTop = 0;
  follow.jumpToBottom();
  list.emit('wheel', { deltaY: -100 });
  list.emit('keydown', { key: 'Home' });
  assert.equal(follow.followBottom, true, 'navigation that cannot move a short transcript does not detach');

  follow.destroy();
  assert.equal([...list.handlers.values()].reduce((n, set) => n + set.size, 0), 0);
  assert.equal([...window.handlers.values()].reduce((n, set) => n + set.size, 0), 0);
  console.log('Scroll-follow tests passed');
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
