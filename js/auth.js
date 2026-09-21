/** Per-origin secret; deliberately separate from exportable browser preferences. */
const KEY = 'agentUi.serverToken';
const override = location.protocol === 'file:'
  ? new URLSearchParams(location.search).get('api') : null;
export const httpBase = override ? override.replace(/\/+$/, '') : location.origin;
export const wsBase = httpBase.replace(/^http/, 'ws');
let token = '';
try { token = localStorage.getItem(KEY) || ''; } catch { /* prompt explains save failures */ }
let paused = !token;
let prompt = null;
const sockets = new Set();
export const authBlocked = () => paused;

/** Never follow redirects carrying credentials to another endpoint/origin. */
export function tokenFetch(path, value, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${value}`);
  return fetch(httpBase + path, { ...options, headers, redirect: 'error' });
}

async function checkToken(value) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await tokenFetch('/agents', value, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function requireToken() {
  if (!paused && token) return token;
  showTokenPrompt();
  throw new Error('Enter the server token in Settings');
}

export function rejectToken(value) {
  if (value !== token) return;
  showTokenPrompt(true);
}

/** Shared transport for both session and file-tree sockets, including retries. */
export function authenticatedSocket(path) {
  const value = requireToken();
  const url = new URL(wsBase + path);
  url.searchParams.set('token', value);
  const socket = new WebSocket(url.href);
  sockets.add(socket);
  let opened = false;
  socket.addEventListener('open', () => { opened = true; });
  socket.addEventListener('close', () => {
    sockets.delete(socket);
    socket.authCheck = (async () => {
      if (opened || paused) return;
      try {
        const response = await checkToken(value);
        if (response.status === 401) rejectToken(value);
      } catch { /* existing offline/backoff handling */ }
    })();
  });
  return socket;
}

/** Saving reloads so all consumers restart with a single, consistent credential. */
export function showTokenPrompt(rejected = false, optional = false) {
  if (prompt) return;
  paused = true;
  for (const socket of sockets) socket.close();
  const dialog = document.createElement('dialog');
  prompt = dialog;
  dialog.className = 'token-dialog';
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const title = el('h2', 'Server token');
  const explanation = el('p', rejected
    ? 'The server rejected the token. It may have been changed on the server.'
    : 'Enter the shared token from this server. It is stored only in this browser origin.');
  const label = el('label', 'Server token');
  const input = el('input');
  input.type = 'password';
  input.value = token;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.autocapitalize = 'none';
  label.append(input);
  const toggle = el('button', 'Show');
  toggle.type = 'button';
  toggle.onclick = () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    toggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
  };
  const message = el('p');
  message.setAttribute('role', 'status');
  const save = el('button', 'Save');
  save.type = 'submit';
  const anyway = el('button', 'Save anyway');
  anyway.type = 'button';
  anyway.hidden = true;
  let offlineValue = null;
  const persist = (value) => {
    try { localStorage.setItem(KEY, value); } catch {
      message.textContent = 'Cannot save the token: browser storage is unavailable.';
      return;
    }
    input.value = '';
    location.reload();
  };
  anyway.onclick = () => {
    if (offlineValue !== null && input.value.trim() === offlineValue) persist(offlineValue);
  };
  input.oninput = () => { anyway.hidden = true; offlineValue = null; };
  const form = el('form');
  form.append(title, explanation, label, toggle, message, save, anyway);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    anyway.hidden = true;
    offlineValue = null;
    if (!value) { message.textContent = 'Enter a server token.'; return; }
    save.disabled = true;
    input.disabled = true;
    message.textContent = 'Checking token…';
    try {
      const response = await checkToken(value);
      if (response.status === 200) persist(value);
      else message.textContent = response.status === 401 ? 'Token rejected' : `Server error ${response.status}`;
    } catch {
      message.textContent = 'Cannot reach the server. You can save the token and try later.';
      offlineValue = value;
      anyway.hidden = false;
    } finally {
      save.disabled = false;
      input.disabled = false;
    }
  };
  if (optional && token) {
    const cancel = el('button', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => location.reload();
    form.append(cancel);
  }
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}
