/**
 * Subscription usage, from `GET /usage`.
 *
 * The keys this endpoint reports are **plans, not agents**. `claude_code` and
 * `codex` deliberately do not match the agent ids from `GET /agents`
 * (`claude-code`, `pi`), because one subscription can back several harnesses —
 * so nothing here maps a plan onto an adapter, and a session's agent does not
 * tell you which quota its turns draw from. They are labelled by plan.
 *
 * Both keys are always present, and each carries its own `error`: a plan that
 * is unauthenticated or unreachable reports null windows and a reason rather
 * than failing the whole request. A non-null `error` on one plan therefore says
 * nothing about the other, which is why every plan is read independently and
 * why the renderer is given a list rather than a pass/fail.
 *
 * This module is pure — no fetching, no DOM — so the shapes it has to survive
 * (a null window on a successful read, a `reset_at` that moves between polls)
 * are testable without a server.
 */

/** Rendered in this order; anything else the server grows follows after. */
export const PLAN_ORDER = ['claude_code', 'codex'];
const PLAN_NAMES = { claude_code: 'Claude Code', codex: 'Codex' };

export const WINDOW_ORDER = ['five_hour', 'weekly'];
const WINDOW_NAMES = { five_hour: 'Five-hour', weekly: 'Weekly' };

/** A key we were not told about is still worth showing, so make it readable. */
const humanize = (key) => String(key)
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

export const planName = (key) => PLAN_NAMES[key] ?? humanize(key);

/**
 * Sort the observed `error` strings into the handling each one deserves. The
 * server's vocabulary is small and documented; an unrecognised reason is
 * reported verbatim rather than guessed at.
 */
export function errorKind(error) {
  const text = typeof error === 'string' ? error.trim() : '';
  if (!text) return null;
  if (/^not authenticated$/i.test(text)) return 'unconfigured';
  if (/^http 401\b/i.test(text)) return 'reauth';
  if (/^http \d+/i.test(text)) return 'upstream';
  if (/^unreachable\b/i.test(text)) return 'unreachable';
  if (/^unreadable response\b/i.test(text)) return 'unreadable';
  return 'unknown';
}

/**
 * Whether a failure is one to ride out. Only these two mean "the plan is fine,
 * this read was not" — an expired token or a shape we cannot parse are states
 * of the plan, and showing yesterday's numbers under them would be a lie.
 */
export const isTransient = (kind) => kind === 'upstream' || kind === 'unreachable';

/** `used_percent` is a float 0–100; anything else is no reading at all. */
function clampPercent(value) {
  const percent = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}

/**
 * Codex's five-hour window is *rolling*: before the first request of a window
 * its reset is simply five hours from now, and `reset_at` moves on every poll.
 * Counting down from it locally would show a deadline that is not one, so a
 * rolling window's remaining time is measured from when it was read and then
 * left alone until the next poll re-reads it.
 */
const isRolling = (planKey, windowKey) => planKey === 'codex' && windowKey === 'five_hour';

function normalizeWindow(planKey, key, raw, readAt) {
  const shell = {
    key,
    name: WINDOW_NAMES[key] ?? humanize(key),
    rolling: isRolling(planKey, key),
    readAt,
  };
  // A window may be null even on a successful read. It is kept as a row with no
  // reading rather than dropped, so a plan reporting one of its two windows
  // does not quietly look like a plan with only one window.
  if (!raw || typeof raw !== 'object') return { ...shell, percent: null, resetAt: null };
  return {
    ...shell,
    percent: clampPercent(raw.used_percent),
    // May be null on a successful read: treat the countdown as unavailable
    // rather than rendering an epoch date.
    resetAt: Number.isFinite(raw.reset_at) ? Number(raw.reset_at) : null,
  };
}

const windowKeysOf = (plan) => [
  ...WINDOW_ORDER.filter((key) => key in plan),
  ...Object.keys(plan).filter((key) => key !== 'error' && !WINDOW_ORDER.includes(key)),
];

function normalizePlan(key, raw, readAt) {
  if (!raw || typeof raw !== 'object') return null;
  const error = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : null;
  return {
    key,
    name: planName(key),
    error,
    kind: errorKind(error),
    stale: false,
    windows: windowKeysOf(raw).map((w) => normalizeWindow(key, w, raw[w], readAt)),
  };
}

/**
 * The response as a list of plans to render, in a stable order.
 *
 * `readAt` is stamped onto every window because a rolling `reset_at` is only
 * meaningful relative to the moment it was read.
 */
export function normalizeUsage(payload, readAt = Date.now() / 1000) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const keys = [
    ...PLAN_ORDER.filter((key) => key in payload),
    ...Object.keys(payload).filter((key) => !PLAN_ORDER.includes(key)),
  ];
  return keys.map((key) => normalizePlan(key, payload[key], readAt)).filter(Boolean);
}

/** Whether anything on this plan can actually be drawn. */
export const hasReading = (plan) => plan.windows.some((w) => w.percent !== null);

/**
 * Carry the last good numbers through a transient failure, marked as what they
 * are. A network blip should not blank a panel that was showing a useful
 * answer a minute ago — but the numbers are labelled stale and their countdowns
 * dropped, because what is still true is the share spent, not the deadline.
 */
export function mergeUsage(previous, next) {
  const before = new Map((previous ?? []).map((plan) => [plan.key, plan]));
  return next.map((plan) => {
    if (hasReading(plan) || !isTransient(plan.kind)) return plan;
    const kept = (before.get(plan.key)?.windows ?? []).filter((w) => w.percent !== null);
    if (!kept.length) return plan;
    return {
      ...plan,
      stale: true,
      // Keep each window's original readAt: it is how long ago these numbers
      // were true, which is the only honest thing left to say about them.
      windows: kept.map((w) => ({ ...w, stale: true })),
    };
  });
}

/* ------------------------------------------------------------------ */
/* presentation                                                       */
/* ------------------------------------------------------------------ */

/** Whole numbers stay whole; 23.0 is "23%", not "23.0%". */
export function formatPercent(percent) {
  if (percent === null || percent === undefined) return '—';
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * The severity the meter's fill carries. Thresholds are about the share spent,
 * so they are the same for a five-hour window and a weekly one.
 */
export function usageLevel(percent) {
  if (percent === null || percent === undefined) return 'unknown';
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'high';
  return 'normal';
}

/**
 * Seconds until this window resets, or null when there is no countdown to
 * offer. A rolling window is measured from its read; a fixed one from now.
 */
export function remainingSeconds(window, now = Date.now() / 1000) {
  if (!window || window.stale || window.resetAt === null) return null;
  return window.resetAt - (window.rolling ? window.readAt : now);
}

/** Coarse on purpose: these windows are hours and days, not seconds. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m`;
  return 'under a minute';
}

/** The line under a meter: when it resets, or why that cannot be said. */
export function resetLabel(window, now = Date.now() / 1000) {
  if (!window) return '';
  if (window.stale) {
    const age = formatDuration(now - window.readAt);
    return age ? `Last reading, ${age} ago` : 'Last reading, just now';
  }
  if (window.resetAt === null) return 'Reset time unavailable';
  const left = formatDuration(remainingSeconds(window, now));
  if (!left) return 'Resetting now';
  // "about", because this one was five hours from the moment it was read and
  // will have moved by the next poll.
  return window.rolling ? `Resets in about ${left}` : `Resets in ${left}`;
}
