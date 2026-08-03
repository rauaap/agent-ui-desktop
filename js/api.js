/**
 * REST client for agent-ui-server.
 *
 * The client is served by the backend itself (a StaticFiles mount at `/`), so
 * the API lives at the page's own origin — there is no host/port/TLS setting to
 * get wrong, unlike the Android client's Prefs. `?api=` is honoured purely so
 * the page can be opened from disk during development.
 */

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

export const listProjects = () => request('GET', '/projects');

export const createProject = (path, name) =>
  request('POST', '/projects', { path, name });

/** Forgets the project and its sessions. Never touches the directory on disk. */
export const deleteProject = (path) => request('DELETE', '/projects', { path });

/* ------------------------------------------------------------------ */
/* sessions                                                           */
/* ------------------------------------------------------------------ */

export const listSessions = () => request('GET', '/sessions');

export const createSession = (name, workingDir, agent) =>
  request('POST', '/sessions', { name, working_dir: workingDir, agent });

export const renameSession = (id, name) =>
  request('PATCH', `/sessions/${id}`, { name });

export const setAutoApprove = (id, write, command) =>
  request('PATCH', `/sessions/${id}`, {
    auto_approve_write: write,
    auto_approve_command: command,
  });

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
