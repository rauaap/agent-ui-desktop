# Inter-agent messaging: client UI design

This is the shared visual and behavioural design for the inter-agent messaging
feature. The desktop and Android clients should both follow it so users see the
same concepts, wording and colours on each. Where a platform needs a different
interaction (hover versus long-press), both variants are listed. Everything
else, including labels, ordering, colours and fallbacks, should match.

Server-side design: `agent-ui-server/docs/inter_agent_communication_design.md`.

## Protocol facts the UI relies on

- `GET /sessions` returns each session's `id` and optional `worktree_id`.
  `GET /worktrees` returns each worktree's `id`. IDs are integers on the wire.
  Compare them as strings, since the desktop client normalises them that way.
- `input` events carry `source` next to `text`:
  - `{"type": "user"}`: typed by the user.
  - `{"type": "agent", "session_id": 42}`: sent by **another** agent.
    `session_id` is the **sender's** ID, not the receiving session's.
  - `source` missing (the key is absent): an older record. Treat it as `user`.
    This is the **only** case besides `{"type": "user"}` that counts as the
    user.
  - Any other shape is an **unknown source**, handled as described below, and is
    never shown as the user's own message. That includes `source: null`, an
    unknown `type`, and `agent` whose `session_id` isn't a positive integer (a
    string `"42"`, `4.5`, `0`, a negative number). The check is
    `Number.isInteger(id) && id > 0`.
- Scrollback replayed over the WebSocket is flattened by the server
  (`frame_for_scrollback`), so replayed `input` events have `source` at the top
  level, just like live ones. Only the raw record returned by the REST scrollback
  endpoint nests it under `payload`.
- `text` never includes a sender prefix. The client adds the sender label.
- An agent can message a session in **any project**. Look up senders and
  targets in the unscoped `GET /sessions` list (it returns every session), not
  only the current project's. A link to a sender or target may lead into
  another project, so resolve that session's project before opening it.
- The three tools arrive as ordinary approval and tool events with action kind
  `other`, `name` set to the tool name, and `arguments` holding the tool
  arguments. All three always require approval, so auto-approve settings never
  apply to them.
- The tool row and the approval for the same call carry **different data**:
  - The `tool_use` row has the harness's name (`mcp__agent_ui__message_session`
    for Claude) and the model's raw input.
  - The approval has the bare name (`message_session`) and the server's
    validated arguments: nulls dropped and defaults filled in (`read_session`
    gains `limit: 200`).

  Accept exactly two spellings everywhere: the bare name and
  `mcp__agent_ui__<tool>`. Don't match any `…__read_session`: another MCP
  server's tool with the same name must not be shown as one of ours. Render each card from the event
  it came from, treating a missing `sandbox` as sandboxed and a missing `limit`
  as 200.
