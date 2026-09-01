/**
 * Modal forms, built on the native `<dialog>` element so there is no focus-trap
 * or overlay machinery to maintain.
 *
 * Each helper resolves with the user's input, or null if they cancelled.
 */

import { suggestName } from './names.js';
import { DEFAULT_TEMPLATE, absolutize, expand, normalize, slug } from './worktree.js';

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
 *   message to show inline instead of closing. May be async, in which case the
 *   dialog stays open until it settles — which is how a form whose validation
 *   is really the server's (a branch name, checked by `git check-ref-format`)
 *   reports a rejection on the field that caused it rather than as a toast over
 *   a dialog that has already closed.
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
    let pending = false;

    const attempt = async () => {
      // An async collect leaves the form live while it waits; without this,
      // Enter held down or a second click would fire the request twice.
      if (pending) return;
      pending = true;
      confirm.disabled = true;
      try {
        settled = await spec.collect();
        dialog.close();
      } catch (problem) {
        error.textContent = problem.message;
        error.style.display = '';
      } finally {
        pending = false;
        confirm.disabled = false;
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
 * project dialog applies to name vs directory, and the create-worktree dialog
 * to branch vs path.
 *
 * One leash, not a chain: a branch seeded from a session name and a path seeded
 * from that branch are two separate calls, so hand-editing the branch breaks
 * only the branch's own link and the path keeps following it.
 *
 * Returns a handle whose `relink()` re-derives and re-attaches, since there is
 * otherwise no way back from an edit made by accident short of reopening the
 * dialog.
 */
function seedFrom(source, target, derive) {
  let linked = true;
  const apply = () => { target.value = derive(source.value); };
  apply();
  source.addEventListener('input', () => {
    if (linked) apply();
  });
  target.addEventListener('input', () => { linked = false; });
  return {
    get linked() { return linked; },
    relink() {
      linked = true;
      apply();
    },
  };
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

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

const TEMPLATE_KEY = 'agent-ui.worktree-template';

/** The path template new worktrees are seeded from. See `js/worktree.js`. */
export const worktreeTemplate = () => {
  try {
    return localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
  } catch {
    return DEFAULT_TEMPLATE;
  }
};

export const setWorktreeTemplate = (template) => {
  try {
    localStorage.setItem(TEMPLATE_KEY, template);
  } catch {
    /* the default keeps working, it just won't be remembered */
  }
};

/** The branch the settings example expands against — a stand-in, not real. */
const SAMPLE_BRANCH = 'feature/fix-login';

/**
 * Client settings. Only the worktree path template so far, which is entirely a
 * client idea — the server takes an absolute path and has never heard of a
 * template.
 *
 * Resolves `{template}`, or null.
 */
export function appSettingsDialog(template, sampleProject) {
  let input;
  const project = sampleProject || '/projects/app';

  return show({
    title: 'Settings',
    confirm: 'Save',
    body: (body) => {
      input = field(body, 'Worktree path template', template || DEFAULT_TEMPLATE, {
        mono: true,
        hint: '%P the project’s parent directory · %N the project directory’s name · '
          + '%B the branch with slashes turned to dashes · %b the branch verbatim.',
      });

      const example = el('div', 'dlg-preview');
      body.appendChild(example);
      const paint = () => {
        example.textContent = `Example: ${expand(input.value || DEFAULT_TEMPLATE, project, SAMPLE_BRANCH)}`;
      };
      input.addEventListener('input', paint);
      paint();

      body.appendChild(el('div', 'dlg-note',
        `Expanded against ${project} and the branch ${SAMPLE_BRANCH}. `
        + 'This only seeds the directory field when you create a worktree — it is always '
        + 'editable there, and existing worktrees are unaffected.'));
      body.appendChild(el('div', 'dlg-note',
        '%B rather than %b is the one to reach for: slashes are legal in branch names, and '
        + `%P/%N-%b would put this one two directories down rather than beside the project.`));
    },
    collect: () => ({ template: input.value.trim() || DEFAULT_TEMPLATE }),
  });
}

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
 * Resolves `{action, worktree}` — the action is `'forget'`, `'session'`,
 * `'worktree-new'`, `'worktree-delete'`, or null for a plain dismissal. They
 * are handed back rather than performed here, because each already has a caller
 * that knows how to run it and what to say afterwards.
 */
export function projectSettingsDialog(project, sessions, worktrees = []) {
  const inWorktree = sessions.filter((s) => s.worktree_id !== null
    && s.worktree_id !== undefined).length;
  let action = null;
  let target = null;

  return show({
    title: 'Project settings',
    confirm: 'Close',
    // Nothing here is editable, so there is nothing to cancel — one dismissal.
    dismissOnly: true,
    body: (body, submit) => {
      const facts = el('div', 'details');
      detail(facts, 'Name', project.name || '—');
      detail(facts, 'Directory', project.path, { mono: true });
      detail(facts, 'Sessions', inWorktree
        ? `${sessions.length} · ${inWorktree} in a worktree`
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
          ? 'Worktrees are checkouts of this repository on their own branches. A session '
            + 'picks one when it is created, several sessions can share one, and a worktree '
            + 'stays after the sessions that used it are gone.'
          : 'Not a git repository, so sessions here all share this one directory — '
            + 'the worktree options are hidden rather than offered and refused.'));
      } else {
        // The row is the record: the server never scans the filesystem to find
        // projects, so a directory deleted behind its back leaves the project
        // listed rather than disappearing.
        body.appendChild(el('div', 'dlg-note warn',
          'The directory is gone from the server. The project stays listed because '
          + 'the database row is the record, not a scan of the disk — creating a '
          + 'session here recreates the directory, empty.'));
      }

      if (worktrees.length) {
        body.appendChild(el('div', 'dlg-label', `Worktrees (${worktrees.length})`));
        const list = el('div', 'wt-list');
        for (const worktree of worktrees) {
          list.appendChild(worktreeRow(worktree, (chosen) => {
            action = 'worktree-delete';
            target = chosen;
            submit();
          }));
        }
        body.appendChild(list);
      }

      body.appendChild(el('div', 'dlg-note',
        'Name and directory are set when the project is created and cannot be '
        + 'changed afterwards: the server has no endpoint that updates a project.'));

      // All of these confirm on their own; the caller takes it from here, and
      // both destructive ones ask again before anything is actually removed.
      const buttons = el('div', 'dlg-buttons');
      const add = el('button', 'btn', '+  New session…');
      add.addEventListener('click', (event) => {
        event.preventDefault();
        action = 'session';
        submit();
      });
      buttons.appendChild(add);

      // Creating one runs `git worktree add` in a directory that has to be
      // there and has to be a repository; a project failing either would learn
      // it from git's own stderr, which is a confusing place to find out.
      if (project.is_git_repo && !missing) {
        const worktree = el('button', 'btn', '+  New worktree…');
        worktree.addEventListener('click', (event) => {
          event.preventDefault();
          action = 'worktree-new';
          submit();
        });
        buttons.appendChild(worktree);
      }

      const danger = el('button', 'btn deny', 'Forget this project…');
      danger.addEventListener('click', (event) => {
        event.preventDefault();
        action = 'forget';
        submit();
      });
      buttons.appendChild(danger);
      body.appendChild(buttons);
    },
    collect: () => ({ action, worktree: target }),
  });
}

/**
 * One worktree in the project settings list.
 *
 * `session_count` of 0 is an ordinary state — an unused worktree still there to
 * attach to — so it is reported flatly rather than flagged. `exists: false` is
 * the one that needs marking: the row outlived its directory, and the button
 * that tidies it away says "clean up" because there is nothing left to delete.
 */
function worktreeRow(worktree, onRemove) {
  const row = el('div', 'wt-row');
  const text = el('div', 'wt-text');

  const head = el('div', 'wt-path', worktree.path);
  if (worktree.exists === false) head.appendChild(el('span', 'missing', 'MISSING'));
  text.appendChild(head);

  const bits = [];
  // The branch it was *created* on. An agent in there can switch branches and
  // this never updates, so it is not labelled as the current one.
  if (worktree.branch) bits.push(`created on ${worktree.branch}`);
  const count = worktree.session_count ?? 0;
  bits.push(count === 0 ? 'no sessions' : `${count} session${count === 1 ? '' : 's'}`);
  text.appendChild(el('div', 'wt-meta', bits.join(' · ')));

  const gone = worktree.exists === false;
  const button = el('button', 'btn small', gone ? 'Clean up…' : 'Remove…');
  button.title = gone
    ? 'The directory is already gone; this tidies the record away'
    : 'git removes the directory, unless it still holds uncommitted or untracked work';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onRemove(worktree);
  });

  row.append(text, button);
  return row;
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
          `The project’s ${worktreeCount} worktree${worktreeCount === 1 ? '' : 's'} `
          + `${worktreeCount === 1 ? 'is' : 'are'} removed too — each one is a checkout git `
          + 'made, not work of yours. Any that still hold uncommitted or untracked files are '
          + 'left on disk and reported afterwards.'));
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

