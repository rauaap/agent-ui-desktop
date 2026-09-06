/**
 * The selected session's WebSocket.
 *
 * The server replays the last 200 scrollback rows on connect and then sends the
 * current `status` — that trailing status is the end-of-replay marker. The
 * first connection renders its replay progressively (nothing on screen to
 * preserve), but a *re*connect buffers into a shadow state and swaps it in only
 * once complete, so a slow reconnect never blanks a transcript you are reading.
 * Ported from SessionActivity.java:90-96 and commitReplay().
 */

import { wsBase } from './api.js';
import { approvalResponsePayload } from './tools.js';

const BASE_DELAY = 1000;
const MAX_DELAY = 15000;

export class SessionSocket {
  /**
   * @param {string} id session id
   * @param {import('./store.js').Store} store
   * @param {(event: object) => void} [onLiveEvent] called for events that are
   *   not replayed scrollback — what a notifier should react to
   */
  constructor(id, store, onLiveEvent) {
    this.id = id;
    this.store = store;
    this.onLiveEvent = onLiveEvent;
    this.socket = null;
    this.attempt = 0;
    this.timer = null;
    this.closed = false;
    // False until the first event of the session's life arrives. Everything
    // after that is a reconnect and buffers its replay.
    this.everReceived = false;
    this.awaitingReplay = false;
    // Every connection starts with a scrollback replay terminated by a status
    // event. Until that arrives, what we are seeing is history, not news.
    this.replayPending = true;
  }

  open() {
    if (this.closed) return;
    this.clearTimer();

    let socket;
    try {
      socket = new WebSocket(`${wsBase}/ws/sessions/${this.id}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.replayPending = true;

    // A reconnect's replay is assembled off-screen and committed on the
    // trailing status event.
    if (this.everReceived) {
      this.awaitingReplay = true;
      this.store.beginReplay(this.id);
    }

    socket.onopen = () => {
      this.attempt = 0;
      this.store.setConnected(this.id, true);
    };

    socket.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (this.replayPending && event.type === 'status') {
        // The server sends the current status right after the replay finishes,
        // so it is the end-of-replay marker. Treat the status itself as live —
        // arriving to find a session already blocked on an approval is news.
        this.replayPending = false;
        if (this.awaitingReplay) {
          this.awaitingReplay = false;
          this.store.commitReplay(this.id);
        }
      }
      this.everReceived = true;
      this.store.apply(this.id, event);
      if (!this.replayPending) this.onLiveEvent?.(event);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.finishReplay();
      this.store.setConnected(this.id, false);
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
  }

  /** Send a prompt, starting a turn. */
  sendInput(text) {
    return this.send({ type: 'input', text });
  }

  /**
   * Run a shell command in the session's working directory, bypassing the
   * agent. Never takes the turn lock server-side, so it is deliberately not
   * gated on session status.
   */
  sendBash(command) {
    return this.send({ type: 'bash', command });
  }

  sendApproval(requestId, behavior, optionId, message) {
    return this.send(approvalResponsePayload(requestId, behavior, optionId, message));
  }

  sendAnswers(requestId, answers) {
    return this.send({ type: 'question_response', request_id: requestId, answers });
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  get connected() {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    this.clearTimer();
    this.finishReplay();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close(1000);
    }
    this.store.setConnected(this.id, false);
  }

  finishReplay() {
    if (!this.awaitingReplay) return;
    this.awaitingReplay = false;
    this.store.abortReplay(this.id);
  }

  scheduleReconnect() {
    if (this.closed || this.timer) return;
    const delay = Math.min(BASE_DELAY * 2 ** this.attempt, MAX_DELAY);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
