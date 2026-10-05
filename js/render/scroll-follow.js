/** Keep following intent independent of incidental content/viewport changes. */
export class ScrollFollow {
  constructor(list, onScroll = () => {}) {
    this.list = list;
    this.onScroll = onScroll;
    this.followBottom = true;
    this.lastTop = list.scrollTop;
    this.userUntil = 0;
    this.pointer = null;
    this.listeners = [];

    this.listen(list, 'wheel', (event) => {
      if (event.ctrlKey || event.shiftKey || !event.deltaY) return; // Zoom/horizontal scrolling.
      this.navigation(event.deltaY < 0);
    }, { passive: true });
    this.listen(list, 'keydown', (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target.closest?.('input, textarea, select, button, [contenteditable]')) return;
      const keys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
      if (!keys.includes(event.key)) return;
      this.navigation(['ArrowUp', 'PageUp', 'Home'].includes(event.key)
        || (event.key === ' ' && event.shiftKey));
    });
    this.listen(list, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = list.getBoundingClientRect();
      // A mouse drag must start on the scrollbar, not a card or its text.
      // Reserve a small edge for platforms with overlay scrollbars too.
      const onScrollbar = event.target === list
        && (event.clientX >= rect.right - Math.max(16, list.offsetWidth - list.clientWidth)
          || event.clientX < rect.left + list.clientLeft);
      if (event.pointerType !== 'touch' && !onScrollbar) return;
      this.pointer = { id: event.pointerId, touch: event.pointerType === 'touch', y: event.clientY, moving: false };
      if (onScrollbar) this.navigation(false);
    });
    this.listen(window, 'pointermove', (event) => {
      if (!this.pointer || event.pointerId !== this.pointer.id) return;
      if (this.pointer.touch) {
        const delta = event.clientY - this.pointer.y;
        if (!delta) return;
        this.pointer.y = event.clientY;
        this.pointer.moving = true;
        this.navigation(delta > 0);
      } else {
        this.pointer.moving = true;
        this.navigation(false);
      }
    }, { passive: true });
    const release = (event) => {
      if (event.pointerId !== this.pointer?.id) return;
      // Native touch scrolling may cancel the pointer; keep accepting its
      // scroll events, including inertia, until they stop arriving.
      if (this.pointer.moving) this.navigation(false);
      this.pointer = null;
    };
    this.listen(window, 'pointerup', release);
    this.listen(window, 'pointercancel', release);
    this.listen(list, 'scroll', () => {
      const top = list.scrollTop;
      const userScrolling = performance.now() <= this.userUntil || this.pointer?.moving;
      if (top !== this.lastTop && userScrolling) {
        this.followBottom = this.isAtBottom();
        this.userUntil = performance.now() + 250;
      }
      this.lastTop = top;
      this.onScroll();
    });
  }

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  navigation(leavingBottom) {
    this.userUntil = performance.now() + 250;
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
