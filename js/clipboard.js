/** Clipboard writes, and the brief "copied" acknowledgement on the control. */

export async function copyText(text) {
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

/** Copy, then show `done` on the control for a moment before restoring it. */
export async function copyWithFeedback(node, text, done = 'copied') {
  const label = node.dataset.label ?? node.textContent;
  node.dataset.label = label;
  await copyText(text);
  node.textContent = done;
  clearTimeout(node.copyTimer);
  node.copyTimer = setTimeout(() => {
    node.textContent = label;
    delete node.dataset.label;
  }, 1200);
}

/**
 * A `#42` that copies `42`. A button so it is reachable by keyboard, and
 * `type="button"` so one inside a dialog's form never submits it.
 */
export function idChip(id, what) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'id-chip';
  chip.textContent = `#${id}`;
  chip.title = `Copy ${what} ID`;
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    copyWithFeedback(chip, String(id));
  });
  return chip;
}
