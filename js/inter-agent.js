/**
 * Inter-agent messaging: who sent an input, and what the client knows about
 * the sessions such messages and tools refer to. **No DOM in this file.**
 *
 * The shared design, which the Android client follows too, is in
 * docs/inter-agent-ui.md.
 */

import { isArchived } from './archive.js';

/**
 * The sender of an `input` event, or null when the user typed it.
 *
 * Only a missing `source` means an older, user-originated record. Anything the
 * client cannot read as user or agent is an unknown source rather than the
 * user's own words — `null`, a string id, `0` and the like included.
 *
 * @returns {null | {type: 'agent', sessionId: string} | {type: 'unknown'}}
 */
export function inputSource(event) {
  if (!Object.hasOwn(event ?? {}, 'source')) return null;
  const source = event.source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    if (source.type === 'user') return null;
    const id = source.session_id;
    if (source.type === 'agent' && Number.isInteger(id) && id > 0) {
      return { type: 'agent', sessionId: String(id) };
    }
  }
  return { type: 'unknown' };
}

/**
 * Every session the server knows, across all projects, for resolving the ids
 * in agent messages and session-tool cards.
 *
 * Until the first list arrives nothing can be called missing: scrollback is
 * usually replayed before `GET /sessions` answers, and every sender would
 * otherwise flash "unavailable" on the way in.
 */
export class SessionDirectory {
  constructor() {
    this.loaded = false;
    /** @type {Map<string, {id: string, name: string, archived: boolean}>} */
    this.sessions = new Map();
    this.signature = '';
    this.listeners = new Set();
  }

  /** Take a fresh `GET /sessions` list. Listeners hear only about changes. */
  setSessions(rows) {
    const entries = rows.map((row) => ({
      id: String(row.id),
      name: row.name || '',
      archived: isArchived(row),
    }));
    const signature = JSON.stringify(entries.map((s) => [s.id, s.name, s.archived]));
    this.sessions = new Map(entries.map((entry) => [entry.id, entry]));
    if (this.loaded && signature === this.signature) return;
    this.loaded = true;
    this.signature = signature;
    for (const fn of this.listeners) fn();
  }

  /** @returns {{state: 'pending'} | {state: 'missing'} | {state: 'found', session: object}} */
  lookup(id) {
    if (!this.loaded) return { state: 'pending' };
    const session = this.sessions.get(String(id));
    return session ? { state: 'found', session } : { state: 'missing' };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * A session named in plain text. `role` picks the wording once the list has
 * loaded and the id is not in it: a sender may simply have been deleted since,
 * while a tool's target that does not exist is worth flagging before approval.
 */
export function sessionText(directory, id, role = 'target') {
  const found = directory?.lookup(id) ?? { state: 'pending' };
  if (found.state === 'found') return `${found.session.name || 'session'} #${id}`;
  if (found.state === 'missing') {
    return role === 'sender' ? `session #${id} (unavailable)` : `#${id} (unknown session)`;
  }
  return `#${id}`;
}

/** "api refactor (#42)", the sender as the Markdown export names it. */
export function senderText(from, directory) {
  if (from?.type !== 'agent') return 'unknown source';
  const found = directory?.lookup(from.sessionId) ?? { state: 'pending' };
  if (found.state === 'found') return `${found.session.name || 'session'} (#${from.sessionId})`;
  if (found.state === 'missing') return `session #${from.sessionId} (unavailable)`;
  return `session #${from.sessionId}`;
}
