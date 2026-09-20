/**
 * Unit tests for `js/usage.js` — the shapes `GET /usage` can return and what
 * the panel is allowed to say about each of them.
 */

import {
  errorKind,
  formatDuration,
  formatPercent,
  hasReading,
  isTransient,
  mergeUsage,
  normalizeUsage,
  remainingSeconds,
  resetLabel,
  usageLevel,
} from '../js/usage.js';

export const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, message = 'Expected true') {
  if (!value) throw new Error(message);
}

/** The documented success response, with the timestamps from the spec. */
const SAMPLE = {
  claude_code: {
    five_hour: { used_percent: 23.0, reset_at: 1789933800 },
    weekly: { used_percent: 12.0, reset_at: 1790218800 },
    error: null,
  },
  codex: {
    five_hour: { used_percent: 6.0, reset_at: 1789936104 },
    weekly: { used_percent: 51.0, reset_at: 1790415517 },
    error: null,
  },
};

test('usage: the documented response reads back window by window', () => {
  const plans = normalizeUsage(SAMPLE, 1789930000);
  equal(plans.map((p) => [p.key, p.name, p.error, p.kind]), [
    ['claude_code', 'Claude Code', null, null],
    ['codex', 'Codex', null, null],
  ]);
  equal(plans[0].windows.map((w) => [w.key, w.name, w.percent, w.resetAt]), [
    ['five_hour', 'Five-hour', 23, 1789933800],
    ['weekly', 'Weekly', 12, 1790218800],
  ]);
  equal(plans[1].windows.map((w) => w.percent), [6, 51]);
  assertTrue(plans.every(hasReading));
});

test('usage: plans keep a fixed order and an unknown plan follows, labelled', () => {
  const plans = normalizeUsage({ gemini: { five_hour: null, weekly: null, error: null }, codex: {}, claude_code: {} });
  equal(plans.map((p) => p.key), ['claude_code', 'codex', 'gemini']);
  equal(plans[2].name, 'Gemini');
});

test('usage: only Codex’s five-hour window is rolling', () => {
  const plans = normalizeUsage(SAMPLE, 0);
  equal(plans[0].windows.map((w) => w.rolling), [false, false]);
  equal(plans[1].windows.map((w) => w.rolling), [true, false]);
});

test('usage: a rolling countdown is measured from the read, a fixed one from now', () => {
  const readAt = 1000;
  const [claude, codex] = normalizeUsage({
    claude_code: { five_hour: { used_percent: 1, reset_at: 5000 }, weekly: null, error: null },
    codex: { five_hour: { used_percent: 1, reset_at: 5000 }, weekly: null, error: null },
  }, readAt);
  // Fixed: shrinks as the clock moves on between polls.
  equal(remainingSeconds(claude.windows[0], 2000), 3000);
  // Rolling: `reset_at` moves on every poll, so counting down locally would
  // show a deadline that is not one. It stays as read until the next read.
  equal(remainingSeconds(codex.windows[0], 2000), 4000);
  equal(remainingSeconds(codex.windows[0], 4000), 4000);
});

test('usage: a null window on a successful read is a row with no reading', () => {
  const [plan] = normalizeUsage({ claude_code: { five_hour: null, weekly: { used_percent: 12, reset_at: null }, error: null } }, 0);
  equal(plan.windows.map((w) => [w.key, w.percent, w.resetAt]), [
    ['five_hour', null, null],
    ['weekly', 12, null],
  ]);
  assertTrue(hasReading(plan), 'the weekly reading still counts');
  // Null `reset_at` on a good read means no countdown, never an epoch date.
  equal(remainingSeconds(plan.windows[1], 0), null);
  equal(resetLabel(plan.windows[1], 0), 'Reset time unavailable');
});

test('usage: an unauthenticated plan reports a reason instead of failing', () => {
  const plans = normalizeUsage({
    claude_code: SAMPLE.claude_code,
    codex: { five_hour: null, weekly: null, error: 'not authenticated' },
  }, 0);
  // Reading each plan independently is the point: one failure is not the
  // response being bad.
  assertTrue(hasReading(plans[0]));
  assertTrue(!hasReading(plans[1]));
  equal(plans[1].kind, 'unconfigured');
});

