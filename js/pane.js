/**
 * One open session: header, transcript, composer.
 *
 * The pane owns the socket for its session — opening a tab is what starts
 * watching a session, and closing it is what stops. That replaces the Android
 * client's per-session bell opt-in with something visible in the UI by
 * construction.
 */

import { isBusy, parseComposerInput, toMarkdown } from './store.js';
import { SessionSocket } from './socket.js';
import { TranscriptView } from './render/transcript.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const STATUS_LABEL = {
  idle: 'Idle',
  running: 'Running',
  awaiting_approval: 'Needs you',
};

export class SessionPane {
  /**
   * @param {string} sessionId
   * @param {import('./store.js').Store} store
   * @param {{onSettings: Function, onError: Function}} handlers
   */
  constructor(sessionId, store, handlers) {
    this.id = sessionId;
    this.store = store;
    this.handlers = handlers;

    this.socket = new SessionSocket(sessionId, store, (event) => {
      handlers.onLiveEvent?.(sessionId, event);
    });

    this.root = el('div', 'pane');
    this.root.appendChild(this.buildHead());

    this.transcript = new TranscriptView(sessionId, store, {
      onApproval: (requestId, optionId, behavior, message) => {
        if (!this.socket.sendApproval(requestId, behavior, optionId, message)) {
          handlers.onError('Not connected — the answer was not sent');
        }
      },
      onAnswers: (requestId, answers) => {
        if (!this.socket.sendAnswers(requestId, answers)) {
          handlers.onError('Not connected — the answer was not sent');
        }
      },
    });
    this.root.appendChild(this.transcript.wrap);
    this.root.appendChild(this.buildComposer());

    // Zoom and window resizes change the composer's viewport-relative growth
    // cap, so a box sitting at the old limit has to be re-measured. Only the
    // visible pane can be: a `display: none` one has no scrollHeight to read,
    // and it is re-measured when it next becomes visible instead.
    this.onViewportChange = () => {
      if (this.root.classList.contains('active')) this.autoGrow();
    };
    window.addEventListener('resize', this.onViewportChange);

    this.unsubscribe = store.subscribe(sessionId, (changes) => {
      if (changes.some((c) => c.op === 'meta' || c.op === 'reset')) this.refresh();
    });

    this.refresh();
    this.socket.open();
  }

  buildHead() {
    const head = el('div', 'pane-head');

    const titles = el('div', 'titles');
    this.nameView = el('div', 'pane-name');
    // The cwd, tagged when it is a worktree the server made for this session
    // rather than the project's own directory — so it is obvious the session is
    // not running where its siblings are.
    this.dirView = el('div', 'pane-dir');
    this.worktreeTag = el('span', 'wt', 'WORKTREE');
    this.dirText = el('span', 'path');
    this.dirView.append(this.worktreeTag, this.dirText);
    titles.append(this.nameView, this.dirView);
    head.appendChild(titles);

    this.searchBox = el('input', 'search-box');
    this.searchBox.type = 'search';
    this.searchBox.placeholder = 'Search transcript';
    this.searchCount = el('span', 'search-count');
    this.searchBox.addEventListener('input', () => {
      const { rows, occurrences } = this.transcript.search(this.searchBox.value);
      if (!this.searchBox.value.trim()) this.searchCount.textContent = '';
      else if (!occurrences) this.searchCount.textContent = 'none';
      else this.searchCount.textContent = `${occurrences} in ${rows}`;
    });
    head.append(this.searchBox, this.searchCount);

    this.statusPill = el('span', 'pill');
    head.appendChild(this.statusPill);

    this.stopButton = el('button', 'icon-btn danger');
    this.stopButton.textContent = '■';
    this.stopButton.title = 'Stop the running turn';
    this.stopButton.addEventListener('click', () => this.handlers.onStop(this.id));
    head.appendChild(this.stopButton);

    const exportButton = el('button', 'icon-btn', '⭳');
    exportButton.title = 'Export the transcript as markdown';
    exportButton.addEventListener('click', () => this.exportMarkdown());
    head.appendChild(exportButton);

    const settings = el('button', 'icon-btn', '⚙');
    settings.title = 'Session settings';
    settings.addEventListener('click', () => this.handlers.onSettings(this.id));
    head.appendChild(settings);

    return head;
  }

