/**
 * The transcript: mirrors a session's store rows into DOM nodes.
 *
 * Append-only by design. The store hands us a list of changes rather than a new
 * state, so a streaming turn touches exactly one node — the trailing agent
 * message — instead of re-rendering the conversation. That is what keeps a long
 * transcript smooth without a virtual DOM.
 */

import { bashOutputText, bashStatus, rowText } from '../store.js';
import { prettyJson, toolSummary } from '../tools.js';
import { toHtml } from './markdown.js';
import { toolBody } from './toolformat.js';

/** How close to the bottom still counts as "following along", in pixels. */
const STICK_SLACK = 60;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class TranscriptView {
  /**
   * @param {string} sessionId
   * @param {import('../store.js').Store} store
   * @param {{onApproval: Function, onAnswers: Function}} handlers
   */
  constructor(sessionId, store, handlers) {
    this.sessionId = sessionId;
    this.store = store;
    this.handlers = handlers;
    /** @type {Map<number, HTMLElement>} row key -> element */
    this.nodes = new Map();
    this.query = '';

    this.wrap = el('div', 'transcript-wrap');
    this.list = el('div', 'transcript');
    this.wrap.appendChild(this.list);

    this.scrollButton = el('button', 'scroll-down', '↓');
    this.scrollButton.title = 'Jump to the latest';
    this.scrollButton.addEventListener('click', () => this.scrollToBottom());
    this.wrap.appendChild(this.scrollButton);

    this.stick = true;
    this.list.addEventListener('scroll', () => {
      this.stick = this.distanceFromBottom() <= STICK_SLACK;
      this.updateScrollButton();
    });

    this.unsubscribe = store.subscribe(sessionId, (changes) => this.applyChanges(changes));
    this.rebuild();
  }

  destroy() {
    this.unsubscribe();
    this.nodes.clear();
  }

  /* ---------------------------------------------------------------- */
  /* change application                                               */
  /* ---------------------------------------------------------------- */

  applyChanges(changes) {
    const wasStuck = this.stick;
    let touched = false;

    for (const change of changes) {
      switch (change.op) {
        case 'reset':
          this.rebuild();
          return;
        case 'append': {
          const node = this.build(change.row);
          this.nodes.set(change.row.key, node);
          this.list.appendChild(node);
          touched = true;
          break;
        }
        case 'update': {
          const existing = this.nodes.get(change.row.key);
          if (!existing) break;
          // A growing agent message is the hot path: swap its rendered markdown
          // rather than rebuilding the row.
          if (change.row.kind === 'agent') {
            const md = existing.querySelector('.md');
            if (md) {
              md.innerHTML = toHtml(change.row.text);
              this.applyQueryTo(existing, change.row);
              touched = true;
              break;
            }
          }
          const replacement = this.build(change.row);
          this.nodes.set(change.row.key, replacement);
          existing.replaceWith(replacement);
          touched = true;
          break;
        }
        case 'remove': {
          const node = this.nodes.get(change.row.key);
          if (node) node.remove();
          this.nodes.delete(change.row.key);
          break;
        }
        default:
          break;
      }
    }

    if (touched && wasStuck) this.scrollToBottom();
    else this.updateScrollButton();
  }

  rebuild() {
    const state = this.store.session(this.sessionId);
    this.nodes.clear();
    this.list.replaceChildren();
    // Build off-document, then attach in one shot: a 200-row replay should cost
    // one layout, not two hundred.
    const fragment = document.createDocumentFragment();
    for (const row of state.rows) {
      const node = this.build(row);
      this.nodes.set(row.key, node);
      fragment.appendChild(node);
    }
    this.list.appendChild(fragment);
    this.scrollToBottom();
  }

  /* ---------------------------------------------------------------- */
  /* scrolling                                                        */
  /* ---------------------------------------------------------------- */

  distanceFromBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
  }

  scrollToBottom() {
    this.stick = true;
    this.list.scrollTop = this.list.scrollHeight;
    this.updateScrollButton();
  }

  updateScrollButton() {
    this.scrollButton.classList.toggle('show', this.distanceFromBottom() > STICK_SLACK);
  }

  /* ---------------------------------------------------------------- */
  /* search                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Filter the transcript to rows matching `query`.
   *
   * Which rows match is decided from the store's row model, so a row is found
   * even when the transcript cap has evicted it from the page. The count that
   * comes back is of highlights actually placed, which is what the eye can
   * check — a card renders more text than the row model carries (the raw-JSON
   * disclosure, a command's description), so counting from the model would
   * disagree with the page.
   */
  search(query) {
    this.query = String(query || '').trim();
    const state = this.store.session(this.sessionId);
    const needle = this.query.toLowerCase();
    let rows = 0;
    let occurrences = 0;

    for (const row of state.rows) {
      const node = this.nodes.get(row.key);
      if (!node) continue;
      const hit = !this.query || rowText(row).toLowerCase().includes(needle);
      if (hit && this.query) rows++;
      node.classList.toggle('hidden-by-search', !!this.query && !hit);
      this.applyQueryTo(node, row);
      if (hit && this.query) occurrences += node.querySelectorAll('mark').length;
    }

    return this.query ? { rows, occurrences } : { rows: 0, occurrences: 0 };
  }

  /** Highlight occurrences of the active query inside one row's text nodes. */
  applyQueryTo(node, row) {
    clearMarks(node);
    if (!this.query) return;
    if (!rowText(row).toLowerCase().includes(this.query.toLowerCase())) return;
    highlight(node, this.query);
  }

  /* ---------------------------------------------------------------- */
  /* row builders                                                     */
  /* ---------------------------------------------------------------- */

  build(row) {
    let node;
    switch (row.kind) {
      case 'user': node = this.buildUser(row); break;
      case 'agent': node = this.buildAgent(row); break;
      case 'tool': node = this.buildTool(row); break;
      case 'approval': node = this.buildApproval(row); break;
      case 'question': node = this.buildQuestion(row); break;
      case 'bash': node = this.buildBash(row); break;
      case 'error': node = this.buildError(row); break;
      default: node = el('div', 'row');
    }
    node.dataset.key = String(row.key);
    if (this.query) this.applyQueryTo(node, row);
    return node;
  }

  buildUser(row) {
    const wrap = el('div', 'row row-user');
    wrap.appendChild(el('div', 'msg-user', row.text));
    return wrap;
  }

  buildAgent(row) {
    const wrap = el('div', 'row msg-agent');
    const body = el('div', 'md');
    body.innerHTML = toHtml(row.text);
    wrap.appendChild(body);

    // Copies the raw markdown, not the rendered text — the source is what you
    // want to paste elsewhere.
    const copy = el('button', 'copy', 'Copy');
    copy.addEventListener('click', async () => {
      await copyText(row.text);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
    wrap.appendChild(copy);
    return wrap;
  }

  buildTool(row) {
    const card = el('div', 'row card');
    const head = el('button', 'card-head');
    head.appendChild(el('span', 'twisty', '▸'));
    head.appendChild(el('span', 'tool', row.tool.toUpperCase()));
    head.appendChild(el('span', 'summary', toolSummary(row.tool, row.input)));
    head.addEventListener('click', () => card.classList.toggle('open'));
    card.appendChild(head);

    const body = el('div', 'card-body');
    body.appendChild(toolBody(row.tool, row.input) || rawBlock(row.input));
    card.appendChild(body);
    return card;
  }

  buildApproval(row) {
    const pending = !row.resolved;
    const card = el('div', `row card${pending ? ' awaiting' : ''}${row.auto ? ' auto' : ''}`);
    if (row.resolved?.behavior === 'deny') card.classList.add('resolved-deny');

    // The head names the request; the verdict row below reports the outcome.
    // Saying "auto-approved" in both just repeats itself.
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'tool', pending ? 'APPROVAL REQUIRED' : 'APPROVAL'));
    head.appendChild(el('span', 'summary', `${row.tool} · ${toolSummary(row.tool, row.input)}`));
    card.appendChild(head);

    // The command or edit, shown expanded — this is what you are approving.
    const body = el('div', 'card-body');
    body.style.display = 'block';
    const formatted = toolBody(row.tool, row.input);
    body.appendChild(formatted || rawBlock(row.input));
    if (formatted) body.appendChild(rawToggle(row.input));
    card.appendChild(body);

    if (pending) card.appendChild(this.buildApprovalControls(row, card));
    else card.appendChild(verdictRow(row));
    return card;
  }

  /**
   * The choice buttons. The backend may offer an arbitrary `options` list (each
   * `{id, name, kind}`) — one button per option, answered with its `option_id`.
   * With no options we fall back to plain Deny / Allow answered with a
   * `behavior`. A free-form reason field sits under the buttons; a reject
   * forwards whatever was typed (empty means no message).
   */
  buildApprovalControls(row, card) {
    const wrap = el('div');
    const bar = el('div', 'approval-bar');

    let options = (row.options || []).filter((o) => o && o.id);
    const fallback = !options.length;
    if (fallback) {
      options = [
        { id: null, name: 'Deny', kind: 'reject_once' },
        { id: null, name: 'Allow', kind: 'allow_once' },
      ];
    }
    // Keep deny on the left and allow on the right regardless of the order the
    // backend sent them.
    if (options.length === 2
        && !String(options[0].kind || '').startsWith('reject')
        && String(options[1].kind || '').startsWith('reject')) {
      options = [options[1], options[0]];
    }

    const reason = el('input', 'deny-reason');
    reason.type = 'text';
    reason.placeholder = 'Deny with a message (optional)';

    for (const option of options) {
      const reject = String(option.kind || '').startsWith('reject');
      const behavior = reject ? 'deny' : 'allow';
      const button = el('button', `btn ${reject ? 'deny' : 'primary'}`, option.name || option.id || '?');
      button.addEventListener('click', () => {
        // Lock the whole card the moment a choice is made, so a double click
        // cannot answer the same request twice.
        for (const other of wrap.querySelectorAll('button')) other.disabled = true;
        const message = reject ? reason.value.trim() : '';
        this.handlers.onApproval(row.id, option.id, behavior, message || null);
      });
      bar.appendChild(button);
    }

    bar.appendChild(reason);
    wrap.appendChild(bar);
    card.classList.add('open');
    return wrap;
  }

  buildQuestion(row) {
    const card = el('div', 'row card question open');
    const resolved = !!row.resolved;

    // Selections per question, by index.
    const selections = row.questions.map(() => new Set());
    // One single-select question is the common case: clicking an option answers
    // immediately rather than making you confirm a single choice.
    const fastPath = row.questions.length === 1 && !row.questions[0]?.multiSelect;

    let submit = null;
    const refreshSubmit = () => {
      if (!submit) return;
      submit.disabled = selections.some((set) => set.size === 0);
    };

    row.questions.forEach((question, index) => {
      if (question.header) card.appendChild(el('div', 'qhead', question.header));
      card.appendChild(el('div', 'qtext', question.question || ''));

      const options = Array.isArray(question.options) ? question.options : [];
      const rows = [];

      options.forEach((option, optionIndex) => {
        const button = el('button', 'qopt');
        button.appendChild(el('div', 'olabel', option.label ?? ''));
        if (option.description) button.appendChild(el('div', 'odesc', option.description));
        rows.push(button);

        if (resolved) {
          button.disabled = true;
        } else {
          button.addEventListener('click', () => {
            if (question.multiSelect) {
              if (selections[index].has(optionIndex)) selections[index].delete(optionIndex);
              else selections[index].add(optionIndex);
            } else {
              selections[index].clear();
              selections[index].add(optionIndex);
            }
            rows.forEach((r, i) => r.classList.toggle('selected', selections[index].has(i)));
            if (fastPath) this.submitQuestion(row, selections, card);
            else refreshSubmit();
          });
        }
        card.appendChild(button);
      });
    });

    if (resolved) {
      card.appendChild(verdictRow(row));
    } else if (!fastPath) {
      const holder = el('div', 'qsubmit');
      submit = el('button', 'btn primary', 'Submit');
      submit.addEventListener('click', () => this.submitQuestion(row, selections, card));
      holder.appendChild(submit);
      card.appendChild(holder);
      refreshSubmit();
    }

    return card;
  }

  submitQuestion(row, selections, card) {
    const answers = {};
    row.questions.forEach((question, index) => {
      const options = Array.isArray(question.options) ? question.options : [];
      const picked = [...selections[index]].map((i) => options[i]?.label).filter(Boolean);
      if (!picked.length) return;
      // A multi-select answer is an array of labels; a single-select is one.
      answers[question.question ?? ''] = question.multiSelect ? picked : picked[0];
    });
    for (const button of card.querySelectorAll('button')) button.disabled = true;
    this.handlers.onAnswers(row.id, answers);
  }

  /**
   * A `!` command and what it printed. Deliberately unlike every other row: the
   * agent neither ran this nor ever sees the output, so nothing about it should
   * read as part of the conversation. The body is a plain code block, so the
   * whole of it can be selected and pasted into a prompt if you do want the
   * agent to see it.
   */
  buildBash(row) {
    const card = el('div', 'row bash-card');

    const head = el('div', 'bash-head');
    head.appendChild(el('span', 'bash-prompt', '$'));
    head.appendChild(el('span', 'bash-cmd', row.command));
    card.appendChild(head);

    const result = row.result;
    const body = el('pre', 'bash-out');
    if (!result) {
      body.classList.add('waiting');
      body.textContent = 'running…';
    } else if (!result.stdout && !result.stderr) {
      body.classList.add('waiting');
      body.textContent = '(no output)';
    } else {
      if (result.stdout) body.appendChild(document.createTextNode(result.stdout));
      if (result.stderr) {
        // Keep the two streams apart visually while leaving them one block of
        // selectable text, in the order a terminal would have shown them.
        if (result.stdout && !result.stdout.endsWith('\n')) {
          body.appendChild(document.createTextNode('\n'));
        }
        body.appendChild(el('span', 'bash-err', result.stderr));
      }
    }
    card.appendChild(body);

    if (result) {
      const copy = el('button', 'copy', 'Copy');
      copy.addEventListener('click', async () => {
        await copyText(bashOutputText(result));
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      head.appendChild(copy);

      const meta = el('div', 'bash-meta', bashStatus(result));
      if (result.exitCode !== 0 || result.timedOut) meta.classList.add('bad');
      card.appendChild(meta);
    }

    return card;
  }

  buildError(row) {
    return el('div', 'row msg-error', row.message);
  }
}

/* ------------------------------------------------------------------ */
/* small pieces                                                       */
/* ------------------------------------------------------------------ */

function rawBlock(input) {
  const pre = el('pre', 'tool-block', prettyJson(input));
  return pre;
}

/** A collapsed "raw input" disclosure that reveals the full JSON. */
function rawToggle(input) {
  const details = el('details', 'raw-toggle');
  details.appendChild(el('summary', null, 'raw input'));
  details.appendChild(el('pre', null, prettyJson(input)));
  return details;
}

function verdictRow(row) {
  const wrap = el('div', 'verdict');

  if (row.kind === 'question') {
    wrap.appendChild(el('span', 'tag allow', 'ANSWERED'));
    wrap.appendChild(el('span', null, summarize(row.resolved?.answers)));
    return wrap;
  }

  const behavior = row.resolved?.behavior;
  if (behavior === 'allow') {
    wrap.appendChild(el('span', 'tag allow', row.resolved.auto ? 'AUTO-APPROVED' : 'ALLOWED'));
    if (row.auto && row.category) wrap.appendChild(el('span', null, row.category));
  } else if (behavior === 'deny') {
    wrap.appendChild(el('span', 'tag deny', 'DENIED'));
    if (row.resolved.message) wrap.appendChild(el('span', null, row.resolved.message));
  } else {
    // Stopped, or the turn ended, without an answer.
    wrap.appendChild(el('span', 'tag', 'NO LONGER PENDING'));
  }
  return wrap;
}

function summarize(answers) {
  if (!answers || typeof answers !== 'object') return '';
  return Object.values(answers)
    .map((value) => (Array.isArray(value) ? value.join(', ') : String(value)))
    .filter(Boolean)
    .join(' / ');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; plain http:// over WireGuard is not
    // one, so fall back to the old selection trick.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch { /* nothing else to try */ }
    area.remove();
  }
}

/* ------------------------------------------------------------------ */
/* search highlighting                                                */
/* ------------------------------------------------------------------ */

function clearMarks(node) {
  for (const mark of node.querySelectorAll('mark')) {
    const text = document.createTextNode(mark.textContent);
    mark.replaceWith(text);
  }
  node.normalize();
}

function highlight(node, query) {
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current.nodeValue.toLowerCase().includes(needle)) targets.push(current);
  }

  for (const target of targets) {
    const value = target.nodeValue;
    const fragment = document.createDocumentFragment();
    let index = 0;
    for (;;) {
      const hit = value.toLowerCase().indexOf(needle, index);
      if (hit < 0) break;
      if (hit > index) fragment.appendChild(document.createTextNode(value.slice(index, hit)));
      const mark = document.createElement('mark');
      mark.textContent = value.slice(hit, hit + query.length);
      fragment.appendChild(mark);
      index = hit + query.length;
    }
    if (index < value.length) fragment.appendChild(document.createTextNode(value.slice(index)));
    target.replaceWith(fragment);
  }
}
