/**
 * Pure helpers for `tool_use` payloads — no DOM, so both the store (which uses
 * the summary to decide whether an approval replaces the tool card it follows)
 * and the renderers can share them.
 *
 * `input` is an opaque, tool-specific passthrough of the agent's raw arguments
 * (see the server's docs/tool_use_event_schema.md): no key is guaranteed, so
 * every read here is guarded.
 */

const firstString = (input, ...keys) => {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
};

/**
 * A one-line description of what a tool call does, used as the card's header
 * and as the identity check when an approval arrives for the tool_use just
 * rendered. Ported from SessionActivity.toolSummary.
 */
export function toolSummary(tool, input) {
  if (!input || typeof input !== 'object') return '';
  switch (tool) {
    case 'Bash':
      return firstString(input, 'command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return firstString(input, 'file_path', 'path');
    case 'Glob':
    case 'Grep':
      return firstString(input, 'pattern', 'query');
    case 'WebFetch':
    case 'WebSearch':
      return firstString(input, 'url', 'query');
    case 'Task':
      return firstString(input, 'description');
    default: {
      const direct = firstString(
        input, 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'description',
      );
      if (direct) return direct;
      // Unknown tool: show the first non-empty string argument rather than
      // nothing, so the header still says something useful.
      for (const value of Object.values(input)) {
        if (typeof value === 'string' && value) return value;
      }
      return '';
    }
  }
}

export function prettyJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
