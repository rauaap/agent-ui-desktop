/**
 * The one session currently shown in the workspace.
 *
 * Selection owns the only full session WebSocket. Switching sessions tears the
 * old pane and runtime state down before opening the new one; the sidebar's
 * polled catalog remains independent of this lifecycle.
 */

import { SessionPane } from './pane.js';

export class Workspace {
  /**
   * @param {{panes: HTMLElement, empty: HTMLElement}} dom
   * @param {import('./store.js').Store} store
   * @param {object} handlers
   */
  constructor(dom, store, handlers) {
    this.dom = dom;
    this.store = store;
    this.handlers = handlers;
    this.activeId = null;
    this.pane = null;
  }

  isOpen(id) {
    return this.activeId === String(id);
  }

  /** Show a session, replacing the current one if necessary. */
  openSession(id) {
    id = String(id);
    if (this.activeId === id) {
      this.pane?.focusComposer();
      return;
    }

    this.clearActive();
    this.activeId = id;
    this.pane = new SessionPane(id, this.store, {
      onSettings: this.handlers.onSettings,
      onStop: this.handlers.onStop,
      onUnarchive: this.handlers.onUnarchive,
      onError: this.handlers.onError,
      onLiveEvent: this.handlers.onLiveEvent,
    });
    this.pane.root.classList.add('active');
    this.dom.panes.appendChild(this.pane.root);
    this.updateEmptyState();
    this.pane.focusComposer();
    this.handlers.onActiveChange?.(id);
  }

  /** Focus the selected session; retained for notification activation. */
  activate(id) {
    if (this.isOpen(id)) this.pane?.focusComposer();
  }

  closeSession(id) {
    if (!this.isOpen(id)) return;
    this.clearActive();
    this.updateEmptyState();
    this.handlers.onActiveChange?.(null);
  }

  /** Close the pane if its session disappeared from the polled catalog. */
  pruneMissing(knownIds) {
    if (this.activeId && !knownIds.has(this.activeId)) this.closeSession(this.activeId);
  }

  updateEmptyState() {
    this.dom.empty.style.display = this.activeId ? 'none' : '';
  }

  clearActive() {
    if (!this.activeId) return;
    const oldId = this.activeId;
    this.activeId = null;
    this.pane?.destroy();
    this.pane = null;
    // A later selection gets a clean replay rather than appending the server's
    // scrollback to rows retained from the previous connection.
    this.store.forget(oldId);
  }
}
