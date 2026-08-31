/**
 * The tab strip and the panes behind it.
 *
 * Open tabs are the workspace: each one holds a live socket, so several
 * sessions stream at once and the tab strip doubles as an at-a-glance status
 * display. The set of open tabs is persisted, so a reload restores what you
 * were watching.
 */

import { SessionPane } from './pane.js';
import { storedIds } from './ids.js';

const OPEN_TABS_KEY = 'agent-ui.open-tabs';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class Workspace {
  /**
   * @param {{strip: HTMLElement, panes: HTMLElement, empty: HTMLElement}} dom
   * @param {import('./store.js').Store} store
   * @param {object} handlers
   */
  constructor(dom, store, handlers) {
    this.dom = dom;
    this.store = store;
    this.handlers = handlers;
    /** @type {Map<string, {tab: HTMLElement, pane: SessionPane, unsubscribe: Function}>} */
    this.open = new Map();
    this.activeId = null;
  }

  isOpen(id) {
    return this.open.has(id);
  }

  ids() {
    return [...this.open.keys()];
  }

  /** Open a session in a tab (or focus it if already open). */
  openSession(id) {
    if (this.open.has(id)) {
      this.activate(id);
      return;
    }

    const pane = new SessionPane(id, this.store, {
      onSettings: this.handlers.onSettings,
      onStop: this.handlers.onStop,
      onError: this.handlers.onError,
      onLiveEvent: this.handlers.onLiveEvent,
    });
    this.dom.panes.appendChild(pane.root);

    const tab = el('button', 'tab');
    const dot = el('span', 'dot');
    const label = el('span', 'tname');
    const close = el('span', 'close', '×');
    tab.append(dot, label, close);

    tab.addEventListener('click', (event) => {
      if (event.target === close) {
        event.stopPropagation();
        this.closeSession(id);
        return;
      }
      this.activate(id);
    });
    // Middle click closes, as everywhere else that has tabs.
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        this.closeSession(id);
      }
    });

    this.dom.strip.appendChild(tab);

    const entry = { tab, pane, dot, label, unsubscribe: null };
    entry.unsubscribe = this.store.subscribe(id, (changes) => {
      if (changes.some((c) => c.op === 'meta' || c.op === 'reset')) this.refreshTab(id);
    });
    this.open.set(id, entry);

    this.refreshTab(id);
    this.activate(id);
    this.persist();
  }

  closeSession(id) {
    const entry = this.open.get(id);
    if (!entry) return;
    entry.unsubscribe();
    entry.pane.destroy();
    entry.tab.remove();
    this.open.delete(id);

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.open.keys().next();
      if (!next.done) this.activate(next.value);
      else this.updateEmptyState();
    }
    this.persist();
    this.handlers.onActiveChange?.(this.activeId);
  }

  activate(id) {
    if (!this.open.has(id)) return;
    this.activeId = id;
    for (const [otherId, entry] of this.open) {
      const active = otherId === id;
      entry.tab.classList.toggle('active', active);
      entry.pane.root.classList.toggle('active', active);
    }
    this.updateEmptyState();
    this.open.get(id).pane.focusComposer();
    this.handlers.onActiveChange?.(id);
  }

  refreshTab(id) {
    const entry = this.open.get(id);
    if (!entry) return;
    const state = this.store.session(id);
    // The fallback is the whole id: it is a small integer, and truncating one
    // was a habit from when ids were uuids.
    entry.label.textContent = state.name || String(id);
    entry.tab.title = state.workingDir || '';
    entry.dot.className = `dot ${state.connected ? state.status : ''}`;
  }

  updateEmptyState() {
    this.dom.empty.style.display = this.open.size ? 'none' : '';
  }

  /** Sessions that vanished server-side must not keep a tab open. */
  pruneMissing(knownIds) {
    for (const id of [...this.open.keys()]) {
      if (!knownIds.has(id)) this.closeSession(id);
    }
  }

  persist() {
    try {
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(this.ids()));
    } catch {
      /* private mode or a full quota — tabs just won't be restored */
    }
  }

  /** Tab ids as they were persisted, in the string form the client works in. */
  static restoreIds() {
    try {
      const raw = localStorage.getItem(OPEN_TABS_KEY);
      return storedIds(raw ? JSON.parse(raw) : []);
    } catch {
      return [];
    }
  }
}
