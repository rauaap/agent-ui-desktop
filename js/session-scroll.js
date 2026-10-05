/** Browser-local reading position. Like drafts, written only on session/page exit. */
export class SessionScroll {
  constructor(sessionId, storage = () => localStorage) {
    this.key = `agent-ui.session-scroll.${sessionId}`;
    this.storage = storage;
    this.saved = null;
    try {
      const position = JSON.parse(this.storage().getItem(this.key) ?? 'null');
      if (position && Number.isFinite(position.scrollTop) && position.scrollTop >= 0
        && typeof position.followBottom === 'boolean') {
        this.saved = { scrollTop: position.scrollTop, followBottom: position.followBottom };
      }
    } catch { /* Unavailable storage or a malformed position starts at the bottom. */ }
  }

  save(position) {
    try {
      this.storage().setItem(this.key, JSON.stringify(position));
      this.saved = { ...position };
      return true;
    } catch {
      return false;
    }
  }
}