- For Claude, the server tags the approval with the tool call's real
  `call_id` (from the MCP request's `_meta["claudecode/toolUseId"]`), so the
  approval replaces the tool row the same way it does for built-in tools.
  **Don't add client-side folding** for these tools. Folding stays keyed on a
  matching `call_id`. pi was never affected.

  | Tool              | Arguments                                                                    |
  |-------------------|------------------------------------------------------------------------------|
  | `message_session` | `session_id`, `message`                                                      |
  | `start_session`   | `name`, `project_path`, `message`, `agent?`, `worktree_id?`, `sandbox?` (defaults to true) |
  | `read_session`    | `session_id`, `after?`, `limit` (defaults to 200)                            |

## Colours

These use the existing theme tokens (`css/theme.css`, dark theme):

| Token         | Value                       | Used for                                    |
|---------------|-----------------------------|---------------------------------------------|
| `info`        | `#7ea7e0`                   | Agent-message accent, sender link           |
| `info-soft`   | `rgba(126, 167, 224, 0.13)` | Agent-message background                    |
| `info-line`   | `rgba(126, 167, 224, 0.4)`  | Agent-message border                        |
| `faint`       | `#6f6a7d`                   | `#id` labels, `FROM` label, unavailable sender |
| `muted`       | `#9893a6`                   | Worktree meta line                          |
| `danger`      | `#ef6f63`                   | Unknown target in an approval card          |
| `accent-soft` | `rgba(217, 119, 87, 0.14)`  | User bubble (unchanged)                     |

The rule: **orange means the user, blue means another agent.** Don't use blue
for anything else in the transcript.

## 1. Agent messages in the transcript

User messages remain orange bubbles aligned to the right. The session's own
agent output remains unboxed text on the left. An input from another agent is
different from both:

```
                                  ┌────────────────────────────┐
                                  │ Can you fix the flaky test?│   ← user (orange, right)
                                  └────────────────────────────┘
  Sure, looking at it now…                                          ← this session's agent

┃ FROM  api refactor  #42                                   Copy   ← other agent
┃ Please review the diff in src/db.py before I merge.              (blue, left, full width)
┃ The migration is in 0007_add_source.py.
```

- **Container:** full width and left-aligned, with an `info-soft` background,
  a 1px `info-line` border, and a thicker `info` bar down the left edge. Use the
  same corner radius as the user bubble.
- **Header line,** in this order:
  1. `FROM`: small, uppercase, in `faint`.
  2. The sender session's **current** name in `info`, as a link. Activating it
     opens that session, even when it's in another project. Look the name up
     each time the row is drawn, not when the message arrives, so renames show
     up.
  3. `#42`: monospace, in `faint`.
  4. An `ARCHIVED` tag if the sender is archived. The link still works.
- **Body:** plain text with line breaks kept, the same as the user bubble. Don't
  render it as Markdown, because it's input, not agent output.
- **Copy:** copies the body text. On desktop the button appears on hover in the
  top-right corner. On Android, use the same long-press or overflow copy action
  as agent replies.
- **Session list not loaded yet:** replayed scrollback usually arrives before
  `GET /sessions` does. Until the list has loaded, show only the bare `#42`
  (no name, no link, no "unavailable"), then redraw once it arrives. The same
  applies to targets in approval and tool cards (section 3): they must redraw
  too, not only message headers.
- **Sender not found** once the list has loaded (deleted, or not in the list):
  the header reads
  `FROM  session #42  (unavailable)`, all in `faint`, with no link. Keep the ID.
- **Unknown source:** the same blue container with the header
  `FROM  unknown source`, in `faint`, with no link.
- **Export (Markdown):** where a user message gets the heading `You`, an agent
  message gets `From api refactor (#42)`, `From session #42 (unavailable)`,
  `From session #42` (list not loaded) or `From unknown source`. Use the same
  heading style (desktop uses `### You`, so `### From api refactor (#42)`).
- **Search:** match the sender name as well as the body.
- **Composer history recall** (up-arrow on desktop): agent-sent inputs must not
  appear in it. It only holds what the user typed. Exclude an input when
  `source` is present and isn't `user`, so old records without `source` still
  count. Apply this everywhere history is filled. On desktop that's both the
  rebuild from transcript rows on load and reconnect and the live `input`
  handler. Otherwise agent messages reappear after a reconnect.

## 2. Exposing IDs

The ID format is always `#` followed by the number, in monospace and `faint`.
Copying puts **only the number** on the clipboard (`42`, not `#42`). After a
copy, the label briefly changes to `copied` (desktop) or a toast reads
`Session ID copied` / `Worktree ID copied` (Android).

### Session pane header

```
  api refactor  #42
  WORKTREE  ~/proj/.worktrees/feat-x  #7
```

- `#42` goes after the session name. Clicking or tapping it copies the ID. On
  desktop, hover underlines it and the tooltip reads `Copy session ID`.
- For a worktree session, `#7` goes after the working-directory path and copies
  the worktree ID the same way.

### Session list (sidebar / Android drawer)

The context menu (right-click on desktop, long-press on Android) gets a copy
item directly above Archive:

```
    Copy session ID          ← one session selected
    Copy 3 session IDs       ← multiple selected; copies "42, 43, 51"
    Archive
    Delete…
```

Clients without multi-select (Android) offer only `Copy session ID`. The menu
closes when an item is chosen, so the confirmation is a toast (`Session ID
copied` / `3 session IDs copied`) on both platforms.

Desktop also adds a `#42` line to the row's hover tooltip. Android has no
tooltip equivalent and doesn't need one.

### Session settings

Read-only rows go directly under the name control, each with a small `Copy`
button. On Android they sit below the Rename button.

```
  Session ID    42          Copy
  Worktree ID   7           Copy        (only when the session has a worktree_id)
```

### Project settings: worktree list

The ID goes at the end of the meta line, and activating it copies it:

```
  ~/proj/.worktrees/feat-x
  created on main · 2 sessions · #7                     [Remove…]
```

Worktree pickers (for example, in new-session creation) don't show IDs.

## 3. Approval and tool cards for the three tools

Keep the existing card layout. Only the title and summary change, and a body
preview is added. The raw arguments stay available under each client's existing
collapsed disclosure (`action details` on desktop, `action JSON` on Android).

Titles: `MESSAGE SESSION`, `START SESSION`, `READ SESSION`, with the
`mcp__agent_ui__` prefix removed and underscores shown as spaces.

Summaries, where a target is `<name> #<id>` looked up the same way as senders
in section 1:

```
MESSAGE SESSION · → api refactor #42
START SESSION   · "db migration" in ~/proj   (claude-code · worktree #7 · sandboxed)
READ SESSION    · api refactor #42   (after 1830 · limit 200)
```

- `message_session` and `start_session`: the card body shows `message` as
  plain text, styled like the agent-message body in section 1 but without the
  header, above `action details`.
- `start_session`: leave out optional parts that weren't given, except the
  sandbox setting. Show `sandboxed` when `sandbox` is true or missing, and
  `unsandboxed` when it's false. Show `agent` only when it's given.
- `read_session`: show `after` only when it's given. Always show `limit`.
- **Unknown target ID** (only once the session list has loaded): show
  `#42 (unknown session)` in `danger` in place of the name, so the user sees a
  bad ID before approving. Before the list loads, show the bare `#42`.
- Resolved cards (Allowed, Denied, No longer pending) behave the same as other
  approvals.
- A session created by `start_session` shows up in the session list at the next
  normal metadata refresh. No special handling is needed.
