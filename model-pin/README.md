# model-pin

Keeps a project on one model and shows when the session leaves it.

A model switch is easy to lose: `/model` resets on resume, the engine falls back
to another model on overload, and a stray picker choice sticks. model-pin
compares the session's model to a per-project pin and, on drift, shows a status
line, shows a toast once, and puts the pin back once. It never fights a
deliberate switch, never changes your default model for new sessions, and
never polls: every check is driven by an event.

## What it does

1. **Finds the pin**, in the engine's own order, so a settings pin is the model
   the engine itself starts on (unless `--model` or `ANTHROPIC_MODEL` overrides
   it at launch) and the mod never fights a setting. Highest wins:
   managed `policy` settings, then `--settings` (`flag`), then this checkout's
   `.claude/settings.local.json`, then the `/model-pin` override for this
   repository (kept in `$.store` under `pin:<main working tree root>`, so linked
   worktrees share it; the session root outside a repository), then the
   project's `.claude/settings.json`. The user-level `~/.claude/settings.json`
   counts only with `includeUserSettings` on. A defined but unusable value
   (anything that is not one model-id token), or a source that cannot be read,
   means "no pin" rather than a fall-through: the engine obeys that source, so
   pinning a lower one would fight it. No pin anywhere: the mod does nothing.
   The engine never reads the override, so a session starts on its settings
   model and an override that differs shows as drift at every start.
2. **Compares like for like.** Both sides are normalized: lowercase, no provider
   prefix (`anthropic.`, `us.anthropic.`, `bedrock/`), no date or `-v1:0` tail,
   no `[1m]`, no `claude-` lead, spaces and dots folded to hyphens. So
   `Fable 5.1`, `claude-fable-5-1` and `anthropic/claude-fable-5-1@20260101` are
   one model, and a pin written as an alias (`fable`) matches any id of that
   family. The one exception is the mod's own `/model` (item 4): it also needs
   the same `[1m]`-style variant, since a variant can change the context window
   and its pricing. `/model-pin <alias>` upgrades itself to the resolved id once a
   switch to that alias lands, so a later alias re-point by the CLI does not
   look like drift; a one-off `/model` to another version never re-pins.
   A pin that cannot be compared (a word outside the fable/opus/sonnet/haiku
   families such as `opusplan` or `default`, or a provider ARN) is shown by
   `/model-pin` but never drives a badge, a re-apply or the lock.
3. **Shows drift.** `model drift: <current> (pinned <pin>)` in the status line,
   a toast the first time per session, cleared when the session is back on the
   pin.
4. **Puts the pin back once per session, without touching your default.**
   Only when the model was restored or defaulted, not chosen: a resume
   (`PostModelSwitch` source `resume`) or a drifted startup, resume or fork
   read (not in a session started as an agent, `--agent`, which runs that
   agent's model on purpose, and not while a fallback retry is waiting). The
   built-in `/model` may save its argument as your default for every new
   session, so the mod runs it itself only when the pin already is your
   user-level default (`model` in `~/.claude/settings.json`, equal once
   normalized, with the same `[1m]`-style variant), and then with that value
   exactly as written, so saving it changes nothing. Any other pin (policy, `--settings`, local or project
   settings, or the `/model-pin` override, including a model named by a cloned
   repository) is offered instead: `/model <pin>` is filled into the composer
   for one Enter, only when the draft is empty; otherwise a toast names the
   command to type. Pressing Enter is then your own `/model`, so what it saves
   is your choice. A queued `/model` the engine refuses (it rejects inside a
   hook the turn waits on) falls back to the same offer. A switch with source
   `auto` (overload or rate-limit fallback) gets the badge now and exactly one
   re-apply attempt 10 minutes after the latest fallback, if still off the pin;
   a resume or fork in that window (its `SessionStart` read and its
   `PostModelSwitch` alike) leaves it to the retry. The due time is kept
   in `$.state`, so a hot reload (which drops timers) re-arms it from
   `session.start`. A switch you made yourself (`command`, `picker`, `sdk`) gets
   the badge only, and a subagent's own start or switch (`agent_id` set) is
   ignored: its model is its own.
5. **Optional lock** (`lock`, default off). A switch away from the pin that you
   make yourself asks first (`project pins <pin>`): `/model`, the picker, or
   the desktop app and Remote Control, which switch over the SDK (`sdk`). It asks, never denies, so you can
   still go on purpose, and it fails open. Its ask replaces an `allow` from
   another plugin's hook beneath it (asking is the stricter answer, so this
   fails safe); a `deny` beneath stands. A subagent's switch is never asked about.

## Hooks it registers

| Event | Purpose |
|---|---|
| `session.start` | registers `/model-pin`; reads the model once and shows drift (badge only); re-arms a waiting fallback retry |
| `classic.SessionStart` | reads the model once; badge, plus the one re-apply for `startup`, `resume`, `fork` (observer, `.catch` falls through) |
| `classic.PostModelSwitch` | drift check on `to_model`; re-apply on `resume`, timed retry on `auto`; resolves an alias override (observer, `.catch` falls through) |
| `classic.PreModelSwitch` | the optional lock (gating hook with `.catch` that falls through) |
| `command.run` `{ command: 'model-pin' }` | serves `/model-pin` |

