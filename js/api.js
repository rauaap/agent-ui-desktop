/**
 * REST client for agent-ui-server.
 *
 * The client is served by the backend itself (a StaticFiles mount at `/`), so
 * the API lives at the page's own origin — there is no host/port/TLS setting to
 * get wrong, unlike the Android client's Prefs. `?api=` is honoured purely so
 * the page can be opened from disk during development.
 *
 * Every response carrying a project or session passes through `ids.js` on the
 * way out: ids are numbers on the wire and strings everywhere above this file.
 */

import { normalizeAgents } from './agents.js';
import { asProject, asSession, asWorktree, each, wireId } from './ids.js';

const override = new URLSearchParams(location.search).get('api');

/** Base for REST calls, e.g. "http://10.0.0.1:8000". */
export const httpBase = override
  ? override.replace(/\/+$/, '')
  : location.origin;

/** Base for WebSocket calls, e.g. "ws://10.0.0.1:8000". */
export const wsBase = httpBase.replace(/^http/, 'ws');

/** An HTTP error carrying the status, so callers can branch on it. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(httpBase + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // fetch() rejects only on network failure; surface it as something a user
    // can act on rather than the browser's generic "Failed to fetch".
    throw new ApiError(0, 'Cannot reach the server');
  }

  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, detail(text, response.status));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** FastAPI reports validation and business errors as `{"detail": ...}`. */
function detail(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.detail === 'string' && parsed.detail) return parsed.detail;
    // 422 bodies carry a list of per-field errors instead of a string.
    if (Array.isArray(parsed.detail) && parsed.detail.length) {
      const first = parsed.detail[0];
      if (first && typeof first.msg === 'string') return first.msg;
    }
  } catch {
    /* not JSON — fall through */
  }
  return `Server error ${status}`;
}

/* ------------------------------------------------------------------ */
/* agents                                                             */
/* ------------------------------------------------------------------ */

/**
 * The agents this server can run, in registration order:
 * `{id, name, default}` per row.
 *
 * The agent picker is built from this and from nothing else — see
 * `js/agents.js` for why a list kept on this side is a list that goes stale.
 * Rejects like any other call; the caller decides what an unreachable or
 * too-old server means for the picker.
 */
export const listAgents = () => request('GET', '/agents').then(normalizeAgents);

/* ------------------------------------------------------------------ */
/* projects                                                           */
/* ------------------------------------------------------------------ */

export const listProjects = () => request('GET', '/projects').then(each(asProject));

export const createProject = (path, name) =>
  request('POST', '/projects', { path, name }).then(asProject);

/**
 * Archive or unarchive a project. Addressed by `path` in the body, like
 * `DELETE /projects` — a filesystem path does not belong in a URL segment, and
 * this is the one `PATCH` the route has.
 *
 * Archiving cascades to the project's live sessions; unarchiving restores
 * exactly the ones that cascade took, leaving any archived by hand beforehand
 * where they are. Resolves the project row plus `sessions_affected`, which is
 * the honest number to report and is not `archived_session_count`.
 *
 * A 409 means at least one session is busy and **nothing was written** — the
 * detail names them.
 */
export const setProjectArchived = (path, archived) =>
  request('PATCH', '/projects', { path, archived }).then(asProject);

/**
 * Forgets the project, its sessions and its worktrees. The project's own
 * directory is never touched.
 *
 * Always resolves — the sweep reports rather than fails — with
 * `{sessions_deleted, worktrees_removed, worktree_errors}`, where each error is
 * `{path, error}` for a worktree git declined to remove. The rows are gone
 * either way; those directories are still on disk.
 */
export const deleteProject = (path) => request('DELETE', '/projects', { path });

/* ------------------------------------------------------------------ */
/* worktrees                                                          */
/* ------------------------------------------------------------------ */

/**
 * The project's worktrees, newest first, or every one when `projectPath` is
 * omitted.
 *
 * A worktree is its own resource: several sessions can share one, and it
 * outlives the sessions that used it. Each row is `{id, project_id, path,
 * branch, created_at, session_count, exists}` — `branch` is the branch it was
 * *created on* rather than live state, `session_count` may legitimately be 0,
 * and `exists` is a stat of `path` at request time.
 */