test('usage: every documented error string maps to its handling', () => {
  equal(errorKind(null), null);
  equal(errorKind(''), null);
  equal(errorKind('not authenticated'), 'unconfigured');
  equal(errorKind('HTTP 401'), 'reauth');
  equal(errorKind('HTTP 503'), 'upstream');
  equal(errorKind('unreachable: timed out after 5s'), 'unreachable');
  equal(errorKind('unreadable response: missing key'), 'unreadable');
  equal(errorKind('something new'), 'unknown');
  equal([
    'unconfigured', 'reauth', 'upstream', 'unreachable', 'unreadable', 'unknown',
  ].filter(isTransient), ['upstream', 'unreachable']);
});

test('usage: a transient failure keeps the last good numbers, marked stale', () => {
  const previous = normalizeUsage(SAMPLE, 1000);
  const next = normalizeUsage({
    claude_code: SAMPLE.claude_code,
    codex: { five_hour: null, weekly: null, error: 'unreachable: timed out' },
  }, 2000);
  const merged = mergeUsage(previous, next);
  assertTrue(merged[1].stale);
  equal(merged[1].windows.map((w) => [w.percent, w.stale, w.readAt]), [
    [6, true, 1000], [51, true, 1000],
  ]);
  // A stale window has a share spent but no deadline left to report, and its
  // age counts from the good read it came from — not from the poll that failed.
  equal(remainingSeconds(merged[1].windows[0], 2000), null);
  equal(resetLabel(merged[1].windows[0], 1000 + 180), 'Last reading, 3m ago');
  equal(resetLabel(merged[1].windows[0], 2000), 'Last reading, 16m ago');
});

test('usage: a rejected token or an unreadable shape drops the old numbers', () => {
  const previous = normalizeUsage(SAMPLE, 1000);
  for (const error of ['HTTP 401', 'not authenticated', 'unreadable response: junk']) {
    const merged = mergeUsage(previous, normalizeUsage({
      codex: { five_hour: null, weekly: null, error },
    }, 2000));
    assertTrue(!merged[0].stale, `${error} must not resurrect old numbers`);
    assertTrue(!hasReading(merged[0]), `${error} must not resurrect old numbers`);
  }
});

test('usage: merging without a previous reading leaves the failure alone', () => {
  const next = normalizeUsage({ codex: { five_hour: null, weekly: null, error: 'HTTP 502' } }, 0);
  equal(mergeUsage([], next)[0].stale, false);
  equal(mergeUsage(null, next)[0].stale, false);
});

test('usage: percentages are clamped and out-of-range or absent readings vanish', () => {
  const [plan] = normalizeUsage({
    claude_code: {
      five_hour: { used_percent: 140, reset_at: 5 },
      weekly: { used_percent: 'nonsense', reset_at: 'later' },
      error: null,
    },
  }, 0);
  equal(plan.windows.map((w) => [w.percent, w.resetAt]), [[100, 5], [null, null]]);
});

test('usage: a garbled payload renders nothing rather than throwing', () => {
  equal(normalizeUsage(null), []);
  equal(normalizeUsage('nope'), []);
  equal(normalizeUsage([1, 2]), []);
  equal(normalizeUsage({ codex: 'nope' }), []);
});

test('usage: percentages read as written', () => {
  equal(formatPercent(23.0), '23%');
  equal(formatPercent(6.5), '6.5%');
  equal(formatPercent(0), '0%');
  equal(formatPercent(12.34), '12.3%');
  equal(formatPercent(null), '—');
});

test('usage: severity thresholds', () => {
  equal([0, 74.9, 75, 89.9, 90, 100].map(usageLevel),
    ['normal', 'normal', 'high', 'high', 'critical', 'critical']);
  equal(usageLevel(null), 'unknown');
});

test('usage: durations are coarse, and a passed deadline has none', () => {
  equal(formatDuration(30), 'under a minute');
  equal(formatDuration(600), '10m');
  equal(formatDuration(3600 * 4 + 1200), '4h 20m');
  equal(formatDuration(86400 * 2 + 3600 * 6), '2d 6h');
  equal(formatDuration(0), null);
  equal(formatDuration(-5), null);
  equal(formatDuration(NaN), null);
});

test('usage: reset lines say what is true of each kind of window', () => {
  const [claude, codex] = normalizeUsage({
    claude_code: { five_hour: { used_percent: 1, reset_at: 5000 }, weekly: null, error: null },
    codex: { five_hour: { used_percent: 1, reset_at: 5000 }, weekly: null, error: null },
  }, 1000);
  equal(resetLabel(claude.windows[0], 2000), 'Resets in 50m');
  equal(resetLabel(codex.windows[0], 2000), 'Resets in about 1h 6m');
  equal(resetLabel(claude.windows[0], 6000), 'Resetting now');
});
