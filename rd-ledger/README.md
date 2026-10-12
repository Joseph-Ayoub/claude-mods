# rd-ledger

A contemporaneous ledger of **R&D engagement time and AI usage**, kept inside every Claude Code session it runs in. It records when you prompted (never what you typed), which repository you were in, and what each model turn cost at list price; shows this week's hours by business component and this month's usage estimate in a pane; lets you map repositories to components and confirm each week with buttons; and exports a CPA-ready bundle. With Joseph's private `rd-tracker` checkout configured it can compare against, and hand confirmed weeks into, that tool.

**Nothing in this mod is tax advice. What is claimed on a return is your CPA's decision.** The ledger is a record of time and usage with the methodology written down; it computes no credit.

## What you see

- **Footer chip** (desktop prompt footer; the terminal's hint line), the one chip this mod draws: `$12.34 ⧗2.4h`, this session's cost (the engine's own figure: cents under $100, whole dollars from there) and then an hourglass mark with the R&D hours recorded today (the R&D view's "Today" figure; `⧗--` until the first ledger read). The `footerChip` option shows both (default), the cost alone or the hours alone; `chipContext` adds ` · ctx 12%`. The label is never longer than 16 characters, so the strip never cuts it to `…`. Press it: the **Usage** pane opens, with **R&D ledger** as the tab beside it. With the `footerButton` option off the figure is plain text and `/rd usage` opens the panes.
- **The Usage pane** (`/rd usage`, or `/spend`, usage-gauge's old command): this session's **Cost** (the engine's figure; `no ledger here` on a host that keeps none), **Session** length, **Active** time (main-loop turns), **API** time (every model request), **Turns**, **Requests** and **Agent turns**; **Context** (a text bar, the window as `147k of 1.0M (15%)`, tokens until auto-compaction, and up to eight categories after a Refresh); **Rate limits** (each window's percent and its local reset time, or `none reported`); **Models** (requests, input, output, cache read and write, cache hit, list-price estimate and share per model, with a Total row; the narrower the pane, the fewer columns); **What's contributing** (`main loop 40% · subagents 60%`, then the top five subagent types); **Code changes** (`+4,321 −321 lines · 42 edits` from your Edit, Write and NotebookEdit calls); the price footnote; then **Refresh** `r`, **R&D ledger** `d` (opens the ledger tab) and **Close** `c`. The estimates use this mod's price table with the cache-write price of the cache TTL in force when each request ran (1.25× input for 5 minutes, 2× for 1 hour). Per-model, per-agent and code figures count from when the mod loaded in this session; a reload keeps them.
- **The R&D ledger pane**: five views sharing one chrome of two button rows: the views (**R&D** `o`, **Review** `v`, **Spend** `s`, **Session** `i`, **Sessions** `a`), then the actions (**Refresh** `r`, **Export** `e`, **Clear stale lock** `l` when one is held, **Close** `c`). Every view is drawn to the pane's width: wide (84 columns or more), medium (60 to 83) and narrow (under 60). Tables drop their least important columns as the pane narrows and long text wraps onto the next line, so nothing runs off the edge. The view you were on, and the session you picked, are still there after a reload.
  - **Session** (`/rd session`, or `/rd session <first 8 characters of a session id>`): engaged hours, prompts, main and agent turns, the four token counts and the cache-hit ratio, the engine's cost beside the list-price estimate, a by-model table, an agents table (the main loop and each subagent with its turns, model, tokens, estimate and share), and recommendations for spending less where the numbers support one: a longer or shorter cache TTL, a cheaper model for a short-answer subagent, a large context worth compacting, turns that ended in errors, or an hour that cost twice your usual. Every figure in a recommendation is an estimate.
  - **Sessions** (`/rd sessions`): every session this and last month, newest first, with its date, id, repository, engaged hours, turns, subagents, cost and recommendation count, and your median cost per engaged hour. It lists 40 at first; **More** (`m`) adds 40 at a time up to the newest 300, and remembers how many. Pick one with **Open session…** (or `/rd session <id8>`), and **Back** returns to the list. Recommendations about the cache TTL say what they assume and stay quiet when the TTL changed during the session.
  - **R&D** (`/rd`): laid out like rd-tracker's dashboard. **Hours in range** (this week's net hours, the figure a claim is built from, and the gross span, first to last prompt each day, for context; today; the change against last week), **Weekly trend** (each week this and last month; the oldest marked `(partial)` when it starts before the first of last month), **Hours by entity** and **Hours by component** (the unmapped, ignored and non-R&D buckets always shown, so the totals add up), **Activity mix** (research, support, non-qualified, unclassified, and the process-of-experimentation share), **Review status** (the review queue, every week this and last month with time that is not yet confirmed, days a flag says to look at, or the longest days), **Spend this month**, **Pipeline** (last refresh and export, the rd-tracker bridge, sessions read, prompts not counted, redactions, the zone, the price-table date, warnings) and **Deadlines** (rd-tracker's six R&D-credit deadlines, your entities' filing dates and the next weekly review, the Section G exemption per entity; calendar tax year, verify with your CPA).
  - **Review** (`/rd review`): unmapped repositories with a picker (a component, Ignore, or Non-R&D for an entity); one two-line block per component and day (the component and entity, then the date, hours, status, activity and marks) with Research / Support / Non-R&D / POE buttons; a note field per component and week (what was done, what was uncertain, what was tried; required before a process-of-experimentation flag); other-hours fields per entity; a Compare button when rd-tracker is configured; Confirm week and Reopen.
  - **Spend** (`/rd spend`): this month and last by model and by component, the token counts, the estimate, the engine's own `/cost` figure beside it, and the cache-write assumption in force. A narrower pane drops the cache-write and input columns first, then cache read.
- **`/rd export [YYYY | YYYY-MM]`** writes a bundle under `~/.claude/rd-ledger/export/<stamp>/` and tells you the path.
- **`/rd import`** (rd-tracker configured) reads the entity and component ids from rd-tracker's registries into your mapping, never overwriting your own entries.
- Where no pane can be drawn (`claude -p`), `/rd` answers a short text table of counts and hours, and `/rd usage` and `/spend` one line (`Usage: $12.34 · ctx 42% · 2 requests`).

## Install and load

**Replacing usage-gauge:** this mod now carries usage-gauge's Usage pane and `/spend`. Disable usage-gauge (`/plugin disable usage-gauge`) when you enable this one, or the footer shows two cost chips and both register `/spend`.

While developing, load it from this folder:

```sh
claude --plugin-dir /absolute/path/to/mods/rd-ledger
```

or add that absolute path to `CLAUDE_CODE_PLUGIN_DIRS` (in the shell, or in the `env` block of `~/.claude/settings.json`) so sessions the desktop app starts load it too. Every session that should be counted needs to load it; a session without the mod records nothing (rd-tracker's nightly transcript parse, where present, still covers it).

Marketplace install: see the distribution decision in `docs/ADR-006-distribution.md`; nothing is published yet.

## Options

Set in the config menu, or in settings under `pluginConfigs` → `rd-ledger`:

| Option | Default | What it does |
| --- | --- | --- |
| `footerButton` | true | The footer figure is a pressable chip that opens Usage with the R&D ledger beside it; off, it is plain text. |
| `footerChip` | `both` | What the chip shows: `both` (`$123 ⧗2.4h`), `cost` (`$123`) or `time` (`⧗2.4h`). Where the host keeps no cost ledger the hours stand in. |
| `chipContext` | false | Adds the context fill (` · ctx 12%`). Within the 16-character bound the hours give way to it first, then it gives way to the hours. |
| `refreshMinutes` | 5 | How often the week and month figures are recomputed (1 to 60). |
| `idleGapMinutes` | 30 | Two prompts further apart than this start a new engagement block (5 to 120). The canonical rd-tracker methodology is 30; changing it changes the method hash printed on every export. |
| `cacheTtl` | `5m` | The prompt-cache write assumption when the engine does not report a TTL: `5m` prices cache writes at 1.25× input, `1h` at 2×. |
| `rdtRepo` | (empty) | Absolute path of an rd-tracker checkout. Empty runs standalone. |
| `bridgeMode` | `corroborate` | `corroborate`: nothing is written into rd-tracker, Compare shows both. `source-of-truth`: confirming a week records its hours in rd-tracker through `rdt add` (read the costs below). `off`: no rd-tracker calls at all. |
| `personLabel` | (empty) | Printed in the export README's header only (`Person: …`); blank prints "not recorded — add on cover sheet". |

Out-of-range values fall back to the default.

## How it works

| Hook | Why |
| --- | --- |
| `session.start` | registers `/rd` and `/spend`, freezes the timezone on first run, opens or continues this process's segment file, arms the refresh timer, reads the usage figures |
| `classic.SessionStart` (startup, resume, clear, fork) | opens a segment for the session id the engine names; `/clear` closes the old one |
| `prompt.submit` | one engagement event per human submission, recorded **after** the prompt entered and only from `origin.kind` and whether a turn was running; the text is never read |
| `turn.complete` | one usage row per turn (main loop and subagents): model and the four token counts; the Usage pane's turn count and active time |
| `turn.step` | the Usage pane's per-request counts (model, four token counts, wall time); the model's stream passes through untouched |
| `tool.call` (Edit, Write, NotebookEdit) | the lines each change added and removed, counted from its result; no path or text is kept |
| `session.measure` | the engine's cumulative cost figure, kept as a corroboration number; the context window and rate limits for the Usage pane |
| `$.agent.list()` (a call, not a hook) | a subagent's type for What's contributing, looked up once per agent; only the id and type are read, never the task description |
| `classic.PostModelSwitch` | a dated cache-TTL change point |
| `session.end` | closes the segment |
| `command.run` `/rd …` | the commands; views open only for your own origins (typed, Remote Control, the desktop app); a peer session, a schedule or another plugin gets one line of counts |
| `ui.render` `Pane` (`rd-ledger`, `rd-usage`) | the two panes, the ledger drawn from the last rollup, Usage from the usage figures in the session state |
| `ui.render` `SessionMode` / `PromptHint` | the one footer chip: the session cost and today's R&D hours |

**Engagement hours** follow rd-tracker's union-v2 method exactly: human prompts from every session are merged into blocks while the gap is at most 30 minutes; a chain longer than 4 hours is split at its largest gap; a lone prompt counts 60 seconds; blocks are cut at local midnight with the seconds shared by prompt count; each block's seconds are shared equally over its prompts and land on the prompt's repository, then on the component your mapping names. Prompts that are not yours (task notifications, scheduled triggers, peer messages, plugins, `claude -p` and SDK runs) are recorded with the reason they were not counted and never form blocks. The method string `union-v2/<hash>` is rd-tracker's own and is printed on every export.

**Usage estimates** price each turn's tokens at the published list rates bundled in `hooks/prices.ts` (dated in the Spend view and the export). They are **list-price estimates, not invoices**: a subscription bills differently, cache writes are priced on an assumption, and the engine's own side calls (compaction, titles) are not in the per-turn counts. The raw counts are kept, so any later price table can be applied.

**Files it writes, all under `~/.claude/rd-ledger/`:**

- `timezone`: one IANA zone name, frozen the first time the mod runs (rd-tracker's `store/timezone` is adopted when the bridge is configured). Never rewritten; a different detected zone is only reported.
- `salt`: 32 hex characters, written once; salts the repository-root hash.
- `components.json`: your mapping (entities, components, repository rules, pre-tag rules). Edit by hand or through Review; the file carries a `gen` counter and unknown keys survive a save. `mapping-history.ndjson` records every save.
- `sessions/YYYY/MM/<sessionId>.<seg>.json`: one **segment** per session per process open (and per local month, and again when a segment passes 3 MiB). It holds the session id, when it opened, how (`startup`, `resume`, `clear`, `fork`), the entrypoint word, the surface, the repository's basename and a salted hash of its root, the cwd's basename, the branch and its changes, the model, the cache-TTL change points, the events (time, origin kind, admitted or not, reason, queued) and the turns (times, model, four token counts, outcome), and counters. **Never** prompt text, answers, tool inputs, titles, full paths, your name, an email, or stderr. Every string from outside the mod is scanned for credential and email shapes first (a hit is stored as `[redacted:<kind>]` and counted), then cut to one line.
- `reviews/YYYY-Www.json`: the weekly review, append-only: a revision is written on Confirm and on Reopen, never on a click. A confirmed revision freezes each row's seconds, entity, activity and POE flag, your notes and other hours, the method and parameters, the zone, and digests of the mapping and of the week's events, so a later remap or setting change shows as `changed since confirmation` rather than silently moving confirmed hours.
- `bridge-YYYY.ndjson`: every hand-off to rd-tracker (an intent line before each call, the outcome after), the record that prevents a second send.
- `.lock/`: a `mkdir` lock taken for shared-file saves and hand-offs. The code never takes a lock over (two takeovers could both succeed): a lock older than 15 minutes, left by a crashed session, shows in the R&D view's Pipeline section and the pane offers **Clear stale lock** (`l`), which asks first and removes it. Until then saves and hand-offs wait.
- `export/<stamp>/`: the CPA bundle (below).

Writes go to a temp file beside the target and are renamed over it, so a crash never leaves a torn record; a file the mod cannot read is counted as unreadable and never rewritten. Nothing is deleted except temp files older than an hour. **The store is the record; the export is its hardcopy. Back the store up off this Mac.**

**The export bundle** (`/rd export`, Rev. Proc. 98-25 in spirit): `README.md` (the caveat, the person line, a data dictionary for every field and column, the method and admission rules verbatim, the mod version and the sha256 of the union and price code, the retention note, redaction counts, a PROVISIONAL stamp when any week in scope is unconfirmed), `method.json` (parameters, zone, method, price table and date, assumptions, scope and rounding rules), `events.csv`, `blocks.csv`, `allocations.csv`, `hours_by_component.csv` (frozen and live seconds, status, confirmation lag), `activity_notes.csv`, `turns.csv`, `spend_by_month.csv` (labelled estimates), `monthly_log.txt` (page-numbered), `reviews.json`, `components.json` (component entries only; ignored and non-R&D directory names stay local), `bridge.ndjson`, `sessions.ndjson` (the raw segments in scope, re-encoded), and `MANIFEST.sha256`. Rows that are not claimable (unmapped, ignored, non-R&D, non-qualified) show a bucket name instead of a repository or branch name. Every cell is scanned and redacted in place; the README counts the redactions; an export is never refused for a hit. CSV cells that start with `= + - @` get a leading apostrophe so a spreadsheet reads text.

**The rd-tracker bridge.** With `rdtRepo` set to a checkout that has its `.venv`, every call is `<repo>/.venv/bin/python -I -m rdt …` by argv (no shell, every value one `--flag=value` token, ids validated, numbers formatted by the mod), run in the repo, with a minute's timeout; stdout is kept as one cleaned line and stderr never. Only `rdt add` (hand-off), `rdt review --json` (Compare) and the registry import run; never `publish`, `ingest`, `spend`, `review --answers`, git, or any file under `store/`. **Compare runs rd-tracker's review derivation, which rewrites that tool's local proposals for the open week; the button says so and asks first.** Under `source-of-truth`, Confirm asks once more, then records each (date, entity, component) of the frozen rows once, keyed by the bridge log (at most 12 per Confirm and 10 minutes of sending, each re-checked against the log as it stands right before its call); a changed amount for a destination already sent is recorded as `needs-manual-adjust` even when nothing new is sent; a changed amount is logged as `needs-manual-adjust` and never sent again (rd-tracker has no update command); a failed call is retried on the next Confirm; a call whose outcome is unknown blocks that destination until you clear it in the log. A POE flag is sent only with your typed justification. The costs of `source-of-truth` are in `docs/ADR-003-bridge-semantics.md`: rd-tracker's nightly parse still counts the same Claude Code time unless its ingest excludes that source, and the entries lose rd-tracker's event-level audit.

## Tests

`claude plugin validate mods/rd-ledger`, `claude plugin test mods/rd-ledger`, and `sh mods/rd-ledger/scripts/check.sh` (the validate call-list and env-read allowlist, the source bans, then the tests). The tests cover:

- the ground-truth fixtures from the tester seat (F1: 19 events over 3 sessions and 2 days with a midnight crossing, a queued prompt, a lone prompt, an over-4-hour chain split at its largest gap and two overlapping sessions; F2 the gap-tie rule; F3 and F4 the two 2026 daylight-saving days), asserted to the second;
- admission for every origin kind, entrypoint and surface; the gap boundary in milliseconds; the method hash golden `a5db146c`; sha256 against the FIPS vectors; every price row; zone math including ISO week-year edges and a sweep over every 2026 day;
- the mapping and review files: validation, null-prototype tables, unknown keys preserved, `gen` conflicts refused, confirm and reopen revisions, POE refused without a note, drift after a remap;
- the export: every file and column, redaction in place, the bucket rule, the manifest, the data dictionary covering every field;
- the bridge: exact argv, refusals, the hand-off matrix, the log round trip;
- the session views: a two-segment session worked by hand (engaged seconds, tokens, both costs, model and agent shares), each recommendation rule with a case that fires and one that does not, `/rd session`, `/rd sessions` and `/rd session <id8>` with one, none and several matches, the picker and Back, and the view surviving a reload;
- the register on the shared fake engine: open-or-continue, `/clear`, resume, month rollover, events written at once, flushes never torn, the sentinel prompt absent from every file, argv, toast, log, state value, drawn pane and export, the views and buttons on terminal, desktop and mobile, options round-trips, and every argv executable on the absolute allowlist;
- the Usage pane and chip (`usage.test.ts`, `usage-pane.test.ts`): usage-gauge's figure formats, patch counting, model lines and shares, rate-limit text and the context line; the estimate at 1.25× and 2× cache writes and a TTL change point mid-session; the chip per `footerChip` and `chipContext` within 16 characters and without emoji; the press opening the ledger then Usage focused; `/rd usage` and `/spend` per origin and headless; the R&D ledger button; the model stream passed through unchanged; an edit counted with no path kept; a sentinel agent description never reaching state, files, the pane or an answer; the pane at 40, 60, 84 and 120 columns on every surface.

## What to test

1. Look at the prompt footer: one chip from this mod, reading the session cost and then `⧗` with today's R&D hours to one decimal (`$1.25 ⧗0.0h`; `⧗--` until the first ledger read). It never shows a cut-off `…`. With usage-gauge disabled there is no second cost chip.
2. Press it: the **Usage** pane opens and is the one shown, with a tab **R&D ledger** beside it. Check Cost against `/cost`, the Context bar and window line, Rate limits, the Models table (estimates and shares), What's contributing after a subagent ran, and Code changes after an edit. Press **Refresh** (`r`) for the context categories. Press **R&D ledger** (`d`) or the tab: the ledger shows on the R&D view.
3. Type `/spend` and `/rd usage`: each opens the same two panes, Usage in front. Set `footerChip` to `cost`, then `time`, and turn on `chipContext`: the chip changes after the next reload and stays within 16 characters.
4. Narrow the pane with Usage shown: the Models table drops Req, Input and Cache wr, then Cache rd and Hit; nothing runs off the edge.
5. On the ledger tab, the **R&D** view: the header names the week, then Hours in range, Weekly trend, Hours by entity, Hours by component, Activity mix, Review status, Spend this month, Pipeline and Deadlines, each with a bold title. Check the Total rows match Net hours. Press **Session** for this session's hours, tokens, costs, models and agents, and either recommendations or "No recommendations for this session".
6. Press **Sessions** (or type `/rd sessions`): sessions this and last month are listed newest first; press **More** if there are over 40, pick an older one with **Open session…** (it may read "Reading the ledger…" for a moment), check its figures, press **Back**.
7. Type `/rd session` and the first eight characters of a session id from the list: that session opens. Eight characters that match nothing, or two sessions, answer one line and open nothing.
8. Reload the mod with the pane on a picked session: the same session is still shown.
9. Make the pane narrow (drag it, or open it beside the transcript), then wide, on each of the five views: no line runs off the edge or ends cut short in a sentence; tables lose columns (Weekly trend loses Gross span, Hours by component loses Activity then Entity, Spend loses cache write and input then cache read, Sessions loses Recs then Agents and Repo) and long lines (captions, warnings, recommendations) continue on the next line.
10. The buttons sit in two rows: R&D, Review, Spend, Session, Sessions on top; Refresh, Export, Close below (and Clear stale lock when a crashed session left a lock). Each hotkey still works.
11. In **Review**, each day row reads as two lines (the component and entity, then the date, hours, status and activity) with its buttons under it.

## Limits

- **macOS only** for the subprocess paths (`/bin/mv`, `/bin/rm`, `/bin/mkdir`, `/bin/rmdir`, `/usr/bin/git`).
- **A session without the mod records nothing.** Load it in every session (see Install).
- **Verified on** the Claude desktop app 2.31226 driving CLI 2.1.296 (2026-10-12): a typed prompt arrives as origin `composer` with entrypoint `claude-desktop`; `session.start` reports no surface and not interactive on the desktop, so the surface is learnt from the first draw or prompt and kept on the record. **Slash commands:** whether a typed slash command raises an engagement event is still unverified; rd-tracker denies them.
- **`sdk` prompts** are counted only on the desktop app (entrypoint `claude-desktop` with a `desktop` surface); a `claude -p` run started from a desktop session inherits the entrypoint variable and is recorded as `sdk-nested`, not counted.
- **Up to 500 ms of turn data** can be lost on a hot reload (events cannot: they are written at once).
- **Segment caps:** 8,000 events and 8,000 turns per segment; past that the counters grow and the Review view shows a `rows-dropped` flag.
- **Non-R&D time of two entities on one day** shares one row that carries the entity with the most seconds and a `mixed-entities` marker.
- **Estimates differ from the AI Spend Ledger** by the cache-write assumption (that ledger reads the TTL split from transcripts) and by the engine's side calls.
- **The export is machine-readable first.** `monthly_log.txt` is the printable leg; the CSVs are for the CPA's spreadsheet.
- **Where the chip can sit:** the desktop raises only the prompt footer's mode row to plugins, which draws a grey chip; the terminal uses the hint line; VS Code and mobile draw neither, so use `/rd usage` and `/rd` there.
