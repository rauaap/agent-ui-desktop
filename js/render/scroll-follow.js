/** Keep following intent independent of incidental content/viewport changes. */
const SCROLL_INPUT_GRACE_MS = 250;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const UPWARD_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

export class ScrollFollow {
  constructor(list, onScroll = () => {}) {
    this.list = list;
    this.onScroll = onScroll;
    this.followBottom = true;
    this.lastTop = list.scrollTop;
    this.userUntil = 0;
    this.pointer = null;
    this.listeners = [];

    this.listen(list, 'wheel', this.handleWheel, { passive: true });
    this.listen(list, 'keydown', this.handleKeyDown);
    this.listen(list, 'pointerdown', this.handlePointerDown);
    this.listen(window, 'pointermove', this.handlePointerMove, { passive: true });
    this.listen(window, 'pointerup', this.handlePointerRelease);
    this.listen(window, 'pointercancel', this.handlePointerRelease);
    this.listen(list, 'scroll', this.handleScroll);
  }

  listen(target, type, handler, options) {
    const bound = handler.bind(this);
    target.addEventListener(type, bound, options);
    this.listeners.push(() => target.removeEventListener(type, bound, options));
  }

  handleWheel(event) {
    if (event.ctrlKey || event.shiftKey || !event.deltaY) return; // Zoom/horizontal scrolling.
    this.navigation(event.deltaY < 0);
  }

  handleKeyDown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, button, [contenteditable]')) return;
    if (!SCROLL_KEYS.has(event.key)) return;
    this.navigation(UPWARD_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey));
  }

  isScrollbarPointer(event) {
    const { list } = this;
    const rect = list.getBoundingClientRect();
    // A mouse drag must start on the scrollbar, not a card or its text.
    // Reserve a small edge for platforms with overlay scrollbars too.
    return event.target === list
      && (event.clientX >= rect.right - Math.max(16, list.offsetWidth - list.clientWidth)
        || event.clientX < rect.left + list.clientLeft);
  }

  handlePointerDown(event) {
    if (event.button !== 0) return;
    const onScrollbar = this.isScrollbarPointer(event);
    if (event.pointerType !== 'touch' && !onScrollbar) return;
    this.pointer = { id: event.pointerId, touch: event.pointerType === 'touch', y: event.clientY, moving: false };
    if (onScrollbar) this.navigation(false);
  }

  handlePointerMove(event) {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;
    let leavingBottom = false;
    if (this.pointer.touch) {
      const delta = event.clientY - this.pointer.y;
      if (!delta) return;
      this.pointer.y = event.clientY;
      leavingBottom = delta > 0;
    }
    this.pointer.moving = true;
    this.navigation(leavingBottom);
  }

  handlePointerRelease(event) {
    if (event.pointerId !== this.pointer?.id) return;
    // Native touch scrolling may cancel the pointer; keep accepting its
    // scroll events, including inertia, until they stop arriving.
    if (this.pointer.moving) this.navigation(false);
    this.pointer = null;
  }

  handleScroll() {
    const top = this.list.scrollTop;
    const userScrolling = performance.now() <= this.userUntil || this.pointer?.moving;
    if (top !== this.lastTop && userScrolling) {
      this.followBottom = this.isAtBottom();
      this.userUntil = performance.now() + SCROLL_INPUT_GRACE_MS;
    }
    this.lastTop = top;
    this.onScroll();
  }

  navigation(leavingBottom) {
    this.userUntil = performance.now() + SCROLL_INPUT_GRACE_MS;
    // Stop following before the native scroll runs, so a simultaneous output
    // update cannot pull an upward wheel/key/touch gesture back to the bottom.
    if (leavingBottom && this.list.scrollTop > 0) this.followBottom = false;
  }

  isAtBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight <= 1;
  }

  restore(followBottom, top) {
    this.followBottom = followBottom;
    this.list.scrollTop = followBottom ? this.list.scrollHeight : top;
    // Ignore the later scroll event from our own positioning, even if it lands
    // during an active user gesture.
    this.lastTop = this.list.scrollTop;
  }

  jumpToBottom() {
    this.userUntil = 0;
    this.restore(true, 0);
  }

  destroy() {
    for (const remove of this.listeners) remove();
    this.listeners = [];
  }
}
