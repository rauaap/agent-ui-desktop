/**
 * The agents this server can run.
 *
 * `GET /agents` derives both halves of each row from the same models that
 * validate `POST /sessions` — the label from the adapter class, the flag from
 * the field's default — so a picker built from it cannot offer an agent the
 * server would reject, or miss one it would accept. That is the whole reason
 * the endpoint exists, and the reason nothing here is hardcoded: the list this
 * replaced was already wrong, still offering two agents on a server that had
 * grown a third.
 *
 * An agent id is not one of ours. It is a registry key the server mints
 * (`claude-code`, `opencode`, `pi`), a string on the wire and a string here, so
 * `ids.js` has nothing to say about it.
 */

/**
 * The rows worth showing, in the order the server registered them.
 *
 * A row has to name an agent to be one; anything without a usable `id` is
 * dropped rather than rendered as an empty option that would 422 on create.
 * `name` falls back to the id, which is at least a thing the user can look up.
 */
export function normalizeAgents(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const agents = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
    agents.push({ id, name, default: !!row.default });
  }
  return agents;
}

/**
 * The id a fresh picker should open on: the server's default, or failing that
 * the first agent it offered.
 *
 * Null for an empty list — which is not a broken server but an unreachable one,
 * or one too old for the endpoint. The dialog drops the field entirely then and
 * the create request omits `agent`, leaving the choice where it started: with
 * the server's own default.
 */
export const defaultAgent = (agents) => {
  const list = Array.isArray(agents) ? agents : [];
  const chosen = list.find((agent) => agent.default) ?? list[0];
  return chosen ? chosen.id : null;
};

const PREFERENCE_KEY = 'agent-ui.default-agent';

/** The agent this browser should prefer for new sessions, if one was saved. */
export const agentPreference = () => {
  try {
    return localStorage.getItem(PREFERENCE_KEY) || null;
  } catch {
    return null;
  }
};

export const setAgentPreference = (id) => {
  try {
    if (id) localStorage.setItem(PREFERENCE_KEY, id);
    else localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    /* the server default keeps working, it just won't be remembered */
  }
};

/**
 * Pick the saved preference when this server still offers it, otherwise use
 * the server's default. A stale preference is deliberately harmless: agent
 * registries can change when the server is upgraded.
 */
export const preferredAgent = (agents, preference = agentPreference()) => {
  const list = Array.isArray(agents) ? agents : [];
  return list.some((agent) => agent.id === preference) ? preference : defaultAgent(list);
};

/** The label for an agent id, falling back to the id for one we were not told about. */
export const agentName = (agents, id) => {
  const match = (Array.isArray(agents) ? agents : []).find((agent) => agent.id === id);
  return match ? match.name : id;
};
