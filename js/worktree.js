/**
 * Where a worktree goes: the path template, and the path arithmetic it needs.
 *
 * A worktree is its own resource now — created through `POST /worktrees` and
 * attached to sessions afterwards — so a path is something the *client* decides
 * before it asks for anything. The server has no notion of a path relative to a
 * project and no template syntax; it takes an absolute path and normalises it
 * lexically. Everything in this file is therefore ours alone.
 *
 * The template is a settings string expanded against the project the form was
 * opened from:
 *
 *   %P  the project's parent directory   dirname("/projects/app") -> "/projects"
 *   %N  the project directory's name     basename("/projects/app") -> "app"
 *   %B  the branch, slug-safe            "feature/fix" -> "feature-fix"
 *   %b  the branch, verbatim             "feature/fix"
 *   %%  a literal percent sign
 *
 * `%P` and `%N` split at the parent so they compose: `%P/%N` reconstructs the
 * project directory, `%P/%N-%B` is the sibling default, `%P/worktrees/%N-%B`
 * gathers them under one directory. A single "project directory" token would
 * write the first two and not the third.
 *
 * `%N` is the path's last segment rather than `project.name`, which merely
 * defaults to that segment and can be anything — "My App", with spaces — so it
 * has no business in a path. `%B` and `%b` split for the same reason: slashes
 * are legal in branch names and common in practice, so `%P/%N-%b` on branch
 * `feature/fix` nests two levels down rather than landing beside the project.
 * Since every use of a template is a path, the spelling people reach for is the
 * slugged one; `%b` is there for deliberately nested layouts.
 *
 * Pure, so it is testable without a browser.
 */

/** The sibling-of-the-project default: `/projects/app` + `fix` -> `/projects/app-fix`. */
export const DEFAULT_TEMPLATE = '%P/%N-%B';

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
 * server-side, on whatever the user types instead. This seeds the branch field;
 * it is deliberately not applied to what the user then types there, because a
 * client-side approximation of git's rules would reject names git accepts.
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
 * Lexical normalisation — the client half of what the server does with
 * `os.path.normpath` on arrival: `.` and `..` collapse, repeated slashes become
 * one, a trailing slash goes.
 *
 * Symlinks are not resolved, here or there. The point is that the path we
 * display and the path we later compare against `GET /worktrees` are spelled
 * the same way the server spells it — a comparison that misses is silent.
 */
export function normalize(path) {
  const raw = String(path ?? '').trim();
  if (!raw) return '';
  const absolute = raw.startsWith('/');
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      // At the root, `..` is the root: there is nothing above it to climb to.
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  if (absolute) return `/${parts.join('/')}`;
  return parts.join('/') || '.';
}

/** The parent of a path: `/projects/app` -> `/projects`, `/app` -> `/`. */
export function parentOf(path) {
  const full = normalize(path);
  const cut = full.lastIndexOf('/');
  if (cut < 0) return '.';
  return cut === 0 ? '/' : full.slice(0, cut);
}

/** The last segment of a path: `/projects/app` -> `app`, `/` -> `""`. */
export function baseOf(path) {
  const full = normalize(path);
  if (full === '/') return '';
  const cut = full.lastIndexOf('/');
  return cut < 0 ? full : full.slice(cut + 1);
}

/**
 * A real path join, not string concatenation. For a project directly under the
 * root, `%P` is `/` and a concatenated `%P/%N-%B` gives `//app-fix`; the server
 * would tidy that away, but our own comparisons against `GET /worktrees` would
 * not.
 */
export const joinPath = (...parts) => normalize(parts.filter(Boolean).join('/'));

/** A path made absolute against the project directory, and normalised. */
export function absolutize(path, projectPath) {
  const full = normalize(path);
  if (!full || full === '.') return normalize(projectPath);
  return full.startsWith('/') ? full : joinPath(normalize(projectPath), full);
}

/**
 * Whether a session runs at the path of a worktree it used to be attached to.
 *
 * Detachment deliberately makes `worktree_id` null without moving the harness:
 * `working_dir` remains the former worktree path. A null id therefore means the
 * project directory only when that path equals the project's path. Accepts both
 * wire rows (snake_case) and store states (camelCase) so every renderer applies
 * the same distinction.
 */
export function isFormerWorktree(session, projectPath = session?.projectPath) {
  if (!session) return false;
  const worktreeId = session.worktree_id !== undefined
    ? session.worktree_id
    : session.worktreeId;
  if (worktreeId !== null && worktreeId !== undefined) return false;
  const workingDir = session.working_dir !== undefined
    ? session.working_dir
    : session.workingDir;
  return !!workingDir && !!projectPath && normalize(workingDir) !== normalize(projectPath);
}

const TOKEN = /%[PNBb%]/g;

/**
 * Expand a template against a project and a branch, yielding an absolute,
 * normalised path — the one the form previews and the one we send.
 *
 * A template that resolves to something relative (`worktrees/%N-%B`) is taken
 * as relative to the project directory, which is the only anchor a client has.
 */
export function expand(template, projectPath, branch) {
  const project = normalize(projectPath);
  const verbatim = String(branch ?? '').trim();
  const table = {
    '%P': parentOf(project),
    '%N': baseOf(project),
    '%B': verbatim.replace(/\//g, '-'),
    '%b': verbatim,
    '%%': '%',
  };
  const expanded = String(template || DEFAULT_TEMPLATE).replace(TOKEN, (token) => table[token]);
  return absolutize(expanded, project);
}
