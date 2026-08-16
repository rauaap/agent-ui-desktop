/**
 * Bootstrap and wiring.
 *
 * Everything stateful lives in the modules this pulls together — the store owns
 * transcript state, the workspace owns open tabs and their sockets, the sidebar
 * owns the tree. This file is the plumbing between them and the REST API.
 */

import * as api from './api.js';
import { Store } from './store.js';
import { Sidebar } from './sidebar.js';
import { Workspace } from './tabs.js';
import { Notifier } from './notify.js';
import {
  confirmDialog,
  forgetProjectDialog,
  newProjectDialog,
  newSessionDialog,
  noticeDialog,
  sessionSettingsDialog,
} from './dialogs.js';

const store = new Store();
const notifier = new Notifier(store);

/** Server-side session rows from the last refresh, by id. */
let sessionsById = new Map();

/* ------------------------------------------------------------------ */
/* toasts                                                             */
/* ------------------------------------------------------------------ */

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = `toast${isError ? ' error' : ''}`;
  node.textContent = message;
  document.getElementById('toasts').appendChild(node);
  setTimeout(() => node.remove(), isError ? 6000 : 3000);
}

const fail = (error) => toast(error?.message || String(error), true);

/* ------------------------------------------------------------------ */
/* wiring                                                             */
/* ------------------------------------------------------------------ */

const workspace = new Workspace(
  {
    strip: document.getElementById('tabstrip'),
    panes: document.getElementById('panes'),
    empty: document.getElementById('empty-state'),
  },
  store,
  {
    onSettings: openSessionSettings,
    onStop: stopSession,
    onError: (message) => toast(message, true),
    onLiveEvent: (id, event) => {
      notifier.observe(id, event);
      // A turn ending or a rename changes what the tree should show.
      if (event.type === 'status' || event.type === 'renamed') sidebar.refreshStatuses();
    },
    onActiveChange: (id) => {
      notifier.setActive(id);
      sidebar.setActive(id);
    },
  },
);

const sidebar = new Sidebar(document.getElementById('tree'), store, {
  onOpenSession: (session) => {
    store.setMeta(session.id, metaFrom(session));
    workspace.openSession(session.id);
  },
  onNewSession: createSession,
  onForgetProject: forgetProject,
});

notifier.onActivate = (id) => {
  if (workspace.isOpen(id)) workspace.activate(id);
};

// Coming back to the browser tab retires the notification for whichever session
// is on screen; the notifier decides, since it is the same rule that stops one
// from firing there. `focus` covers returning from another window, where the
// document stayed visible and `visibilitychange` never fires.
const dismissNotifications = () => notifier.dismissActive();
document.addEventListener('visibilitychange', dismissNotifications);
window.addEventListener('focus', dismissNotifications);

/** Map a server session row onto the store's metadata fields. */
const metaFrom = (session) => ({
  name: session.name,
  workingDir: session.working_dir,
  ownsWorktree: !!session.owns_worktree,
  agent: session.agent,
  status: session.status,
  autoApproveWrite: !!session.auto_approve_write,
  autoApproveCommand: !!session.auto_approve_command,
});

/* ------------------------------------------------------------------ */
/* data                                                               */
/* ------------------------------------------------------------------ */

async function refresh() {
  try {
    const [projects, sessions] = await Promise.all([api.listProjects(), api.listSessions()]);
    sessionsById = new Map(sessions.map((s) => [s.id, s]));

    // Seed metadata for sessions we have not opened, so the tree and any
    // restored tab show a name before their socket says anything.
    for (const session of sessions) {
      if (!workspace.isOpen(session.id)) store.setMeta(session.id, metaFrom(session));
    }

    sidebar.setData(projects, sessions);
    sidebar.setActive(workspace.activeId);
    workspace.pruneMissing(new Set(sessionsById.keys()));
    return { projects, sessions };
  } catch (error) {
    fail(error);
    return { projects: [], sessions: [] };
  }
}

/* ------------------------------------------------------------------ */
/* actions                                                            */
/* ------------------------------------------------------------------ */

async function createProject() {
  const spec = await newProjectDialog();
  if (!spec) return;
  try {
    await api.createProject(spec.path, spec.name);
    await refresh();
  } catch (error) {
    fail(error);
  }
}

async function forgetProject(project, sessions) {
  const worktrees = sessions.filter((s) => s.owns_worktree).length;
  if (!(await forgetProjectDialog(project, sessions.length, worktrees))) return;
  try {
    const result = await api.deleteProject(project.path);
    await refresh();
    const removed = result?.sessions_deleted ?? 0;
    toast(removed
      ? `Forgot ${project.name} and ${removed} session${removed === 1 ? '' : 's'}`
      : `Forgot ${project.name}`);
    reportWorktreesLeft(result?.worktree_errors);
  } catch (error) {
    fail(error);
  }
}

/**
 * Say which of a project's worktrees git declined to remove. Removal is never
 * forced and git counts untracked files as dirty, so any session that created
 * a file leaves one behind: this is the common outcome, not a failure.
 */
