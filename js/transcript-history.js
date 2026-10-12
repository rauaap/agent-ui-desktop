/** Backward paging, independent of DOM and safe across reconnects/pane disposal. */
export class TranscriptHistory {
  constructor(id, store, fetchPage, onError) {
    this.id = id;
    this.store = store;
    this.fetchPage = fetchPage;
    this.onError = onError;
    this.pending = false;
    this.disposed = false;
  }

  async load() {
    const state = this.store.session(this.id);
    const history = state.history;
    if (this.disposed || this.pending || !state.sessionReady
      || this.store.isReplaying(this.id) || !history.hasMore || history.oldest === null) return;
    this.pending = true;
    const epoch = state.connectionEpoch;
    const current = () => !this.disposed && this.store.session(this.id).history === history
      && this.store.session(this.id).connectionEpoch === epoch && !this.store.isReplaying(this.id);
    try {
      const page = await this.fetchPage(this.id, history.oldest);
      if (!current()) return;
      const events = page.messages.map((row) => ({
        ...row.payload, type: row.type, event_id: row.id,
        ...(row.type === 'input' ? { message_id: row.id } : {}),
      }));
      this.store.prependHistory(this.id, events, page.next_cursor, page.has_more);
    } catch (error) {
      if (current()) this.onError?.(error.message);
    } finally {
      this.pending = false;
    }
  }

  destroy() { this.disposed = true; }
}
