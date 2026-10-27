# Model output streaming — desktop client

The wire contract is the server's
`docs/model-streaming-client-handoff.md` (authoritative design:
`docs/model-streaming-implementation-spec.md`). This note covers how the
desktop client applies it.

## State

- `state.drafts` is a `Map` from `stream_id` to the client's draft model
  (`parseDraft` in `js/store.js`). It is separate from `rows`, `history.events`
  and `history.ids`. Insertion order is source order: starts arrive in order,
  and a snapshot arrives already sorted.
- `Store.apply` routes `stream_start`, `stream_delta`, `stream_snapshot` and
  `stream_remove` to `applyStream` **before** history recording. No delta ever
  enters the replay log, so history prepends and rebuilds never replay one.
- A text delta appends to `text`. A tool delta appends to `argumentsJson` and
  **replaces** `argumentsPreview`; partial JSON is never parsed client-side.
- Final `output`/`tool_use` and durable `stream_interrupted` retire the draft
  with the same `stream_id`, and still render on their own when no draft
  exists, as in history replay.
- **Source order.** Rows from generated blocks record `source` (`turn_id`,
  `ordinal`). A new one is inserted before the first row of the same turn
  with a later ordinal, so blocks keep the turn's source order even when
  ordinal 1 completes before ordinal 0. The change carries `before` (that row's
  key) for the view. History replays in completion order through the same
  rule, so live, reconnect and prepend agree. An approval or question that
  takes over a card inherits its `source`.
- A streamed `output` is one whole block with its own identity: it neither
  absorbs nor is absorbed by other output. Only unidentified `output` chunks
  coalesce into one agent message, as before.
- Strict `tool_use` validation admits only `stream_id`, `turn_id` and `ordinal`
  in addition to the existing keys, each well-typed. Canonical action
  validation is unchanged. Previews never reach `isCanonicalAction`.

## Revisions and resynchronization

A delta whose revision is at or below the draft's is ignored, and so is a
duplicate start. A revision gap, an update for an unknown draft, or a malformed
stream frame makes `apply` return `false`. `SessionSocket.resync` then drops
the connection, ignoring anything more from it, and reconnects at once for
authoritative history and a fresh snapshot. A resync that keeps recurring backs
off exponentially; a cleanly applied live delta resets the backoff.

## Reconnect, replay and prepend

The server sends history, one `stream_snapshot`, `input_queue`, then `status`.
A reconnect buffers all of it, snapshot included, in the shadow state, and
`commitReplay` swaps in history and drafts together at the status marker.
Drafts missing from the snapshot are gone. The first connection applies the
snapshot directly. `prependHistory` rebuilds rows only; live drafts stay as
they are.

## Questions and approvals

A `question` with a `call_id` takes the slot and key of the completed `tool_use`
card for that call, as an approval does. The result is one card, with controls
built only from the question request. A `tool_use` arriving after its question
adds no second card. Drafts and interrupted entries never offer controls, and a
completed call creates no pending approval.

## Rendering

- Each draft node sits before the first row of its turn with a later ordinal,
  and otherwise after every row (`placeDrafts`). Drafts are re-placed after
  structural changes only, and a node already in place is not moved, which
  keeps selections. Durable rows go where the store put them.
- A draft's node is created on its start. Later deltas only mark it dirty, and
  dirty drafts are redrawn at most once per animation frame, with one
  scroll-follow restore per frame. Follow the tail only while already following.
- Final, remove and snapshot changes take effect synchronously and cancel any
  pending redraw of the drafts they retire.
- Text drafts use the same sanitizing Markdown renderer as completed output. It
  shows an unclosed fence or link as literal text.
- Tool drafts use `draftPreview` (`js/tools.js`), a provisional model that reads
  only fields that are already strings. It strips MCP prefixes, names a
  messaging target only once a valid `session_id` exists ("composing…"
  before that), and shows the decoded `message` once. A growing body appends
  text nodes in place, so a selection inside it survives. Raw provisional
  arguments sit in a collapsed disclosure that is serialized only while open.
- `stream_interrupted` renders as an `INTERRUPTED · <reason>` entry with no
  controls, and is included in search and Markdown export. Drafts are excluded
  from both: they are not part of the transcript yet.
