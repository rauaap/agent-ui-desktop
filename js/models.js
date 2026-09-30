/**
 * The models each agent can run, for the new-session picker.
 *
 * Every row of `GET /agents` carries its own catalog: `models`, a list of
 * `{id, name}` in the server's order, and `models_error`, the reason discovery
 * failed or null. The server discovers every catalog once at startup and never
 * again, so there is nothing to refresh here either: a picker takes whatever
 * the agent list it was given says.
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
 * One agent row's catalog, as `{models, models_error}`: `models` a list of
 * `{id, name}` and `models_error` a string or null.
 *
 * Rows without a usable `id` are dropped, as `normalizeAgents` drops agents —
 * an option the server would reject is only a way to fail on create. A catalog
 * with neither models nor an error is kept: an empty catalog is an answer, and
 * the picker says so.
 */
export function normalizeCatalog(row) {
  let error = null;
  if (row.models_error !== null && row.models_error !== undefined) {
    error = typeof row.models_error === 'string' && row.models_error.trim()
      ? row.models_error.trim() : 'Model discovery failed';
  }
  const seen = new Set();
  const models = [];
  for (const model of Array.isArray(row.models) ? row.models : []) {
    if (!model || typeof model !== 'object') continue;
    const id = typeof model.id === 'string' ? model.id : '';
    if (!id.trim() || seen.has(id)) continue;
    seen.add(id);
    const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id;
    models.push({ id, name });
  }
  return { models: error ? [] : models, models_error: error };
}

/**
 * What the picker can offer for one normalized agent: `{models, blocked}`.
 * `blocked` is null when `models` has at least one entry, and otherwise the
 * reason no session can be created for this agent, to show beside the picker.
 */
export function modelChoices(agent) {
  if (agent.models_error) return { models: [], blocked: `Model list unavailable: ${agent.models_error}` };
  if (!agent.models.length) return { models: [], blocked: 'The server found no models for this agent.' };
  return { models: agent.models, blocked: null };
}

/**
 * The model a picker should land on: the catalog's first model, or null. No
 * ranking — the server's order is the order.
 */
export function pickModel(choices) {
  return choices.models.length ? choices.models[0].id : null;
}

/**
 * How a session's model reads: its name in its agent's catalog while that
 * agent still lists it, else the id itself. Null for a session created before
 * models were selectable, which shows no model at all.
 */
export function modelLabel(agents, agent, id) {
  if (typeof id !== 'string' || !id) return null;
  const entry = agents.find((row) => row.id === agent);
  const match = entry?.models.find((model) => model.id === id);
  return match ? match.name : id;
}
