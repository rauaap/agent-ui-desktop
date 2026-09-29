/** Specialized bodies for provider-neutral canonical tool actions. */

import { ADD, CONTEXT, DELETE, diff } from './diff.js';
import { escapeHtml } from './markdown.js';
import { formatTimeout, prettyJson, sandboxBypass } from '../tools.js';

const CLASSES = { [ADD]: 'diff-add', [DELETE]: 'diff-del', [CONTEXT]: 'diff-ctx' };
const GUTTERS = { [ADD]: '+', [DELETE]: '-', [CONTEXT]: ' ' };

/** A formatted body element, or null when a generic canonical detail is better. */
export function toolBody(action) {
  switch (action?.kind) {
    case 'edit': return editBlock(action.edits);
    case 'write': return editBlock([{ old_text: '', new_text: action.content }]);
    case 'command': return commandBlock(action);
    case 'other': return bypassBlock(sandboxBypass(action));
    default: return null;
  }
}

const block = (html) => {
  const pre = document.createElement('pre');
  pre.className = 'tool-block';
  pre.innerHTML = html;
  return pre;
};

function editBlock(edits) {
  const lines = [];
  for (const edit of edits) {
    if (lines.length) lines.push('<span class="diff-ctx"> ⋯</span>');
    for (const row of diff(edit.old_text, edit.new_text)) {
      lines.push(
        `<span class="${CLASSES[row.kind]}">${GUTTERS[row.kind]} ${escapeHtml(row.text)}</span>`,
      );
    }
  }
  return lines.length ? block(lines.join('\n')) : null;
}

function commandBlock(action) {
  const lines = action.command.split('\n').map((line, index) => {
    const prompt = index === 0 ? '$ ' : '  ';
    return `<span class="cmd-prompt">${prompt}</span>${escapeHtml(line)}`;
  });
  if (action.description) lines.unshift(`<span class="cmd-desc"># ${escapeHtml(action.description)}</span>`);
  return block(lines.join('\n'));
}

/** The command plus what is being approved with it, the timeout above all. */
function bypassBlock(bypass) {
  if (!bypass) return null;
  const text = (value) => escapeHtml(typeof value === 'string' ? value : prettyJson(value));
  const field = (label, value) => `<span class="cmd-desc">${label}:</span> ${value}`;
  const lines = text(bypass.command).split('\n').map((line, index) =>
    `<span class="cmd-prompt">${index === 0 ? '$ ' : '  '}</span>${line}`);
  lines.push('');
  if (bypass.reason !== undefined) lines.push(field('Reason', text(bypass.reason)));
  if (bypass.cwd !== undefined) lines.push(field('Working directory', text(bypass.cwd)));
  lines.push(field('Timeout', escapeHtml(formatTimeout(bypass.timeoutSeconds))));
  return block(lines.join('\n'));
}
