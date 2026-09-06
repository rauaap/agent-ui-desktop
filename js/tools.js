/** Pure helpers for provider-neutral canonical tool actions. */

const ACTION_KEYS = {
  command: ['kind', 'command', 'description', 'timeout_ms', 'shell'],
  read: ['kind', 'path', 'offset', 'limit'],
  edit: ['kind', 'path', 'edits'],
  write: ['kind', 'path', 'content'],
  search: ['kind', 'mode', 'query', 'path', 'glob', 'limit'],
  list: ['kind', 'path', 'limit'],
  web: ['kind', 'operation', 'query', 'url', 'prompt'],
  task: ['kind', 'description', 'prompt', 'agent'],
  other: ['kind', 'name', 'arguments'],
};

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const optionalText = (value) => value === undefined || nonEmpty(value);
const integer = (value) => Number.isInteger(value) && Number.isFinite(value);
const optionalInteger = (value) => value === undefined || integer(value);
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

/** Defensive validation of the strict canonical action union. */
export function isCanonicalAction(action) {
  if (!object(action) || !Object.hasOwn(ACTION_KEYS, action.kind)
      || !exactKeys(action, ACTION_KEYS[action.kind])) return false;

  switch (action.kind) {
    case 'command':
      return nonEmpty(action.command)
        && optionalText(action.description)
        && optionalText(action.shell)
        && (action.timeout_ms === undefined
          || (typeof action.timeout_ms === 'number' && Number.isFinite(action.timeout_ms)
            && action.timeout_ms >= 0));
    case 'read':
      return nonEmpty(action.path) && optionalInteger(action.offset) && optionalInteger(action.limit);
    case 'edit':
      return nonEmpty(action.path) && Array.isArray(action.edits) && action.edits.length > 0
        && action.edits.every((edit) => object(edit)
          && exactKeys(edit, ['old_text', 'new_text', 'replace_all'])
          && nonEmpty(edit.old_text) && typeof edit.new_text === 'string'
          && (edit.replace_all === undefined || typeof edit.replace_all === 'boolean'));
    case 'write':
      return nonEmpty(action.path) && typeof action.content === 'string';
    case 'search':
      return (action.mode === 'content' || action.mode === 'files') && nonEmpty(action.query)
        && optionalText(action.path) && optionalText(action.glob) && optionalInteger(action.limit);
    case 'list':
      return optionalText(action.path) && optionalInteger(action.limit);
    case 'web':
      return (action.operation === 'search'
        ? nonEmpty(action.query) && action.url === undefined
        : action.operation === 'fetch' && nonEmpty(action.url) && action.query === undefined)
        && optionalText(action.prompt);
    case 'task':
      return nonEmpty(action.description) && optionalText(action.prompt) && optionalText(action.agent);
    case 'other':
      return nonEmpty(action.name) && object(action.arguments);
    default:
      return false;
  }
}

/** Provider-neutral card title. */
export function actionLabel(action) {
  if (!isCanonicalAction(action)) return 'TOOL';
  const labels = {
    command: action.shell || 'command', read: 'read', edit: 'edit', write: 'write',
    search: action.mode === 'files' ? 'find' : 'search', list: 'list',
    web: `web ${action.operation}`, task: 'task', other: action.name,
  };
  return labels[action.kind].toUpperCase();
}

/** Concise provider-neutral summary used by cards, search, and export. */
export function actionSummary(action) {
  if (!isCanonicalAction(action)) return '';
  switch (action.kind) {
    case 'command': return action.command;
    case 'read':
    case 'edit':
    case 'write': return action.path;
    case 'search': return `${action.query}${action.path ? ` · ${action.path}` : ''}`;
    case 'list': return action.path || 'current directory';
    case 'web': return action.query || action.url;
    case 'task': return action.description;
    case 'other': return action.name;
    default: return '';
  }
}

export function approvalResponsePayload(requestId, behavior, optionId, message) {
  const payload = { type: 'approval_response', request_id: requestId };
  // Named choices and generic Allow/Deny controls are distinct wire forms.
  if (optionId) payload.option_id = optionId;
  else payload.behavior = behavior;
  if (message) payload.message = message;
  return payload;
}

export function prettyJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
