/**
 * Session state and the transcript reducer. **No DOM in this file.**
 *
 * This is the part of the client that is actually load-bearing logic rather
 * than presentation: turning the server's flat stream of tagged events into a
 * list of transcript rows, with all the fiddly rules the Android client keeps
 * tangled up in view code (SessionActivity.handleMessage) —
 *
 *   - consecutive `output` chunks coalesce into one agent message
 *   - an `approval_request` replaces, in place, the `tool_use` card with its
 *     call ID
 *   - approvals and questions resolve in place when their response arrives
 *   - a `bash_output` fills in the card its `bash_input` opened
 *   - an accepted `input` waits in a pending queue, outside the transcript,
 *     until `inputs_shipped` moves it in at the turn boundary
 *   - anything else that isn't `output` closes the open agent message
 *
 * Keeping it DOM-free means it can be exercised headlessly (see test/), and it
 * gives the renderer a single job: mirror rows into elements.
 */

import { inputSource, senderText, sessionText } from './inter-agent.js';
import { actionLabel, actionSummary, isCanonicalAction, prettyJson } from './tools.js';
import { isFormerWorktree } from './worktree.js';

/**
 * Live transcript cap. The server replays at most 200 rows on connect
 * (SCROLLBACK_REPLAY_LIMIT in main.py), so only a long-running live session can
 * grow past this; older rows are dropped from the top.
 */
export const MAX_ROWS = 400;

const BUSY = new Set(['running', 'awaiting_approval']);
export const isBusy = (status) => BUSY.has(status);

/**
 * Decide what a line of composer text means.
 *
 * A leading `!` is the *client's* syntax for bash mode — the server never
 * inspects prompt text, it only honours a `bash` message — so `\!` is how you
 * send a prompt that genuinely starts with an exclamation mark. The escape is
 * positional: first character only, and only in front of a `!`.
 *
 * A bare `!` comes back as a bash intent with an empty command, so the composer
 * can flip to command styling the moment the key is pressed; the caller decides
 * that there is nothing to run yet.
 *
 * @returns {{kind: 'bash', command: string} | {kind: 'input', text: string} | null}
 */
export function parseComposerInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('!')) return { kind: 'bash', command: text.slice(1).trim() };
  if (text.startsWith('\\!')) return { kind: 'input', text: text.slice(1) };
  return { kind: 'input', text };
}

/**
 * Why composer input cannot be sent right now, or null when it can. Being busy
 * is never a reason: the server queues a prompt for the next turn, and Bash
 * does not take the turn at all. Connectivity is the socket's to report.
 *
 * @param {{kind: 'bash' | 'input'}} parsed from parseComposerInput
 */
export function sendRefusal(state, parsed) {
  // The box is disabled while archived, so this is for the race: the event
  // that archived the session — from another device, or from a project
  // archive — can land between the keystroke and the send. Prompts *and*
  // commands are refused; bash is outside the turn, not outside this.
  if (state.archivedAt) return 'This session is archived — unarchive it to send anything';
  if (parsed.kind !== 'bash' && state.sandboxSaving) {
    return 'Wait for the sandbox setting to finish saving before starting a turn';
  }
  return null;
}

/** One-line summary of a finished command: how it ended, how long it took. */
export function bashStatus(result) {
  if (!result) return 'running…';
  const bits = [result.exitCode === null ? 'did not start' : `exit ${result.exitCode}`];
  if (typeof result.durationMs === 'number') {
    bits.push(result.durationMs < 1000
      ? `${result.durationMs} ms`
      : `${(result.durationMs / 1000).toFixed(1)} s`);
  }
  if (result.timedOut) bits.push('timed out');
  if (result.truncated) bits.push('output truncated');
  return bits.join(' · ');
}

/** stdout and stderr as one blob, which is what a copy button should hand over. */
export function bashOutputText(result) {
  const out = result?.stdout || '';
  const err = result?.stderr || '';
  if (!out) return err;
  if (!err) return out;
  return out.endsWith('\n') ? out + err : `${out}\n${err}`;
}