`$.state` keys (`PluginState['model-pin']`, per session, survive hot reload):
`reappliedOnce`, `drifted`, `toastShown`, `retryAt`.

## Commands

- `/model-pin` shows the pin, where it came from, and whether the session is on it.
- `/model-pin <model>` pins this repository and offers `/model <model>` in the
  composer (or names it, if you have a draft); it queues the switch itself only
  when `<model>` already is your user-level default, and then says it was
  queued, not that it ran. If local, `--settings` or
  policy settings name a model, the override is saved but the command says
  those win here, and switches nothing.
- `/model-pin clear` removes the override (settings pins still apply).

Anyone may read the pin, but only you can set or clear it: from your own
prompt (`composer`), Remote Control (`bridge`) or the desktop app, which hosts
its sessions over the SDK (`sdk`). A peer session, a channel message, a
schedule, a task notification, a coordinator, an unclassified sender or
another plugin is refused, since the pin outlives the session and would steer
every later one.

To pin through settings instead, set `"model": "claude-fable-5-1"` in the
project's `.claude/settings.json`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `lock` | boolean | `false` | ask before a manual switch away from the pin |
| `includeUserSettings` | boolean | `false` | count the user-level `model` as a pin for projects that set none |

Set them under `pluginConfigs["model-pin"].options` in settings, or in the config menu.

## Load it

```
claude --plugin-dir /absolute/path/to/mods/model-pin
```

or `CLAUDE_CODE_PLUGIN_DIRS=/absolute/path/to/mods/model-pin`.
Check and test it with `claude plugin validate mods/model-pin` and
`claude plugin test mods/model-pin`.

## Known limits

- **`--model` and `ANTHROPIC_MODEL` are not settings sources.** A session
  started with `claude --model sonnet`, or with `ANTHROPIC_MODEL` set, in a
  project that pins another model is badged and offered `/model <pin>` at
  startup (switched silently only when the pin is your own default). Clear the
  composer line to stay. Leave the project unpinned (the user-level default
  does not count unless `includeUserSettings` is on) to let each session choose.
- **An override drifts at every start.** The engine never reads the
  `/model-pin` override, so each session starts on the settings model and is
  offered the override. For a pin the engine starts on, put `model` in
  `.claude/settings.local.json` instead.
- **A queued `/model` inside a hook may be refused.** The engine rejects
  `$.command.run` inside a hook the turn is waiting on, so a re-apply from
  `PostModelSwitch`, or the switch `/model-pin <your default>` queues, often
  lands as the one-Enter composer fill instead (or a toast, with a draft). The
  `/model-pin` reply is written before that is known, so it says the switch
  was queued and may be offered instead. The 10-minute retry runs from a
  timer, outside any hook, and does run `/model` when the pin is your default.
- **The lock and a headless SDK run.** With `lock` on, a switch over the SDK
  asks too. In a `claude -p` or Agent SDK run with nobody to answer, what the
  host does with that ask is up to the host (it may refuse the switch). The
  lock is off by default.
- **Variants compare as one model.** The badge treats `opus[1m]` and plain
  `opus` as the same model, so running the 1M-context variant of the pin is not
  drift. Only the mod's own `/model` tells them apart: a user default that
  differs from the pin only by its variant is offered, never run.
- **Alias pins match by family.** A pin of `opus` cannot tell Opus 4.1 from
  Opus 5.5 without switching, so a same-family version change is not drift.
  Pin the resolved id for an exact match. `/model-pin <alias>` stores the alias
  until a switch to it lands; if the queued `/model` falls back to the composer
  and you never press Enter, the alias stays.
- **At most one automatic re-apply per session**, spent by whichever event gets
  there first. `/model-pin <model>` and `/model-pin clear` reset it.
- **Per-session state, shared store.** `$.store` is one file across sessions
  with no compare-and-swap. It is written by `/model-pin` and by the alias swap
  (item 2, from `PostModelSwitch` source `command`), which reads the key again
  just before writing and writes only if it still holds the alias, so a clear
  or a new pin from another session stands. Two writes on one repository in the
  same instant still mean last write wins. The key is per repository, not per
  session, as the spec's per-root override requires; it is the one store key
  the mod writes.
- **Fallback retries.** Each `auto` switch restarts the 10-minute wait; only
  the timer for the latest one acts. Timers die on quit (a new process starts
  with fresh per-session state, so nothing is re-armed then).
- **Overrides span worktrees, not subprojects.** The override is keyed by the
  repository's main working tree, so a project in a subfolder of a repository
  shares the repository's override.
- **Status line is plain text** (no color), one line per plugin.
- **`/model` may save your default.** The built-in `/model` may persist its
  argument as the default for new sessions (not verified against a live
  2.1.293 session). That is why the mod runs it only with your own user-level
  default, unchanged, and offers every other pin for you to run.
