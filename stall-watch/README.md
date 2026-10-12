# stall-watch

A Claude Code mod (function-hooks plugin) that keeps a session from stalling:

1. **Auto-retry.** When the main conversation's turn dies on a transient API
   error (`rate_limit`, `overloaded`, `server_error`, `unknown`), it waits 30 s,
   then 2 min, then 8 min and sends a short continuation:
   *"The previous turn ended on a transient API error; continue from where you
   left off without restarting the work."* It is framed as the plugin's message
   (not as your words), so the model knows where it came from. A toast says
   `stall-watch: auto-retry N/3 in Xs`.
2. **Task-notification hint.** After a turn started by a background task's
   notification ends normally, it puts `resume` in the prompt box as a dim
   Tab-to-accept suggestion. It never sends it for you.
3. **Usage-limit countdown.** When a rate-limit window reaches 85 %, the status
   line under the prompt shows e.g. `weekly 92% · resets 11:00pm (in 2h 13m)`,
   refreshed every minute while shown and cleared when usage drops.
4. **Resume after reset (opt-in, off by default).** `/stall-watch on` makes the
   session continue by itself 30 s after a usage limit resets, if the last turn
   failed on `rate_limit` against a window at 95 % or more and nothing has run
   since (no prompt of yours, no other turn). Only you can turn it on: at the
   terminal, over Remote Control, or in the desktop app (which hosts sessions
   over the SDK). A `/stall-watch on` from another plugin, a peer session, a
   task or a schedule is refused; `off` and `status` answer anyone.
5. **Resume note.** At 90 % it writes a short note (branch, working directory,
   the first 80 characters of your last prompt with credentials redacted, time,
   the limit) to `~/.claude/stall-watch/<sessionId>.md`, once per window. Notes older than
   7 days are deleted at the next session start.

## Hooks it registers

| Event | What it does | On failure |
| --- | --- | --- |
| `session.start` | registers `/stall-watch`, reads the local UTC offset (`date +%z`), restores this session's resume switch and arm from the store (and refreshes its age), re-arms a pending retry, an armed resume and the countdown ticker from `$.state` (it fires again on a hot reload or worker respawn), prunes store records older than 14 days and resume notes older than 7 days | replays `next(e)` |
| `session.end` | on a switch to another conversation (`clear`, `resume`, `logout`, or any reason other than the process exiting): cancels anything armed, resets the cap, turns resume off; `/clear` also forgets the old session's stored switch, the others keep it but drop its arm; `/stall-watch` is registered again at the next hook | replays `next(e)` |
| `prompt.submit` (gating site, observer) | notes which origin started the turn; on your own prompt (composer, bridge or sdk) cancels pending retries and resumes, resets the caps, notes the running turn it was typed over, keeps a redacted 80-character excerpt for the note, and keeps an enabled switch fresh in the store; another origin's prompt re-arms nothing (its own `turn.start` comes next) | `.catch` replays `next(e)`: never blocks a prompt |
| `classic.StopFailure` (gating site, observer) | records the error kind of a main-loop failure and pairs it with the error turn | `.catch` replays `next(e)`: never blocks |
| `turn.start` (main loop only) | any turn starting means the session moved past the failure: drops a pending retry, an armed resume, and a failure kind or error turn still waiting for its other half, before re-arming anything | replays `next(e)` |
| `turn.complete` (main loop only) | on `error`, pairs with the recorded kind and decides; on any other ending, drops a pending retry and an armed resume (should `turn.start` have missed); on `answer` after a task notification, offers the `resume` hint | replays `next(e)`; the answer is never changed |
| `session.measure` | updates the countdown and writes the resume note | replays `next(e)` |
| `command.run` `{ command: 'stall-watch' }` | answers `/stall-watch on \| off \| status` | answers a fixed error line |

`claude plugin validate` reports `prompt.submit` and `classic.StopFailure` as
"gating hook with .catch"; both are observers that fail open.

## Never retried

`billing_error`, `authentication_failed`, `invalid_request`,
`max_output_tokens`, `model_not_found` (and every other non-transient kind), a
context overflow (detected from the API's own wording in `error_details`),
a subagent's failure, an interrupted turn, and an empty answer (a thinking-only
turn is not a failure).

## Runaway guards

- At most 3 automated turns (auto-retries and resumes together) per prompt of
  yours; the counter resets only on a `composer`, `bridge` or `sdk` prompt (the
  desktop app hosts its sessions over the SDK), never on the plugin's own, a
  peer's, a task's, a schedule's or an unclassified one. Each timer checks the
  cap again when it fires.
- Each submit is counted where it is made (the plugin's own `prompt.submit`
  hook never sees it). A submit another hook drops is not counted and not
  re-armed, so a refusing guard cannot become a loop.