/** The "New worktree…" entry's value. Not an id, so it can never collide. */
const NEW_WORKTREE = ' new';

/**
 * New session in a project: `{name, agent, worktreeId}`, or null. `worktreeId`
 * is null for a session that runs in the project directory.
 *
 * A picker rather than the toggle-and-two-fields this used to be: worktrees are
 * their own resource now, so the choice is which of the project's existing ones
 * to run in — with making a new one an entry in the same list, since that is
 * the same decision reached from the other end.
 *
 * @param {object} project
 * @param {object[]} worktrees from `GET /worktrees?project_path=…`
 * @param {{onCreateWorktree?: (branchSeed: string) => Promise<object|null>}} handlers
 */
export function newSessionDialog(project, worktrees = [], handlers = {}) {
  let nameInput;
  let agentSelect;
  let picked = '';
  const list = [...worktrees];

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

      // Nowhere else for the session to run, so there is no choice to offer.
      // `is_git_repo` is a stat of `<path>/.git` and only a hint — the server
      // checks for real — but it is what keeps "not a git repository" a rare
      // error rather than a routine one.
      if (!project.is_git_repo && !list.length) {
        const dir = el('div', 'dlg-note', project.path);
        dir.style.fontFamily = 'var(--mono)';
        body.appendChild(dir);
        return;
      }

      const where = el('div', 'field');
      where.appendChild(el('label', null, 'Runs in'));
      const picker = el('select');
      where.appendChild(picker);
      const note = el('div', 'dlg-note', '');
      where.appendChild(note);
      body.appendChild(where);

      const canCreate = project.is_git_repo && project.exists !== false;

      const paintNote = () => {
        if (!picked) {
          note.className = 'dlg-note';
          note.textContent = `The session runs in ${project.path}, alongside its siblings.`;
          return;
        }
        const worktree = list.find((w) => String(w.id) === picked);
        if (!worktree) return;
        const bits = [worktree.path];
        if (worktree.branch) bits.push(`created on ${worktree.branch}`);
        const count = worktree.session_count ?? 0;
        // Sharing one is a supported choice, so this is a fact, not a warning.
        if (count) bits.push(`${count} session${count === 1 ? '' : 's'} already here`);
        note.className = 'dlg-note';
        note.textContent = bits.join(' · ');
      };

      const rebuild = () => {
        picker.replaceChildren();
        const base = el('option', null, 'Project directory');
        base.value = '';
        picker.appendChild(base);

        for (const worktree of list) {
          const bits = [worktree.path];
          if (worktree.branch) bits.push(worktree.branch);
          const count = worktree.session_count ?? 0;
          if (count) bits.push(`${count} session${count === 1 ? '' : 's'} here`);
          // The server deliberately does not recreate a missing directory —
          // that would hand the agent a plain directory dressed up as a
          // worktree — so the session would fail on its first turn instead.
          if (worktree.exists === false) bits.push('directory missing');
          const option = el('option', null, bits.join(' · '));
          option.value = String(worktree.id);
          option.disabled = worktree.exists === false;
          picker.appendChild(option);
        }

        if (canCreate) {
          const add = el('option', null, 'New worktree…');
          add.value = NEW_WORKTREE;
          picker.appendChild(add);
        }
        picker.value = picked;
      };

      picker.addEventListener('change', async () => {
        if (picker.value !== NEW_WORKTREE) {
          picked = picker.value;
          paintNote();
          return;
        }
        // Never leave the sentinel showing: the form opens on top of this one,
        // and a cancel has to land back on whatever was selected before.
        picker.value = picked;
        const created = await handlers.onCreateWorktree?.(nameInput.value.trim());
        if (created) {
          if (!list.some((w) => String(w.id) === String(created.id))) list.push(created);
          picked = String(created.id);
          rebuild();
        }
        paintNote();
      });

      rebuild();
      paintNote();
    },
    collect: () => {
      const name = nameInput.value.trim();
      if (!name) throw new Error('Give the session a name');
      return { name, agent: agentSelect.value, worktreeId: picked || null };
    },
  });
}

