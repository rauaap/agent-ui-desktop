/**
 * One open session: header, transcript, composer.
 *
 * The pane owns the socket for the selected session. Selecting another session
 * destroys this pane and connection; the sidebar tracks every other session
 * through its lightweight metadata poll.
 */

import { httpBase } from './auth.js';
import { ImageViews, uploadImage } from './images.js';
import { filedLabel } from './archive.js';
import { idChip } from './clipboard.js';
import {
  completionToken,
  insertCompletion,
  matchPaths,
} from './completion.js';
import { FileTreeSocket } from './file-tree.js';
import {
  composerEntries, composerEntry, historyRows, MessageHistory,
} from './message-history.js';
import {
  isBusy, parseComposerInput, sendRefusal, toMarkdown,
} from './store.js';
import { SessionSocket } from './socket.js';
import { SessionDraft } from './session-draft.js';
import { SessionScroll } from './session-scroll.js';
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
   * @param {{onSettings: Function, onError: Function, onUnarchive: Function,
   *   onOpenSession: Function}} handlers
   * @param {import('./inter-agent.js').SessionDirectory} directory
   */
  constructor(sessionId, store, handlers, directory) {
    this.id = sessionId;
    this.store = store;
    this.handlers = handlers;
    this.directory = directory;
    this.draft = new SessionDraft(sessionId);
    this.attachments = this.draft.images.map((image) => ({ image, status: 'ready' }));
    this.composerImages = new ImageViews();
    this.scrollPosition = new SessionScroll(sessionId);
    this.pendingScrollPosition = this.scrollPosition.saved;

    this.socket = new SessionSocket(sessionId, store, (event) => {
      handlers.onLiveEvent?.(sessionId, event);
    }, () => handlers.onConnected?.(sessionId));
    this.completionOpen = false;
    this.completionResults = [];
    this.completionIndex = 0;
    const initial = store.session(sessionId);
    this.messageHistory = new MessageHistory(composerEntries([...initial.rows, ...initial.queue]));
    // Successful sends are added immediately, before their server echo arrives.
    // This queue prevents those echoes from adding the same entry a second time.
    this.pendingHistoryEchoes = [];
    this.fileTree = new FileTreeSocket(sessionId, () => {
      if (this.completionOpen) this.renderCompletions();
    });

    this.root = el('div', 'pane');
    this.root.appendChild(this.buildHead());

    this.transcript = new TranscriptView(sessionId, store, {
      serverBase: httpBase,
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
      onOpenSession: (id) => handlers.onOpenSession?.(id),
      // Do not override navigation the reader makes while replay is loading.
      onNavigate: () => { this.pendingScrollPosition = null; },
    }, directory);
    this.root.appendChild(this.transcript.wrap);
    this.root.appendChild(this.transcript.queueView);
    this.archiveNotice = this.buildArchiveNotice();
    this.root.appendChild(this.archiveNotice);
    this.root.appendChild(this.buildComposer());
    this.setComposerValue(this.draft.saved);
    this.renderAttachments();
    // localStorage writes are synchronous, so normal page exits can save here.
    this.onBeforeUnload = () => { this.saveLocalState(); };
    window.addEventListener('beforeunload', this.onBeforeUnload);

    // Zoom and window resizes change the composer's viewport-relative growth
    // cap, so a box sitting at the old limit has to be re-measured. Only the
    // visible pane can be: a `display: none` one has no scrollHeight to read,
    // and it is re-measured when it next becomes visible instead.
    this.onViewportChange = () => {
      if (this.root.classList.contains('active')) this.autoGrow();
    };
    window.addEventListener('resize', this.onViewportChange);

    this.unsubscribe = store.subscribe(sessionId, (changes) => {
      if (changes.some((c) => c.op === 'meta' || c.op === 'reset')) {
        this.refresh();
        this.restoreSavedScroll();
      }
      if (changes.some((c) => c.op === 'reset')) {
        const state = store.session(sessionId);
        this.messageHistory.replace(composerEntries([...state.rows, ...state.queue]));
        this.pendingHistoryEchoes = [];
      } else {
        for (const row of historyRows(changes)) {
          const entry = composerEntry(row);
          if (entry === null) continue;
          if (this.pendingHistoryEchoes[0] === entry) this.pendingHistoryEchoes.shift();
          else this.messageHistory.add(entry);
        }
      }
    });

    this.refresh();
    this.socket.open();
  }

  buildHead() {
    const head = el('div', 'pane-head');

    const titles = el('div', 'titles');
    // Names are not unique, so the id people hand to agents sits beside it.
    const nameRow = el('div', 'pane-name');
    this.nameView = el('span', 'name');
    nameRow.append(this.nameView, idChip(this.id, 'session'));
    // The cwd, tagged when it is a worktree rather than the project's own
    // directory — so it is obvious the session is not running where its
    // siblings are.
    this.dirView = el('div', 'pane-dir');
    this.worktreeTag = el('span', 'wt', 'WORKTREE');
    this.dirText = el('span', 'path');
    this.worktreeChip = null;
    this.dirView.append(this.worktreeTag, this.dirText);
    titles.append(nameRow, this.dirView);
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
    this.input.addEventListener('paste', (event) => {
      if (this.input.disabled || !this.handlers.canAttachImages?.(this.store.session(this.id))) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const images = [...(clipboard.items ?? [])]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile()).filter(Boolean);
      if (!images.length) {
        images.push(...[...(clipboard.files ?? [])].filter((file) => file.type.startsWith('image/')));
      }
      if (!images.length) return;
      // Mixed clipboard content still pastes its text normally into the textarea.
      if (!clipboard.getData('text/plain')) event.preventDefault();
      this.selectImages(images);
    });
    this.input.addEventListener('input', () => {
      // Typing after recalling an entry starts a fresh history traversal; the
      // edited value is then preserved as the draft on the next ArrowUp.
      this.messageHistory.resetNavigation();
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
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
          && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
          && this.input.selectionStart === this.input.selectionEnd
          && (event.key === 'ArrowUp'
            ? this.input.selectionStart === 0
            : this.input.selectionEnd === this.input.value.length)) {
        const value = event.key === 'ArrowUp'
          ? this.messageHistory.previous(this.input.value)
          : this.messageHistory.next();
        if (value !== null) {
          event.preventDefault();
          this.setComposerValue(value, event.key === 'ArrowUp' ? 0 : value.length);
        }
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

    this.attachmentView = el('div', 'composer-images');
    this.imagePicker = el('input');
    this.imagePicker.type = 'file';
    this.imagePicker.accept = 'image/jpeg,image/png,image/gif,image/webp';
    this.imagePicker.multiple = true;
    this.imagePicker.hidden = true;
    this.imagePicker.addEventListener('change', () => {
      this.selectImages([...this.imagePicker.files]);
      this.imagePicker.value = '';
    });
    this.attachButton = el('button', 'btn attach-image');
    this.attachButton.type = 'button';
    this.attachButton.title = 'Attach images';
    this.attachButton.setAttribute('aria-label', 'Attach images');
    this.attachButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8L15 6"/></svg>';
    this.attachButton.addEventListener('click', () => this.imagePicker.click());
    const field = el('div', 'composer-field');
    field.append(this.attachmentView, this.input, this.attachButton);
    composer.append(this.imagePicker, this.completionMenu,
      field, this.completionButton, this.sendButton);
    return composer;
  }

  async selectImages(files) {
    if (!this.handlers.canAttachImages?.(this.store.session(this.id)) || this.input.disabled) return;
    for (const file of files) {
      if (this.attachments.length >= 10) {
        this.handlers.onError('At most 10 images per message');
        break;
      }
      const attachment = { status: 'uploading', url: URL.createObjectURL(file) };
      this.attachments.push(attachment);
      this.renderAttachments();
      // Upload/cache lifetime is independent of the pane. Late success is not a saved draft.
      uploadImage(file).then((image) => {
        if (this.destroyed || !this.attachments.includes(attachment)) return;
        attachment.image = image;
        attachment.status = 'ready';
        this.renderAttachments();
      }).catch((error) => {
        if (this.destroyed || !this.attachments.includes(attachment)) return;
        attachment.status = 'failed';
        attachment.error = error.message;
        this.renderAttachments();
      });
    }
  }

  savedImages() {
    return this.attachments.filter((item) => item.status === 'ready').map((item) => item.image);
  }

  clearAttachments() {
    for (const item of this.attachments) if (item.url) URL.revokeObjectURL(item.url);
    this.attachments = [];
    this.renderAttachments();
  }

  renderAttachments() {
    this.composerImages.dispose();
    this.attachmentView.replaceChildren();
    for (const item of this.attachments) {
      const card = el('div', 'composer-image');
      if (item.url) {
        const img = el('img');
        img.src = item.url;
        img.alt = 'Selected image';
        card.append(img);
      } else this.composerImages.append(card, [item.image]);
      if (item.status !== 'ready') {
        card.append(el('span', 'upload-status', item.error || 'Uploading…'));
      }
      const remove = el('button', 'image-remove', '×');
      remove.type = 'button';
      remove.title = 'Remove image';
      remove.setAttribute('aria-label', 'Remove image');
      remove.addEventListener('click', () => {
        if (item.url) URL.revokeObjectURL(item.url);
        this.attachments = this.attachments.filter((other) => other !== item);
        this.renderAttachments();
        if (!this.draft.save(this.input.value, this.savedImages())) {
          this.handlers.onError('The updated draft could not be saved in this browser');
        }
      });
      card.append(remove);
      this.attachmentView.append(card);
    }
    this.refresh();
  }

  /** Replace composer text while keeping its derived styling and size current. */
  setComposerValue(value, cursor = value.length) {
    this.input.value = value;
    this.input.setSelectionRange(cursor, cursor);
    this.autoGrow();
    this.paintMode();
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
    this.messageHistory.resetNavigation();
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
    const parsed = parseComposerInput(this.input.value)
      || (this.attachments.length ? { kind: 'input', text: '' } : null);
    if (!parsed) return;
    if (this.attachments.length && (parsed.kind === 'bash'
        || this.attachments.some((item) => item.status !== 'ready'))) {
      this.handlers.onError('Remove failed images or wait for uploads; images cannot accompany shell commands');
      return;
    }

    if (this.attachments.length) {
      const state = this.store.session(this.id);
      const images = [...this.savedImages(), ...(state.queue ?? []).flatMap((item) => item.images ?? [])];
      if (images.reduce((bytes, image) => bytes + image.size, 0) > 20 * 1024 * 1024) {
        this.handlers.onError('Images exceed the 20 MiB queued-turn limit; remove images or wait for the queue to ship');
        return;
      }
    }
    // Nothing typed after the `!` yet.
    if (parsed.kind === 'bash' && !parsed.command) return;
    const refusal = sendRefusal(this.store.session(this.id), parsed);
    if (refusal) {
      this.handlers.onError(refusal);
      return;
    }

    if (parsed.kind === 'bash') {
      if (!this.socket.sendBash(parsed.command)) {
        this.handlers.onError('Not connected — the command was not sent');
        return;
      }
    } else if (!this.socket.sendInput(parsed.text, this.savedImages().map((image) => image.id))) {
      this.handlers.onError('Not connected — the prompt was not sent');
      return;
    }

    const historyEntry = parsed.kind === 'bash'
      ? `!${parsed.command}`
      : parsed.text.startsWith('!') ? `\\${parsed.text}` : parsed.text;
    this.messageHistory.add(historyEntry);
    this.pendingHistoryEchoes.push(historyEntry);
    this.input.value = '';
    this.clearAttachments();
    if (!this.draft.save('')) {
      this.handlers.onError('Sent, but the saved draft could not be cleared in this browser');
    }
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
    const worktreeId = state.worktreeId ? String(state.worktreeId) : null;
    if (this.worktreeChip?.dataset.id !== worktreeId) {
      this.worktreeChip?.remove();
      this.worktreeChip = worktreeId ? idChip(worktreeId, 'worktree') : null;
      if (this.worktreeChip) {
        this.worktreeChip.dataset.id = worktreeId;
        this.dirView.appendChild(this.worktreeChip);
      }
    }

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
    // agent does not: `!` commands bypass the turn entirely, and a prompt sent
    // mid-turn is queued for the next one.
    this.input.disabled = offline || archived;
    this.sendButton.disabled = offline || archived
      || this.attachments.some((item) => item.status !== 'ready');
    this.attachButton.hidden = !this.handlers.canAttachImages?.(state);
    this.attachButton.disabled = offline || archived || this.attachments.length >= 10;
    this.input.placeholder = archived
      ? 'Archived — unarchive to send prompts or commands'
      : offline
        ? 'Reconnecting…'
        : state.status === 'awaiting_approval'
          ? 'Answer above — a prompt sent now waits for the next turn…'
          : busy
            ? 'The agent is working — a prompt sent now is queued…'
            : 'Send a prompt, or ! to run a command…';
    this.stopButton.style.display = busy ? '' : 'none';
  }

  exportMarkdown() {
    const state = this.store.session(this.id);
    const blob = new Blob([toMarkdown(state, this.directory)], { type: 'text/markdown' });
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

  restoreSavedScroll() {
    if (!this.pendingScrollPosition || !this.store.session(this.id).sessionReady) return;
    const { followBottom, scrollTop } = this.pendingScrollPosition;
    this.pendingScrollPosition = null;
    this.transcript.restoreScroll(followBottom, scrollTop);
  }

  saveLocalState() {
    const unsaved = [];
    if (!this.draft.save(this.input.value, this.savedImages())) unsaved.push('draft');
    // Leaving before replay finishes must not replace a saved offset with the
    // temporary position in the partly loaded transcript.
    const position = this.pendingScrollPosition ?? {
      scrollTop: Math.max(0, this.transcript.list.scrollTop),
      followBottom: this.transcript.followBottom,
    };
    if (!this.scrollPosition.save(position)) unsaved.push('scroll position');
    return unsaved;
  }

  destroy() {
    const unsaved = this.saveLocalState();
    if (unsaved.length) {
      this.handlers.onError(`The ${unsaved.join(' and ')} could not be saved in this browser`);
    }
    this.destroyed = true;
    this.clearAttachments();
    this.composerImages.dispose();
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('resize', this.onViewportChange);
    this.unsubscribe();
    this.fileTree.close();
    this.socket.close();
    this.transcript.destroy();
    this.root.remove();
  }
}
