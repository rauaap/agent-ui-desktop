/**
 * One type for an id at every boundary.
 *
 * Project and session ids arrive from the server as JSON **numbers** — they
 * were uuid strings before it renumbered its rows — and are held everywhere in
 * this client as strings, which is what the DOM and a URL each turn them into
 * anyway. Coercing at the doors they come in through is what keeps
 * `node.dataset.id === session.id` and other id-keyed lookups true rather than
 * silently false: `1 === "1"` is
 * `false`, and `new Set([1]).has("1")` is too, neither with a word said.
 *
 * An id is identity, never arithmetic: nothing downstream parses one back to a
 * number, compares two with `<`, or slices one — the last was a uuid-era habit
 * and would now throw. A string passes through untouched, so a server old
 * enough to still mint uuids works unchanged.
 *
 * `request_id`, `option_id` and the `id` on an approval option are not ours —
 * an agent or the approval protocol mints them, they are strings already, and
 * nothing here applies to them.
 */

/** A copy of `row` with the named fields coerced to strings. */
export const withStringIds = (row, keys) => {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of keys) {
    if (out[key] !== null && out[key] !== undefined) out[key] = String(out[key]);
  }
  return out;
};

export const asProject = (row) => withStringIds(row, ['id']);

export const asSession = (row) => withStringIds(row, ['id', 'project_id', 'worktree_id']);

export const asWorktree = (row) => withStringIds(row, ['id', 'project_id']);

/**
 * The outbound half: an id going back out in a request *body*.
 *
 * `worktree_id` on `POST /sessions` is the only one — every other id we send
 * travels in a URL, where a string is already the right shape. The server types
 * it `int`, so hand it a number rather than leaning on the framework to coerce
 * `"1"`. A value that is not an integer is passed through untouched, which is
 * both the uuid case and the way a null stays a null.
 */
export const wireId = (id) => {
  if (id === null || id === undefined || id === '') return null;
  const number = Number(id);
  return Number.isInteger(number) ? number : id;
};

/** Lift a row mapper over a list response, leaving anything else alone. */
export const each = (fn) => (rows) => (Array.isArray(rows) ? rows.map(fn) : rows);
