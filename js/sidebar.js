/**
 * The project/session tree.
 *
 * Sessions nest under their project rather than living in a second pane: at
 * this scale the whole tree fits on screen, which means every session is one
 * click away and there is only one selection concept to keep straight.
 *
 * `GET /sessions` carries the link on every row and there are no nested project
 * routes, so the grouping happens here — the same thing the Android client
 * does.
 */

const EXPANDED_KEY = 'agent-ui.expanded';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Whether a session belongs to a project.
 *
 * The link is `project_id`: a session running in a worktree has a
 * `working_dir` somewhere else entirely, and matching on the path would drop it
 * out of the list it belongs to. Path equality survives only as the fallback
 * for a server old enough not to send an id — which is also a server old enough
 * to have no worktrees.
 */
const belongsTo = (session, project) => (project.id && session.project_id
  ? session.project_id === project.id
  : session.working_dir === project.path);

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
    // `dataset` hands back a string whatever went in, so the comparison is made
    // between strings explicitly — an id that arrived as a number would match
    // nothing at all, and quietly.
    const wanted = id === null || id === undefined ? null : String(id);
    for (const node of this.root.querySelectorAll('.session')) {
      node.classList.toggle('active', node.dataset.id === wanted);
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

    for (const project of this.projects) {
      const open = this.expanded.has(project.path);
      const sessions = this.sessions.filter((s) => belongsTo(s, project));

      const row = el('button', `project${open ? ' open' : ''}`);
      row.appendChild(el('span', 'twisty', '▸'));
      row.appendChild(el('span', 'pname', project.name || project.path));
      if (project.exists === false) row.appendChild(el('span', 'missing', 'MISSING'));
      row.appendChild(el('span', 'count', String(sessions.length)));

      const forget = el('span', 'close', '×');
      forget.title = 'Forget this project';
      forget.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handlers.onForgetProject(project, sessions);
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
        const active = String(session.id) === String(this.activeId);
        const item = el('button', `session${active ? ' active' : ''}`);
        item.dataset.id = String(session.id);
        item.appendChild(el('span', `dot ${this.statusOf(session)}`));
        item.appendChild(el('span', 'sname', session.name || String(session.id)));
        // A worktree session runs somewhere other than the project directory,
        // which the tree otherwise gives no hint of. The row has no space for
        // a path, so the badge carries it in its tooltip and the pane header
        // spells it out in full.
        if (session.owns_worktree) {
          const mark = el('span', 'wt', 'WT');
          mark.title = `Worktree: ${session.working_dir}`;
          item.appendChild(mark);
        }
        item.title = `${session.name}\n${session.agent}`
          + (session.owns_worktree ? `\n${session.working_dir}` : '');
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
      const session = this.sessions.find((s) => String(s.id) === node.dataset.id);
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
