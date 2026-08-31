/**
 * One type for an id at every boundary.
 *
 * Project and session ids arrive from the server as JSON **numbers** — they
 * were uuid strings before it renumbered its rows — and are held everywhere in
 * this client as strings, which is what the DOM, `localStorage` and a URL each
 * turn them into anyway. Coercing at the doors they come in through is what
 * keeps `node.dataset.id === session.id` and `new Set(sessions.map((s) =>
 * s.id)).has(restoredId)` true rather than silently false: `1 === "1"` is
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

export const asSession = (row) => withStringIds(row, ['id', 'project_id']);

/** Lift a row mapper over a list response, leaving anything else alone. */
export const each = (fn) => (rows) => (Array.isArray(rows) ? rows.map(fn) : rows);

/**
 * The ids worth trying from a persisted tab list.
 *
 * A list written by an older build holds numbers and one written before the
 * renumbering holds uuids, so both shapes are taken and handed back as strings.
 * Whether an id still exists is the caller's question: it checks each against
 * the current session list and drops the rest, which is what makes a stale list
 * harmless — no migration, it self-corrects after one run.
 */
export const storedIds = (parsed) => (Array.isArray(parsed)
  ? parsed.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v))
  : []);
