/**
 * Where a session's git worktree goes, and what its branch is called.
 *
 * Both are seeded from the session name and then editable — the same
 * seed-then-break-the-link rule the new-project dialog uses for name vs
 * directory. The seed is deliberately conservative: ASCII letters, digits and
 * single dashes, which is both a legal branch name and a path that needs no
 * quoting.
 *
 * Pure, so it is testable without a browser. Ported from the Android client's
 * Worktree.java.
 */

/** Cap on a seeded slug. git allows far more; a path stays readable. */
const MAX_SLUG = 48;

/** Used when a name slugs away to nothing — "!!!", or a non-Latin script. */
const FALLBACK = 'session';

/**
 * A session name reduced to a branch-safe, path-safe token:
 * `"Fix login!"` becomes `"fix-login"`.
 *
 * Runs of anything else collapse to one dash and never lead or trail, so the
 * result cannot trip `git check-ref-format` — which is the authority,
 * server-side, on whatever the user types instead.
 */
export function slug(name) {
  const kept = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Trim to the cap first, then strip a dash the cut may have left dangling.
  const capped = kept.slice(0, MAX_SLUG).replace(/-+$/, '');
  return capped || FALLBACK;
}

/**
 * A sibling of the project directory named after the session: project
 * `/home/me/app` plus session "fix login" gives `/home/me/app-fix-login`.
 *
 * Beside the project rather than inside it, so the worktree is not part of the
 * tree the agent is working on.
 */
export function pathFor(projectDir, name) {
  // Nothing to hang a suffix on: neither "" nor "/" has a last segment.
  const base = String(projectDir ?? '').trim().replace(/\/+$/, '');
  if (!base) return `/${slug(name)}`;
  return `${base}-${slug(name)}`;
}
