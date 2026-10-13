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
 * All retained sessions appear under their project in server order.
 */

import { agentName } from './agents.js';
import { modelLabel } from './models.js';
import { isFormerWorktree } from './worktree.js';
import { directoryExists } from './directory-existence.js';

const EXPANDED_KEY = 'agent-ui.expanded';

/** Shift-click ranges stay within one project's session rows. */
const selectionScopeFor = (project) => String(project.id || project.path);

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
    /** @type {Map<string, object>} worktrees by id, for badges and tooltips. */
    this.worktrees = new Map();
    /** @type {object[]} agents from `GET /agents`, for the tooltip's agent and model names. */
    this.agents = [];
    this.activeId = null;
    this.query = '';
    this.searchCollapsed = new Set();
    this.selectedIds = new Set();
    this.selectionAnchor = null;
    this.selectionScope = null;
    this.expanded = new Set(loadExpanded());
    this.menu = null;
    this.menuTarget = null;

    // Context menus live outside the scrolling tree, so close one whenever the
    // next gesture lands elsewhere or the viewport moves underneath it.
    document.addEventListener('pointerdown', (event) => {
      if (this.menu && !this.menu.contains(event.target)) this.closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeMenu();
    });
    window.addEventListener('blur', () => this.closeMenu());
    window.addEventListener('resize', () => this.closeMenu());
    this.root.addEventListener('scroll', () => this.closeMenu());
  }

  setData(projects, sessions, worktrees = [], agents = [], directoryExistence = {}) {
    const metadataChanged = JSON.stringify([this.projects, [...this.worktrees.values()], this.agents, this.directoryExistence ?? {}])
      !== JSON.stringify([projects, worktrees, agents, directoryExistence]);
    this.directoryExistence = directoryExistence;
    this.projects = projects;
    this.worktrees = new Map(worktrees.map((w) => [String(w.id), w]));
    this.agents = agents;
    if (metadataChanged) {
      this.sessions = sessions;
      this.render();
    } else {
      this.setSessions(sessions);
    }
  }

  /** Search is transient; clearing it restores the saved expansion state. */
  setQuery(value) {
    const query = value.trim().toLowerCase();
    if (query === this.query) return;
    this.query = query;
    this.searchCollapsed.clear();
    this.render();
    this.scrollToTop();
  }

  /** Apply a poll without rebuilding the tree when only status changed. */
  setSessions(sessions) {
    const rerender = sessionRowsChanged(this.sessions, sessions);
    this.sessions = sessions;
    if (rerender) this.render();
    else this.refreshStatuses();
  }

  setActive(id) {
    this.activeId = id;
    const key = id === null || id === undefined ? null : String(id);
    // Activations from outside the tree (for example, a notification) become
    // the new selection. Activating the end of a shift-selected range must not
    // collapse that range again.
    if (key && !this.selectedIds.has(key)) {
      const session = this.sessions.find((row) => String(row.id) === key);
      if (session) {
        const project = this.projects.find((row) => belongsTo(session, row));
        this.selectedIds = new Set([key]);
        this.selectionAnchor = key;
        this.selectionScope = project ? selectionScopeFor(project) : null;
      }
    }
    this.paintSelection();
  }

  /** Follow a newly active project after the server moves it to the top. */
  scrollToTop() {
    this.root.scrollTop = 0;
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
  worktreeNote(session, project) {
    const missing = directoryExists(this.directoryExistence, session.working_dir) === false
      ? '\nthe directory is missing' : '';
    if (isFormerWorktree(session, project.path)) {
      return `Former worktree: ${session.working_dir}${missing}`;
    }
    if (session.worktree_id === null || session.worktree_id === undefined) return null;
    const worktree = this.worktrees.get(String(session.worktree_id));
    const branch = worktree?.branch ? `\ncreated on ${worktree.branch}` : '';
    return `Worktree: ${session.working_dir}${branch}${missing}`;
  }

  /** The selected session's live status wins over its polled catalog row. */
  statusOf(session) {
    if (String(this.activeId) === String(session.id) && this.store.has(session.id)) {
      return this.store.session(session.id).status;
    }
    return session.status || 'idle';
  }

  /** Each project with all matching sessions. */
  groups() {
    return this.projects.map((project) => {
      const projectMatches = (project.name || project.path).toLowerCase().includes(this.query);
      const sessions = this.sessions.filter((session) => belongsTo(session, project)
        && (projectMatches || (session.name || String(session.id)).toLowerCase().includes(this.query)));
      return { project, projectMatches, sessions };
    }).filter((group) => group.projectMatches || group.sessions.length);
  }

  render() {
    this.closeMenu();
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
    for (const group of groups) this.renderProject(group);
    if (!this.root.children.length) {
      this.root.appendChild(el('div', 'tree-empty', 'No matching projects or sessions.'));
    }
  }

  /** One project row plus, when open, its sessions. */
  renderProject(group) {
    const { project, sessions } = group;
    const key = project.path;
    const open = this.query ? !this.searchCollapsed.has(key) : this.expanded.has(key);
    const row = el('button', `project${open ? ' open' : ''}`);
    row.dataset.key = key;
    row.appendChild(el('span', 'twisty', '▸'));
    row.appendChild(el('span', 'pname', project.name || project.path));
    if (project.exists === false) row.appendChild(el('span', 'missing', 'MISSING'));

    const count = el('span', 'count', String(sessions.length));
    count.title = plural(sessions.length, 'session');
    row.appendChild(count);
    row.appendChild(this.gear('⚙', 'Project settings', () => {
      this.handlers.onProjectSettings(project);
    }));

    row.addEventListener('click', () => this.toggle(key));
    this.root.appendChild(row);

    if (!open) return;

    const list = el('div', 'sessions');

    const add = el('button', 'add-row', '+  New session');
    add.addEventListener('click', () => this.handlers.onNewSession(project));
    list.appendChild(add);

    for (const session of sessions) {
      list.appendChild(this.sessionRow(session, project));
    }

    this.root.appendChild(list);
  }

  sessionRow(session, project) {
    const id = String(session.id);
    const active = id === String(this.activeId);
    const selected = this.selectedIds.has(id);
    const scope = selectionScopeFor(project);
    const item = el('button', `session${active ? ' active' : ''}${selected ? ' selected' : ''}`);
    item.dataset.id = id;
    item.dataset.scope = scope;
    item.appendChild(el('span', `dot ${this.statusOf(session)}`));
    item.appendChild(el('span', 'sname', session.name || String(session.id)));
    // A worktree session runs somewhere other than the project directory,
    // which the tree otherwise gives no hint of. The row has no space for
    // a path, so the badge carries it in its tooltip and the pane header
    // spells it out in full.
    const former = isFormerWorktree(session, project.path);
    const where = this.worktreeNote(session, project);
    if (where) {
      const mark = el('span', `wt${former ? ' former' : ''}`, former ? 'FWT' : 'WT');
      mark.title = where;
      item.appendChild(mark);
    }
    if (directoryExists(this.directoryExistence, session.working_dir) === false) {
      item.appendChild(el('span', 'missing', 'MISSING'));
    }
    // The server's label for the agent, falling back to the id it stored —
    // which is what a session started under an agent this server no longer
    // registers shows, rather than nothing.
    const agent = agentName(this.agents, session.agent);
    // A legacy session has no model and shows none.
    const model = modelLabel(this.agents, session.agent, session.model);
    item.title = `${session.name}\n#${id}\n${agent}${model ? ` · ${model}` : ''}`
      + (where ? `\n${where}` : '');
    item.addEventListener('click', (event) => {
      this.selectSession(session, scope, event.shiftKey);
      this.handlers.onOpenSession(session);
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (!this.selectedIds.has(id)) this.selectSession(session, scope, false);
      const selected = this.sessions.filter((row) => this.selectedIds.has(String(row.id)));
      this.openSessionMenu(selected, event.clientX, event.clientY, item);
    });
    return item;
  }

  /** Select one row, or the contiguous range from the anchor in this project. */
  selectSession(session, scope, extend) {
    const id = String(session.id);
    if (extend && this.selectionAnchor && this.selectionScope === scope) {
      const rows = [...this.root.querySelectorAll('.session')]
        .filter((node) => node.dataset.scope === scope);
      const from = rows.findIndex((node) => node.dataset.id === this.selectionAnchor);
      const to = rows.findIndex((node) => node.dataset.id === id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        this.selectedIds = new Set(rows.slice(start, end + 1).map((node) => node.dataset.id));
        this.paintSelection();
        return;
      }
    }

    this.selectedIds = new Set([id]);
    this.selectionAnchor = id;
    this.selectionScope = scope;
    this.paintSelection();
  }

  paintSelection() {
    const active = String(this.activeId);
    for (const node of this.root.querySelectorAll('.session')) {
      node.classList.toggle('active', node.dataset.id === active);
      node.classList.toggle('selected', this.selectedIds.has(node.dataset.id));
    }
  }

  /** A native-sized action menu for one session or a selected range. */
  openSessionMenu(sessions, x, y, anchor) {
    this.closeMenu();
    if (!sessions.length) return;

    const menu = el('div', 'session-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', sessions.length === 1
      ? `Actions for ${sessions[0].name || sessions[0].id}`
      : `Actions for ${sessions.length} sessions`);
    if (sessions.length > 1) {
      menu.appendChild(el('div', 'session-menu-label', `${sessions.length} sessions selected`));
    }

    const action = (label, onClick, danger = false) => {
      const button = el('button', `session-menu-item${danger ? ' danger' : ''}`);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.append(el('span', 'session-menu-mark'), el('span', '', label));
      button.addEventListener('click', () => {
        this.closeMenu();
        onClick();
      });
      menu.appendChild(button);
      return button;
    };

    if (sessions.length === 1) {
      const session = sessions[0];
      let write = !!session.auto_approve_write;
      let command = !!session.auto_approve_command;
      let interAgent = !!session.auto_approve_inter_agent_communication;
      menu.appendChild(el('div', 'session-menu-label', 'Permissions'));

      // These deliberately stay open: turning several permissions on is a
      // common multi-click operation. Keep the local values current so a later
      // PATCH includes the values chosen by earlier clicks.
      const permission = (label, getChecked, setChecked) => {
        const button = el('button', 'session-menu-item');
        button.type = 'button';
        button.setAttribute('role', 'menuitemcheckbox');
        const mark = el('span', 'session-menu-mark session-menu-check');
        button.append(mark, el('span', '', label));
        const paint = () => {
          const checked = getChecked();
          button.setAttribute('aria-checked', String(checked));
          mark.textContent = checked ? '✓' : '';
        };
        paint();
        button.addEventListener('click', () => {
          setChecked(!getChecked());
          paint();
          session.auto_approve_write = write;
          session.auto_approve_command = command;
          session.auto_approve_inter_agent_communication = interAgent;
          this.handlers.onPermissions(session, write, command, interAgent);
        });
        menu.appendChild(button);
      };
      permission('Auto-approve writes', () => write, (value) => { write = value; });
      permission('Auto-approve commands', () => command, (value) => { command = value; });
      permission('Auto-approve inter-agent communication',
        () => interAgent, (value) => { interAgent = value; });
      menu.appendChild(el('div', 'session-menu-separator'));
    }

    // Names are not unique; the id is what a user hands to an agent.
    action(sessions.length > 1 ? `Copy ${sessions.length} session IDs` : 'Copy session ID', () => {
      this.handlers.onCopyIds(sessions);
    });
    action(`Delete${sessions.length > 1 ? ` ${sessions.length} sessions` : ''}…`,
      () => this.handlers.onDeleteSessions(sessions), true);

    document.body.appendChild(menu);
    this.menu = menu;
    this.menuTarget = anchor;
    anchor.classList.add('context-target');

    // Keyboard-opened context menus report (0, 0); put those beside the row.
    const rect = anchor.getBoundingClientRect();
    const requestedX = x || rect.left + 16;
    const requestedY = y || rect.bottom;
    const gap = 8;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(gap, Math.min(requestedX, window.innerWidth - bounds.width - gap))}px`;
    menu.style.top = `${Math.max(gap, Math.min(requestedY, window.innerHeight - bounds.height - gap))}px`;
    menu.querySelector('.session-menu-item')?.focus();
  }

  closeMenu() {
    this.menu?.remove();
    this.menuTarget?.classList.remove('context-target');
    this.menu = null;
    this.menuTarget = null;
  }

  toggle(key) {
    // Search-only collapses last until the query changes, not in saved layout.
    if (this.query) {
      if (this.searchCollapsed.has(key)) this.searchCollapsed.delete(key);
      else this.searchCollapsed.add(key);
      this.render();
      return;
    }
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    saveExpanded([...this.expanded]);
    this.render();
  }

  /**
   * Expand whichever part of the tree holds a session opened from elsewhere —
   * an agent message's sender can be in any project — and scroll to its row.
   */
  revealSession(session) {
    const project = this.projects.find((row) => belongsTo(session, row));
    if (!project) return;
    const keys = [project.path];
    if (this.query && keys.some((key) => this.searchCollapsed.has(key))) {
      for (const key of keys) this.searchCollapsed.delete(key);
      this.render();
    } else if (!this.query && keys.some((key) => !this.expanded.has(key))) {
      for (const key of keys) this.expanded.add(key);
      saveExpanded([...this.expanded]);
      this.render();
    }
    const row = this.root.querySelector(`.session[data-id="${cssEscape(String(session.id))}"]`);
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

const ROW_FIELDS = [
  'id', 'project_id', 'name', 'working_dir', 'worktree_id', 'agent',
  'last_active_at',
];

/** Whether a poll changed anything represented by the tree beyond its dots. */
function sessionRowsChanged(before, after) {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    if (ROW_FIELDS.some((field) => before[i]?.[field] !== after[i]?.[field])) return true;
  }
  return false;
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