function reportWorktreesLeft(errors) {
  if (!errors?.length) return;
  const one = errors.length === 1;
  noticeDialog(
    'Worktrees left in place',
    `${one ? 'One worktree' : `${errors.length} worktrees`} still had uncommitted or untracked `
    + `files, so ${one ? 'it was' : 'they were'} left on disk. The project and its sessions are `
    + 'forgotten either way.',
    errors.map((e) => `${e.session} — ${e.path}\n${e.error}`),
  );
}

async function createSession(project) {
  const spec = await newSessionDialog(project);
  if (!spec) return;
  try {
    // A worktree that could not be created means no session at all, so the
    // failure lands as a toast and nothing is opened — rather than dropping the
    // user into a session running somewhere they did not expect.
    const session = await api.createSession(spec.name, project.path, spec.agent, spec.worktree);
    await refresh();
    store.setMeta(session.id, metaFrom(session));
    workspace.openSession(session.id);
  } catch (error) {
    fail(error);
  }
}

async function stopSession(id) {
  try {
    await api.stopSession(id);
  } catch (error) {
    fail(error);
  }
}

async function openSessionSettings(id) {
  const state = store.session(id);
  const before = { name: state.name, write: state.autoApproveWrite, command: state.autoApproveCommand };
  const result = await sessionSettingsDialog(state);
  if (!result) return;

  if (result.deleted) {
    const confirmed = await confirmDialog(
      `Delete “${state.name}”?`,
      state.ownsWorktree
        ? 'The session and its whole transcript are removed, and so is its worktree at '
          + `${state.workingDir} — unless that still holds uncommitted or untracked files, in `
          + 'which case it is left in place. The project directory is untouched either way.'
        : 'The session and its whole transcript are removed. Files the agent wrote stay on disk.',
    );
    if (!confirmed) return;
    try {
      const outcome = await api.deleteSession(id);
      workspace.closeSession(id);
      store.forget(id);
      await refresh();
      if (outcome?.worktree_error) {
        noticeDialog(
          'Worktree left in place',
          'The session was deleted, but its worktree still has uncommitted or untracked files, '
          + 'so it was left on disk.',
          [`${state.workingDir}\n${outcome.worktree_error}`],
        );
      }
    } catch (error) {
      fail(error);
    }
    return;
  }

  try {
    // PATCH is a partial update, so only send what actually changed.
    if (result.name && result.name !== before.name) {
      await api.renameSession(id, result.name);
    }
    if (result.autoApproveWrite !== before.write
        || result.autoApproveCommand !== before.command) {
      await api.setAutoApprove(id, result.autoApproveWrite, result.autoApproveCommand);
    }
    // The server broadcasts `renamed` and `settings` to every subscriber, so the
    // store updates itself; refresh only the tree, which has no socket.
    await refresh();
  } catch (error) {
    fail(error);
  }
}

/* ------------------------------------------------------------------ */
/* chrome                                                             */
/* ------------------------------------------------------------------ */

document.getElementById('new-project-btn').addEventListener('click', createProject);
document.getElementById('refresh-btn').addEventListener('click', () => refresh());

// Collapsing the sidebar gives the transcript the full window, for reading a
// wide diff. Persisted like the rest of the workspace state.
const SIDEBAR_KEY = 'agent-ui.sidebar-collapsed';
const appEl = document.getElementById('app');
const sidebarToggle = document.getElementById('sidebar-toggle');

const paintSidebarToggle = () => {
  const collapsed = appEl.classList.contains('sidebar-collapsed');
  sidebarToggle.title = collapsed ? 'Show the sidebar' : 'Hide the sidebar';
};

try {
  if (localStorage.getItem(SIDEBAR_KEY) === '1') appEl.classList.add('sidebar-collapsed');
} catch {
  /* nothing to restore */
}
paintSidebarToggle();

sidebarToggle.addEventListener('click', () => {
  const collapsed = appEl.classList.toggle('sidebar-collapsed');
  paintSidebarToggle();
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch {
    /* the toggle still works, it just won't be remembered */
  }
});

// A notification bell in the sidebar header: one switch for every session,
// since every open tab is already being watched.
const bell = document.createElement('button');
bell.className = 'icon-btn';
bell.textContent = '🔔';
const paintBell = () => {
  bell.style.opacity = notifier.enabled ? '1' : '0.4';
  bell.title = notifier.enabled
    ? 'Desktop notifications on — click to mute'
    : 'Desktop notifications off — click to enable';
};
bell.addEventListener('click', async () => {
  const wanted = !notifier.enabled;
  await notifier.setEnabled(wanted);
  if (wanted && !notifier.enabled) {
    toast('The browser has blocked notifications for this site', true);
  }
  paintBell();
});
paintBell();
document.querySelector('.sidebar-head').insertBefore(
  bell,
  document.getElementById('new-project-btn'),
);

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  const { sessions } = await refresh();
  const known = new Set(sessions.map((s) => s.id));
  // Restore the tabs that were open last time, skipping any that have since
  // been deleted server-side.
  for (const id of Workspace.restoreIds()) {
    if (known.has(id)) workspace.openSession(id);
  }
})();
