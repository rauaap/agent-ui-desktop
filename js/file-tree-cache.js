/** DOM-free state for the revisioned file-tree wire protocol. */

const isRevision = (value) => Number.isInteger(value) && value >= 0;

/** Wire paths are relative, normalized, and use a trailing slash for directories. */
export function isWirePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/')) return false;
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!path) return false;
  const components = path.split('/');
  return components.every((component) => component && component !== '.' && component !== '..');
}

function validPathArray(value) {
  if (!Array.isArray(value) || !value.every(isWirePath)) return false;
  return new Set(value).size === value.length;
}

export class FileTreeCache {
  constructor() {
    this.generation = null;
    this.revision = null;
    this.paths = new Set();
    this.searchPaths = [];
    this.state = 'unavailable';
    this.message = '';
  }

  connecting() {
    this.clear('connecting');
  }

  unavailable(message = '') {
    this.clear('unavailable', message);
  }

  clear(state, message = '') {
    this.generation = null;
    this.revision = null;
    this.paths.clear();
    this.searchPaths = [];
    this.state = state;
    this.message = message;
  }

  /**
   * Apply one decoded frame. Returns false when the frame is malformed or is
   * not the next frame in this generation; callers must reconnect in that case.
   */
  apply(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false;

    if (frame.type === 'file_tree_snapshot') {
      if (typeof frame.generation !== 'string' || !frame.generation
          || !isRevision(frame.revision) || !validPathArray(frame.paths)) return false;
      this.generation = frame.generation;
      this.revision = frame.revision;
      this.paths = new Set(frame.paths);
      this.rebuildSearch();
      this.state = 'ready';
      this.message = '';
      return true;
    }

    if (frame.type === 'file_tree_patch') {
      if (typeof frame.generation !== 'string' || !frame.generation
          || !isRevision(frame.base_revision) || !isRevision(frame.revision)
          || frame.revision !== frame.base_revision + 1
          || !validPathArray(frame.added) || !validPathArray(frame.removed)) return false;
      if (this.state !== 'ready' || frame.generation !== this.generation
          || frame.base_revision !== this.revision) return false;
      const removed = new Set(frame.removed);
      if (frame.added.some((path) => removed.has(path))) return false;
      for (const path of frame.removed) this.paths.delete(path);
      for (const path of frame.added) this.paths.add(path);
      this.revision = frame.revision;
      this.rebuildSearch();
      return true;
    }

    return false;
  }

  rebuildSearch() {
    // Keep the original spelling beside its locale-independent search form.
    this.searchPaths = [...this.paths].map((path) => ({ path, lower: path.toLowerCase() }));
  }
}
