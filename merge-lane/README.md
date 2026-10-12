# merge-lane

One merge lane per repository, shared by every Claude Code session on this
machine. When several sessions work on the same repo, only one of them may
merge at a time. The others wait in a queue. When the merge lands, the lane
frees itself and the next session is woken up to merge.

## What it does

- **Holds the lane.** One session holds the repo's lane. The rest wait in a
  queue: prioritized sessions first, then `--high` requests, then everyone
  else in the order they asked.
- **Gates merges.** It watches Bash commands for `gh pr merge`, merging
  `gh api` calls (`PUT pulls/<n>/merge`, `POST merges`, the GraphQL
  `mergePullRequest` / `enablePullRequestAutoMerge` mutations), and
  `git push` to `main` or `master`. It also watches MCP GitHub merge tools
  (`merge_pull_request`). Such a call goes through only from the session that
  holds the lane. If the lane is free and nobody is waiting ahead, the gate
  takes it and lets the merge run. Otherwise it refuses the merge, adds the
  session to the queue, and tells it where it stands (`you are #2 of 3`).
  Other commands pass untouched, with no process run. Text that only mentions
  a merge (a commit message, a heredoc, a comment) also passes, as do help
  pages (`gh pr merge --help`), dry runs (`git push --dry-run`/`-n`), and
  read-only MCP tools whose names merely contain the words. When the text
  names a repo or directory the gate cannot pin down (`cd "$DIR" &&`,
  `git -C "$DIR"`, `env -C dir`, `-R "$REPO"`), it lets the merge through rather than guess
  a lane, and writes a debug log line with the reason (never the command).
- **Frees itself.** The lane is given back when the engine reports the PR
  merged, or when the holder's 60-second `gh pr view` poll sees it MERGED or
  CLOSED. If the gate took the lane just for one merge and that merge failed,
  it is handed straight back. A holder with no merge attempt for
  `maxHoldMinutes` hands the lane on while others wait.
- **Wakes the next session.** On release it sends the queue head a
  `merge-lane/v1` message. That session's copy of the mod takes the message
  so it never reaches the model, claims the lane, shows a toast, and (with
  auto on) submits one "proceed with the merge" prompt as the mod's own
  message. Every waiting session
  also checks the lane every 30 seconds, so a lost message only delays it.
- **Status line.** `lane: yours (PR #12) · 2 queued`, or
  `lane: queued #2 of 3 behind feature-x (PR #7)`. It is cleared when the
  session is not on the lane.

## Commands

The verbs that change anything run only when the person typed them: the
composer, the Remote Control bridge, or the desktop app (which hosts its
sessions over the SDK, so its origin is `sdk`). From any other origin (a
peer, a plugin, a schedule) they answer "type it yourself". Plain `/lane` works from anywhere. `/lane` runs immediately, even
mid-turn.

| Command | What it does |
|---|---|
| `/lane` | Holder, since when, heartbeat, its PR and CI (`gh pr view --json state,mergeStateStatus,statusCheckRollup`), and the queue with positions |
| `/lane request [pr\|branch] [--high]` | Join the queue. Takes the lane at once if it is free and nobody waits ahead |
| `/lane release` | Give the lane back and wake the next session, or leave the queue |
| `/lane prioritize <id-prefix\|pr>` | Put a queued session first (the latest prioritize goes foremost) |
| `/lane take [--yes]` | Break the current holder and take the lane, after a confirmation dialog. Dismissing the dialog counts as No. The dialog cannot open mid-turn, so take is refused then. `--yes` skips the dialog only when the holder looks stale; a live holder may be mid-merge, so breaking it always needs the dialog |
| `/lane auto on\|off` | Whether this session auto-submits the proceed prompt when the lane comes to it |
| `/lane off` / `/lane on` | Let this session merge without the lane, or gate it again |

## Options (`userConfig`)

| Option | Default | Meaning |
|---|---|---|
| `auto` | `true` | Submit the proceed-with-merge prompt when the lane comes to this session. It is the mod's own message ("The merge-lane plugin sent a message: ..."), never submitted as your words |
| `staleMinutes` | `10` | A holder whose heartbeat is this old may be broken with `/lane take` (the dialog says "looks stale"). The queue head breaks it on its own 5 minutes later, but only if the holder's session is confirmed gone |
| `maxHoldMinutes` | `30` | Hand the lane on after this long with no merge attempt while others wait. `0` turns this off |
| `enforce` | `true` | Off: nothing is refused. The queue and commands still work |
| `allowAutoMerge` | `false` | Allow `gh pr merge --auto`. It is refused by default because auto-merge lands later, without the lane and without re-checking CI against current main |

Options are set in settings under `pluginConfigs` → `merge-lane`, or in the
config menu.

## Hooks

| Hook | Role |
|---|---|
| `session.start` | Registers `/lane`, then looks at the lane once (on a timer) |
| `tool.call` `{ tool: 'Bash' }` | The merge gate. A guard: its `.catch` refuses a merge it could not judge, and passes anything else |
| `tool.call` | The same gate for MCP merge tools |
| `session.receive` | Consumes every `merge-lane/v1` message, valid or not, so none reaches the model. A wake is only a hint: the lane is re-read from disk and taken by `mkdir` |
| `command.run` `{ command: 'lane' }` | `/lane` and its verbs. Answers its own command |
| `session.end` | Gives the lane back and leaves the queue under the *ending* id (also on `/clear`). Resets `/lane off` and `/lane auto` for the next id. Sends no message (no time) |
| `turn.start` / `turn.complete` | Tracks the main loop's running turn for `/lane take` (a subagent's turn does not count). Picks the lane back up after a hot reload |

