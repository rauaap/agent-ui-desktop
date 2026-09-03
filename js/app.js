/**
 * Bootstrap and wiring.
 *
 * Everything stateful lives in the modules this pulls together — the store owns
 * transcript state, the workspace owns open tabs and their sockets, the sidebar
 * owns the tree. This file is the plumbing between them and the REST API.
 */

import * as api from './api.js';
import { partition } from './archive.js';
import { Store, isBusy } from './store.js';
import { Sidebar, belongsTo } from './sidebar.js';
import { Workspace } from './tabs.js';
import { Notifier } from './notify.js';
import {
  appSettingsDialog,
  confirmDialog,
  createWorktreeDialog,
  forgetProjectDialog,
  newProjectDialog,
  newSessionDialog,
  noticeDialog,
  projectSettingsDialog,
  sessionSettingsDialog,
  setWorktreeTemplate,
  worktreeTemplate,
} from './dialogs.js';
import { baseOf, normalize } from './worktree.js';

const store = new Store();
const notifier = new Notifier(store);

/** Server-side rows from the last refresh. */
let projects = [];
let sessionsById = new Map();
let worktrees = [];
/** The agents `GET /agents` last offered — see `js/agents.js`. */
let agents = [];

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
    onUnarchive: (id) => setSessionArchived(id, false),
    onError: (message) => toast(message, true),
    onLiveEvent: (id, event) => {
      notifier.observe(id, event);
      // A turn ending or a rename changes what the tree should show.
      if (event.type === 'status' || event.type === 'renamed') sidebar.refreshStatuses();
      // Archiving moves a row between the two halves of the tree, which the
      // dots-only repaint cannot do — and this event is how an archive
      // performed on another device reaches us at all. The server also sends it
      // on connect, so it is only news when it disagrees with the last refresh;
      // otherwise opening a tab would refetch both lists for nothing.
      if (event.type === 'archived'
          && (event.archived_at ?? null) !== (sessionsById.get(id)?.archived_at ?? null)) {
        refresh();
      }
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
  onProjectSettings: openProjectSettings,
  onUnarchiveProject: (project) => setProjectArchived(project, false),
  onUnarchiveSession: (session) => setSessionArchived(session.id, false),
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
window.addEventListener('focus', () => {
  dismissNotifications();
  // There is no global archive feed: a device with no session open cannot hear
  // that another one archived a project or session. Focus is a natural point
  // at which this client catches up with server state, without adding polling.
  refresh();
});

/**
 * Map a server session row onto the store's metadata fields.
 *
 * `working_dir` is still the cwd the agent runs in and still means exactly what
 * it did; the server computes it now rather than storing it, which is invisible
 * from here. `worktree_id` is what says whether that cwd is a worktree.
 */
const metaFrom = (session) => ({
  name: session.name,
  workingDir: session.working_dir,
  worktreeId: session.worktree_id ?? null,
  agent: session.agent,
  status: session.status,
  archivedAt: session.archived_at ?? null,
  autoApproveWrite: !!session.auto_approve_write,
  autoApproveCommand: !!session.auto_approve_command,
});

/* ------------------------------------------------------------------ */
/* data                                                               */
/* ------------------------------------------------------------------ */

async function refresh() {
  try {
    // Worktrees come along unfiltered: they are wanted in three places — the
    // tree's tooltips, the new-session picker and project settings — and one
    // list is cheaper than a filtered fetch each time a dialog opens.
    // The agent list changes only when the server is upgraded or restarted, so
    // it rides along with the refresh button rather than being fetched once at
    // startup — and it fails on its own, keeping whatever it last knew: an
    // agent picker is not worth failing the tree over, and a server too old for
    // the endpoint should still list its projects.
    const [nextProjects, sessions, nextWorktrees, nextAgents] = await Promise.all([
      api.listProjects(),
      api.listSessions(),
      api.listWorktrees(),
      api.listAgents().catch(() => agents),
    ]);
    projects = nextProjects;
    worktrees = nextWorktrees;
    agents = nextAgents;
    // Keyed by the string form, like every other id-keyed collection here: a
    // `Map` or `Set` lookup is type-sensitive, and `has(1)` misses a key of
    // `"1"` without saying so.
    sessionsById = new Map(sessions.map((s) => [String(s.id), s]));

    // Seed metadata for sessions we have not opened, so the tree and any
    // restored tab show a name before their socket says anything.
    for (const session of sessions) {
      if (!workspace.isOpen(session.id)) store.setMeta(session.id, metaFrom(session));
    }

    sidebar.setData(projects, sessions, worktrees, agents);
    sidebar.setActive(workspace.activeId);
    workspace.pruneMissing(new Set(sessionsById.keys()));
    return { projects, sessions, worktrees };
  } catch (error) {
    fail(error);
    return { projects: [], sessions: [], worktrees: [] };
  }
}

/** The project's sessions, from the last refresh — grouped as the tree does. */
const sessionsFor = (project) => [...sessionsById.values()]
  .filter((s) => belongsTo(s, project));

/** The project's worktrees, from the last refresh. */
const worktreesFor = (project) => worktrees
  .filter((w) => String(w.project_id) === String(project.id));

/** How many sessions are attached to a worktree, by the last refresh. */
const sessionsOnWorktree = (worktreeId) => [...sessionsById.values()]
  .filter((s) => s.worktree_id !== null
    && s.worktree_id !== undefined
    && String(s.worktree_id) === String(worktreeId)).length;

/** The project the settings example should expand against. */
const sampleProject = () => [...projects]
  .sort((a, b) => String(b.last_active_at ?? '').localeCompare(String(a.last_active_at ?? '')))[0];

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

/**
 * Project settings. The dialog itself changes nothing about the project beyond
 * archiving it — the server has no other route that updates one — so it reports
 * what `GET /projects` says, lists the project's worktrees, and hands back
 * whichever action was chosen, all of which already live here.
 *
 * A loop rather than one shot, because managing worktrees is the one thing here
 * you do more than once: removing one drops you back into the list, refreshed.
 */
async function openProjectSettings(project) {
  for (let current = project; current;) {
    const sessions = sessionsFor(current);
    const result = await projectSettingsDialog(
      current,
      sessions,
      worktreesFor(current),
      // Named in the dialog so the refusal is visible before the button rather
      // than after it. Not a substitute for handling the 409: a session running
      // a shell command stays `idle` here and is busy to the server.
      partition(sessions).live.filter((s) => isBusy(statusOf(s))),
    );
    if (result?.action === 'forget') {
      await forgetProject(current);
      return;
    }
    if (result?.action === 'session') {
      await createSession(current);
      return;
    }
    // Archiving a project is the gesture for being done with it, so it closes
    // the dialog rather than reopening it over a tree the project has just left.
    if (result?.action === 'archive' || result?.action === 'unarchive') {
      const archiving = result.action === 'archive';
      if (archiving) {
        // Use the counts on the project row: those are the contract's live and
        // archived totals, and together are the real size of the cascade the
        // confirmation has to disclose before making the single PATCH.
        const reported = Number(current.session_count)
          + Number(current.archived_session_count);
        const total = Number.isFinite(reported) ? reported : sessions.length;
        const title = total
          ? `Archive “${current.name || current.path}” and ${total} session${total === 1 ? '' : 's'}?`
          : `Archive “${current.name || current.path}”?`;
        const confirmed = await confirmDialog(
          title,
          'The project and its sessions stay readable, but no new work can start until they '
          + 'are unarchived.'
          + (worktreesFor(current).length
            ? ' Its worktrees are not archived or removed; they stay on disk as they are.'
            : ''),
          'Archive',
          false,
        );
        if (!confirmed) return;
      }
      await setProjectArchived(current, archiving);
      return;
    }
    if (result?.action === 'worktree-new') await createWorktreeFor(current, '');
    else if (result?.action === 'worktree-delete') await removeWorktree(result.worktree);
    else return;
    // Both actions refreshed; re-resolve so the reopened dialog shows the
    // project as it is now, and give up on one that has gone away meanwhile.
    current = projects.find((p) => String(p.id) === String(current.id));
  }
}

/**
 * Archive or unarchive a whole project. One call: the server cascades to the
 * sessions, and a 409 means it wrote nothing at all — including for the idle
 * sessions — so there is no partial state to reconcile, just a refresh.
 */
async function setProjectArchived(project, archived) {
  try {
    const result = await api.setProjectArchived(project.path, archived);
    await refresh();
    // `sessions_affected` is the server's own count of what moved, which is not
    // the same as how many sessions the project has: unarchiving restores only
    // what this project's archive swept up, leaving anything filed by hand.
    const moved = result?.sessions_affected ?? 0;
    const sessionResult = archived
      ? `${moved} session${moved === 1 ? '' : 's'} newly archived`
      : `${moved} session${moved === 1 ? '' : 's'} restored`;
    // Report zero too. In particular, an unarchive can honestly restore no
    // sessions because all of them had been archived by hand beforehand.
    toast(`${archived ? 'Archived' : 'Unarchived'} ${project.name || project.path}; ${sessionResult}`);
  } catch (error) {
    fail(error);
  }
}

/**
 * Archive or unarchive one session.
 *
 * Unarchiving one silently unarchives its project too, when that project was
 * archived — so both lists are stale afterwards and this refetches rather than
 * patching the tree in place.
 */
async function setSessionArchived(id, archived) {
  try {
    await api.setSessionArchived(id, archived);
    await refresh();
    toast(archived ? 'Session archived' : 'Session unarchived');
  } catch (error) {
    fail(error);
  }
}

/** The live status if the session is open, else the last one the list gave. */
const statusOf = (session) => (store.has(session.id)
  ? store.session(session.id).status
  : session.status || 'idle');

async function forgetProject(project) {
  const sessions = sessionsFor(project);
  const confirmed = await forgetProjectDialog(
    project,
    sessions.length,
    worktreesFor(project).length,
    partition(sessions).archived.length,
  );
  if (!confirmed) return;
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
 * forced and git counts untracked files as dirty, so any worktree an agent did
 * real work in is left behind: this is the common outcome, not a failure — the
 * same category of message as "the project's own directory is untouched".
 */
function reportWorktreesLeft(errors) {
  if (!errors?.length) return;
  const one = errors.length === 1;
  noticeDialog(
    'Worktrees left in place',
    `${one ? 'One worktree' : `${errors.length} worktrees`} still had uncommitted or untracked `
    + `files, so ${one ? 'its directory was' : 'their directories were'} left on disk. The `
    + 'project, its sessions and the rest of its worktrees are forgotten either way.',
    errors.map((e) => `${e.path}\n${e.error}`),
  );
}

/* ------------------------------------------------------------------ */
/* worktrees                                                          */
/* ------------------------------------------------------------------ */

/**
 * Create a worktree for a project, resolving with it — or with the one already
 * at that path, which is a routine outcome rather than an edge case: a template
 * maps a branch to the same path every time.
 *
 * The request runs while the form is still open, so a `400` carrying git's own
 * words about the branch name lands under the fields the user can fix. Nothing
 * is created on disk when it fails.
 */
function createWorktreeFor(project, branchSeed) {
  return createWorktreeDialog(
    project,
    worktreesFor(project),
    worktreeTemplate(),
    branchSeed,
    async (spec) => {
      try {
        const worktree = await api.createWorktree(project.path, spec.path, spec.branch);
        await refresh();
        return worktree;
      } catch (error) {
        // The dialog pre-empts a collision from the list it was given, so a 409
        // here is the race: one made since the last refresh, or by another
        // client. The answer is the same either way — offer what is there.
        if (error.status === 409) {
          const existing = await adoptCollision(project, spec.path);
          if (existing) return existing;
        }
        // Shown inline, under the field it is about.
        throw error;
      }
    },
  );
}

/**
 * Find the worktree a 409 was about and ask whether to use it. The response
 * body is a plain sentence and does not carry the id, so it has to be matched
 * on the path — against the spelling the server stores, which is why both sides
 * are normalised.
 */
async function adoptCollision(project, path) {
  await refresh();
  const existing = worktreesFor(project).find((w) => normalize(w.path) === normalize(path));
  if (!existing) return null;
  const reuse = await confirmDialog(
    'That worktree already exists',
    `There is already a worktree at ${existing.path}`
    + `${existing.branch ? `, created on ${existing.branch}` : ''}. Use it instead of making `
    + 'another?',
    'Use it',
    false,
  );
  return reuse ? existing : null;
}

async function removeWorktree(worktree) {
  // `exists: false` is the recovery path, not a deletion: git prunes its own
  // admin files and the row goes, but there is nothing on disk left to remove.
  const gone = worktree.exists === false;
  const confirmed = await confirmDialog(
    gone ? `Clean up “${baseOf(worktree.path)}”?` : `Remove “${baseOf(worktree.path)}”?`,
    gone
      ? `${worktree.path} is already gone from the server. This tidies away the record of it `
        + 'and git’s own administrative files.'
      : `git removes ${worktree.path}. Any branch it was on stays; only the checkout goes. If `
        + 'it still holds uncommitted or untracked work, git refuses and nothing is removed.',
    gone ? 'Clean up' : 'Remove',
    // Cleaning up after a directory that is already gone is recovery, not a
    // deletion, so it does not get the red button.
    !gone,
  );
  if (!confirmed) return;

  try {
    await api.deleteWorktree(worktree.id);
    await refresh();
  } catch (error) {
    // Nothing was removed and the row still stands, so re-render from the
    // server rather than optimistically dropping it.
    await refresh();
    if (error.status === 409) await reportWorktreeKept(worktree, error.message);
    else fail(error);
  }
}

/**
 * The two ways `DELETE /worktrees/{id}` declines, neither of which the user
 * should read as an error. Awaited, because the caller reopens project settings
 * over the top of it otherwise.
 */
function reportWorktreeKept(worktree, detail) {
  if (/using this worktree/i.test(detail)) {
    // The server names them. There is no force for this case, so the way
    // forward is the sessions — and leaving the worktree alone is also fine.
    return noticeDialog(
      'Sessions are still using this worktree',
      'Nothing was removed. Delete those sessions first, or simply leave the worktree where '
      + 'it is — several sessions sharing one is a supported arrangement.',
      [detail],
    );
  }
  // git counts untracked files as dirty, so this is the common path for any
  // worktree an agent did real work in. git's own suggestion to force it is not
  // passed on: the server takes no force flag, deliberately, so the honest
  // answer is that the user resolves it in the worktree.
  return noticeDialog(
    'Worktree left in place',
    `${worktree.path} has uncommitted work, so it was left in place. Commit or discard the `
    + 'changes there, then try again.',
  );
}

async function createSession(project) {
  const spec = await newSessionDialog(project, worktreesFor(project), agents, {
    // Opened from inside the dialog, on top of it: the picker adds whatever
    // comes back and selects it, so the session being created is not lost.
    onCreateWorktree: (branchSeed) => createWorktreeFor(project, branchSeed),
  });
  if (!spec) return;
  try {
    const session = await api.createSession(spec.name, project.path, spec.agent, spec.worktreeId);
    await refresh();
    store.setMeta(session.id, metaFrom(session));
    workspace.openSession(session.id);
  } catch (error) {
    fail(error);
    // A 404 here means the picker offered a worktree that has since gone; a
    // refresh is what stops the next attempt offering it again.
    if (error.status === 404) await refresh();
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
  const before = {
    name: state.name,
    write: state.autoApproveWrite,
    command: state.autoApproveCommand,
    archived: !!state.archivedAt,
  };
  const result = await sessionSettingsDialog(state);
  if (!result) return;

  if (result.deleted) {
    // Deleting a session touches nothing on disk any more: the worktree is its
    // own resource and outlives whatever sessions used it.
    const worktreePath = state.worktreeId ? state.workingDir : null;
    const lastOnWorktree = !!state.worktreeId && sessionsOnWorktree(state.worktreeId) <= 1;
    const confirmed = await confirmDialog(
      `Delete “${state.name}”?`,
      state.worktreeId
        ? 'The session and its whole transcript are removed. Its worktree at '
          + `${state.workingDir} stays exactly where it is, along with everything in it.`
        : 'The session and its whole transcript are removed. Files the agent wrote stay on disk.',
    );
    if (!confirmed) return;
    try {
      await api.deleteSession(id);
      workspace.closeSession(id);
      store.forget(id);
      await refresh();
      // Finishing a session does not mean finishing with the branch, so this is
      // a note that the worktree is still there rather than a nudge to remove
      // it — project settings is where it can be, when the user wants to.
      if (lastOnWorktree) {
        toast(`The worktree ${worktreePath} is still there — see project settings`);
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
    // Last, and on its own: it is the one field here that can be refused (409
    // while the session is busy), and a refusal should not also lose the rename
    // typed beside it. Unarchiving may take the project with it, which is why
    // the refresh below reloads both lists.
    if (result.archived !== before.archived) {
      await api.setSessionArchived(id, result.archived);
    }
  } catch (error) {
    fail(error);
  }
  // The server broadcasts `renamed`, `settings` and `archived` to every
  // subscriber, so the store updates itself; this is for the tree, which has no
  // socket. In the `finally` position because a rejected archive still leaves
  // whatever was applied before it to be shown.
  await refresh();
}

/* ------------------------------------------------------------------ */
/* chrome                                                             */
/* ------------------------------------------------------------------ */

document.getElementById('new-project-btn').addEventListener('click', createProject);
document.getElementById('refresh-btn').addEventListener('click', () => refresh());

/**
 * Client settings — currently just the worktree path template, which is a
 * client idea start to finish: the server takes an absolute path and has never
 * heard of a template.
 */
async function openAppSettings() {
  const result = await appSettingsDialog(worktreeTemplate(), sampleProject()?.path);
  if (result) setWorktreeTemplate(result.template);
}

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

const settingsButton = document.createElement('button');
settingsButton.className = 'icon-btn';
settingsButton.textContent = '⚙';
settingsButton.title = 'Settings';
settingsButton.addEventListener('click', openAppSettings);

// Both go in front of +, which stays last: it is the one that adds something.
const sidebarHead = document.querySelector('.sidebar-head');
const newProjectButton = document.getElementById('new-project-btn');
sidebarHead.insertBefore(bell, newProjectButton);
sidebarHead.insertBefore(settingsButton, newProjectButton);

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  const { sessions } = await refresh();
  const known = new Set(sessions.map((s) => String(s.id)));
  // Restore the tabs that were open last time, skipping any that have since
  // been deleted server-side. This fails closed on purpose: a stored id is
  // opened only if the server still lists it, which is also what makes ids
  // saved before the server renumbered its rows harmless — they match nothing
  // and drop out after one run, so there is no migration to write.
  for (const id of Workspace.restoreIds()) {
    if (known.has(id)) workspace.openSession(id);
  }
})();