/**
 * New worktree in a project. Resolves with the worktree `submit` produced — or
 * with the one already at that path — and null if the form was dismissed.
 *
 * The path field starts expanded from the template and stays leashed to the
 * branch; hand-editing it breaks the leash, and Reset is the way back.
 *
 * The collision case is pre-empted rather than left to the round trip: a
 * template maps a branch to the same path every time, so `POST /worktrees`
 * answering 409 is a routine outcome. Offering the existing worktree is almost
 * always what the user meant, and the 409 body does not carry its id anyway.
 *
 * `submit` runs while the form is still open, so what it throws lands under the
 * fields. That matters most for the branch: whether a name is legal is
 * `git check-ref-format`'s answer, given server-side, and git's own message
 * about it is more specific than anything a regex here could say.
 *
 * @param {object} project
 * @param {object[]} existing the project's worktrees, for the collision check
 * @param {string} template from settings
 * @param {string} branchSeed e.g. the session name the form was opened from
 * @param {(spec: object) => Promise<object>} submit creates it, or throws
 */
export function createWorktreeDialog(
  project,
  existing = [],
  template = DEFAULT_TEMPLATE,
  branchSeed = '',
  submit = async (spec) => spec,
) {
  let branchInput;
  let pathInput;
  let collision = null;

  return show({
    title: `New worktree in ${project.name || project.path}`,
    confirm: 'Create',
    body: (body) => {
      branchInput = field(body, 'Branch', slug(branchSeed || project.name || ''), {
        mono: true,
        // Not validated here on purpose: the authority is `git check-ref-format`
        // server-side, and a regex approximating it would reject names git takes.
        hint: 'A new branch, cut from the project’s current HEAD. Attaching to a branch that '
          + 'already exists is not supported.',
      });

      pathInput = field(body, 'Directory', '', {
        mono: true,
        hint: 'Created by git; must not already exist, or must be an empty directory. A '
          + 'relative path is resolved against the project directory.',
      });
      const pathField = pathInput.parentNode;

      const preview = el('div', 'dlg-preview');
      preview.style.display = 'none';
      const warn = el('div', 'dlg-note warn');
      warn.style.display = 'none';
      const reset = el('button', 'btn small', 'Reset to the template');
      reset.title = 'Re-expand the path from the template and follow the branch again';
      pathField.append(preview, warn, reset);

      const leash = seedFrom(branchInput, pathInput, (branch) => expand(template, project.path, branch));

      const paint = () => {
        const typed = pathInput.value.trim();
        const path = absolutize(typed, project.path);
        // Say what will actually be sent whenever the field does not already
        // spell it: a relative path, a `..`, a trailing slash.
        const differs = !!typed && path !== typed;
        preview.style.display = differs ? '' : 'none';
        if (differs) preview.textContent = `Resolves to ${path}`;

        collision = existing.find((w) => normalize(w.path) === path) || null;
        warn.style.display = collision ? '' : 'none';
        if (collision) {
          warn.textContent = 'A worktree already exists here'
            + (collision.branch ? `, created on ${collision.branch}` : '')
            + '. Create will use that one rather than making another.';
        }
        reset.style.display = leash.linked ? 'none' : '';
      };

      branchInput.addEventListener('input', paint);
      pathInput.addEventListener('input', paint);
      reset.addEventListener('click', (event) => {
        event.preventDefault();
        leash.relink();
        paint();
      });
      paint();

      body.appendChild(el('div', 'dlg-note',
        'Somewhere under the same root as the project directory: in a Docker deployment a '
        + 'path outside the bind mount is not visible inside the container.'));
    },
    collect: () => {
      const typed = pathInput.value.trim();
      if (!typed) throw new Error('Give the worktree a directory');
      const path = absolutize(typed, project.path);
      if (path === normalize(project.path)) {
        throw new Error('The worktree must go somewhere other than the project directory');
      }
      // Reusing one makes the branch field irrelevant, so it is not asked for.
      if (collision) return collision;
      const branch = branchInput.value.trim();
      if (!branch) throw new Error('Give the worktree a branch name');
      // Async, so a rejection from git shows here rather than over a closed form.
      return submit({ path, branch });
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

/**
 * Plain confirmation. Resolves true when confirmed.
 *
 * `danger` defaults on because most of these are destructive, but not all —
 * "use the worktree that is already there" is a choice, not a deletion, and
 * dressing it in red would say otherwise.
 */
export function confirmDialog(title, message, confirmLabel = 'Delete', danger = true) {
  return show({
    title,
    confirm: confirmLabel,
    danger,
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
