/**
 * Console runner for the same suite `test/index.html` renders in a browser.
 * Requires a JS runtime with ES module support:
 *
 *   node test/run.js
 *
 * Exits non-zero if anything failed, so it can gate a commit.
 */

import { results } from './tests.js';

const failed = results.filter((r) => !r.ok);

for (const result of results) {
  if (result.ok) console.log(`  ok  ${result.name}`);
  else console.log(` FAIL ${result.name}\n        ${result.message}`);
}

console.log(`\n${results.length - failed.length} / ${results.length} passing`);
if (failed.length) process.exit(1);
