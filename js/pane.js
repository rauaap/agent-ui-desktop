/**
 * One open session: header, transcript, composer.
 *
 * The pane owns the socket for the selected session. Selecting another session
 * destroys this pane and connection; the sidebar tracks every other session
 * through its lightweight metadata poll.
 */

import { filedLabel } from './archive.js';
import {
  completionToken,
  insertCompletion,
  matchPaths,
} from './completion.js';
import { FileTreeSocket } from './file-tree.js';
import { isBusy, parseComposerInput, toMarkdown } from './store.js';
import { SessionSocket } from './socket.js';
import { TranscriptView } from './render/transcript.js';
import { isFormerWorktree } from './worktree.js';

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
   * @param {{onSettings: Function, onError: Function, onUnarchive: Function}} handlers
   */
  constructor(sessionId, store, handlers) {
    this.id = sessionId;
    this.store = store;
    this.handlers = handlers;

    this.socket = new SessionSocket(sessionId, store, (event) => {
      handlers.onLiveEvent?.(sessionId, event);
    });
    this.completionOpen = false;
    this.completionResults = [];
    this.completionIndex = 0;
    this.fileTree = new FileTreeSocket(sessionId, () => {
      if (this.completionOpen) this.renderCompletions();
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
    this.archiveNotice = this.buildArchiveNotice();
    this.root.appendChild(this.archiveNotice);
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
    // The cwd, tagged when it is a worktree rather than the project's own
    // directory — so it is obvious the session is not running where its
    // siblings are.
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

    // Kept beside the status rather than instead of it: an archived session is
    // still idle or still connected, and the two say different things.
    this.archivedPill = el('span', 'pill archived', 'Archived');
    head.appendChild(this.archivedPill);

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

  /**
   * Why the composer is closed, and the way out of it. Reading an archived
   * session is the whole point of the archive, so the transcript above is
   * untouched — only starting new work is refused, and the server refuses it
   * too (`409 Session is archived`).
   */
  buildArchiveNotice() {
    const notice = el('div', 'archive-notice');
    notice.appendChild(el('span', null,
      'This session is archived. Unarchive it to continue working in it.'));
    const unarchive = el('button', 'btn', 'Unarchive');
    unarchive.addEventListener('click', () => this.handlers.onUnarchive?.(this.id));
    notice.appendChild(unarchive);
    notice.style.display = 'none';
    return notice;
  }

  buildComposer() {
    const composer = el('div', 'composer');

    this.input = el('textarea');
    this.input.rows = 1;
    this.input.placeholder = 'Send a prompt…';
    this.input.addEventListener('input', () => {
      this.autoGrow();
      this.paintMode();
      if (this.completionOpen) this.renderCompletions();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        if (this.completionOpen && this.completionResults.length) {
          const step = event.shiftKey ? -1 : 1;
          const length = this.completionResults.length;
          this.completionIndex = (this.completionIndex + step + length) % length;
          this.paintCompletionSelection();
        } else {
          this.invokeCompletion();
        }
        return;
      }
      if (this.completionOpen && event.key === 'Escape') {
        event.preventDefault();
        this.hideCompletions();
        return;
      }
      if (this.completionOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const length = this.completionResults.length;
        if (length) this.completionIndex = (this.completionIndex + step + length) % length;
        this.paintCompletionSelection();
        return;
      }
      if (this.completionOpen && event.key === 'Enter' && !event.shiftKey
          && this.completionResults.length) {
        event.preventDefault();
        this.acceptCompletion(this.completionIndex);
        return;
      }
      // Enter sends, Shift+Enter inserts a newline. This is the input's submit
      // gesture, not a shortcut layer.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });

    this.completionButton = el('button', 'btn completion-trigger', 'Paths');
    this.completionButton.type = 'button';
    this.completionButton.title = 'Complete a path (Tab)';
    this.completionButton.setAttribute('aria-label', 'Complete a file path');
    this.completionButton.setAttribute('aria-expanded', 'false');
    // A pointer click must leave keyboard ownership with the textarea so Escape
    // can still dismiss the menu and typing can immediately refine it.
    this.completionButton.addEventListener('mousedown', (event) => event.preventDefault());
    this.completionButton.addEventListener('click', () => {
      if (this.completionOpen) this.hideCompletions();
      else this.invokeCompletion();
      this.input.focus();
    });

    this.completionMenu = el('div', 'completion-menu');
    this.completionMenu.setAttribute('role', 'listbox');
    this.completionMenu.setAttribute('aria-label', 'File path completions');
    this.completionMenu.style.display = 'none';

    this.sendButton = el('button', 'btn primary send', 'Send');
    this.sendButton.addEventListener('click', () => this.send());

    composer.append(this.completionMenu, this.input, this.completionButton, this.sendButton);
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
    return bash;
  }

  /** Open or refresh the local completion list. Also serves as manual retry. */
  invokeCompletion() {
    this.fileTree.open(true);
    this.completionOpen = true;
    this.completionButton.setAttribute('aria-expanded', 'true');
    this.completionIndex = 0;
    this.renderCompletions();
  }

  renderCompletions() {
    if (!this.completionOpen) return;
    const cache = this.fileTree.cache;
    const token = completionToken(this.input.value, this.input.selectionStart);
    this.completionMenu.replaceChildren();
    this.completionResults = [];

    if (!token) {
      this.hideCompletions();
      return;
    }
    if (cache.state !== 'ready') {
      const fallback = cache.state === 'connecting'
        ? 'Loading files…'
        : 'File completion is unavailable.';
      this.completionMenu.appendChild(el('div', 'completion-status', cache.message || fallback));
      this.completionMenu.style.display = '';
      return;
    }

    this.completionResults = matchPaths(cache.searchPaths, token.query);
    if (!this.completionResults.length) {
      this.completionMenu.appendChild(el('div', 'completion-status', 'No matching paths'));
    } else {
      if (this.completionIndex >= this.completionResults.length) this.completionIndex = 0;
      this.completionResults.forEach((path, index) => {
        const option = el('button', 'completion-option', path);
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.dataset.index = String(index);
        // Keep textarea selection intact until click chooses the path.
        option.addEventListener('mousedown', (event) => event.preventDefault());
        option.addEventListener('click', () => this.acceptCompletion(index));
        this.completionMenu.appendChild(option);
      });
      this.paintCompletionSelection();
    }
    this.completionMenu.style.display = '';
  }

  paintCompletionSelection() {
    const options = this.completionMenu.querySelectorAll('.completion-option');
    options.forEach((option, index) => {
      const selected = index === this.completionIndex;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) option.scrollIntoView({ block: 'nearest' });
    });
  }

  acceptCompletion(index) {
    const path = this.completionResults[index];
    const token = completionToken(this.input.value, this.input.selectionStart);
    if (!path || !token) return;
    const next = insertCompletion(this.input.value, token, path);
    const cursor = next.length - (this.input.value.length - token.end);
    this.input.value = next;
    this.input.setSelectionRange(cursor, cursor);
    this.autoGrow();
    this.paintMode();
    this.hideCompletions();
    this.input.focus();
  }

  hideCompletions() {
    this.completionOpen = false;
    this.completionButton?.setAttribute('aria-expanded', 'false');
    this.completionResults = [];
    if (this.completionMenu) {
      this.completionMenu.replaceChildren();
      this.completionMenu.style.display = 'none';
    }
  }

  send() {
    const parsed = parseComposerInput(this.input.value);
    if (!parsed) return;

    // The box is disabled while archived, so this is for the race: the event
    // that archived the session — from another device, or from a project
    // archive — can land between the keystroke and the send. Prompts *and*
    // commands are refused; bash is outside the turn lock, not outside this.
    if (this.store.session(this.id).archivedAt) {
      this.handlers.onError('This session is archived — unarchive it to send anything');
      return;
    }

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
    this.hideCompletions();
    this.autoGrow();
    this.paintMode();
  }

  /** Reflect metadata, status and connectivity into the header and composer. */
  refresh() {
    const state = this.store.session(this.id);
    this.nameView.textContent = state.name || '';
    this.dirText.textContent = state.workingDir || '';
    this.dirView.title = state.workingDir || '';
    const formerWorktree = isFormerWorktree(state);
    this.worktreeTag.style.display = state.worktreeId || formerWorktree ? '' : 'none';
    this.worktreeTag.classList.toggle('former', formerWorktree);
    this.worktreeTag.textContent = formerWorktree ? 'FORMER WORKTREE' : 'WORKTREE';

    const offline = !state.connected;
    this.statusPill.className = `pill ${offline ? 'offline' : state.status}`;
    this.statusPill.textContent = offline
      ? 'Reconnecting…'
      : STATUS_LABEL[state.status] || state.status;

    const archived = !!state.archivedAt;
    this.archivedPill.style.display = archived ? '' : 'none';
    this.archivedPill.title = archived ? `Archived ${filedLabel(state.archivedAt)}` : '';
    this.archiveNotice.style.display = archived ? '' : 'none';

    const busy = isBusy(state.status);
    // Connectivity closes the composer, and so does the archive — the server
    // refuses both a prompt and a command in an archived session, and a dead
    // box with a notice above it says that better than a rejected send. A busy
    // agent still does not: `!` commands bypass the turn entirely, and a prompt
    // sent mid-turn is turned away in send() with a toast.
    this.input.disabled = offline || archived;
    this.sendButton.disabled = offline || archived;
    this.input.placeholder = archived
      ? 'Archived — unarchive to send prompts or commands'
      : offline
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
    this.autoGrow();
    if (!this.input.disabled) this.input.focus();
  }

  destroy() {
    window.removeEventListener('resize', this.onViewportChange);
    this.unsubscribe();
    this.fileTree.close();
    this.socket.close();
    this.transcript.destroy();
    this.root.remove();
  }
}
