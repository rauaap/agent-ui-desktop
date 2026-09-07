/**
 * Composer history independent of the DOM. Entries use composer syntax, so a
 * recalled Bash command still begins with `!`, while a prompt whose text begins
 * with `!` is escaped to keep it a prompt when sent again.
 */

/** Convert a transcript row to text that can safely be put in the composer. */
export function composerEntry(row) {
  if (row?.kind === 'bash') return `!${row.command ?? ''}`;
  if (row?.kind !== 'user') return null;
  const text = String(row.text ?? '');
  return text.startsWith('!') ? `\\${text}` : text;
}

/** Recover the available composer history from replayed transcript rows. */
export function composerEntries(rows) {
  return (rows ?? []).map(composerEntry).filter((entry) => entry !== null);
}

/**
 * Shell-style history cursor. The text present when navigation starts is kept
 * as a draft and restored after moving down past the newest entry.
 */
export class MessageHistory {
  constructor(entries = []) {
    this.entries = [...entries];
    this.resetNavigation();
  }

  replace(entries) {
    this.entries = [...entries];
    this.resetNavigation();
  }

  add(entry) {
    this.entries.push(String(entry));
    this.resetNavigation();
  }

  resetNavigation() {
    this.index = null;
    this.draft = '';
  }

  previous(current) {
    if (!this.entries.length) return null;
    if (this.index === null) {
      this.draft = String(current ?? '');
      this.index = this.entries.length;
    }
    if (this.index > 0) this.index -= 1;
    return this.entries[this.index];
  }

  next() {
    if (this.index === null) return null;
    if (this.index < this.entries.length - 1) {
      this.index += 1;
      return this.entries[this.index];
    }
    const draft = this.draft;
    this.resetNavigation();
    return draft;
  }
}
