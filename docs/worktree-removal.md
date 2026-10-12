# Worktree removal and directory existence

The desktop fetches projects, sessions, worktrees and agents, then
`GET /directory-existence`. The combined refresh is published together. If a
catalog path is absent, the client retries the entire refresh once; still-unknown
paths remain unknown until a subsequent refresh, never treated as missing.
Transient failures retain the last complete snapshot. Refreshes run every three
seconds while visible and after worktree deletion, including failed attempts.
No new WebSocket event is required.

Project/worktree `exists` values are local presentation fields derived from the
separate existence snapshot, not API catalog properties. Session existence is
looked up using the preserved effective working directory. FWT / FORMER WORKTREE
indicates no managed association; MISSING independently indicates a directory
that does not exist. Recreating a directory clears MISSING without clearing FWT.

Removal confirmations count attached and already-detached sessions using the
path, whether live or archived. Removal preserves their conversations, settings,
archive state and exact working directory. Busy agent turns or shell commands
and Git safe-removal refusals still prevent removal. Archive and explicit
detachment actions are unchanged.

`js/catalog-snapshot.js` owns fetching and the bounded retry. `js/app.js` owns
publication and request ordering; one request identity is retained throughout a
retry so an older read cannot supersede a newer action refresh. Existence-map
lookups use `directoryExists` consistently; presentation rows retain derived
`exists` fields.

Network orchestration is tested through direct imports in
`node test/catalog-snapshot-tests.js`. `node test/catalog-poll-tests.js` retains
small app-wiring checks for visibility/auth guards, publication and overlap.
Other regression tests: `node test/worktree-removal-tests.js` and
`node test/run.js`.
