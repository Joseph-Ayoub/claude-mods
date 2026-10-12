# wrap

`/wrap` is a close-out command for Claude Code. It runs your end-of-session checklist deterministically and prints one table row per check, each `pass`, `fail` or `unknown` with the reason, then a final line `Ready to archive: yes|no`.

The one rule: anything that could not be established (non-zero exit, missing `git` or `gh`, timeout, output it cannot parse) is `unknown`, and `unknown` is never a pass. Raw command output is never copied into the table, because git and gh can echo remote URLs with embedded credentials. Reasons use only parsed facts (counts, short SHAs, PR numbers, branch names).

## The checks

| Row | Passes when |
| --- | --- |
| Working tree clean | `git status --porcelain` is empty |
| Fetched origin/<default> | one `git fetch origin <default>` succeeded (`unknown (no origin)` without an origin remote) |
| Commits pushed | the PR head equals local HEAD; with no PR, in sync with upstream (or nothing beyond origin/<default>) |
| PR | an open or merged PR exists for the branch without merge conflicts (or there is nothing to raise) |
| CI green on current head | the PR's `headRefOid` equals local HEAD and every check rollup entry is `SUCCESS`; an empty rollup is pending |
| Base fresh vs origin/<default> | `origin/<default>` is an ancestor of HEAD after the fresh fetch (n/a once merged) |
| Merged into origin/<default> | HEAD is contained in `origin/<default>`, or the PR is `MERGED` at this exact head |
| No stale worktrees | no other worktree is stale. A worktree counts as stale only when a merged PR (`gh pr list --state merged --head <branch>`, asked per sibling branch) has the worktree's branch as its head branch AND the worktree's HEAD as its head SHA, and `git -C <path> status --porcelain` shows its tree clean. `git branch --merged` is not used, because it also lists a live session's new branch sitting at the base tip. A worktree with uncommitted work is never stale. The main checkout and the session's own worktree are never counted. A detached sibling (no branch, so no PR to match) is never flagged; the row names how many it skipped. A sibling git marks `prunable` (its folder is gone) is never read and reads `unknown`, with `git worktree prune` named as the fix |
| No background tasks or wakeups | the last `Stop` event this session listed no background tasks AND no session crons (CronCreate, ScheduleWakeup, `/loop`: work that would wake this session later, which an archive would drop); `unknown` if no Stop has fired, or the last one carried no task list or no cron list | On a host that raises no `Stop` to mods (the desktop app, verified 2026-10-12), the main-loop turn end reads the running subagents instead: the row passes when none is running, with a note that shell tasks and wakeups are not listed there and the app refuses to archive live work.

