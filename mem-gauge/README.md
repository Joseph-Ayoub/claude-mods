# mem-gauge

A memory gauge under the Claude Code composer, and a **Memory** pane that shows what is using this Mac's RAM: every Claude session (with its model, context fill and running agents), the other apps, and plain advice on what to close or wrap up. Built for running many sessions on one Mac, which has run out of RAM and disk before.

## What you see

- **Under the prompt:** a small pressable gauge on the hint line, for example `mem ◑ 62%`. The ring fills by fifths (`○ ◔ ◑ ◕ ●`). It gets a `!` in front when macOS reports memory pressure (warn or critical) or when another session has asked this one to wrap up. Click it (or type `/mem`) to open the pane.
- **Status line:** one line under the prompt, for example
  `mem ◑ 62% · pressure ok · this session 1.8 GB · 7 sessions · disk 41 GB free`.
  It refreshes every 30 seconds. Turn it off with the `statusLine` option if the gauge alone is enough. The pressable gauge exists on the terminal and the desktop app only, so on VS Code and mobile turning the status line off leaves just `/mem`.
- **The Memory pane** (`/mem` or a click on the gauge):
  - a ring (desktop, VS Code, mobile) or a bar (terminal) of memory used, and the pressure
  - totals: Used, Free, Compressed, Swap, Load, each figure flush with the pane's right edge (free disk is in the Disk pane)
  - **Sessions:** the ten biggest active Claude sessions (memory first). A session that runs mem-gauge shows model, memory, context %, running agents and minutes idle; one that does not is listed from the engine's own session record (`~/.claude/sessions/<pid>.json`) by its name with its process tree's memory and idle time (model, context and agents read `--`, and there is no Ask to wrap for it); **View all** (hotkey a) lists every active session, up to 60, and **View top 10** folds it back. This session is the bold row. A session whose heartbeat is older than 2 minutes reads `(stale)`; one whose process has exited is not listed. A Claude engine with no session record is summed on one line.
  - **Other apps:** the 10 largest non-Claude apps, helper processes rolled up under their app (Chrome's renderers count as Chrome).
  - **Optimize:** fixed rules (the rules themselves make no AI call), one block per tip with a blank line between them: the advice first, then its button row beneath it, an **Apply** button where there is one safe thing to do (confirmed first in the engine's own dialog; a tip with nothing safe to automate has no button row). The Disk pane's "Free up safely" tips use the same shape:
    - another session idle over 30 min and over 1 GB: wrap or archive it; Apply asks it to wrap (the request file below) when it runs the mod, no button when it does not
    - this session's context past 150k tokens (option `contextTipTokens`; 0 falls back to 80 % of the window): two buttons. **Compact** runs `/compact` on this session (confirmed first). **Hand off** runs `/handoff`, the [handoff mod](../handoff/README.md)'s command, which writes a handoff note and moves you to a fresh session (install it with `claude plugin install handoff@joseph-mods --scope user`; without it the button says so). Another session's context past the same line is advice only: compact or hand off from there. A session whose token count is not known yet (an older build's heartbeat, a fresh session) uses the 80 % rule.
    - more than 3 running agents: the largest fan-out; consider running them one after another (no button)
    - memory over 85 % used or under pressure: close the largest other app; Apply asks it to quit the normal way (`osascript`, the name passed as an argument, so it may still ask you to save; never the Claude app itself)
    - load over twice the core count: pause heavy test suites (no button)
    - under 10 GB of free disk: Apply opens the Disk pane, which says what is safe to free
  - **Refresh** (`r`) and **Close** (`c`, or Esc).

### Compact or hand off?

**Compact** summarizes the conversation in place and keeps the session; **Hand off** writes a note and starts fresh from it. What Hand off does, in order, and why nothing is lost if a step fails, is in [`mods/handoff/README.md`](../handoff/README.md): the handoff mod owns the dialog, the note, `/clear` and the pre-filled prompt. This mod only offers the button: it refuses the press while a turn is running (a toast says to wait), runs `/handoff` once per press, and dims the button, and Compact beside it, until the command has been handed over.

The tip's threshold is an absolute token count, not a share of the window, because a 1M window is capacity for reading a lot at once, not a target: per-turn cost, cache-miss cost and latency grow with the prefix and quality thins, and Anthropic's own compaction defaults to 150k.

### Ask to wrap

The button asks you to confirm, then leaves a small request file for that session. That session's own copy of mem-gauge shows its person a toast and a `!` in its status line. **Nothing runs by itself**: no message reaches the other session's model, so it is never woken into a turn (which would spend memory) and nothing could read it as an order to push or merge. Each session can be asked at most once per 10 minutes, and this session is never offered for itself.

On the receiving side, only the time and the size are read from the file (anything else in it is ignored). While a request is already showing, a newer one only updates the size, so several sessions asking at once raise one toast. A request older than 30 minutes, or stamped in the future, is dropped. Opening the pane counts as having seen it and clears the `!`.

## Install and load

Install it from the marketplace (terminal session):

```
/plugin install mem-gauge --marketplace Joseph-Ayoub/claude-mods
```

or at user scope from the local marketplace (`claude plugin install mem-gauge@joseph-mods --scope user`) so every session loads it (see `mods/README.md`). The Hand off button also needs the handoff mod: `claude plugin install handoff@joseph-mods --scope user`.

While developing, load it from this folder:

```sh
claude --plugin-dir /absolute/path/to/claude-mods/mem-gauge
```

or set `CLAUDE_CODE_PLUGIN_DIRS` to that absolute path (in the shell, or in the `env` block of `~/.claude/settings.json`) so sessions the desktop app starts load it too. To see every session in one pane, every session needs to load it.

## The gauge icon

On the desktop the gauge sits in the prompt footer's mode row (the dim labels at the right of the composer, the one site under the composer the desktop app raises to plugins). That strip clips whatever does not fit, draws no vector element, draws every button before every text whatever the order, and a button (a small native chip) is the only pressable thing it has. It also ignores a Box's hover and display. So the row is two buttons, each a glyph icon with its figure: the memory ring glyph (`○ ◔ ◑ ◕ ●`, filling with use) with the used percent, for example `◔ 60%`, which opens the **Memory** pane, and the disk glyph (`⛁`) with the free space, `⛁ 901 GB`, which opens the **Disk** pane; then the engine's own mode labels. With `footerCompact` on, both figures sit in one tight chip as fullness percents (`◔60% ⛁59%`) that opens the Memory pane, whose **Disk** button (`d`) opens the Disk pane; use it when other mods' chips share the strip. With the `footerButtons` option off the row is plain text (the ring glyph in red) and `/mem` and `/disk` open the panes. Under memory pressure, or while another session's wrap request is showing, the memory figure reads `◔ ! 60%`. The terminal, which has no vector element, draws the quintile glyph in red and the one-line text `Memory 60% · Pressure ✓ · 7 sessions · Disk 41 GB free` in the hint line under the prompt; a press there opens the Memory pane. The separate status line is off by default (option `statusLine`); turn it on for VS Code or mobile where neither row is drawn. The Memory pane header draws the red ring with the percent inside at 88 px.

## The Disk pane

The Disk button or `/disk` (and nothing on the tick) opens a second pane with the main volume's use (a ring on the desktop, a bar on the terminal; `used 1.1 TB of 1.9 TB · free 830 GB`), then **Volumes**: every real volume from `df -kP` with Size, Used, Free and Used %: the APFS system and data volumes merged into one bold **Macintosh HD** row (they share one container, so df lists the same size and free space twice; used is the two together), external disks, iOS simulator runtimes; devfs, the swap and preboot helpers and automounter maps are left out; then **Big folders**: the usual disk hogs measured with `du -sk` when the pane opens, each in parallel with a 10 s timeout: Claude transcripts (`~/.claude/projects`), Claude file history, Xcode DerivedData, iOS simulator devices, Library caches and the Trash. A folder that is missing or takes longer than 10 s shows `--`. Then **Free up safely**, rule-based: Library caches from 512 MB (apps rebuild them), Xcode DerivedData (the next build is a full one), iOS simulator devices (delete the ones you no longer test on; `xcrun simctl delete unavailable` removes the stale ones), more than one iOS simulator runtime (keep the one you test on), the Trash, and Claude file history (edit snapshots for rewinding; prune once those sessions are closed). Each of those tips has an **Apply** button (the runtimes tip is manual): Apply asks first in the engine's own dialog, then runs one fixed command with no shell (`find <folder> -mindepth 1 -maxdepth 1 -exec rm -rf {} +` for caches, DerivedData and the Trash, under a HOME that must be a plain absolute path; a target folder that is itself a symlink is left alone; `xcrun simctl delete unavailable`; the file-history find with `-mtime +30`), says how it went in a toast, and re-reads the sizes; while it runs the button reads Applying. Only things that can be cleared are listed: the Claude transcripts (`~/.claude/projects`) are the session history and never appear (a test holds every tip and every command away from that folder). A volume name is cleaned to one line of printable text before it is drawn, like every other program's text here. The reading is kept for a minute; **Refresh** (hotkey r) reads again, **Close** (hotkey c) closes.

## Options

Set in the config menu, or in settings under `pluginConfigs` → `mem-gauge`:

| Option | Default | What it does |
| --- | --- | --- |
| `intervalSeconds` | 30 | How often the gauge re-reads memory (10 to 600). |
| `idleMinutes` | 30 | Minutes without a turn before a session counts as idle for the wrap advice. |
| `contextTipTokens` | 150000 | The Memory pane suggests Compact or Hand off once a session's context passes this many tokens (20000 to 1000000). 0 falls back to 80 % of the window. |
| `statusLine` | false | Also show the one-line summary as a status line (the gauge row already carries it). |
| `footerButtons` | true | Draw the desktop footer figures as buttons (grey chips) that open the panes; off, they are plain text and `/mem`, `/disk` open the panes. |
| `footerCompact` | false | Both figures as fullness percents in one tight chip (`◔60% ⛁59%`) that opens the Memory pane, where **Disk** (`d`) opens the Disk pane; with `footerButtons` off, the same figures as plain text, which takes the least room. For footers that other mods' chips share: the desktop strip clips once the chips overflow it. |

## How it works

| Hook | Why |
| --- | --- |
| `session.start` | registers `/mem` and `/disk`, starts the 30 s timer, takes the first reading |
| `turn.start`, `turn.complete` (main loop only) | marks the session active (a Hand off press is refused until the turn ends); refreshes the repo · branch label after a turn |
| `session.measure` | keeps the latest context (percent, tokens, window) and rate-limit figures |
| `session.end` | removes this session's heartbeat file (one `rm -f`) |
| `command.run` `/mem` | opens the pane; where no pane can be drawn (`claude -p`), answers with a short table |
| `command.run` `/disk` | opens the Disk pane; where no pane can be drawn, answers with one line (used, total, free) |
|  | any origin may run it (it only reads); only your own origins (typed at the prompt, the Remote Control bridge, the SDK host behind the desktop app) open the focused pane, and get the short table where the pane cannot be placed. A peer session, a plugin, a scheduled task or an unknown origin gets one summary line (used %, pressure, live sessions) in a session that draws, so nothing else can pop a pane in front of you or copy every session's labels into this transcript; only where nothing draws (`claude -p`) does it get the table. If `/mem` overruns its time budget, it answers from the last reading |
| `ui.render` `PromptHint` | adds the pressable gauge after the engine's own hint line |
| `ui.render` `Pane` `mem-gauge` | draws the pane from the last reading only |

Each tick runs, with argv only (no shell) and a 5 s timeout each, all in parallel: one `sysctl` (pressure level, swap, load; memory size and cores are read on the first call only, they never change), `vm_stat`, `df -k /` and `ps -axo pid=,ppid=,rss=,comm=`. A collector that fails leaves only its own figures blank (`--` or `?`); the rest still draws. Ticks never overlap: a slow one is joined, not doubled. Sessions share the work: whoever finds `~/.claude/mem-gauge/machine.json` older than about 25 seconds collects and writes it, the rest read it. "Used" is (active + wired + compressed) pages, the same as Activity Monitor's "Memory Used". Pressure comes from `kern.memorystatus_level` (percent free; under 20 warns, under 10 is critical).

The mod makes no model call, writes no handoff note and never fills the prompt box. The **Hand off** button runs one command, `/handoff` (`$.command.run`), which the handoff mod answers; the note, `/clear` and the pre-filled prompt are that mod's.

Files it writes, all under `~/.claude/mem-gauge/`:

- `machine.json`: the shared reading (numbers and process names, no command lines)
- `sessions/<sessionId>.json`: one heartbeat per session: label (repo · branch), working folder, model, memory, context % (with the token count and window), rate-limit %, running agents, last activity. Never prompt text, never secrets.
- `requests/<sessionId>.json`: an Ask to wrap waiting to be seen; removed once seen.

Clean-up never depends on `session.end` (a crash or a kill skips it):

- Heartbeats of crashed sessions are removed by any session's tick once their process is gone (or its pid now belongs to something that is not `claude`, `node` or `bun`) and they are 10 minutes old; anything a day old goes regardless.
- After `/clear` the session goes on under a new id; its first tick removes the old id's heartbeat, so one process is never counted twice.
- Request files nobody picked up are removed after 30 minutes.
- At most 10 files are removed per tick.

The prompt text of a turn is never read or stored; `turn.start` is used only as a timestamp. The short `/mem` table goes into the transcript the model reads, so it carries repo · branch labels but never a working folder. Other sessions wrote those labels (and the model names and the app names in `machine.json`), so every one is read as a single printable line: control characters, escape codes and line breaks become spaces, and invisible format characters (bidi overrides, zero-width, tag characters) are dropped, so nothing written there can add lines to the table, the Ask to wrap question or a toast.

## Tests

`claude plugin validate mods/mem-gauge` and `claude plugin test mods/mem-gauge` (108 tests in `parse.test.ts` and `register.test.ts`). The tests cover:

- pure parsing of `vm_stat`, `sysctl`, `df` and `ps` from fixtures, process trees, helper roll-up, the used % formula, pressure thresholds, glyph quintiles, every Optimize rule (and no false positives), registry status and garbage collection, torn files;
- the tick end to end against a fake Mac (every command and file answered beneath the plugin, the clock mocked): the status line, the heartbeat, shared readings, other sessions, `/clear`;
- the pane on terminal (text bar, no Svg) and desktop (Svg ring with alt text), plus narrow panes on all four surfaces, and the pressable gauge on the hint line (mounted and pressed on terminal and desktop);
- `/mem` from each kind of origin, placed, unplaced and headless;
- Ask to wrap: confirm, cancel, dismiss, the 10-minute limit, and the receiving side's toast, marker and de-duplication;
- Compact and Hand off: the tip fires at 150k tokens whatever the window, `contextTipTokens` lowers it and 0 falls back to 80 % of the window; this session's tip draws both buttons and another session's none; a Hand off press runs `/handoff` exactly once with this plugin as its origin and nothing else (no dialog, process or file of its own); without the handoff mod the toast names its install line; a running turn refuses the press with a toast; while `/handoff` is being handed over the button and Compact are dim and a second press of either is ignored, and the reverse while Compact runs (the note itself is tested in the handoff mod);
- fail-safe paths: every process and file refused, an untrusted parent pid, a transient pid-probe failure (retried, at most five tries), the `statusLine` option off, usage unreadable (figures come from `session.measure`), the timer re-armed by the first main-loop turn after a hot reload, a denied Close press, `session.end` not waiting on its `rm`, `/mem` during a tick in flight;
- hostile text: a heartbeat label or model, or an app name, holding newlines, escape codes or bidi characters cannot forge lines in `/mem`, the Ask to wrap question or a toast.

## Limits

- **macOS only** (`vm_stat`, `sysctl`, BSD `ps`).
- **Memory per session is approximate.** It is the resident size (RSS) of the session's process and everything it started (MCP servers, shells, test runs). RSS undercounts memory that macOS has compressed.
- **There is no API for the engine's process id.** mem-gauge asks a `sh` for its parent and trusts it only if `ps` names it `claude`, `node` or `bun`; otherwise it shows "this session unknown" rather than a wrong number.
- **Agents** counts this session's pending, running and waiting subagents. Workflow agents are not listed by the engine, so they are not counted.
- **Where the gauge can sit.** The terminal draws it on the prompt's hint line. The desktop app (2.31226, CLI 2.1.293) never raises the hint line or the band above the prompt to plugins, only the prompt footer's mode row, the spinner, the transcript rows and panes, so the desktop gauge lives in the mode row. VS Code and mobile raise neither: turn the `statusLine` option on there, and use `/mem`. That a press reaches the Button is proven by the test kit; confirm it with a live click before relying on it.
- **Never clear the status line with `undefined`.** On the desktop host that call stops every later render from reaching the plugin (the gauge, the pane, everything), so when `statusLine` is off the mod makes no status call at all. A line pinned by an earlier load of the mod (hot reload, or the option switched off) stays until the session restarts.
- **The engine pid comes from `$PPID` of a spawned `sh`**, which depends on how the host starts processes and may change between Claude Code releases; the check falls back to "unknown".
- **Advice sizes are estimates.** "Frees N GB" is that session's RSS, which can read low under compression.
- **Only the memory half** of keeping many sessions healthy is covered; ordering sessions' PR / CI / merge work is out of scope.
- Writes are not atomic: a half-written heartbeat is left out of the table for one tick (it is not drawn as stale), and a half-written shared reading is simply re-collected.
