# Agent UI — Desktop

A desktop client for controlling coding-agent sessions — Claude Code, OpenCode,
pi, or whatever else the server registers — talking to the
[agent-ui-server](https://github.com/rauaap/agent-ui-server) backend over REST
and a WebSocket per session.

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
  two are independent.
- **Project settings** — the ⚙ on a project row opens what the server knows
  about it: directory, session count (and how many run in a worktree), last
  activity, whether it is a git repo, and its worktrees. Every whole-project
  action lives there — new session, new worktree, removing a worktree, and
  forgetting the project, which removes it, its sessions and its worktrees but
  **never touches the project's own directory**.
- **Agent picker** — the new-session dialog offers the agents `GET /agents`
  says this server can run, labelled and preselected as the server asks. Nothing
  is listed here, so an agent added on the server shows up on the next refresh.
- **Worktrees** — a worktree is its own thing, not something a session owns: it
  is created on its own, several sessions can share one, and it outlives the
  sessions that used it. The new-session dialog picks one — "project directory"
  by default, any existing worktree, or "New worktree…" — and sessions running
  in one are tagged in the tree with their directory spelled out in the pane
  header. Removing a worktree is never forced; git counts untracked files as
  dirty, so one an agent did real work in is left in place and said so.
- **Worktree path template** — the ⚙ in the sidebar header holds the template
  new worktree paths are seeded from: `%P` the project's parent directory, `%N`
  the project directory's name, `%B` the branch with slashes turned to dashes,
  `%b` the branch verbatim. The default `%P/%N-%B` puts `/projects/app` on
  branch `fix-login` at `/projects/app-fix-login`. The seeded path follows the
  branch field until you edit it, and a Reset button leashes it again.
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
- **Bash mode** — a message starting with `!` runs as a shell command in the
  session's working directory instead of going to the agent. `\!` sends a prompt
  that really does start with an exclamation mark.
- **Archive** — file a session you are done with under **Archived** in the
  sidebar, from its settings; a project's settings archive the project and every
  session in it in one call. The archive has the same project → session shape as
  the tree above it, ordered by when things were filed. Archived sessions stay
  open-able and readable — only new prompts and commands are refused — and
  nothing is deleted. The state is the server's, so it is the same on every
  device and arrives live over the WebSocket.
- **Search and export** — filter and highlight within a transcript, or export
  the whole session as markdown.

## Layout

```
index.html            the only page — no client-side router
css/theme.css         palette, ported from the Android client's Theme.java
css/app.css           layout and component styles
js/
  api.js              REST over fetch(), same-origin
  ids.js              ids: numbers on the wire, strings everywhere above api.js
  agents.js           the server's agent list, normalized — nothing hardcoded
  socket.js           one WebSocket per open session: backoff + buffered replay
  store.js            per-session state and the transcript reducer — no DOM
  tools.js            pure helpers over tool_use payloads
  sidebar.js          the project/session tree, and the archive below it
  archive.js          reading `archived_at`: split, order, label — no DOM
  tabs.js             tab strip and pane lifecycle
  pane.js             one session: header, transcript, composer
  dialogs.js          native <dialog> forms for CRUD and settings
  notify.js           Notification API + "don't shout about what's on screen"
  names.js            adjective-noun session-name suggestions
  worktree.js         the path template, and the path arithmetic it needs
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

### The window is the only fixed dimension

Browser zoom is not a scale factor the page can see — it resizes the CSS pixel,
so all the layout is told is that the viewport got smaller. 140% zoom on a
1366×768 screen lays out in 976×549. So nothing is sized to a constant that a
smaller window has to honour: the sidebar is `clamp(180px, 26vw, 260px)`, the
composer's growth cap and the bash output's height are capped against `vh` as
well as a pixel value, and the pane header wraps rather than pushing its buttons
past the right edge. The pane is positioned against its container rather than
sized at `height: 100%`, which is what keeps the composer pinned to the bottom of
the window instead of being pushed off it by a long transcript.

The two breakpoints that remain are `@container` queries on the pane, not media
queries on the window — what the header has to fit into is the pane's width, and
that changes when the sidebar is collapsed without the window moving at all.
Nothing rescales type: zoom is the user asking for bigger text, and undoing it
would be rude.

### Reconnects never blank the transcript

The server replays the last 200 scrollback rows on connect, then sends the
current status — that trailing status is the end-of-replay marker. The first
connection renders its replay progressively, but a *reconnect* assembles it into
a detached buffer and swaps it in only once complete, so a slow reconnect leaves
the scrollback you were reading on screen. Ported from `SessionActivity`'s
buffered replay.

The live transcript is capped at 400 rows, dropped from the top, so a very long
session cannot grow the DOM without bound.

### Bash mode runs beside the agent, not through it

The `!` split is the client's, not the server's: the backend never inspects
prompt text, it only honours a `bash` message, which is what keeps a prompt that
legitimately starts with `!` sendable (as `\!`). The composer's border turns red
while a `!` line is being typed, so what Send is about to do is visible before it
happens.

Server-side a command **never takes the turn lock** — it runs while the agent is
working and neither side notices — so the composer is deliberately not gated on
session status. The consequence is that a normal prompt sent mid-turn has to be
turned away by the client instead: it raises a toast and keeps your text, rather
than disabling the box. (Queuing it is the eventual answer; rejecting it is the
current one.)

The command's echo and its output are one card, filled in when the result
arrives rather than appended, so a command that finishes mid-stream does not
split the agent message below it. The card is bordered red and its output sits
in a plain code block: the agent never saw any of this, and the block is there to
be copied into a prompt if you decide it should.

### Project settings report; they do not edit

The session gear saves — rename and the two auto-approve toggles are a `PATCH
/sessions/{id}`. The project gear cannot, and that is the API's shape rather
than an unfinished dialog: `/projects` is `GET`, `POST` and `DELETE` only, there
is no `PATCH`, and `POST` inserts with `OR IGNORE` — so re-posting an existing
path under a new name returns the project **unchanged** instead of renaming it.
Moving a project's path is on the server's roadmap, and `projects.id` exists
precisely so sessions survive it, but there is no endpoint yet.

So name and directory are shown, not offered. A Name field would be a box that
silently discards what you type, which is worse than no box at all; the note in
the dialog says why instead. If the server grows the route, the field goes here
and nothing else has to move.

Forgetting a project moved *into* this dialog from a bare `×` on the tree row.
It takes every session in the project and their transcripts with it, which is
more than belongs on one click on a row you were probably only trying to expand
— and deleting a *session* was never a one-click affordance in the tree either.
It still asks a second time, and still reports any worktree git declined to
remove. It is also where worktrees are managed, because a worktree belongs to a
project and to nothing smaller.

### A worktree session belongs to its project, not to its directory

The tree used to group sessions by string-matching `working_dir` against the
project path. A worktree session's `working_dir` is somewhere else entirely, so
that rule would drop it out of the very project it was created in. Grouping is
`project_id` now, with path equality kept only as the fallback for a server old
enough not to send an id — which is also a server old enough to have no
worktrees.

### A worktree is a resource, not a session's property

It used to be created inside `POST /sessions` and destroyed with the session
that made it. It is now `POST /worktrees`, `GET /worktrees`,
`DELETE /worktrees/{id}`, and a `worktree_id` on the session. A null id normally
means the project directory; an explicitly detached session is the exception,
keeping its former worktree path as its effective `working_dir`.

That turns three UI decisions:

- The new-session dialog offers a **picker**, not a toggle and two text fields.
  The question is no longer "should this session get a worktree" but "which of
  the project's checkouts does it run in", with `session_count` shown flatly
  because sharing one is a supported arrangement rather than a warning.
- Deleting a session touches nothing on disk. Where the old flow reported what
  it did to the worktree, the new one says the worktree is still there when the
  last session on it goes — a note, not a nudge, because finishing a session
  does not mean finishing with the branch.
- Removing a worktree is its own action, in project settings. Attached sessions
  block it; the refusal names them and explains that archived sessions can be
  detached later from Session settings, without turning the error into a guided
  cleanup flow. A live detached session also blocks removal while its preserved
  cwd is active. Removal is never forced and **git counts untracked files as
  dirty**, so one an agent did real work in refuses: the *common* path, phrased
  as information. git's own suggestion to `--force` it is not passed on,
  because the server takes no force flag and the fix is in the worktree.

### The path is the client's problem

The server takes an absolute path and normalises it lexically. It has no notion
of a path relative to a project and no template syntax, so `worktree.js` owns
all of it: the token expansion, and enough path arithmetic — `normalize`,
`parentOf`, `baseOf`, `joinPath` — to get the same spelling the server stores.

That last part is what the arithmetic is *for*. A path built by concatenation
gives `//app-fix` for a project directly under the root, and the server tidies
that away; our own later comparison against `GET /worktrees` does not. Since the
whole collision story — "you already have a worktree here, use that one" — runs
on matching paths, a comparison that misses is a `409` the user has to read
their way out of instead.

Two things the client deliberately does not decide. **The project's current
HEAD**: worktrees are always cut from it, but nothing exposes what it is, so the
copy says "the project's current HEAD" and not "`main`". **Whether a branch name
is legal**: that is `git check-ref-format`, run server-side. The create form
sends while it is still open so git's answer lands under the branch field — a
regex here would only approximate git's rules, and reject names git accepts.

### The agent list is the server's

Which agents exist is not something a client can know. This one used to keep its
own list of two, and was wrong about it: the server had grown a third (`pi`)
that the picker never offered, and there was nothing to notice — a stale list
does not fail, it just quietly withholds an option.

`GET /agents` ends that. Each row is `{id, name, default}`, derived server-side
from the same models that validate `POST /sessions`, so the picker cannot offer
an agent the server would reject or miss one it would accept, and it opens on
the default the server would have applied anyway. `agents.js` normalizes the
rows — dropping any that name no agent, falling back to the id for a missing
label — and everything above it reads that list: the picker's options, its
preselection, and the agent named in a session's tooltip.

The list comes along with the ordinary refresh, since it changes only when the
server does, and it is fetched with its own `catch`: a picker is not worth
failing the tree over. A refresh that cannot get one keeps the last list it had.
With no list at all — an unreachable server, or one too old for the endpoint —
the field disappears and the create request omits `agent`, which leaves the
choice exactly where it was: with the server's default. That is deliberately not
a hardcoded fallback list, because a hardcoded list is the thing this replaced.

### An id is a number on the wire and a string here

`projects.id`, `sessions.id` and `worktrees.id` are JSON numbers; they were uuid
strings until the server renumbered its rows. Above `api.js` they are strings,
because that is what `dataset`, `localStorage`, a `<select>`'s value and a URL
turn them into regardless — so the conversion happens once, in `ids.js`, at the
door they come in through rather than at each of the dozen places they are
compared.

That is worth a section because the alternative fails *quietly*. `1 === "1"` is
`false` and `new Set([1]).has("1")` is `false`, so an id that keeps its wire type
does not throw or log — the active-session highlight simply stops applying, the
status dots stop updating, and restored tabs silently never open. Nothing about
`String(s.id)` is defensive noise; it is the only thing standing between those
features and a no-op.

There is one door back out. `worktree_id` on `POST /sessions` is the only id
this client sends in a request *body* rather than in a URL, and the server types
it `int`, so `ids.js` converts it there too rather than leaving the framework to
guess about `"1"`. Everything else stays a string, because a number stringifies
predictably into a path and `` `/sessions/${id}` `` needs no help.

Otherwise an id is identity, never arithmetic: nothing here parses one to order
two, or slices one — that last was a uuid-era habit and would now throw on a
number. `request_id` and an approval option's `id` are minted by the agent
or the approval protocol, are strings already, and are left alone. Ids saved
before the renumbering need no migration: the restore path checks each against
the current session list and drops what it does not find, so a stale list
corrects itself after one run.

### The archive is server state the client only sorts

`archived_at` is a nullable timestamp on both a project row and a session row:
null is live, an ISO 8601 UTC string is when it was filed. Neither list endpoint
filters — `GET /projects` and `GET /sessions` return everything with the field
attached — so splitting the tree from the archive is entirely this client's job,
and `archive.js` is that job with no DOM and no state of its own.

Two rules fall out of the server's shape and are easy to get wrong:

- **Do not reuse the server's order for the archive.** `GET /projects` sorts by
  `last_active_at` descending, and an archived project's `last_active_at` is
  always null, so the whole archive arrives heaped at the end in no useful
  sequence. The archive sorts itself by `archived_at` descending instead — for a
  live project holding archived sessions, by the newest of those sessions, since
  that is when it acquired a row down there at all.
- **Archived and live session counts stay apart.** A live project's count is its
  live sessions; anything filed away sits beside it as a separate `3 archived`
  badge that opens the archive at that project. Folding them together would
  overstate what is actually running.

Archiving a project is one `PATCH /projects` that cascades server-side, so the
confirmation names the number of sessions going with it. Unarchiving restores
only what that cascade took — a session filed by hand beforehand stays filed —
which is why the toast reports the server's `sessions_affected` rather than a
count guessed here. Unarchiving a *session* silently unarchives its project too
(a live session under an archived project would have nowhere to show), so it
refetches both lists rather than patching one row. No session is brought back
unless its effective working directory still exists as a directory: that is a
harness requirement whether the path is its project, a current worktree, or a
former one.

Detaching is deliberately separate from archiving. An archived session that is
still attached gets **Detach from worktree** in Session settings; the call clears
its worktree association but preserves the absolute cwd and touches nothing on
disk. The session is then labelled **Former worktree**, not mistaken for a
project-directory session. Removing that worktree later may remove the cwd and
prevent future unarchive until the same absolute directory is recreated.

A busy session cannot be archived. The archive controls are disabled when one is
running and the project dialog names the offenders, but that guard is not
sufficient and the `409` path is not optional: a shell command leaves a session
`idle` while still counting as busy server-side, so a session can look archivable
here and be refused. A refused project archive writes nothing at all, so there is
no partial state to unpick.

An archived session still opens, still connects, still replays its scrollback —
keeping old work readable is the point. What closes is the composer, with the
reason and an Unarchive button in place of it, because the server refuses both
prompts and `!` commands with `409 Session is archived`. For the same reason an
archived project's settings drop **New session** and **New worktree** rather
than offering a `409`, and the tree stops offering them too.

Two things archiving deliberately does *not* do, both stated in the dialogs
rather than left to be found out. It does not protect anything from deletion:
forgetting a project still takes its archived sessions with it. And it does not
sweep up worktrees — they carry no archive flag, they hold real uncommitted
work, and the only thing that removes one is the worktree list in project
settings.

## Tests

The pure modules — the diff, the markdown parser, the reducer, the worktree path
template, session location and detachment, the id coercion, the agent list, and
the archive's split and ordering — have unit tests, most ported from the Android
client's `LineDiffTest`, `MarkdownTest` and `WorktreeTest`:

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
- **Bash mode** is here only, for now.

## Notes

- Search matches against the store's row model, so it finds rows the 400-row cap
  has evicted from the page — but only within what the client has received,
  which after a reconnect is the last 200 scrollback rows.
- Copying falls back to a hidden textarea when the Clipboard API is unavailable,
  which it is over plain `http://` — the normal case on a WireGuard LAN.
- Agent output is escaped on the way into the DOM, and link hrefs are restricted
  to `http`, `https`, `mailto` and relative URLs.