The default branch comes from `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `main`. All commands run argv-only (no shell) in `$.session.cwd()` with explicit timeouts: 60 s for network calls (`git fetch`, `gh`), 15 s for local git.

## Arguments

- `/wrap` runs the checklist. When a model-only step is open (raise the PR, push, fix CI, merge on green, rebase) it queues the canonical close-out prompt, once per head SHA.
- `/wrap --dry` never queues the prompt and never requests an archive.
- `/wrap --resend` queues the close-out prompt again for a head it was already sent for, when it never arrived (see Known limits). Only your own `/wrap` can resend, never with `--dry`, and two quick resends still send once.
- `/wrap --archive` additionally offers to archive, only if you issued the command yourself, the session draws on the desktop app, the app's archive tool is listed, AND every check passed (see Known limits).
- Unknown arguments are ignored and named in the output.

The close-out prompt restates the rules the mod cannot enforce itself: ship only if the brief authorized it, read CI for the PR's current head, merge only on green re-verified against current `<default>` right before the merge, never rely on auto-merge, delete this session's merged remote branch and prune, never remove another worktree or branch (one may be a live session's) but name flagged ones in the report, and report to the lead with the PR link. It is sent with `asUser: true`, tracked in `$.state` (`wrap.submittedFor`) by head SHA, and never re-triggered from `turn.complete` (there is no such hook), so `/wrap` cannot loop.

**Only your own /wrap can send it.** Other plugins (`$.command.run`), scheduled tasks, peer sessions and task notifications can run `/wrap` too. The prompt is sent, and the archive offered, only when the command's `e.origin.kind` is `composer` (you pressed Enter), `bridge` (Remote Control) or `sdk` (the desktop app hosts sessions over the SDK, so what you type there arrives as `sdk`; it is also the one surface the archive exists for). Any other origin (`plugin`, `peer`, `task-notification`, `scheduled-trigger`, `channel`, `coordinator`, `observer`, `auto-continuation`, `unclassified` and the rest), or no origin at all, gets the table plus a note saying the prompt was not sent. The prompt speaks as you, so it must never be set off by something that is not you. Note that `sdk` also covers a script driving Claude Code through the SDK (`claude -p`, an automated workflow): those runs are treated as yours.

## Hooks registered

| Hook | Why |
| --- | --- |
| `session.start` | registers the `/wrap` command (not `immediate`, so it runs between turns) |
| `command.run` `{ command: 'wrap' }` | answers its own command and never calls `next`; returns `{ text }` only (the row is already what the model reads, so the table is not repeated as `context`); reads `e.origin` to gate the prompt and archive; the whole handler is in try/catch and a failure prints only the error kind |
| `classic.Stop` (with a fail-open `.catch`) | observes `background_tasks` and `session_crons` into `$.state` (`wrap.backgroundTasks`; task id, type and status, cron id and recurring flag only, never commands, descriptions, cron schedules or cron prompts) because no `$` call lists either. A Stop without `background_tasks` writes `null`, and one without `session_crons` leaves crons out, so the row reads `unknown` |

State contract (`types/index.d.ts`): `PluginState['wrap'] = { submittedFor: string | null; backgroundTasks: unknown | null }`.

## Options

- `acceptSkippedChecks` (boolean, default false): count `SKIPPED` and `NEUTRAL` check conclusions as green. Off, only `SUCCESS` counts.

## Load it

```
claude --plugin-dir /absolute/path/to/mods/wrap
```

or set `CLAUDE_CODE_PLUGIN_DIRS=/absolute/path/to/mods/wrap`. Check it with `claude plugin validate mods/wrap` and `claude plugin test mods/wrap`.

## Known limits

- **Prompt submit is deferred by one timer tick.** The engine refuses `$.prompt.submit` from inside a `command.run` hook (it would wait on the turn the hook is holding), so the close-out prompt is sent from a single `$.clock.after(0)` callback right after the table is returned. The SHA is claimed inside that callback (compare-and-set against the version `/wrap` read), so a timer lost to a hot reload claims nothing and the next `/wrap` retries, and two quick `/wrap`s send once. A submit that rejects, or resolves as `{ drop }` (a hook's refusal or a settings `UserPromptSubmit` block), releases the SHA so the next `/wrap` can retry; the release is a compare-and-set on the version the claim itself returned, not a fresh `get` (every `get` in one dispatch reads one moment, so a `get` after the claim in the same timer could miss it). A reload or lost hooks worker in the instant between the claim and the submit could still leave the SHA claimed with nothing sent: the engine has no primitive that makes the claim and the submit one step, and a timer's calls are not replayed after the hook that set it returned. Then `/wrap` says "already sent" for that head; a new commit clears it, and `/wrap --resend` sends it again at once. `--resend` while an earlier prompt is still waiting for the session to go idle queues a second copy.
- **Archive arguments are fixed.** The app's tool takes `{ session_id: 'self', reason }` (the literal `self` names this session; the reason shows in the app's approval prompt), so that is what `/wrap` sends; `$.tool.list()` carries no input schema to read them from. The archive is offered only when `$.session.surfaces()` includes `desktop` AND the tool is listed. The probe for `mcp__ccd_session_mgmt__archive_session` runs when `--archive` is passed, not once at `session.start` (a start-time probe would miss servers that connect later, and the state contract has no key to hold it). If the tool needs arguments, the call comes back as a tool error and `/wrap` shows a toast; use the app's own archive or its "Auto-archive on PR close" preference. The archive runs after the table row is drawn, behind `$.ui.ask('Archive this session?', ['Archive', 'Not yet'])`. Whether `$.mcp.call` can reach the desktop host's `ccd_*` tools is undocumented.
- **Background tasks are as of the last turn end.** A task that finished after the last `Stop` still reads as running until the next turn ends; a task started after it is invisible.
- **Another session's stale worktree blocks this session's readiness.** The row is part of `Ready to archive`, as the spec has every check gate it, and no close-out step removes another session's worktree. Two sessions that finish together each flag the other until one is archived or its worktree removed outside the mod; this errs toward withholding the archive.
- **Stale worktrees need a merged PR.** A branch merged locally with no PR is never flagged (a miss, not a false alarm: ancestry alone cannot tell it from a live session's fresh branch). If `gh` cannot answer while other worktrees exist, the row reads `unknown`, not pass. Merged PRs are asked per sibling branch (`--head <branch>`, 30 per branch), for at most 20 siblings; a sibling past that cap, one whose query failed, one whose branch name is not allow-listed for argv, or one whose answer filled the page without a match reads `unknown`, never pass. At most 20 merged worktrees' trees are read (the rest read `unknown`). Each `/wrap` with siblings makes one `gh` call per sibling (up to 20, in parallel).
- `$.process.run` is documented as CLI only and inherits the Claude process environment, not your login PATH: if `git` or `gh` are not on that PATH every row reads `unknown`.
- Output stops at what the checklist can see: it does not verify that a merge was authorized, and the model-side steps depend on the canonical prompt being followed.
