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

import { asProject, asSession, each } from './ids.js';

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
/* projects                                                           */
/* ------------------------------------------------------------------ */

export const listProjects = () => request('GET', '/projects').then(each(asProject));

export const createProject = (path, name) =>
  request('POST', '/projects', { path, name }).then(asProject);

/**
 * Forgets the project and its sessions. Never touches the directory on disk —
 * except for worktrees the server itself created, which it removes with their
 * sessions.
 *
 * Resolves `{sessions_deleted, worktrees_removed, worktree_errors}`, where each
 * error is `{session, path, error}` for a worktree git refused to remove.
 */
export const deleteProject = (path) => request('DELETE', '/projects', { path });

/* ------------------------------------------------------------------ */
/* sessions                                                           */
/* ------------------------------------------------------------------ */

export const listSessions = () => request('GET', '/sessions').then(each(asSession));

/**
 * Create a session in `projectPath`, optionally in a git worktree of it —
 * pass `{path, branch}` for that, or nothing for the plain case.
 *
 * The worktree is part of *this* request rather than one the client makes
 * first, so ownership is atomic: a client that died between two calls would
 * leave a worktree on disk that no session claims. If anything about it fails
 * the response is a 400 and no session exists.
 *
 * The path travels as both `project_path` and its deprecated spelling
 * `working_dir`: a server that knows the new name ignores the old one, and one
 * that doesn't ignores the new one.
 */
export const createSession = (name, projectPath, agent, worktree = null) =>
  request('POST', '/sessions', {
    name,
    project_path: projectPath,
    working_dir: projectPath,
    agent,
    ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
  }).then(asSession);

export const renameSession = (id, name) =>
  request('PATCH', `/sessions/${id}`, { name }).then(asSession);

export const setAutoApprove = (id, write, command) =>
  request('PATCH', `/sessions/${id}`, {
    auto_approve_write: write,
    auto_approve_command: command,
  }).then(asSession);

/**
 * Deletes the session and, if the server created one for it, its worktree.
 *
 * Resolves `{worktree_removed, worktree_error}`. Removal is never forced, so a
 * worktree holding modified or untracked files is left on disk and reported
 * here — the session is deleted either way, and this is a notice rather than a
 * failed request.
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
