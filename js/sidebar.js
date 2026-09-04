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

import { agentName } from './agents.js';

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
export const belongsTo = (session, project) => (project.id && session.project_id
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
    /** @type {Map<string, object>} worktrees by id, for the badge's tooltip. */
    this.worktrees = new Map();
    /** @type {object[]} agents from `GET /agents`, for the tooltip's label. */
    this.agents = [];
    this.activeId = null;
    this.expanded = new Set(loadExpanded());
  }

  setData(projects, sessions, worktrees = [], agents = []) {
    this.projects = projects;
    this.sessions = sessions;
    this.worktrees = new Map(worktrees.map((w) => [String(w.id), w]));
    this.agents = agents;
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

  /**
   * A line describing where a worktree session runs, or null for one running in
   * the project directory.
   *
   * `working_dir` is the authority on the directory — the server computes it —
   * and the worktree row adds the branch it was created on, when we have it.
   * That branch is not live state: an agent can switch branches in there and
   * nothing updates, hence "created on" rather than a bare branch name.
   */
  worktreeNote(session) {
    if (session.worktree_id === null || session.worktree_id === undefined) return null;
    const worktree = this.worktrees.get(String(session.worktree_id));
    const branch = worktree?.branch ? `\ncreated on ${worktree.branch}` : '';
    const missing = worktree?.exists === false ? '\nthe directory is missing' : '';
    return `Worktree: ${session.working_dir}${branch}${missing}`;
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

      // A gear rather than the bare × this used to be: forgetting a project
      // takes its sessions and their transcripts with it, which is too much to
      // hang off one click on a row you were only trying to expand. It now sits
      // inside the settings dialog behind a second confirmation — the same
      // shape as deleting a session, which was never a one-click affordance in
      // the tree either.
      const settings = el('span', 'gear', '⚙');
      settings.title = 'Project settings';
      settings.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handlers.onProjectSettings(project);
      });
      row.appendChild(settings);

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
        const where = this.worktreeNote(session);
        if (where) {
          const mark = el('span', 'wt', 'WT');
          mark.title = where;
          item.appendChild(mark);
        }
        // The server's label for the agent, falling back to the id it stored —
        // which is what a session started under an agent this server no longer
        // registers shows, rather than nothing.
        const agent = agentName(this.agents, session.agent);
        item.title = `${session.name}\n${agent}` + (where ? `\n${where}` : '');
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
