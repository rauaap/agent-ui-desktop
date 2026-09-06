/** Pure Bash path-completion matching, token parsing, and safe insertion. */

export const COMPLETION_LIMIT = 50;
const OPERATORS = new Set(['|', '&', ';', '(', ')', '<', '>']);
const isBoundary = (character) => /\s/.test(character) || OPERATORS.has(character);

/** True when composer text is currently in the client's leading-! Bash mode. */
export function isBashComposer(text) {
  const first = String(text ?? '').search(/\S/);
  return first >= 0 && text[first] === '!';
}

/**
 * Find and decode the shell token at the cursor.
 *
 * This is deliberately an incomplete-input parser rather than a command
 * parser: it recognizes boundaries, quotes and escapes, but never evaluates
 * substitutions or executes anything. `start`/`end` cover the complete raw
 * token, while `query` contains only its decoded prefix through the cursor.
 */
export function completionToken(text, cursor = String(text ?? '').length) {
  text = String(text ?? '');
  cursor = Math.max(0, Math.min(text.length, Number.isInteger(cursor) ? cursor : text.length));
  const first = text.search(/\S/);
  if (first < 0 || text[first] !== '!' || cursor <= first) return null;
  const commandStart = first + 1;

  let start = commandStart;
  let quote = null;
  let escaped = false;
  for (let i = commandStart; i < cursor; i += 1) {
    const character = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (isBoundary(character)) start = i + 1;
  }

  // Decode only the prefix, since completion is based on what precedes the
  // cursor even when the complete token has an existing suffix after it.
  const query = decodeShellFragment(text.slice(start, cursor));

  let end = cursor;
  let endQuote = quote;
  let endEscaped = escaped;
  for (; end < text.length; end += 1) {
    const character = text[end];
    if (endEscaped) {
      endEscaped = false;
      continue;
    }
    if (endQuote === "'") {
      if (character === "'") endQuote = null;
      continue;
    }
    if (character === '\\') {
      endEscaped = true;
      continue;
    }
    if (endQuote === '"') {
      if (character === '"') endQuote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      endQuote = character;
      continue;
    }
    if (isBoundary(character)) break;
  }

  return { start, end, query };
}

export function decodeShellFragment(fragment) {
  let result = '';
  let quote = null;
  for (let i = 0; i < fragment.length; i += 1) {
    const character = fragment[i];
    if (quote === "'") {
      if (character === "'") quote = null;
      else result += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\' && i + 1 < fragment.length) result += fragment[++i];
      else result += character;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === '\\') {
      if (i + 1 < fragment.length) result += fragment[++i];
      continue;
    }
    result += character;
  }
  return result;
}

/** Match only at the beginning of the full path or a path component. */
export function componentMatchIndex(pathLower, queryLower) {
  if (!queryLower || pathLower.startsWith(queryLower)) return 0;
  const found = pathLower.indexOf(`/${queryLower}`);
  return found < 0 ? -1 : found + 1;
}

/**
 * Match and deterministically rank a cache's `{path, lower}` search rows.
 * The limit constrains rendering, never the synchronized cache.
 */
export function matchPaths(searchPaths, query, limit = COMPLETION_LIMIT) {
  const lowerQuery = String(query ?? '').toLowerCase();
  const queryForExact = lowerQuery.endsWith('/') ? lowerQuery.slice(0, -1) : lowerQuery;
  const ranked = [];

  for (const item of searchPaths || []) {
    const boundary = componentMatchIndex(item.lower, lowerQuery);
    if (boundary < 0) continue;
    const exactPath = item.lower.endsWith('/') ? item.lower.slice(0, -1) : item.lower;
    ranked.push({
      ...item,
      boundary,
      exact: exactPath === queryForExact,
      atStart: boundary === 0,
    });
  }

  ranked.sort((a, b) => Number(b.exact) - Number(a.exact)
    || Number(b.atStart) - Number(a.atStart)
    || a.boundary - b.boundary
    || a.path.length - b.path.length
    || compareStrings(a.lower, b.lower)
    || compareStrings(a.path, b.path));
  return ranked.slice(0, Math.max(0, limit)).map((item) => item.path);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Quote one path as one POSIX shell argument, preserving safe paths verbatim. */
export function shellEscape(path) {
  path = String(path ?? '');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Return composer text with the complete current token safely replaced. */
export function insertCompletion(text, token, path) {
  const escaped = shellEscape(path);
  return `${text.slice(0, token.start)}${escaped}${text.slice(token.end)}`;
}
