/**
 * Desktop notifications for sessions you aren't looking at.
 *
 * Every open tab holds a socket, so this watches all of them at once — no
 * per-session opt-in like the Android client's bell toggle and WatchService.
 * The suppression rule is the same one WatchService applies via `viewing`: stay
 * quiet for the session on screen, speak up for the rest.
 */

import { isBusy } from './store.js';

const STORAGE_KEY = 'agent-ui.notify';

export class Notifier {
  constructor(store) {
    this.store = store;
    /** @type {Map<string, string>} last status seen per session */
    this.previous = new Map();
    /** @type {Set<string>} request ids already announced */
    this.announced = new Set();
    this.activeId = null;
    this.enabled = load();
  }

  setActive(id) {
    this.activeId = id;
  }

  /** True when the user is looking at this session right now. */
  suppressed(id) {
    return id === this.activeId && document.visibilityState === 'visible';
  }

  async requestPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  }

  async setEnabled(enabled) {
    if (enabled && !(await this.requestPermission())) return false;
    this.enabled = enabled;
    save(enabled);
    return enabled;
  }

  /**
   * Feed one session event. Fires on a turn finishing and on anything that
   * blocks waiting for the user.
   */
  observe(sessionId, event) {
    const state = this.store.session(sessionId);
    const name = state.name || 'Session';

    if (event.type === 'status') {
      const before = this.previous.get(sessionId);
      this.previous.set(sessionId, event.status);
      if (before === event.status) return;
      // busy -> idle is a completed turn.
      if (isBusy(before) && event.status === 'idle') {
        this.fire(sessionId, name, 'Task complete');
      } else if (event.status === 'awaiting_approval' && before === undefined) {
        // Connecting to a session that was already blocked before we arrived.
        this.fire(sessionId, name, 'Waiting for you');
      }
      return;
    }

    // An approval or question that the backend did not answer itself blocks the
    // agent until someone responds — the notification that actually matters.
    if (event.type === 'approval_request' && !event.auto_approved) {
      if (this.once(event.request_id)) this.fire(sessionId, name, 'Needs your approval');
    } else if (event.type === 'question') {
      if (this.once(event.request_id)) this.fire(sessionId, name, 'Needs your answer');
    }
  }

  /** Replayed scrollback repeats old requests; announce each id only once. */
  once(requestId) {
    if (!requestId || this.announced.has(requestId)) return false;
    this.announced.add(requestId);
    return true;
  }

  fire(sessionId, title, body) {
    if (!this.enabled) return;
    if (this.suppressed(sessionId)) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try {
      const notification = new Notification(title, { body, tag: `agent-ui-${sessionId}` });
      notification.addEventListener('click', () => {
        window.focus();
        this.onActivate?.(sessionId);
        notification.close();
      });
    } catch {
      // Some browsers refuse the constructor outside a service worker; a missing
      // notification is not worth breaking the stream over.
    }
  }
}

function load() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function save(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* nothing to do */
  }
}
