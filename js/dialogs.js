/**
 * Modal forms, built on the native `<dialog>` element so there is no focus-trap
 * or overlay machinery to maintain.
 *
 * Each helper resolves with the user's input, or null if they cancelled.
 */

import { suggestName } from './names.js';
import { pathFor, slug } from './worktree.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Build and show a dialog.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {(body: HTMLElement, submit: () => void) => void} spec.body fills the
 *   form; `submit` runs `collect` and closes, for controls that confirm on
 *   their own (a Delete button that shouldn't need Save pressed afterwards)
 * @param {string} spec.confirm label for the confirming button
 * @param {boolean} [spec.danger] style the confirm button as destructive
 * @param {boolean} [spec.dismissOnly] drop the Cancel button — for a dialog
 *   that reports something rather than asking it
 * @param {() => any} spec.collect returns the resolved value, or throws a
 *   message to show inline instead of closing
 */
function show(spec) {
  return new Promise((resolve) => {
    const dialog = el('dialog');
    dialog.appendChild(el('div', 'dlg-title', spec.title));

    const body = el('div', 'dlg-body');
    dialog.appendChild(body);

    const error = el('div', 'dlg-error');
    error.style.display = 'none';
    dialog.appendChild(error);

    const actions = el('div', 'dlg-actions');
    const cancel = el('button', 'btn', 'Cancel');
    const confirm = el('button', `btn ${spec.danger ? 'deny' : 'primary'}`, spec.confirm);
    if (!spec.dismissOnly) actions.appendChild(cancel);
    actions.appendChild(confirm);
    dialog.appendChild(actions);

    let settled = null;

    const attempt = () => {
      try {
        settled = spec.collect();
        dialog.close();
      } catch (problem) {
        error.textContent = problem.message;
        error.style.display = '';
      }
    };

    // Filled only now that `attempt` exists, so the body can wire its own
    // self-confirming controls.
    spec.body(body, attempt);

    confirm.addEventListener('click', attempt);
    cancel.addEventListener('click', () => dialog.close());
    // Enter anywhere in the form confirms, Esc cancels (native).
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        attempt();
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(settled);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    const first = body.querySelector('input, select');
    if (first) {
      first.focus();
      if (first.select) first.select();
    } else {
      // Nothing to fill in. Focus the dismissing button rather than letting
      // showModal() land on whichever button the body happens to put first —
      // in a read-only dialog that is one that acts, not one that closes.
      confirm.focus();
    }
  });
}

function field(parent, label, value, { mono = false, hint } = {}) {
  const wrap = el('div', 'field');
  wrap.appendChild(el('label', null, label));
  const input = el('input', mono ? 'mono' : null);
  input.type = 'text';
  input.value = value ?? '';
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el('div', 'dlg-note', hint));
  parent.appendChild(wrap);
  return input;
}

/**
 * A read-only label/value row, for facts the API reports but offers no way to
 * change. Deliberately not a disabled `field()`: an input the user cannot use
 * still looks like one they should be able to.
 */
function detail(parent, label, value, { mono = false } = {}) {
  const row = el('div', 'detail-row');
  row.appendChild(el('span', 'dkey', label));
  row.appendChild(el('span', `dval${mono ? ' mono' : ''}`, value));
  parent.appendChild(row);
  return row;
}

/** `last_active_at` is ISO 8601 in UTC; read it back in the viewer's zone. */
function whenever(iso) {
  if (!iso) return 'Never';
  const at = new Date(iso);
  return Number.isNaN(at.valueOf()) ? iso : at.toLocaleString();
}

/** A checkbox with a label and a line of help. Returns the input. */
function toggle(parent, label, help, checked) {
  const row = el('label', 'toggle-row');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  const text = el('div', 'tlabel');
  text.appendChild(el('div', null, label));
  text.appendChild(el('div', 'thelp', help));
  row.append(input, text);
  parent.appendChild(row);
  return input;
}

/**
 * Keep `target` tracking `source` through `derive`, until the user edits the
 * target by hand — after which the two are independent. The rule the new
 * project dialog applies to name vs directory, and the new session dialog to
 * name vs worktree.
 */
