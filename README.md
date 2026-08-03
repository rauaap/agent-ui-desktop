# Agent UI — Desktop

A desktop client for controlling Claude Code and OpenCode agent sessions,
talking to the [agent-ui-server](https://github.com/rauaap/agent-ui-server)
backend over REST and a WebSocket per session.

It is the big-screen counterpart to
[agent-ui-android](https://github.com/rauaap/agent-ui-android): a sidebar tree
of projects and sessions plus **tabbed transcripts**, so you can watch one agent
work while prompting another.

**There is no build step.** No bundler, no npm, no toolchain, no runtime
dependencies — plain ES modules the browser loads directly. `git clone` is the
install.

## Running

The backend serves the client from its own origin, so the page infers the API
from its own URL and there is no host/port/TLS to configure:

```sh
cd ../agent-ui-server
WEB_ROOT=../agent-ui-desktop uv run main.py
```

Then open the server's address (e.g. `http://10.0.0.1:8000`). Under Compose the
bind mount and `WEB_ROOT` are already wired in `compose.yaml`.

Install it as a PWA (Chrome: ⋮ → Cast, save and share → Install page as app) and
it gets its own window, icon, and working notifications — closer to an app than
a tab, without shipping a browser.

<details>
<summary>Opening it without the backend serving it</summary>

Pass `?api=` to point at a backend on another origin, e.g.
`http://localhost:8080/?api=http://10.0.0.1:8000`. The server sends no CORS
headers, so this only works if you add them — the supported path is `WEB_ROOT`.
</details>

## Features

- **Sidebar tree** — projects with their sessions nested underneath. Session
  count, last-activity ordering, and a `MISSING` flag when a project's directory
  has been removed on the server. Creating a project takes a name and a
  directory; the directory tracks the name until you edit it, after which the
  two are independent. Forgetting a project removes it and its sessions but
  **never touches the disk**.
- **Session tabs** — several sessions open at once, each with its own live
  WebSocket. The tab's status dot shows idle / running / needs-you at a glance.
  Open tabs are restored on reload.
- **Live transcript** — streamed agent output rendered as markdown, collapsible
  tool cards with git-style diffs and terminal-style command blocks, inline
  approval prompts (including the agent's own multiple-choice options and a
  free-form denial reason), and AskUserQuestion cards.
- **Auto-approve** — per-session toggles for writes and shell commands.
  Auto-approved tools still appear in the transcript, marked as such.
- **Desktop notifications** — one switch in the sidebar covers every open
  session. Fires when a turn completes or an approval blocks, and stays quiet
  for the session you are currently looking at.
- **Search and export** — filter and highlight within a transcript, or export
  the whole session as markdown.

## Layout

```
index.html            the only page — no client-side router
css/theme.css         palette, ported from the Android client's Theme.java
css/app.css           layout and component styles
js/
  api.js              REST over fetch(), same-origin
  socket.js           one WebSocket per open session: backoff + buffered replay
  store.js            per-session state and the transcript reducer — no DOM
  tools.js            pure helpers over tool_use payloads
  sidebar.js          the project/session tree
  tabs.js             tab strip and pane lifecycle
  pane.js             one session: header, transcript, composer
  dialogs.js          native <dialog> forms for CRUD and settings
  notify.js           Notification API + "don't shout about what's on screen"
  names.js            adjective-noun session-name suggestions
  app.js              bootstrap and wiring
  render/
    markdown.js       markdown subset -> HTML (port of Markdown.java)
    diff.js           LCS line diff (port of LineDiff.java)
    toolformat.js     tool_use -> diffs and command blocks (ToolFormat.java)
    transcript.js     store rows -> DOM, append-only
test/                 unit tests: open test/index.html, or `node test/run.js`
```

Three rules carry the design:

**The store is DOM-free.** `store.js` owns the logic the Android client tangles
into its view code — coalescing consecutive `output` chunks into one message,
letting an `approval_request` swallow the `tool_use` card it duplicates,
resolving approvals and questions in place. It is the part worth testing, and it
is testable without a browser.

**Rendering is incremental, never a re-render.** The store emits a list of
changes, not a new state, so a streaming turn touches exactly one node — the
trailing agent message. No virtual DOM, and a long transcript stays smooth.

**One socket per open tab.** Opening a tab is what starts watching a session;
closing it stops. That replaces the Android client's per-session bell opt-in
with something visible in the UI by construction.

### Reconnects never blank the transcript

The server replays the last 200 scrollback rows on connect, then sends the
current status — that trailing status is the end-of-replay marker. The first
connection renders its replay progressively, but a *reconnect* assembles it into
a detached buffer and swaps it in only once complete, so a slow reconnect leaves
the scrollback you were reading on screen. Ported from `SessionActivity`'s
buffered replay.

The live transcript is capped at 400 rows, dropped from the top, so a very long
session cannot grow the DOM without bound.

## Tests

The pure modules — the diff, the markdown parser, the reducer — have unit tests
ported from the Android client's `LineDiffTest` and `MarkdownTest`:

```sh
node test/run.js          # any JS runtime
```

or open `test/index.html` in a browser, which needs nothing installed at all.

## Differences from the Android client

- **No server address setting.** Same-origin serving makes it unnecessary.
- **No per-session notification opt-in.** Every open tab is watched; one switch
  turns notifications on or off globally.
- **No fallback for pre-`/projects` servers.** The Android client degrades to an
  unscoped session list on a 404; this one requires a current server.
- **Search and export** are new here.
- **No keyboard shortcut layer.** The composer sends on Enter (Shift+Enter for a
  newline) because a text input needs a submit gesture; nothing else is bound.

## Notes

- Search matches against the store's row model, so it finds rows the 400-row cap
  has evicted from the page — but only within what the client has received,
  which after a reconnect is the last 200 scrollback rows.
- Copying falls back to a hidden textarea when the Clipboard API is unavailable,
  which it is over plain `http://` — the normal case on a WireGuard LAN.
- Agent output is escaped on the way into the DOM, and link hrefs are restricted
  to `http`, `https`, `mailto` and relative URLs.