export const listWorktrees = (projectPath) => request(
  'GET',
  projectPath ? `/worktrees?project_path=${encodeURIComponent(projectPath)}` : '/worktrees',
).then(each(asWorktree));

/**
 * Runs `git worktree add -b <branch> <path>`, always cutting a **new** branch
 * off the project's current HEAD — attaching to an existing branch has no
 * endpoint.
 *
 * `path` must be absolute; the server normalises it lexically, so `..` need not
 * be collapsed first. Nothing is created on disk when this fails, and a 409
 * means the worktree already exists — see `js/worktree.js` for the path
 * arithmetic that makes that a routine outcome rather than an edge case.
 */
export const createWorktree = (projectPath, path, branch) =>
  request('POST', '/worktrees', { project_path: projectPath, path, branch }).then(asWorktree);

/**
 * Removes the directory (`git worktree remove`, never `--force`) and the row.
 *
 * A 409 means nothing was removed and the row still stands: either sessions are
 * still attached, or git counts the tree as dirty — and it counts untracked
 * files, so any worktree an agent did real work in refuses. That is the common
 * path, not an error.
 */
export const deleteWorktree = (id) => request('DELETE', `/worktrees/${id}`);

/* ------------------------------------------------------------------ */
/* sessions                                                           */
/* ------------------------------------------------------------------ */

export const listSessions = () => request('GET', '/sessions').then(each(asSession));

/**
 * Create a session in `projectPath`, attached to an existing worktree of it or
 * — with `worktreeId` null — running in the project directory itself.
 *
 * The worktree is no longer created here. It is its own resource, made first
 * through `POST /worktrees` and outliving whatever sessions attach to it, so a
 * failed worktree and a failed session are now two separate outcomes rather
 * than one all-or-nothing request.
 *
 * `agent` is omitted rather than guessed when the dialog had no list to pick
 * from: the field is optional and the server's own default is a better answer
 * than a name this client made up.
 */
export const createSession = (name, projectPath, agent, worktreeId = null) =>
  request('POST', '/sessions', {
    name,
    project_path: projectPath,
    ...(agent ? { agent } : {}),
    worktree_id: wireId(worktreeId),
  }).then(asSession);

export const renameSession = (id, name) =>
  request('PATCH', `/sessions/${id}`, { name }).then(asSession);

export const setAutoApprove = (id, write, command) =>
  request('PATCH', `/sessions/${id}`, {
    auto_approve_write: write,
    auto_approve_command: command,
  }).then(asSession);

/**
 * Archive or unarchive one session. The same partial `PATCH` as the two above,
 * and every field on it is optional, so this disturbs neither the name nor the
 * auto-approve toggles.
 *
 * Unarchiving takes the session's project with it when that project was
 * archived — a live session under an archived project would have nowhere to
 * show — so the projects list is stale afterwards and has to be refetched.
 *
 * A 409 means the session is busy. `status` does not settle that on its own: a
 * shell command keeps a session `idle` and still refuses, so the error path is
 * required however carefully the button is guarded.
 */
export const setSessionArchived = (id, archived) =>
  request('PATCH', `/sessions/${id}`, { archived }).then(asSession);

/**
 * Release an archived session's worktree association without moving its
 * harness. The returned row has `worktree_id: null` while `working_dir` keeps
 * the former worktree's absolute path. Nothing on disk is touched.
 *
 * A completed detach may be retried while the session remains archived. A 409
 * means it is live, or that it always ran in the project directory.
 */
export const detachSessionWorktree = (id) =>
  request('POST', `/sessions/${id}/detach-worktree`).then(asSession);

/**
 * Deletes the session and its transcript. Nothing on disk is touched — a
 * worktree it was attached to stays where it is, for the other sessions using
 * it or for the next one. Resolves `{status: "deleted"}` and nothing else.
 */
export const deleteSession = (id) => request('DELETE', `/sessions/${id}`);

export const stopSession = (id) => request('POST', `/sessions/${id}/stop`);

/**
 * Starts a turn over REST. The composer normally sends over the WebSocket
 * instead — same effect, and it keeps prompt and transcript on one channel —
 * but this exists because the server offers it and it is the only way to start
 * a turn without an open socket.
 */
export const startTurn = (id, prompt) =>
  request('POST', `/sessions/${id}/turn`, { prompt });