- Typing anything cancels a pending retry and an armed resume.
- Any other main-loop turn (a background task's notification, a peer's
  prompt, a scheduled one) cancels them too, as soon as it starts: a
  continuation waits on the failed turn, never on a session that has moved on.
  A failure kind left unpaired by a turn that ended without an error goes with
  it, so it can never decide the next turn (a `billing_error` is never retried
  under an earlier turn's `overloaded`).
- A failed turn you typed over is not retried: your queued prompt runs next.
- A `rate_limit` while a window is at 95 % or more with its reset still ahead is not
  retried on the 30 s / 2 min / 8 min schedule (it cannot clear before the
  reset); it waits for that reset if resume is on, and otherwise says so in a
  toast; no retry attempt is spent on it. A window at 100 % is waited on
  before a nearly-full one (so a 96 % weekly window days from its reset never
  outranks the full 5-hour one). Any other `rate_limit` (no window at 95 %,
  an unknown reset, or a stale reading whose reset has passed) gets the
  ordinary backoff retry. (A deliberate, lead-approved departure from the spec,
  which backs off on every `rate_limit`.)
- Everything armed belongs to one conversation. If the session id changes
  without a `session.end` reaching the plugin, the next event or timer notices
  and drops what was armed instead of firing it into the new conversation.
- A resume is armed only for a reset still in the future; one that passed while
  no session was running is dropped at `session.start`.

## Options

No `userConfig` fields. Resume is switched per session with the command:

```
/stall-watch on       # resume 30 s after a usage-limit reset
/stall-watch off
/stall-watch status   # shows the switch, retries used, what is armed
```

The switch is kept in the plugin's store under `session:<sessionId>` as
`{ sessionId, enabled, resetsAt?, armedAt?, updatedAt }`, so it survives a hot
reload and a restart of the same session. A record not seen for 14 days is
pruned; a session start and, while resume is on, each prompt of yours refresh
it.

## Load it

```
claude --plugin-dir /absolute/path/to/mods/stall-watch
```

or set `CLAUDE_CODE_PLUGIN_DIRS=/absolute/path/to/mods/stall-watch`
in the environment (or in the `env` block of `~/.claude/settings.json`).
Check and test it with:

```
claude plugin validate mods/stall-watch
claude plugin test mods/stall-watch
```

## Known limits

- The engine retries API errors itself before a turn reports `error`; these
  retries come on top, deliberately slow. Each one re-sends the conversation.
- The engine setting `autoContinueAtUsageLimit` already covers resuming at a
  usage limit; that is why resume here is opt-in. Turn on one of the two, not
  both.
- Countdown and resume need subscription rate-limit readings; on an API key
  they stay silent.
- Timers do not survive quitting. A hot reload re-arms from `$.state` at the
  `session.start` the reload fires (and at the next event, should that fail);
  a restart re-arms the resume from the store at `session.start`.
- `/clear` and an in-process `/resume` move to another session id: anything
  armed is cancelled and resume is off again for the new session. Whether a
  resumed conversation's own stored switch is restored depends on the engine
  firing `session.start` for it; a restart with `claude --resume <id>` does.
- The local time comes from one `date +%z` at session start; a daylight-saving
  change mid-session shifts the shown time by an hour until the next session.
  If `date` cannot run, the line shows only the relative time.
- The resume note holds only the first 80 characters of your last prompt,
  redacted before it is cut, in three layers: vendor token shapes
  (OpenAI/Anthropic/Stripe-style `sk-`, `whsec_`, GitHub, Shopify `shpat_`,
  Google `AIza`, npm, GitLab, Slack tokens and webhook URLs, AWS key ids, JWTs,
  PEM keys), auth headers and cookies, URL passwords
  (`postgres://user:[redacted]@host`, `redis://:[redacted]@host`), `mysql -p`;
  any value after a name holding a secret word (password, pass, secret, token,
  api key, access key, private key, `_KEY`, credentials) in env-var
  (`DB_PASSWORD=`, `SHOPIFY_API_SECRET=`, `ENCRYPTION_KEY=`), camelCase, JSON
  (`"password": "..."`), flag (`--password x`) and prose (`password is ...`,
  `password hunter2`) form; and any bare run of 20+ token characters that
  mixes letters and digits (or 32+ mixing upper and lower case), which is how
  an AWS secret access key pasted on its own is caught. What it cannot know: a
  letters-only secret after a plain word (`password hunter`, `use correcthorse
  to log in`) passes. It over-redacts on purpose: a commit hash, a UUID or a
  path holding digits reads `[redacted]` in the note. The file is written
  with default permissions and deleted after 7 days. Prompt text is never put
  in a toast, a log line or the store, and only the redacted excerpt is held
  in memory.
- A failure is paired with its turn by order, as the events carry no shared
  id. Should a turn's `StopFailure` arrive only after the next turn started,
  and that next turn end in an error before its own `StopFailure`, the next
  turn is decided by the earlier kind. Both orders are undocumented; the
  common orders (either half first, within one turn) are handled.
- A resume more than a day away is waited out in steps of a day (a timer may
  not hold a wait of weeks); each step re-arms only while that resume still
  stands.
- Note pruning runs `/bin/rm` by argv (the hooks API has no delete); on a
  system without `/bin/rm`, old notes stay until removed by hand.
- Plugin prompts do not expand `@file` mentions or images, so the
  continuation is a fixed sentence rather than a replay of your prompt.