function blankState(id) {
  return {
    id,
    name: '',
    workingDir: '',
    projectId: null,
    projectPath: '',
    // The worktree this session is attached to. Null normally means the
    // project directory, but a detached session keeps its former worktree path
    // in `workingDir`; compare that with `projectPath` to tell the two apart.
    worktreeId: null,
    agent: 'Agent',
    // The model chosen at creation, or null for the agent's default. Fixed for
    // the session's lifetime.
    model: null,
    // The reasoning level, or null while the harness picks its own default.
    // Changeable between turns; arrives as `reasoning_level` events.
    reasoningLevel: null,
    status: 'idle',
    // When the server filed this session away, or null while it is live.
    // Server state like `status`, and arriving the same way: on connect, and
    // again whenever any device changes it.
    archivedAt: null,
    autoApproveWrite: false,
    autoApproveCommand: false,
    autoApproveInterAgent: false,
    sandbox: null, // Missing on older servers means unknown, not enabled.
    sandboxSaving: false,
    settingsLoaded: false,
    sessionReady: false,
    connectionEpoch: 0,
    connected: false,
    rows: [],
    nextKey: 1,
    // The agent message currently accepting chunks, or null.
    openBubble: null,
    pendingApprovalId: null,
    pendingQuestionId: null,
    // Inputs the server accepted but has not shipped to a turn yet, in
    // acceptance order. Rows shaped like a user transcript row plus
    // `messageId`, but never in `rows` and never keyed for the transcript.
    queue: [],
    // Message IDs seen accepted or shipped in this state. Shipping must not
    // re-record history for an acceptance already seen, nor append twice.
    acceptedIds: new Set(),
    shippedIds: new Set(),
  };
}

export class Store {
  constructor() {
    // Unique even if a pane is forgotten and the same session is reopened.
    this.connectionEpoch = 0;
    /** @type {Map<string, object>} */
    this.states = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** Shadow states used while buffering a reconnect's replay. */
    this.replays = new Map();
  }

  /** The live state for a session, created empty on first use. */
  session(id) {
    let state = this.states.get(id);
    if (!state) {
      state = blankState(id);
      this.states.set(id, state);
    }
    return state;
  }

  has(id) {
    return this.states.has(id);
  }

  forget(id) {
    this.states.delete(id);
    this.replays.delete(id);
    this.listeners.delete(id);
  }

