/**
 * The project/session tree.
 *
 * Sessions nest under their project rather than living in a second pane: at
 * this scale the whole tree fits on screen, which means every session is one
 * click away and there is only one selection concept to keep straight.
 *
 * `GET /sessions` carries `working_dir` on every row and there are no nested
 * project routes, so the grouping happens here — the same thing the Android
 * client does.
 */

const EXPANDED_KEY = 'agent-ui.expanded';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class Sidebar {
  /**
   * @param {HTMLElement} root the <nav> to render into
   * @param {import('./store.js').Store} store
   * @param {object} handlers
   */
  constructor(root, store, handlers) {
    this.root = root;
    this.store = store;
    this.handlers = handlers;
    this.projects = [];
    this.sessions = [];
    this.activeId = null;
    this.expanded = new Set(loadExpanded());
  }

  setData(projects, sessions) {
    this.projects = projects;
    this.sessions = sessions;
    this.render();
  }

  setActive(id) {
    this.activeId = id;
    for (const node of this.root.querySelectorAll('.session')) {
      node.classList.toggle('active', node.dataset.id === id);
    }
  }

  /** Live status wins over the REST snapshot for sessions we have open. */
  statusOf(session) {
    if (this.store.has(session.id)) return this.store.session(session.id).status;
    return session.status || 'idle';
  }

  render() {
    this.root.replaceChildren();

    if (!this.projects.length) {
      this.root.appendChild(el(
        'div',
        'tree-empty',
        'No projects yet. Use + above to create one.',
      ));
      return;
    }

    const byDir = new Map();
    for (const session of this.sessions) {
      const list = byDir.get(session.working_dir) || [];
      list.push(session);
      byDir.set(session.working_dir, list);
    }

    for (const project of this.projects) {
      const open = this.expanded.has(project.path);
      const sessions = byDir.get(project.path) || [];

      const row = el('button', `project${open ? ' open' : ''}`);
      row.appendChild(el('span', 'twisty', '▸'));
      row.appendChild(el('span', 'pname', project.name || project.path));
      if (project.exists === false) row.appendChild(el('span', 'missing', 'MISSING'));
      row.appendChild(el('span', 'count', String(sessions.length)));

      const forget = el('span', 'close', '×');
      forget.title = 'Forget this project';
      forget.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handlers.onForgetProject(project, sessions.length);
      });
      row.appendChild(forget);

      row.addEventListener('click', () => {
        if (this.expanded.has(project.path)) this.expanded.delete(project.path);
        else this.expanded.add(project.path);
        saveExpanded([...this.expanded]);
        this.render();
      });
      this.root.appendChild(row);

      if (!open) continue;

      const list = el('div', 'sessions');
      for (const session of sessions) {
        const item = el('button', `session${session.id === this.activeId ? ' active' : ''}`);
        item.dataset.id = session.id;
        item.appendChild(el('span', `dot ${this.statusOf(session)}`));
        item.appendChild(el('span', 'sname', session.name || session.id.slice(0, 8)));
        item.title = `${session.name}\n${session.agent}`;
        item.addEventListener('click', () => this.handlers.onOpenSession(session));
        list.appendChild(item);
      }

      const add = el('button', 'add-row', '+  New session');
      add.addEventListener('click', () => this.handlers.onNewSession(project));
      list.appendChild(add);

      this.root.appendChild(list);
    }
  }

  /** Refresh just the status dots, without rebuilding the tree. */
  refreshStatuses() {
    for (const node of this.root.querySelectorAll('.session')) {
      const session = this.sessions.find((s) => s.id === node.dataset.id);
      if (!session) continue;
      const dot = node.querySelector('.dot');
      if (dot) dot.className = `dot ${this.statusOf(session)}`;
    }
  }
}

function loadExpanded() {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveExpanded(paths) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(paths));
  } catch {
    /* nothing to do — expansion just won't persist */
  }
}
