/**
 * Reading the server's archive state.
 *
 * `archived_at` is a nullable timestamp on both projects and sessions — null is
 * live, an ISO 8601 UTC string is the moment it was filed. Neither list
 * endpoint filters: `GET /projects` and `GET /sessions` return everything with
 * the field attached, and splitting the two apart is this client's job. That is
 * what this file is.
 *
 * Pure, so it is testable without a browser, and deliberately without a store:
 * the archive is server state now, and the only copy of it is the last refresh.
 */

/** Whether a server project or session row is archived. */
export const isArchived = (row) => !!row?.archived_at;

/**
 * Split rows into live and archived, each keeping the order it arrived in.
 *
 * @returns {{live: object[], archived: object[]}}
 */
export function partition(rows) {
  const live = [];
  const archived = [];
  for (const row of rows) (isArchived(row) ? archived : live).push(row);
  return { live, archived };
}

/**
 * Most recently filed first.
 *
 * The timestamps are ISO 8601 in UTC with a `Z`, which is fixed-width and sorts
 * lexicographically in the same order it sorts chronologically — so there is no
 * date parsing here to get wrong. A row with no timestamp sorts last; nothing
 * in the archive should be missing one, but a truncated response should not
 * reorder everything around it.
 *
 * Never sort the archive by the order `GET /projects` returns. That is
 * `last_active_at` descending, and an archived project's `last_active_at` is
 * always null, so the server's order puts the whole archive at the end in no
 * particular sequence.
 */
export function byArchivedAt(rows) {
  return [...rows].sort((a, b) => compareFiled(a.archived_at, b.archived_at));
}

/**
 * When a project's row in the archive was filed: its own timestamp if the
 * project itself is archived, otherwise the newest of the archived sessions
 * that put it there. A live project appears in the archive only because
 * sessions under it were archived by hand, and the most recent of those is what
 * "when did this get filed" means for it.
 */
export function filedAt(project, archivedSessions) {
  if (isArchived(project)) return project.archived_at;
  let newest = null;
  for (const session of archivedSessions) {
    if (!newest || compareFiled(session.archived_at, newest) < 0) newest = session.archived_at;
  }
  return newest;
}

/** Descending, missing last. Shared by the sort and by `filedAt`'s max. */
function compareFiled(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : -1;
}

/**
 * How a moment in the archive is spelled in a tooltip. The server sends UTC;
 * this is the reader's own clock, which is the only one they can check against.
 */
export function filedLabel(timestamp) {
  if (!timestamp) return '';
  const when = new Date(timestamp);
  if (Number.isNaN(when.getTime())) return timestamp;
  return when.toLocaleString();
}