  buildComposer() {
    const composer = el('div', 'composer');

    this.input = el('textarea');
    this.input.rows = 1;
    this.input.placeholder = 'Send a prompt…';
    this.input.addEventListener('input', () => {
      this.autoGrow();
      this.paintMode();
    });
    this.input.addEventListener('keydown', (event) => {
      // Enter sends, Shift+Enter inserts a newline. This is the input's submit
      // gesture, not a shortcut layer.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });

    this.sendButton = el('button', 'btn primary send', 'Send');
    this.sendButton.addEventListener('click', () => this.send());

    composer.append(this.input, this.sendButton);
    return composer;
  }

  /**
   * Size the box to its text. The cap comes from the stylesheet rather than a
   * constant here: it is partly viewport-relative, so on a short window — a
   * laptop screen at high zoom — it is smaller than the 190px a roomy one gets,
   * and a number duplicated here would grow the box past it.
   */
  autoGrow() {
    this.input.style.height = 'auto';
    const cap = parseFloat(getComputedStyle(this.input).maxHeight);
    this.input.style.height = `${Math.min(this.input.scrollHeight, cap || Infinity)}px`;
  }

  /**
   * Say what pressing Send will do. A `!` line goes to the shell, not to the
   * agent, and that is worth knowing *before* it is sent — hence the red
   * border rather than the usual terracotta.
   */
  paintMode() {
    const bash = parseComposerInput(this.input.value)?.kind === 'bash';
    this.input.classList.toggle('bash', bash);
    this.sendButton.textContent = bash ? 'Run' : 'Send';
  }

  send() {
    const parsed = parseComposerInput(this.input.value);
    if (!parsed) return;

    if (parsed.kind === 'bash') {
      // Nothing typed after the `!` yet.
      if (!parsed.command) return;
      // Bash never takes the turn lock, so this path ignores session status
      // entirely: a command runs while the agent works, and neither notices.
      if (!this.socket.sendBash(parsed.command)) {
        this.handlers.onError('Not connected — the command was not sent');
        return;
      }
    } else {
      const state = this.store.session(this.id);
      if (isBusy(state.status)) {
        // Rejected, but the text stays put: it is still worth sending once the
        // turn ends, and it may be what you want to run as a command instead.
        this.handlers.onError(
          'The agent is busy — wait for the turn to finish, or prefix with ! to run a shell command',
        );
        return;
      }
      if (!this.socket.sendInput(parsed.text)) {
        this.handlers.onError('Not connected — the prompt was not sent');
        return;
      }
    }

    this.input.value = '';
    this.autoGrow();
    this.paintMode();
  }

  /** Reflect metadata, status and connectivity into the header and composer. */
  refresh() {
    const state = this.store.session(this.id);
    this.nameView.textContent = state.name || '';
    this.dirText.textContent = state.workingDir || '';
    this.dirView.title = state.workingDir || '';
    this.worktreeTag.style.display = state.ownsWorktree ? '' : 'none';

    const offline = !state.connected;
    this.statusPill.className = `pill ${offline ? 'offline' : state.status}`;
    this.statusPill.textContent = offline
      ? 'Reconnecting…'
      : STATUS_LABEL[state.status] || state.status;

    const busy = isBusy(state.status);
    // Only connectivity closes the composer. A busy agent no longer does:
    // `!` commands bypass the turn entirely, and a prompt sent mid-turn is
    // turned away in send() with a toast, which says more than a dead box.
    this.input.disabled = offline;
    this.sendButton.disabled = offline;
    this.input.placeholder = offline
      ? 'Reconnecting…'
      : state.status === 'awaiting_approval'
        ? 'Answer above, or ! to run a command…'
        : busy
          ? 'The agent is working — ! runs a command…'
          : 'Send a prompt, or ! to run a command…';
    this.stopButton.style.display = busy ? '' : 'none';
  }

  exportMarkdown() {
    const state = this.store.session(this.id);
    const blob = new Blob([toMarkdown(state)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(state.name || 'session').replace(/[^\w.-]+/g, '-')}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  focusComposer() {
    // Nothing could be measured while the pane was hidden, so size the box now
    // that it is on screen — a draft left in it survives the tab switch.
    this.autoGrow();
    if (!this.input.disabled) this.input.focus();
  }

  destroy() {
    window.removeEventListener('resize', this.onViewportChange);
    this.unsubscribe();
    this.socket.close();
    this.transcript.destroy();
    this.root.remove();
  }
}