  subscribe(id, fn) {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(id, changes) {
    if (!changes.length) return;
    const set = this.listeners.get(id);
    if (!set) return;
    for (const fn of set) fn(changes, this.session(id));
  }

  /** Merge server-supplied session metadata (from REST) into the state. */
  setMeta(id, meta) {
    const state = this.session(id);
    Object.assign(state, meta);
    // A reconnect shadow began as a snapshot of the visible state. If REST
    // supplies authoritative location metadata while replay is in flight, copy
    // it there too or commitReplay would resurrect the stale worktree link.
    const replaying = this.replays.get(id);
    if (replaying) Object.assign(replaying, meta);
    this.emit(id, [{ op: 'meta' }]);
  }

  setConnected(id, connected) {
    const state = this.session(id);
    if (state.connected === connected) return;
    this.setMeta(id, {
      connected,
      settingsLoaded: false,
      sessionReady: false,
      connectionEpoch: ++this.connectionEpoch,
    });
  }

  /* ---------------------------------------------------------------- */
  /* replay buffering                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Start buffering into a shadow state. Used on *re*connect only: the first
   * connection renders its replay progressively because there is nothing on
   * screen worth preserving, but a reconnect must not blank a transcript the
   * user is reading while a slow replay trickles in.
   */
  beginReplay(id) {
    const live = this.session(id);
    const shadow = blankState(id);
    // Carry metadata across so the shadow's own `settings`/`renamed` events
    // apply on top of what we already know.
    Object.assign(shadow, {
      name: live.name,
      workingDir: live.workingDir,
      projectId: live.projectId,
      projectPath: live.projectPath,
      worktreeId: live.worktreeId,
      agent: live.agent,
      model: live.model,
      reasoningLevel: live.reasoningLevel,
      status: live.status,
      archivedAt: live.archivedAt,
      autoApproveWrite: live.autoApproveWrite,
      autoApproveCommand: live.autoApproveCommand,
      autoApproveInterAgent: live.autoApproveInterAgent,
      sandbox: live.sandbox,
      sandboxSaving: live.sandboxSaving,
      settingsLoaded: live.settingsLoaded,
      sessionReady: live.sessionReady,
      connectionEpoch: live.connectionEpoch,
      nextKey: live.nextKey,
    });
    this.replays.set(id, shadow);
  }

  isReplaying(id) {
    return this.replays.has(id);
  }

  /** Swap a completed replay in for the visible transcript, in one shot. */
  commitReplay(id) {
    const shadow = this.replays.get(id);
    if (!shadow) return;
    // `connected` is the one field set outside the event stream — the socket
    // opened while this replay was being assembled — so read it at commit time.
    // Snapshotting it in beginReplay would swap the live `true` back to the
    // `false` from the moment the connection dropped, leaving a reconnected
    // session displayed as offline forever.
    shadow.connected = this.session(id).connected;
    this.replays.delete(id);
    this.states.set(id, shadow);
    this.emit(id, [{ op: 'reset' }]);
  }

  /** Drop a partial replay — the socket died before it finished. */
  abortReplay(id) {
    this.replays.delete(id);
  }

  /* ---------------------------------------------------------------- */
  /* the reducer                                                      */
  /* ---------------------------------------------------------------- */

  /** Apply one server event, notifying subscribers of what changed. */
  apply(id, event) {
    // Settings and reasoning levels are never replayed history. Apply
    // immediately to both copies so a dropped replay cannot lose a live update.
    if (event.type === 'settings' || event.type === 'reasoning_level') {
      const changes = reduce(this.session(id), event);
      const shadow = this.replays.get(id);
      if (shadow) reduce(shadow, event);
      this.emit(id, changes);
      return;
    }
    const replaying = this.replays.get(id);
    const state = replaying ?? this.session(id);
    const changes = reduce(state, event);
    // A buffered replay is invisible until it commits, so nothing to emit.
    if (!replaying) this.emit(id, changes);
  }
}

function newRow(state, row) {
  row.key = state.nextKey++;
  return row;
}

/** `extra` annotates the change itself, e.g. `history: false` for the pane. */
function append(state, row, changes, extra = null) {
  newRow(state, row);
  state.rows.push(row);
  changes.push({ op: 'append', row, ...extra });
  // Trim from the front once past the cap, so a very long session cannot grow
  // the transcript without bound.
  while (state.rows.length > MAX_ROWS) {
    const dropped = state.rows.shift();
    if (state.openBubble === dropped) state.openBubble = null;
    changes.push({ op: 'remove', row: dropped });
  }
  return row;
}

function queuedItem(messageId, message) {
  return { kind: 'user', messageId, text: message.text ?? '', from: inputSource(message), images: message.images ?? [] };
}

function findRow(state, predicate) {
  for (let i = state.rows.length - 1; i >= 0; i--) {
    if (predicate(state.rows[i])) return state.rows[i];
  }
  return null;
}

const APPROVAL_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
const exactEventKeys = (event, required, optional = []) => {
  const keys = Object.keys(event);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};

function validApprovalRequest(event) {
  return exactEventKeys(event, ['type', 'request_id', 'call_id', 'action', 'options'], ['auto_approved'])
    && typeof event.request_id === 'string' && event.request_id.length > 0
    && typeof event.call_id === 'string' && event.call_id.length > 0
    && isCanonicalAction(event.action)
    && Array.isArray(event.options)
    && event.options.every((option) => option && typeof option === 'object'
      && !Array.isArray(option)
      && Object.keys(option).every((key) => ['id', 'name', 'kind'].includes(key))
      && typeof option.id === 'string' && option.id.length > 0
      && typeof option.name === 'string' && option.name.length > 0
      && APPROVAL_KINDS.has(option.kind))
    && (event.auto_approved === undefined || event.auto_approved === true);
}

/**
 * The reducer proper: mutate `state` for one event and return the list of
 * changes a view needs to apply. Exported for tests.
 */
export function reduce(state, event) {
  const changes = [];
  const type = event?.type;

  switch (type) {
    case 'status': {
      state.status = event.status || 'idle';
      // Leaving a blocked state without an explicit response (a stop, or the
      // process dying) strands the pending cards; close them out so they don't
      // sit there offering buttons that no longer do anything.
      if (state.status !== 'awaiting_approval') {
        if (state.pendingApprovalId) {
          resolveApproval(state, state.pendingApprovalId, null, null, changes);
        }
        if (state.pendingQuestionId) {
          resolveQuestion(state, state.pendingQuestionId, null, changes);
        }
      }
      changes.push({ op: 'meta' });
      break;
    }

    case 'settings':
      if (typeof event.sandbox === 'boolean') state.sandbox = event.sandbox;
      if (typeof event.auto_approve_write === 'boolean') {
        state.autoApproveWrite = event.auto_approve_write;
      }
      if (typeof event.auto_approve_command === 'boolean') {
        state.autoApproveCommand = event.auto_approve_command;
      }
      if (typeof event.auto_approve_inter_agent_communication === 'boolean') {
        state.autoApproveInterAgent = event.auto_approve_inter_agent_communication;
      }
      changes.push({ op: 'meta' });
      break;

    case 'renamed':
      if (event.name) state.name = event.name;
      changes.push({ op: 'meta' });
      break;

    case 'reasoning_level':
      state.reasoningLevel = event.reasoning_level;
      changes.push({ op: 'meta' });
      break;

    // Filed away, or brought back — by this client, by another device, or by a
    // project archive that swept this session up. Sent on connect too, right
    // after the status event, so it is authoritative rather than a delta: no
    // toggling, just take what it says.
    case 'archived':
      state.archivedAt = event.archived_at ?? null;
      changes.push({ op: 'meta' });
      break;

    // Detachment changes only the database association: the harness remains at
    // the same absolute path. Unlike `archived`, this is not replayed when a
    // socket connects, so REST metadata also refreshes these fields.
    case 'worktree_detached':
      state.worktreeId = event.worktree_id ?? null;
      if (event.working_dir) state.workingDir = event.working_dir;
      changes.push({ op: 'meta' });
      break;

    case 'input': {
      if (event.delivery !== 'queued') {
        // A historical record from before the queue: it was delivered when it
        // was sent, so it is a transcript row where it stands. Replays give
        // these a `message_id` too, which is why `delivery` decides.
        state.openBubble = null;
        // `from` is null for the user's own words, including older records that
        // predate provenance; see docs/inter-agent-ui.md.
        append(state, { kind: 'user', text: event.text ?? '', from: inputSource(event), images: event.images ?? [] }, changes);
        break;
      }
      // Accepted, not delivered: it waits outside the transcript, and must not
      // close the agent message that may be streaming right now.
      const messageId = event.message_id;
      if (state.acceptedIds.has(messageId) || state.shippedIds.has(messageId)) break;
      const item = queuedItem(messageId, event);
      state.acceptedIds.add(messageId);
      state.queue.push(item);
      changes.push({ op: 'accepted', item }, { op: 'queue' });
      break;
    }

    // The authoritative pending list, sent on every connection after the
    // replay. It replaces rather than merges: entries that shipped or vanished
    // while we were away must go, and acceptances older than the replay window
    // appear here only.
    case 'input_queue': {
      const items = (Array.isArray(event.messages) ? event.messages : [])
        .filter((m) => m && Number.isInteger(m.message_id) && !state.shippedIds.has(m.message_id))
        .map((m) => queuedItem(m.message_id, m));
      for (const item of items) {
        if (state.acceptedIds.has(item.messageId)) continue;
        state.acceptedIds.add(item.messageId);
        changes.push({ op: 'accepted', item });
      }
      state.queue = items;
      changes.push({ op: 'queue' });
      break;
    }

    // The turn boundary: these messages are what the next turn was handed, so
    // this, not their acceptance, is where they enter the conversation.
    case 'inputs_shipped': {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const shipped = new Set();
      for (const message of messages) {
        const messageId = message?.message_id;
        if (!Number.isInteger(messageId) || state.shippedIds.has(messageId)) continue;
        state.openBubble = null;
        state.shippedIds.add(messageId);
        shipped.add(messageId);
        // History was recorded at acceptance; record it here only when that
        // acceptance was never seen (it fell outside the replay window).
        const history = !state.acceptedIds.has(messageId);
        state.acceptedIds.add(messageId);
        append(state, queuedItem(messageId, message), changes, { history });
      }
      if (shipped.size) {
        state.queue = state.queue.filter((item) => !shipped.has(item.messageId));
        changes.push({ op: 'queue' });
      }
      break;
    }

    case 'output': {
      const text = event.text ?? '';
      if (state.openBubble) {
        state.openBubble.text += text;
        changes.push({ op: 'update', row: state.openBubble });
      } else {
        state.openBubble = append(state, { kind: 'agent', text }, changes);
      }
      break;
    }

    case 'tool_use': {
      state.openBubble = null;
      const canonical = exactEventKeys(event, ['type', 'call_id', 'action'])
        && typeof event.call_id === 'string' && event.call_id.length > 0
        && isCanonicalAction(event.action);
      append(state, {
        kind: 'tool',
        callId: canonical ? event.call_id : null,
        action: canonical ? event.action : null,
        rawEvent: canonical ? null : event,
        legacy: !Object.hasOwn(event, 'action'),
      }, changes);
      break;
    }

    case 'approval_request': {
      state.openBubble = null;
      const canonical = validApprovalRequest(event);
      const auto = canonical && event.auto_approved === true;
      const row = {
        kind: 'approval',
        id: canonical ? event.request_id : '',
        callId: canonical ? event.call_id : null,
        action: canonical ? event.action : null,
        rawEvent: canonical ? null : event,
        legacy: !Object.hasOwn(event, 'action'),
        auto,
        options: canonical ? event.options : [],
        // An auto-approved request never blocks, so it is born resolved.
        resolved: auto ? { behavior: 'allow', auto: true, message: null } : null,
      };
      // Only invocation identity can replace a call card, and a call ID names
      // one invocation, so a match anywhere is the right card — parallel calls
      // put several tool cards ahead of their approvals. The approval takes the
      // card's key and slot, so the view swaps it in place. It repeats the
      // action, so rendering never depends on the replaced row.
      const index = canonical
        ? state.rows.findLastIndex((r) => r.kind === 'tool'
          && r.callId !== null && r.callId === event.call_id)
        : -1;
      if (index >= 0) {
        row.key = state.rows[index].key;
        state.rows[index] = row;
        changes.push({ op: 'update', row });
      } else {
        append(state, row, changes);
      }
      // Legacy and malformed approvals are display-only.
      if (canonical && !auto) state.pendingApprovalId = row.id;
      break;
    }

    case 'approval_response':
      resolveApproval(
        state,
        event.request_id ?? '',
        event.behavior ?? null,
        event.message ?? null,
        changes,
        event.auto === true,
      );
      break;

    case 'question': {
      state.openBubble = null;
      const row = append(state, {
        kind: 'question',
        id: event.request_id ?? '',
        questions: Array.isArray(event.questions) ? event.questions : [],
        resolved: null,
      }, changes);
      state.pendingQuestionId = row.id;
      break;
    }

    case 'question_response':
      resolveQuestion(state, event.request_id ?? '', event.answers ?? null, changes);
      break;

    // Bash mode: the echo opens a card, the result fills it in. The two are one
    // row rather than two because a command runs alongside the agent — its
    // output can arrive several messages after the command that asked for it.
    case 'bash_input':
      state.openBubble = null;
      append(state, { kind: 'bash', command: event.command ?? '', result: null }, changes);
      break;

    case 'bash_output': {
      const command = event.command ?? '';
      const result = {
        stdout: event.stdout ?? '',
        stderr: event.stderr ?? '',
        exitCode: event.exit_code ?? null,
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
        timedOut: event.timed_out === true,
        truncated: event.truncated === true,
      };
      const pending = findRow(
        state,
        (r) => r.kind === 'bash' && !r.result && r.command === command,
      );
      if (pending) {
        // An update, not an append: a command finishing mid-turn must not split
        // the agent message that is streaming below its card.
        pending.result = result;
        changes.push({ op: 'update', row: pending });
      } else {
        // No echo to fill in — a replay that began past it, or a command
        // another client started before we connected. The card stands alone.
        state.openBubble = null;
        append(state, { kind: 'bash', command, result }, changes);
      }
      break;
    }

    case 'done':
      state.openBubble = null;
      break;

    case 'error':
      state.openBubble = null;
      append(state, { kind: 'error', message: event.message || 'Unknown error' }, changes);
      break;

    default:
      break;
  }

  return changes;
}

/**
 * Close out an approval card. A null `behavior` means it stopped being pending
 * without an answer (the turn ended, the session was stopped) — rendered as a
 * neutral "no longer pending" rather than a verdict.
 */
function resolveApproval(state, requestId, behavior, message, changes, auto = false) {
  if (state.pendingApprovalId === requestId) state.pendingApprovalId = null;
  const row = findRow(state, (r) => r.kind === 'approval' && r.id === requestId && !r.resolved);
  if (!row) return;
  row.resolved = { behavior, message, auto };
  changes.push({ op: 'update', row });
}

function resolveQuestion(state, requestId, answers, changes) {
  if (state.pendingQuestionId === requestId) state.pendingQuestionId = null;
  const row = findRow(state, (r) => r.kind === 'question' && r.id === requestId && !r.resolved);
  if (!row) return;
  row.resolved = { answers };
  changes.push({ op: 'update', row });
}

/* ------------------------------------------------------------------ */
/* projections over the row model                                     */
/* ------------------------------------------------------------------ */

/**
 * Flatten a row to searchable text. Search runs over this rather than over the
 * DOM so it still matches rows the transcript cap has evicted from the page.
 * `directory` (a SessionDirectory) lets session names match too.
 */
export function rowText(row, directory = null) {
  const nameSession = (id) => sessionText(directory, id);
  switch (row.kind) {
    case 'user':
      return row.from ? `${senderText(row.from, directory)} ${row.text}` : row.text;
    case 'agent':
      return row.text;
    case 'tool':
      return row.action
        ? `${actionLabel(row.action)} ${actionSummary(row.action, nameSession)} ${prettyJson(row.action)}`
        : prettyJson(row.rawEvent);
    case 'approval':
      return row.action
        ? `${actionLabel(row.action)} ${actionSummary(row.action, nameSession)} ${prettyJson(row.action)} ${row.resolved?.message ?? ''}`
        : prettyJson(row.rawEvent);
    case 'question':
      return row.questions.map((q) => {
        const options = (q.options || []).map((o) => o.label).join(' ');
        return `${q.question ?? ''} ${options}`;
      }).join(' ');
    case 'bash':
      return `${row.command} ${bashOutputText(row.result)}`;
    case 'error':
      return row.message;
    default:
      return '';
  }
}

/** Serialize a session's transcript to markdown, for export. */
export function toMarkdown(state, directory = null) {
  const nameSession = (id) => sessionText(directory, id);
  const parts = [`# ${state.name || 'Session'}`, ''];
  if (state.workingDir) {
    const kind = state.worktreeId
      ? ' (worktree)'
      : isFormerWorktree(state) ? ' (former worktree)' : '';
    const model = state.model ? ` · ${state.model}` : '';
    parts.push(`\`${state.workingDir}\`${kind} · ${state.agent}${model}`, '');
  }

  for (const row of state.rows) {
    switch (row.kind) {
      case 'user':
        parts.push(row.from ? `### From ${senderText(row.from, directory)}` : '### You', '', row.text, '');
        break;
      case 'agent':
        parts.push('### Agent', '', row.text, '');
        break;
      case 'tool':
        if (row.action) {
          parts.push(`**${actionLabel(row.action)}** — \`${actionSummary(row.action, nameSession)}\``, '');
          parts.push('```json', JSON.stringify(row.action, null, 2), '```', '');
        } else {
          parts.push(row.legacy ? '**Legacy event from an older server version**' : '**Malformed tool event**', '');
          parts.push('```json', JSON.stringify(row.rawEvent, null, 2), '```', '');
        }
        break;
      case 'approval': {
        if (!row.action) {
          parts.push(row.legacy ? '**Legacy event from an older server version**' : '**Malformed approval event**', '');
          parts.push('```json', JSON.stringify(row.rawEvent, null, 2), '```', '');
          break;
        }
        const verdict = !row.resolved
          ? 'pending'
          : row.resolved.behavior === 'allow'
            ? (row.resolved.auto ? 'auto-approved' : 'allowed')
            : row.resolved.behavior === 'deny' ? 'denied' : 'unresolved';
        parts.push(`**Approval — ${actionLabel(row.action)}** (${verdict})`, '');
        parts.push('```json', JSON.stringify(row.action, null, 2), '```', '');
        if (row.resolved?.message) parts.push(`> ${row.resolved.message}`, '');
        break;
      }
      case 'question':
        for (const q of row.questions) {
          parts.push(`**Question — ${q.question ?? ''}**`, '');
          for (const option of q.options || []) parts.push(`- ${option.label}`);
          parts.push('');
        }
        if (row.resolved?.answers) {
          parts.push(`Answered: ${summarizeAnswers(row.resolved.answers)}`, '');
        }
        break;
      case 'bash': {
        // Marked as a shell command rather than as conversation: the agent
        // never saw any of this.
        parts.push(`**\`$ ${row.command}\`** — shell command`, '');
        if (!row.result) {
          parts.push('_running…_', '');
          break;
        }
        parts.push('```', bashOutputText(row.result) || '(no output)', '```', '');
        parts.push(`_${bashStatus(row.result)}_`, '');
        break;
      }
      case 'error':
        parts.push(`> **Error:** ${row.message}`, '');
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

/** Flatten an answers object to a human summary, e.g. "Rocket" or "A / B". */
export function summarizeAnswers(answers) {
  if (!answers || typeof answers !== 'object') return '';
  return Object.values(answers)
    .map((value) => (Array.isArray(value) ? value.join(', ') : String(value)))
    .filter(Boolean)
    .join(' / ');
}
