/**
 * Human-readable bodies for `tool_use` payloads — git-style diffs for file
 * edits, a terminal block for shell commands. Ported from ToolFormat.java.
 *
 * Anything it doesn't recognise returns null so the caller falls back to
 * pretty-printed JSON.
 */

import { ADD, CONTEXT, DELETE, diff } from './diff.js';
import { escapeHtml } from './markdown.js';

const CLASSES = { [ADD]: 'diff-add', [DELETE]: 'diff-del', [CONTEXT]: 'diff-ctx' };
const GUTTERS = { [ADD]: '+', [DELETE]: '-', [CONTEXT]: ' ' };

/**
 * A formatted body element for a tool card, or null when the tool has no
 * special formatting.
 */
export function toolBody(tool, input) {
  if (!input || typeof input !== 'object') return null;
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return diffBlock(tool, input);
    case 'Bash':
      return commandBlock(input);
    default:
      return null;
  }
}

const block = (html) => {
  const pre = document.createElement('pre');
  pre.className = 'tool-block';
  pre.innerHTML = html;
  return pre;
};

/* ------------------------------------------------------------------ */
/* file edits → git-style diff                                        */
/* ------------------------------------------------------------------ */

function diffBlock(tool, input) {
  const lines = [];

  const appendDiff = (oldText, newText) => {
    for (const row of diff(oldText, newText)) {
      lines.push(
        `<span class="${CLASSES[row.kind]}">${GUTTERS[row.kind]} ${escapeHtml(row.text)}</span>`,
      );
    }
  };

  switch (tool) {
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object') continue;
        if (lines.length) lines.push('<span class="diff-ctx"> ⋯</span>');
        appendDiff(edit.old_string ?? '', edit.new_string ?? '');
      }
      break;
    }
    case 'Write':
      appendDiff('', input.content ?? '');
      break;
    default: // Edit
      appendDiff(input.old_string ?? '', input.new_string ?? '');
      break;
  }

  if (!lines.length) return null;
  return block(lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* shell commands → terminal block                                    */
/* ------------------------------------------------------------------ */

function commandBlock(input) {
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return null;

  const lines = command.split('\n').map((line, index) => {
    const prompt = index === 0 ? '$ ' : '  ';
    return `<span class="cmd-prompt">${prompt}</span>${escapeHtml(line)}`;
  });

  const description = typeof input.description === 'string' ? input.description : '';
  if (description) {
    lines.push(`<span class="cmd-desc"># ${escapeHtml(description)}</span>`);
  }

  return block(lines.join('\n'));
}