function seedFrom(source, target, derive) {
  let linked = true;
  target.value = derive(source.value);
  source.addEventListener('input', () => {
    if (linked) target.value = derive(source.value);
  });
  target.addEventListener('input', () => { linked = false; });
}

/* ------------------------------------------------------------------ */
/* projects                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_DIR_KEY = 'agent-ui.default-dir';

export const defaultDir = () => {
  try {
    return localStorage.getItem(DEFAULT_DIR_KEY) || '/projects/';
  } catch {
    return '/projects/';
  }
};

export const setDefaultDir = (dir) => {
  try {
    localStorage.setItem(DEFAULT_DIR_KEY, dir);
  } catch {
    /* nothing to do */
  }
};

/** New project: `{path, name}`, or null. */
export function newProjectDialog() {
  let nameInput;
  let pathInput;
  // The path tracks the name until the user edits it by hand, after which the
  // two are independent — the same rule as the Android client.
  let linked = true;

  return show({
    title: 'New project',
    confirm: 'Create',
    body: (body) => {
      nameInput = field(body, 'Name', '');
      pathInput = field(body, 'Directory', defaultDir(), {
        mono: true,
        hint: 'Absolute path on the server. Created if it does not exist.',
      });
      const base = defaultDir().replace(/\/*$/, '/');
      nameInput.addEventListener('input', () => {
        if (linked) pathInput.value = base + nameInput.value.trim();
      });
      pathInput.addEventListener('input', () => { linked = false; });
    },
    collect: () => {
      const name = nameInput.value.trim();
      const path = pathInput.value.trim();
      if (!name) throw new Error('Give the project a name');
      if (!path.startsWith('/')) throw new Error('The directory must be an absolute path');
      // Remember the parent directory so the next project pre-fills sensibly.
      const parent = path.slice(0, path.lastIndexOf('/') + 1);
      if (parent) setDefaultDir(parent);
      return { path, name };
    },
  });
}

/**
 * Project settings: what the server knows about a project, and the two actions
 * that take the whole thing as their subject.
 *
 * **It is read-only, and that is the API's doing rather than an omission.**
 * `/projects` is `GET`, `POST` and `DELETE` only — there is no `PATCH` — and
 * `POST` inserts with `OR IGNORE`, so re-posting an existing path under a new
 * name returns the project unchanged instead of renaming it. Moving a project's
 * path is on the server's roadmap (`projects.id` exists precisely so sessions
 * survive it) but has no endpoint yet. A Name field here would therefore be a
 * box that silently discards what you type, which is worse than no box: name
 * and directory are fixed at creation, so they are reported, not offered.
 *
 * Resolves `{action}` — `'forget'`, `'session'`, or null for a plain dismissal.
 * The two actions are handed back rather than performed here, because both
 * already have a caller that knows how to run them and what to say afterwards.
 */
export function projectSettingsDialog(project, sessions) {
  const worktrees = sessions.filter((s) => s.owns_worktree).length;
  let action = null;

  return show({
    title: 'Project settings',
    confirm: 'Close',
    // Nothing is editable, so there is nothing to cancel — one dismissal.
    dismissOnly: true,
    body: (body, submit) => {
      const facts = el('div', 'details');
      detail(facts, 'Name', project.name || '—');
      detail(facts, 'Directory', project.path, { mono: true });
      detail(facts, 'Sessions', worktrees
        ? `${sessions.length} · ${worktrees} in a worktree`
        : String(sessions.length));
      detail(facts, 'Last active', whenever(project.last_active_at));
      // `is_git_repo` is a stat of `<path>/.git`, so on a directory that is no
      // longer there it is false for the wrong reason. Say so rather than
      // reporting a plain "No" about a path nobody can look at.
      const missing = project.exists === false;
      detail(facts, 'Git repository', missing
        ? 'Unknown — the directory is missing'
        : (project.is_git_repo ? 'Yes' : 'No'));
      body.appendChild(facts);

      if (!missing) {
        body.appendChild(el('div', 'dlg-note', project.is_git_repo
          ? 'New sessions here can be given their own git worktree, so two agents '
            + 'can work on separate branches without sharing one checkout.'
          : 'Not a git repository, so sessions here all share this one directory — '
            + 'the worktree option is hidden rather than offered and refused.'));
      } else {
        // The row is the record: the server never scans the filesystem to find
        // projects, so a directory deleted behind its back leaves the project
        // listed rather than disappearing.
        body.appendChild(el('div', 'dlg-note warn',
          'The directory is gone from the server. The project stays listed because '
          + 'the database row is the record, not a scan of the disk — creating a '
          + 'session here recreates the directory, empty.'));
      }

      body.appendChild(el('div', 'dlg-note',
        'Name and directory are set when the project is created and cannot be '
        + 'changed afterwards: the server has no endpoint that updates a project.'));

      // Both confirm on their own; the caller takes it from here, and forgetting
      // asks again before anything is actually deleted.
      const buttons = el('div', 'dlg-buttons');
      const add = el('button', 'btn', '+  New session…');
      add.addEventListener('click', (event) => {
        event.preventDefault();
        action = 'session';
        submit();
      });
      const danger = el('button', 'btn deny', 'Forget this project…');
      danger.addEventListener('click', (event) => {
        event.preventDefault();
        action = 'forget';
        submit();
      });
      buttons.append(add, danger);
      body.appendChild(buttons);
    },
    collect: () => ({ action }),
  });
}

/** Confirm forgetting a project. Resolves true when confirmed. */
export function forgetProjectDialog(project, sessionCount, worktreeCount = 0) {
  return show({
    title: `Forget “${project.name || project.path}”?`,
    confirm: 'Forget',
    danger: true,
    body: (body) => {
      body.appendChild(el('div', 'dlg-note',
        'The directory and everything in it stays on disk. Only Agent UI forgets it.'));
      if (sessionCount > 0) {
        body.appendChild(el('div', 'dlg-note warn',
          `${sessionCount} session${sessionCount === 1 ? '' : 's'} and their transcripts `
          + 'will be deleted — sessions are reachable only through their project.'));
      }
      if (worktreeCount > 0) {
        body.appendChild(el('div', 'dlg-note',
          `${worktreeCount} of them run${worktreeCount === 1 ? 's' : ''} in a worktree Agent UI `
          + 'created; those directories are removed too, unless they still hold uncommitted or '
          + 'untracked files.'));
      }
      if (project.exists === false) {
        body.appendChild(el('div', 'dlg-note',
          'This project’s directory is already gone from the server.'));
      }
    },
    collect: () => true,
  });
}

/* ------------------------------------------------------------------ */
/* sessions                                                           */
/* ------------------------------------------------------------------ */

const AGENTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
];

/**
 * New session in a project: `{name, agent, worktree}`, or null. `worktree` is
 * `{path, branch}` when the toggle is on, and null otherwise.
 */
export function newSessionDialog(project) {
  let nameInput;
  let agentSelect;
  let worktreeToggle = null;
  let pathInput;
  let branchInput;

  return show({
    title: `New session in ${project.name || project.path}`,
    confirm: 'Create',
    body: (body) => {
      nameInput = field(body, 'Name', suggestName(), {
        hint: 'Suggestions are not checked for uniqueness — duplicates are fine.',
      });

      const wrap = el('div', 'field');
      wrap.appendChild(el('label', null, 'Agent'));
      agentSelect = el('select');
      for (const agent of AGENTS) {
        const option = el('option', null, agent.label);
        option.value = agent.id;
        agentSelect.appendChild(option);
      }
      wrap.appendChild(agentSelect);
      body.appendChild(wrap);

      const dir = el('div', 'dlg-note', project.path);
      dir.style.fontFamily = 'var(--mono)';
      body.appendChild(dir);

      // Offered only for a project the server reports as a git repo: anywhere
      // else `git worktree add` would refuse, and the toggle would be an
      // invitation to a 400. The server checks again for real.
      if (!project.is_git_repo) return;

      worktreeToggle = toggle(
        body,
        'Create a git worktree',
        'Run this session in its own checkout on a new branch, so it does not '
        + 'share the project directory with other sessions.',
        false,
      );

      // The inputs live in their own block so the toggle can hide them whole,
      // rather than leaving two dead fields taking up the dialog.
      const fields = el('div', 'subfields');
      fields.style.display = 'none';
      pathInput = field(fields, 'Worktree directory', '', {
        mono: true,
        hint: 'Created by git. Must not already exist, or must be empty.',
      });
      branchInput = field(fields, 'Branch', '', {
        mono: true,
        hint: 'Created off the project’s current HEAD. Must not already exist.',
      });
      body.appendChild(fields);

      seedFrom(nameInput, pathInput, (name) => pathFor(project.path, name));
      seedFrom(nameInput, branchInput, slug);
      worktreeToggle.addEventListener('change', () => {
        fields.style.display = worktreeToggle.checked ? '' : 'none';
      });
    },
    collect: () => {
      const name = nameInput.value.trim();
      if (!name) throw new Error('Give the session a name');
      if (!worktreeToggle?.checked) return { name, agent: agentSelect.value, worktree: null };

      // A trailing slash would make the path look unlike the one we get back.
      const path = pathInput.value.trim().replace(/\/+$/, '');
      const branch = branchInput.value.trim();
      if (!path) throw new Error('Give the worktree a directory');
      if (!path.startsWith('/')) throw new Error('The worktree directory must be an absolute path');
      if (path === project.path.replace(/\/+$/, '')) {
        throw new Error('The worktree must go somewhere other than the project directory');
      }
      if (!branch) throw new Error('Give the worktree a branch name');
      return { name, agent: agentSelect.value, worktree: { path, branch } };
    },
  });
}

/**
 * Session settings: rename, auto-approve toggles, delete.
 * Resolves `{name, autoApproveWrite, autoApproveCommand, deleted}`, or null.
 */
export function sessionSettingsDialog(state) {
  let nameInput;
  let writeToggle;
  let commandToggle;
  let deleted = false;

  return show({
    title: 'Session settings',
    confirm: 'Save',
    body: (body, submit) => {
      nameInput = field(body, 'Name', state.name);

      writeToggle = toggle(
        body,
        'Auto-approve writes',
        'Write, Edit and MultiEdit run without asking.',
        state.autoApproveWrite,
      );
      commandToggle = toggle(
        body,
        'Auto-approve commands',
        'Shell commands run without asking.',
        state.autoApproveCommand,
      );
      body.appendChild(el('div', 'dlg-note',
        'Auto-approved tools still appear in the transcript, marked as such. '
        + 'Read-only tools never prompt.'));

      // Confirms on its own — the caller asks for a second confirmation before
      // anything is actually deleted.
      const danger = el('button', 'btn deny', 'Delete this session…');
      danger.addEventListener('click', (event) => {
        event.preventDefault();
        deleted = true;
        submit();
      });
      body.appendChild(danger);
    },
    collect: () => {
      const name = nameInput.value.trim();
      if (!name && !deleted) throw new Error('The name cannot be empty');
      return {
        name,
        autoApproveWrite: writeToggle.checked,
        autoApproveCommand: commandToggle.checked,
        deleted,
      };
    },
  });
}

/** Plain confirmation. Resolves true when confirmed. */
export function confirmDialog(title, message, confirmLabel = 'Delete') {
  return show({
    title,
    confirm: confirmLabel,
    danger: true,
    body: (body) => body.appendChild(el('div', 'dlg-note', message)),
    collect: () => true,
  });
}

/**
 * Report something and wait for an OK — a dialog rather than a toast, because
 * what it carries is git's own words about a worktree it declined to remove,
 * which is more than a line and worth reading.
 *
 * @param {string} title
 * @param {string} message
 * @param {string[]} [details] monospace lines under it, e.g. paths and stderr
 */
export function noticeDialog(title, message, details = []) {
  return show({
    title,
    confirm: 'OK',
    dismissOnly: true,
    body: (body) => {
      body.appendChild(el('div', 'dlg-note', message));
      for (const line of details) body.appendChild(el('div', 'dlg-detail', line));
    },
    collect: () => true,
  });
}
