/** Browser-local composer text. Writes happen on session/page exit, not while typing. */
export class SessionDraft {
  constructor(sessionId, storage = () => localStorage) {
    this.key = `agent-ui.session-draft.${sessionId}`;
    this.storage = storage;
    try {
      this.saved = this.storage().getItem(this.key) ?? '';
    } catch {
      this.saved = '';
    }
  }

  save(text) {
    try {
      if (text === '') this.storage().removeItem(this.key);
      else this.storage().setItem(this.key, text);
      this.saved = text;
      return true;
    } catch {
      return false;
    }
  }

}
