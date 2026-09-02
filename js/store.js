/**
 * Session state and the transcript reducer. **No DOM in this file.**
 *
 * This is the part of the client that is actually load-bearing logic rather
 * than presentation: turning the server's flat stream of tagged events into a
 * list of transcript rows, with all the fiddly rules the Android client keeps
 * tangled up in view code (SessionActivity.handleMessage) —
 *
 *   - consecutive `output` chunks coalesce into one agent message
 *   - an `approval_request` swallows the `tool_use` card it duplicates
 *   - approvals and questions resolve in place when their response arrives
 *   - a `bash_output` fills in the card its `bash_input` opened
 *   - anything that isn't `output` closes the open agent message
 *
 * Keeping it DOM-free means it can be exercised headlessly (see test/), and it
 * gives the renderer a single job: mirror rows into elements.
 */

import { toolSummary } from './tools.js';

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
    // The worktree this session is attached to, or null when it runs in the
    // project directory. Not ownership: the worktree is its own resource, may
    // be shared with other sessions, and outlives this one.
    worktreeId: null,
    agent: 'claude-code',
    status: 'idle',
    // When the server filed this session away, or null while it is live.
    // Server state like `status`, and arriving the same way: on connect, and
    // again whenever any device changes it.
    archivedAt: null,
    autoApproveWrite: false,
    autoApproveCommand: false,
    connected: false,
    rows: [],
    nextKey: 1,
    // The agent message currently accepting chunks, or null.
    openBubble: null,
    // The most recent tool_use row, still eligible to be replaced by a matching
    // approval_request. Cleared by anything that ends the tool's moment.
    lastTool: null,
    pendingApprovalId: null,
    pendingQuestionId: null,
  };
}

export class Store {
  constructor() {
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
    this.emit(id, [{ op: 'meta' }]);
  }

  setConnected(id, connected) {
    const state = this.session(id);
    if (state.connected === connected) return;
    state.connected = connected;
    this.emit(id, [{ op: 'meta' }]);
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
      worktreeId: live.worktreeId,
      agent: live.agent,
      status: live.status,
      archivedAt: live.archivedAt,
      autoApproveWrite: live.autoApproveWrite,
      autoApproveCommand: live.autoApproveCommand,
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

function append(state, row, changes) {
  newRow(state, row);
  state.rows.push(row);
  changes.push({ op: 'append', row });
  // Trim from the front once past the cap, so a very long session cannot grow
  // the transcript without bound.
  while (state.rows.length > MAX_ROWS) {
    const dropped = state.rows.shift();
    if (state.openBubble === dropped) state.openBubble = null;
    if (state.lastTool === dropped) state.lastTool = null;
    changes.push({ op: 'remove', row: dropped });
  }
  return row;
}

function findRow(state, predicate) {
  for (let i = state.rows.length - 1; i >= 0; i--) {
    if (predicate(state.rows[i])) return state.rows[i];
  }
  return null;
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
      if (typeof event.auto_approve_write === 'boolean') {
        state.autoApproveWrite = event.auto_approve_write;
      }
      if (typeof event.auto_approve_command === 'boolean') {
        state.autoApproveCommand = event.auto_approve_command;
      }
      changes.push({ op: 'meta' });
      break;

    case 'renamed':
      if (event.name) state.name = event.name;
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

    case 'input':
      state.openBubble = null;
      state.lastTool = null;
      append(state, { kind: 'user', text: event.text ?? '' }, changes);
      break;

    case 'output': {
      state.lastTool = null;
      const text = event.text ?? '';
      if (state.openBubble) {
        state.openBubble.text += text;
        changes.push({ op: 'update', row: state.openBubble });
      } else {
        state.openBubble = append(state, { kind: 'agent', text }, changes);
      }
      break;
    }

    case 'tool_use':
      state.openBubble = null;
      state.lastTool = append(state, {
        kind: 'tool',
        tool: event.tool || 'tool',
        input: event.input ?? {},
      }, changes);
      break;

    case 'approval_request': {
      state.openBubble = null;
      const tool = event.tool || 'tool';
      const input = event.input ?? {};
      // This approval is for the tool_use we just rendered: drop that row so
      // the command or edit isn't shown twice — the approval card replaces it.
      const previous = state.lastTool;
      if (previous
          && previous.tool === tool
          && toolSummary(tool, input) === toolSummary(previous.tool, previous.input)) {
        const index = state.rows.indexOf(previous);
        if (index >= 0) {
          state.rows.splice(index, 1);
          changes.push({ op: 'remove', row: previous });
        }
      }
      state.lastTool = null;

      const auto = event.auto_approved === true;
      const row = append(state, {
        kind: 'approval',
        id: event.request_id ?? '',
        tool,
        input,
        category: event.category ?? '',
        auto,
        options: Array.isArray(event.options) ? event.options : null,
        // An auto-approved request never blocks, so it is born resolved.
        resolved: auto ? { behavior: 'allow', auto: true, message: null } : null,
      }, changes);
      if (!auto) state.pendingApprovalId = row.id;
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
      state.lastTool = null;
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
        state.lastTool = null;
        append(state, { kind: 'bash', command, result }, changes);
      }
      break;
    }

    case 'done':
      state.openBubble = null;
      state.lastTool = null;
      break;

    case 'error':
      state.openBubble = null;
      state.lastTool = null;
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
 */
export function rowText(row) {
  switch (row.kind) {
    case 'user':
    case 'agent':
      return row.text;
    case 'tool':
      return `${row.tool} ${toolSummary(row.tool, row.input)}`;
    case 'approval':
      return `${row.tool} ${toolSummary(row.tool, row.input)} ${row.resolved?.message ?? ''}`;
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
export function toMarkdown(state) {
  const parts = [`# ${state.name || 'Session'}`, ''];
  if (state.workingDir) {
    const where = state.worktreeId ? `\`${state.workingDir}\` (worktree)` : `\`${state.workingDir}\``;
    parts.push(`${where} · ${state.agent}`, '');
  }

  for (const row of state.rows) {
    switch (row.kind) {
      case 'user':
        parts.push('### You', '', row.text, '');
        break;
      case 'agent':
        parts.push('### Agent', '', row.text, '');
        break;
      case 'tool':
        parts.push(`**${row.tool}** — \`${toolSummary(row.tool, row.input)}\``, '');
        parts.push('```json', JSON.stringify(row.input, null, 2), '```', '');
        break;
      case 'approval': {
        const verdict = !row.resolved
          ? 'pending'
          : row.resolved.behavior === 'allow'
            ? (row.resolved.auto ? 'auto-approved' : 'allowed')
            : row.resolved.behavior === 'deny' ? 'denied' : 'unresolved';
        parts.push(`**Approval — ${row.tool}** (${verdict})`, '');
        parts.push('```json', JSON.stringify(row.input, null, 2), '```', '');
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
