/**
 * Synchronized file-tree cache and its dedicated server-only WebSocket.
 *
 * Completion queries never leave the browser. The socket only keeps this flat
 * cache current; a broken revision chain makes the whole cache stale and is
 * recovered by reconnecting for another authoritative snapshot.
 */

import { wsBase } from './api.js';
import { FileTreeCache } from './file-tree-cache.js';

const BASE_DELAY = 1000;
const MAX_DELAY = 15000;

export class FileTreeSocket {
  /** @param {(cache: FileTreeCache) => void} [onChange] */
  constructor(sessionId, onChange) {
    this.id = sessionId;
    this.onChange = onChange;
    this.cache = new FileTreeCache();
    this.socket = null;
    this.timer = null;
    this.attempt = 0;
    this.closed = false;
    // Application errors are commonly deterministic. They wait for an explicit
    // retry (leaving and re-entering Bash mode, or pressing Paths) rather than
    // spinning against the server.
    this.applicationError = false;
  }

  open(explicitRetry = false) {
    if (this.closed || this.socket) return;
    if (this.timer) {
      if (!explicitRetry) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.applicationError && !explicitRetry) return;
    if (explicitRetry) this.applicationError = false;

    this.cache.connecting();
    this.changed();
    let socket;
    try {
      socket = new WebSocket(`${wsBase}/ws/sessions/${this.id}/files`);
    } catch {
      this.cache.unavailable('File completion could not connect.');
      this.changed();
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    // Readiness begins with a validated snapshot, not merely the transport
    // handshake. A socket repeatedly rejected before that continues to back off.
    socket.onmessage = (message) => {
      // Once an application error invalidates the tree, no stale frame can
      // make it ready again while the server's close handshake is in flight.
      if (this.applicationError) return;
      let frame;
      try {
        frame = JSON.parse(message.data);
      } catch {
        this.protocolFailure(socket);
        return;
      }

      if (frame?.type === 'file_tree_error') {
        if (typeof frame.code !== 'string' || !frame.code
            || typeof frame.message !== 'string' || !frame.message) {
          this.protocolFailure(socket);
          return;
        }
        this.applicationError = true;
        this.cache.unavailable(frame.message);
        this.changed();
        return;
      }

      if (!this.cache.apply(frame)) {
        this.protocolFailure(socket);
        return;
      }
      if (frame.type === 'file_tree_snapshot') this.attempt = 0;
      this.changed();
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // Even a formerly ready cache is stale as soon as transport ordering is
      // lost. Preserve an application error's useful message, but no paths.
      if (!this.applicationError) this.cache.unavailable('File completion disconnected.');
      this.changed();
      if (!this.applicationError) this.scheduleReconnect();
    };

    socket.onerror = () => {
      // Browsers follow this with close; teardown and reconnect happen there.
    };
  }

  protocolFailure(socket) {
    if (this.socket !== socket) return;
    this.cache.unavailable('File completion lost synchronization. Reconnecting…');
    this.changed();
    socket.close(1002, 'Invalid file tree sequence');
  }

  scheduleReconnect() {
    if (this.closed || this.timer || this.applicationError) return;
    const delay = Math.min(BASE_DELAY * 2 ** this.attempt, MAX_DELAY);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  changed() {
    this.onChange?.(this.cache);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close(1000);
    }
    this.cache.unavailable();
  }
}
