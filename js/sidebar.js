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
 *
 * Neither list endpoint filters the archive out, so the split is this file's
 * job too: the tree proper holds what is live, and an **Archived** section
 * below it holds the rest in the same project -> session shape. See
 * `archive.js` for the rules its ordering follows.
 */

import { agentName } from './agents.js';
import { byArchivedAt, filedAt, filedLabel, isArchived, partition } from './archive.js';

const EXPANDED_KEY = 'agent-ui.expanded';

/**
 * Expansion is remembered per row, and a project with archived sessions is
 * drawn in both halves, so the archive's keys are prefixed to keep the two
 * copies independent — collapsing a project in the archive should not collapse
 * it above. A project path is always absolute, so nothing it could be can
 * collide with these.
 */
const SECTION_KEY = 'archived';
const archiveKey = (project) => `archived:${project.path}`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
    for (const node of this.root.querySelectorAll('.session')) {
      node.classList.toggle('active', node.dataset.id === String(id));
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

  /** Each project with its sessions split by the server's `archived_at`. */
  groups() {
    return this.projects.map((project) => ({
      project,
      ...partition(this.sessions.filter((s) => belongsTo(s, project))),
    }));
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

    const groups = this.groups();
    // An archived project leaves the tree entirely — that is what archiving it
    // was for — and by the server's own invariant it has no live sessions to
    // strand up here. A live project stays put however many of its sessions
    // have been filed away.
    for (const group of groups) {
      if (!isArchived(group.project)) this.renderProject(group, false);
    }

    // A project belongs in the archive if it is archived itself, or if any of
    // its sessions are: an archived session has to be reachable under the
    // project it was created in either way.
    const filed = groups.filter((g) => isArchived(g.project) || g.archived.length);
    if (filed.length) this.renderArchive(filed);
  }

  /** One project row plus, when open, its sessions. */
  renderProject(group, inArchive) {
    const { project } = group;
    const sessions = inArchive ? byArchivedAt(group.archived) : group.live;
    const key = inArchive ? archiveKey(project) : project.path;
    const open = this.expanded.has(key);
    // Inside the archive, a project that is *itself* archived is a different
    // thing from a live one that merely holds archived sessions: only the
    // former can be brought back, and only the former is dimmed.
    const projectArchived = isArchived(project);

    const row = el('button', `project${open ? ' open' : ''}`
      + `${inArchive && projectArchived ? ' archived' : ''}`);
    row.dataset.key = key;
    row.appendChild(el('span', 'twisty', '▸'));
    row.appendChild(el('span', 'pname', project.name || project.path));
    if (project.exists === false) row.appendChild(el('span', 'missing', 'MISSING'));

    if (inArchive) {
      const count = el('span', 'count', String(group.archived.length));
      count.title = projectArchived
        ? `Archived ${filedLabel(project.archived_at)} · `
          + `${plural(group.archived.length, 'session')} filed with it`
        : plural(group.archived.length, 'archived session');
      row.appendChild(count);
    } else {
      // Archived sessions are deliberately not folded into this count — the
      // server keeps the two apart, and so does the row: the badge beside it
      // says how many are filed away, and opens the archive at this project.
      const count = el('span', 'count', String(group.live.length));
      count.title = plural(group.live.length, 'live session');
      row.appendChild(count);
      if (group.archived.length) {
        const badge = el('span', 'archived-count', `${group.archived.length} archived`);
        badge.title = 'Show these in the archive';
        badge.addEventListener('click', (event) => {
          event.stopPropagation();
          this.reveal(project);
        });
        row.appendChild(badge);
      }
    }

    // The one-click way back, on the rows that are the archive. Safe and
    // reversible, unlike forgetting — which is why that one stays behind the
    // gear and its second confirmation, and this does not.
    if (inArchive && projectArchived) {
      row.appendChild(this.gear('⤺', 'Unarchive this project and the sessions it filed', () => {
        this.handlers.onUnarchiveProject(project);
      }));
    }
    // A live project's settings belong on its live row; a project that has left
    // the tree has no other row to carry them.
    if (!inArchive || projectArchived) {
      row.appendChild(this.gear('⚙', 'Project settings', () => {
        this.handlers.onProjectSettings(project);
      }));
    }

    row.addEventListener('click', () => this.toggle(key));
    this.root.appendChild(row);

    if (!open) return;

    const list = el('div', 'sessions');
    for (const session of sessions) list.appendChild(this.sessionRow(session, inArchive));

    // No "New session" in the archive: the server refuses one in an archived
    // project, and in a live project it would land in the tree above, several
    // rows from where it was asked for.
    if (!inArchive) {
      const add = el('button', 'add-row', '+  New session');
      add.addEventListener('click', () => this.handlers.onNewSession(project));
      list.appendChild(add);
    }

    this.root.appendChild(list);
  }

  sessionRow(session, inArchive) {
    const active = String(session.id) === String(this.activeId);
    const item = el('button', `session${active ? ' active' : ''}${inArchive ? ' archived' : ''}`);
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
    if (inArchive) {
      // Unarchiving from the row rather than only from session settings: those
      // are behind opening the session, which is the one thing archiving says
      // you are done doing.
      item.appendChild(this.gear('⤺', 'Unarchive this session', () => {
        this.handlers.onUnarchiveSession(session);
      }));
    }
    // The server's label for the agent, falling back to the id it stored —
    // which is what a session started under an agent this server no longer
    // registers shows, rather than nothing.
    const agent = agentName(this.agents, session.agent);
    item.title = `${session.name}\n${agent}` + (where ? `\n${where}` : '')
      + (inArchive ? `\nArchived ${filedLabel(session.archived_at)}` : '');
    item.addEventListener('click', () => this.handlers.onOpenSession(session));
    return item;
  }

  renderArchive(groups) {
    const open = this.expanded.has(SECTION_KEY);
    const total = groups.reduce((sum, g) => sum + g.archived.length, 0);

    const head = el('button', `tree-section${open ? ' open' : ''}`);
    head.appendChild(el('span', 'twisty', '▸'));
    head.appendChild(el('span', 'pname', 'Archived'));
    head.appendChild(el('span', 'count', String(total)));
    head.title = `${plural(total, 'archived session')} in ${plural(groups.length, 'project')}`;
    head.addEventListener('click', () => this.toggle(SECTION_KEY));
    this.root.appendChild(head);

    if (!open) return;
    // Most recently filed first, which is not the order the server sent: it
    // sorts projects by last activity, and an archived project's is always
    // null, so its list arrives with the archive heaped at the end.
    for (const group of [...groups].sort(compareGroups)) this.renderProject(group, true);
  }

  toggle(key) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    saveExpanded([...this.expanded]);
    this.render();
  }

  /** Open the archive at one project — where its "N archived" badge points. */
  reveal(project) {
    this.expanded.add(SECTION_KEY);
    this.expanded.add(archiveKey(project));
    saveExpanded([...this.expanded]);
    this.render();
    const row = this.root.querySelector(`[data-key="${cssEscape(archiveKey(project))}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }

  /**
   * A small trailing control on a row, which must not also select the row.
   * A span rather than a button because the row is itself a button.
   */
  gear(glyph, title, onClick) {
    const node = el('span', 'gear', glyph);
    node.title = title;
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return node;
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

/** Newest-filed first, over whichever timestamp put the project in the archive. */
function compareGroups(a, b) {
  const left = filedAt(a.project, a.archived);
  const right = filedAt(b.project, b.archived);
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left < right ? 1 : -1;
}

/** A project path can hold quotes and backslashes; an attribute selector can't. */
const cssEscape = (value) => (typeof CSS !== 'undefined' && CSS.escape
  ? CSS.escape(value)
  : value.replace(/["\\]/g, '\\$&'));

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
