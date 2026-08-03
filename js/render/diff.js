/**
 * Line-level diff of two text blocks, with interior line matching via a
 * longest-common-subsequence alignment. A direct port of the Android client's
 * LineDiff.java — pure, no DOM, so the same tests apply.
 */

export const CONTEXT = 'context';
export const DELETE = 'delete';
export const ADD = 'add';

/**
 * Above this many changed lines per side we skip the O(m*n) alignment and fall
 * back to a plain block diff — nobody reads a 500-line diff anyway.
 */
export const MAX_DIFF_LINES = 500;

const row = (kind, text) => ({ kind, text });

/** Diff `oldText` against `newText` by line, in display order. */
export function diff(oldText, newText) {
  const oldS = oldText ?? '';
  const newS = newText ?? '';
  const rows = [];

  // Both sides empty: nothing to show. Returning no rows lets the caller fall
  // back to raw JSON instead of painting a lone empty "+" line.
  if (!oldS && !newS) return rows;

  // A created or deleted block has no counterpart to align against, so it is
  // purely added or removed — and this keeps a huge Write off the table.
  if (!oldS) {
    for (const line of newS.split('\n')) rows.push(row(ADD, line));
    return rows;
  }
  if (!newS) {
    for (const line of oldS.split('\n')) rows.push(row(DELETE, line));
    return rows;
  }

  const o = oldS.split('\n');
  const n = newS.split('\n');

  // Trim common leading/trailing lines into context, shrinking the region the
  // alignment has to chew on to just the part that actually changed.
  let pre = 0;
  while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
  let suf = 0;
  while (suf < o.length - pre && suf < n.length - pre
         && o[o.length - 1 - suf] === n[n.length - 1 - suf]) suf++;

  for (let i = 0; i < pre; i++) rows.push(row(CONTEXT, o[i]));

  if (o.length - pre - suf > MAX_DIFF_LINES || n.length - pre - suf > MAX_DIFF_LINES) {
    for (let i = pre; i < o.length - suf; i++) rows.push(row(DELETE, o[i]));
    for (let i = pre; i < n.length - suf; i++) rows.push(row(ADD, n[i]));
  } else {
    align(rows, o, n, pre, suf);
  }

  for (let i = n.length - suf; i < n.length; i++) rows.push(row(CONTEXT, n[i]));
  return rows;
}

/**
 * Align the changed region of both sides with an LCS, so unchanged interior
 * lines stay context instead of a delete plus an insert. Within each replaced
 * run, deletes are emitted before inserts (git ordering).
 */
function align(rows, o, n, start, suf) {
  const m = o.length - suf - start; // changed old lines
  const p = n.length - suf - start; // changed new lines

  // dp[i][j] = LCS length of o[start+i..] and n[start+j..] within the region
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(p + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = p - 1; j >= 0; j--) {
      dp[i][j] = o[start + i] === n[start + j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const dels = [];
  const inss = [];
  const flush = () => {
    for (const d of dels) rows.push(row(DELETE, d));
    for (const s of inss) rows.push(row(ADD, s));
    dels.length = 0;
    inss.length = 0;
  };

  let i = 0;
  let j = 0;
  while (i < m && j < p) {
    if (o[start + i] === n[start + j]) {
      flush();
      rows.push(row(CONTEXT, o[start + i]));
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      dels.push(o[start + i++]);
    } else {
      inss.push(n[start + j++]);
    }
  }
  while (i < m) dels.push(o[start + i++]);
  while (j < p) inss.push(n[start + j++]);
  flush();
}
