/**
 * The models each agent can run, for the new-session picker.
 *
 * `GET /models` is a map keyed by agent id, each entry `{models, error}`. The
 * server discovers every catalog once at startup and never again, so there is
 * nothing to refresh here either: the dialog asks when it opens and takes
 * whatever the server learned then.
 *
 * A model id is not ours in the same way an agent id is not: `claude-opus-5-5`,
 * `openai-codex/gpt-5.5` — opaque strings the server validates against the
 * catalog of the agent they are sent with. Nothing here parses one, and a
 * selection never outlives the agent it was picked under.
 *
 * Every session is created with an explicit model. An agent without a usable
 * catalog cannot be picked into a session at all, and the dialog says why. It
 * never leaves the choice to the harness instead: broken discovery is the
 * server's to fix, and a client that quietly worked around it would hide that.
 */

/**
 * The catalogs worth showing, keyed by agent id. Each is `{models, error}`,
 * `models` a list of `{id, name}` and `error` a string or null.
 *
 * Rows without a usable `id` are dropped, as `normalizeAgents` drops agents —
 * an option the server would reject is only a way to fail on create. An entry
 * with neither models nor an error is kept: an empty catalog is an answer, and
 * the picker says so.
 */
export function normalizeModels(catalogs) {
  const out = {};
  if (!catalogs || typeof catalogs !== 'object' || Array.isArray(catalogs)) return out;
  for (const [agent, entry] of Object.entries(catalogs)) {
    if (!entry || typeof entry !== 'object') continue;
    let error = null;
    if (entry.error !== null && entry.error !== undefined) {
      error = typeof entry.error === 'string' && entry.error.trim()
        ? entry.error.trim() : 'Model discovery failed';
    }
    const seen = new Set();
    const models = [];
    for (const row of Array.isArray(entry.models) ? entry.models : []) {
      if (!row || typeof row !== 'object') continue;
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id.trim() || seen.has(id)) continue;
      seen.add(id);
      const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
      models.push({ id, name });
    }
    out[agent] = { models: error ? [] : models, error };
  }
  return out;
}

/**
 * What the picker can offer for one agent: `{models, blocked}`. `blocked` is
 * null when `models` has at least one entry, and otherwise the reason no
 * session can be created for this agent, to show beside the picker.
 *
 * `catalogs` is null while the request is in flight and an Error when it
 * failed outright — an unreachable server, or one too old for the endpoint.
 */
export function modelChoices(catalogs, agent) {
  if (catalogs === null || catalogs === undefined) {
    return { models: [], blocked: 'Loading models…' };
  }
  if (catalogs instanceof Error) {
    return { models: [], blocked: `Model list unavailable: ${catalogs.message}` };
  }
  const entry = agent ? catalogs[agent] : undefined;
  if (!entry) return { models: [], blocked: 'The server lists no models for this agent.' };
  if (entry.error) return { models: [], blocked: `Model list unavailable: ${entry.error}` };
  if (!entry.models.length) return { models: [], blocked: 'The server found no models for this agent.' };
  return { models: entry.models, blocked: null };
}

/**
 * The model a picker should land on: `current` while the agent's catalog still
 * lists it, otherwise that catalog's first model, otherwise null. No ranking —
 * the server's order is the order.
 */
export function pickModel(choices, current = null) {
  const { models } = choices;
  if (current && models.some((model) => model.id === current)) return current;
  return models.length ? models[0].id : null;
}

/**
 * How a session's model reads: its catalog name while the agent still lists
 * it, else the id itself. Null for a session created before models were
 * selectable, which shows no model at all.
 */
export function modelLabel(catalogs, agent, id) {
  if (typeof id !== 'string' || !id) return null;
  const entry = catalogs && !(catalogs instanceof Error) ? catalogs[agent] : undefined;
  const match = entry?.models?.find((model) => model.id === id);
  return match ? match.name : id;
}