`claude plugin validate` lists the Bash gate as `gating hook with .catch` and
`/lane` as `answers its own command`.

## How the lane is kept

Everything lives in `~/.claude/merge-lane/<key>/`. The key is the first 16 hex
characters of the SHA-256 of the normalized origin remote, so
`git@github.com:Owner/Repo.git` and `https://github.com/owner/repo` share one
lane. Userinfo (tokens) is stripped before anything is hashed, written or
shown.

- `holder/` is the lock, made with `mkdir`, which only one session can win.
  `holder/holder.json` names the holder; it is written to `tmp/` and renamed
  in, so it is never read half-written. `holder/heartbeat` is touched every
  30 seconds.
- `queue/<sessionId>.json` holds one waiting session. Only that session writes
  it.
- `priority/<sessionId>.json` is `/lane prioritize`'s overlay, so nobody
  rewrites another session's queue file.
- `alive/<sessionId>` is touched every 30 seconds by each session on the lane.

Breaking or releasing a lock renames `holder/` to a `tomb.<uuid>` first. Only
one rename can succeed. The winner keeps the tomb only if it holds the very
lock it judged; otherwise it puts it back. Nothing is ever `rm -rf`'d in
place. A session is pruned from the queue, or its lock auto-broken, only
when its timestamps are old **and** the engine says a ping to it was not
delivered. After a laptop sleep every timestamp is old, but live sessions
still answer, so nothing is wrongly taken.

## How to load

```sh
claude --plugin-dir /path/to/mods/merge-lane
```

Or name the folder in `CLAUDE_CODE_PLUGIN_DIRS` (process environment, or the
`env` block of `~/.claude/settings.json`) for sessions the desktop app
starts. Every session that should take part needs the mod loaded. A session
without it is not gated and does not queue.

Checks:

```sh
claude plugin validate mods/merge-lane
claude plugin test mods/merge-lane
```

## Limits

- **Not a security boundary.** It coordinates sessions that run this mod. It
  reads shell text, so a merge hidden in a script file, another plugin's
  `$.process.run`, a session without the mod, or your own terminal is not
  seen.
- **One machine.** The lane is a folder under `~/.claude`. Sessions on another
  machine are not coordinated.
- **No remote, no lane.** A session outside a git repo with an `origin`
  remote, or with `HOME` unset, is inert: nothing is gated and `/lane` says so.
- **Fails closed on merges only.** If the gate breaks (for example
  `~/.claude` is not writable), merges are refused with a message naming
  `/lane off`. Every other command passes. `enforce: false` turns the gate
  off everywhere.
- **Ambiguous text is allowed, not refused.** A merge whose repo or
  directory the text cannot tell, or a bare `git push` whose current branch
  cannot be read, goes through ungated, with a debug log line naming the
  reason. A wrong refusal costs more than an ungated merge the person can see.
- **Other repos' lanes are not queued.** A merge aimed at another repo
  (`-R owner/other`, `cd ../other &&`) is gated against that repo's lane, but
  this session does not join that queue. Retry once it frees.
- **Cleanup is best effort.** `session.end` shares a 1.5-second budget and
  never runs after a crash. Liveness pings and the queue head's checks make
  up for it.
- **gh is needed** for CI status in `/lane`, branch-name requests, and the PR
  poll. Without it the lane still works and frees on the engine's own merge
  report or `/lane release`.
- **Auto-proceed is an autonomy step.** With `auto` on, the woken session gets
  one prompt per wake. It is submitted as the mod's own message, so the model
  reads it under the plugin's name and never as your instruction; an earlier
  "don't merge yet" from you still stands. It only happens to sessions that
  queued through `/lane request` (you typed it) or through a refused merge
  (the session was already merging). Turn it off with `auto: false` or
  `/lane auto off`.

## Known limits

Found in review and left open on purpose, each because the fix is larger
than the risk or cannot be verified without a live engine.

- **A narrow lock race remains (rare timing only).** `holder.json` is moved
  into whichever `holder/` exists at that moment; the move cannot check that
  the lock is still the writer's own. Two cases can leave two sessions both
  believing they hold the lane: (a) two sessions break the same orphaned lock
  that has no `holder.json` (a session that crashed between `mkdir` and its
  record) while a third is mid-claim, and (b) `/lane take` lands inside the
  tens-of-milliseconds window of the holder's own record rewrite. Plain
  concurrent claims and breaks of a recorded lock never produce two winners
  (stress-tested). The full fix is a claim token inside the lock, re-checked
  after every record move, plus an mtime check before breaking a record-less
  lock; it is a protocol change, so it is deferred. `--yes` no longer breaks
  a live holder without the dialog, which narrows case (b).
- **An undelivered ping counts as a dead session.** Liveness reads
  `isDelivered: false` from `$.session.send` as "gone". The engine also
  answers false when another plugin's `session.send` guard refuses the
  message, and its `reason` is free text with no stable values to tell the
  two apart. With such a plugin installed, after a sleep a live holder past
  `staleMinutes` + 5 could be auto-broken and live queue entries pruned. A
  session that holds the lane but has unloaded this mod also receives the
  ping as a peer message on each tick. The fix (a recorded pid checked with
  `kill -0`) needs the Claude process id, which the hooks do not expose.
