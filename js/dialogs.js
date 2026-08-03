/**
 * Modal forms, built on the native `<dialog>` element so there is no focus-trap
 * or overlay machinery to maintain.
 *
 * Each helper resolves with the user's input, or null if they cancelled.
 */

import { suggestName } from './names.js';

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
    actions.append(cancel, confirm);
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

/** Confirm forgetting a project. Resolves true when confirmed. */
export function forgetProjectDialog(project, sessionCount) {
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

/** New session in a project: `{name, agent}`, or null. */
export function newSessionDialog(project) {
  let nameInput;
  let agentSelect;

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
    },
    collect: () => {
      const name = nameInput.value.trim();
      if (!name) throw new Error('Give the session a name');
      return { name, agent: agentSelect.value };
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

  const toggle = (body, label, help, checked) => {
    const row = el('label', 'toggle-row');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    const text = el('div', 'tlabel');
    text.appendChild(el('div', null, label));
    text.appendChild(el('div', 'thelp', help));
    row.append(input, text);
    body.appendChild(row);
    return input;
  };

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
