/** Browser-local composer text. Writes happen on session/page exit, not while typing. */
export class SessionDraft {
  constructor(sessionId, storage = () => localStorage) {
    this.key = `agent-ui.session-draft.${sessionId}`;
    this.storage = storage;
    try {
      this.saved = this.storage().getItem(this.key) ?? '';
      this.images = [];
      try {
        const record = JSON.parse(this.saved);
        if (record?.version === 1 && typeof record.text === 'string' && Array.isArray(record.images)) {
          this.saved = record.text;
          this.images = record.images.filter((image) => typeof image?.id === 'string');
        }
      } catch { /* Existing plain-text draft. */ }
    } catch {
      this.saved = '';
      this.images = [];
    }
  }

  save(text, images = []) {
    try {
      if (text === '' && !images.length) this.storage().removeItem(this.key);
      else this.storage().setItem(this.key, images.length
        ? JSON.stringify({ version: 1, text, images }) : text);
      this.saved = text;
      this.images = images;
      return true;
    } catch {
      return false;
    }
  }

}
