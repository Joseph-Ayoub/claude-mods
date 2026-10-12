# rd-ledger

A contemporaneous ledger of **R&D engagement time and AI usage**, kept inside every Claude Code session it runs in. It records when you prompted (never what you typed), which repository you were in, and what each model turn cost at list price; shows this week's hours by business component and this month's usage estimate in a pane; lets you map repositories to components and confirm each week with buttons; and exports a CPA-ready bundle. With Joseph's private `rd-tracker` checkout configured it can compare against, and hand confirmed weeks into, that tool.

**Nothing in this mod is tax advice. What is claimed on a return is your CPA's decision.** The ledger is a record of time and usage with the methodology written down; it computes no credit.

## What you see

- **Footer chip** (desktop prompt footer; the terminal's hint line): `⧗ 2.4h`, an hourglass mark and the R&D hours recorded today (the same figure the Overview's "today" line shows; `⧗ --` until the first ledger read). It carries no cost: the usage-gauge chip owns the session cost. Press it to open the pane on the Overview, the R&D tax ledger; the session ledger stays one press away (**Session**, or `/rd session`). With the `footerButton` option off the figure is plain text.
- **The R&D ledger pane**: five views sharing one chrome (buttons Session `i`, Sessions `a`, Overview `o`, Review `v`, Spend `s`, Refresh `r`, Export `e`, Close `c`). The view you were on, and the session you picked, are still there after a reload.
  - **Session** (`/rd session`, or `/rd session <first 8 characters of a session id>`): engaged hours, prompts, main and agent turns, the four token counts and the cache-hit ratio, the engine's cost beside the list-price estimate, a by-model table, an agents table (the main loop and each subagent with its turns, model, tokens, estimate and share), and recommendations for spending less where the numbers support one: a longer or shorter cache TTL, a cheaper model for a short-answer subagent, a large context worth compacting, turns that ended in errors, or an hour that cost twice your usual. Every figure in a recommendation is an estimate.
  - **Sessions** (`/rd sessions`): every session this and last month, newest first, with its date, id, repository, engaged hours, turns, subagents, cost and recommendation count, and your median cost per engaged hour. It lists 40 at first; **More** (`m`) adds 40 at a time up to the newest 300, and remembers how many. Pick one with **Open session…** (or `/rd session <id8>`), and **Back** returns to the list. Recommendations about the cache TTL say what they assume and stay quiet when the TTL changed during the session.
  - **Overview** (`/rd`): this week's hours by component with its entity and status (`pretag`, `confirmed`, or `changed since confirmation`), the unmapped-repository queue, review status for this and last week, this month's usage estimate with its label, the deadline calendar for the entities you configured (calendar tax year; verify with your CPA), and data health (sessions and segments read, unreadable files, prompts not counted by reason, redactions, dropped rows, the frozen timezone, the price-table date, days since the last export, bridge status).
  - **Review** (`/rd review`): unmapped repositories with a picker (a component, Ignore, or Non-R&D for an entity); one row per component and day with Research / Support / Non-R&D / POE buttons; a note field per component and week (what was done, what was uncertain, what was tried; required before a process-of-experimentation flag); other-hours fields per entity; a Compare button when rd-tracker is configured; Confirm week and Reopen.
  - **Spend** (`/rd spend`): this month and last by model and by component, the four token counts, the estimate, the engine's own `/cost` figure beside it, and the cache-write assumption in force.
- **`/rd export [YYYY | YYYY-MM]`** writes a bundle under `~/.claude/rd-ledger/export/<stamp>/` and tells you the path.
- **`/rd import`** (rd-tracker configured) reads the entity and component ids from rd-tracker's registries into your mapping, never overwriting your own entries.
- Where no pane can be drawn (`claude -p`), `/rd` answers a short text table of counts and hours.

## Install and load

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
| `footerButton` | true | The footer figure (`⧗ <hours>h`) is a pressable chip that opens the Overview; off, it is plain text. |
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
| `session.start` | registers `/rd`, freezes the timezone on first run, opens or continues this process's segment file, arms the refresh timer |
| `classic.SessionStart` (startup, resume, clear, fork) | opens a segment for the session id the engine names; `/clear` closes the old one |
| `prompt.submit` | one engagement event per human submission, recorded **after** the prompt entered and only from `origin.kind` and whether a turn was running; the text is never read |
| `turn.complete` | one usage row per turn (main loop and subagents): model and the four token counts |
| `session.measure` | the engine's cumulative cost figure, kept as a corroboration number |
| `classic.PostModelSwitch` | a dated cache-TTL change point |
| `session.end` | closes the segment |
| `command.run` `/rd …` | the commands; views open only for your own origins (typed, Remote Control, the desktop app); a peer session, a schedule or another plugin gets one line of counts |
| `ui.render` `Pane` | the pane, drawn from the last rollup only |
| `ui.render` `SessionMode` / `PromptHint` | the footer figure: the hourglass mark and today's R&D hours |

**Engagement hours** follow rd-tracker's union-v2 method exactly: human prompts from every session are merged into blocks while the gap is at most 30 minutes; a chain longer than 4 hours is split at its largest gap; a lone prompt counts 60 seconds; blocks are cut at local midnight with the seconds shared by prompt count; each block's seconds are shared equally over its prompts and land on the prompt's repository, then on the component your mapping names. Prompts that are not yours (task notifications, scheduled triggers, peer messages, plugins, `claude -p` and SDK runs) are recorded with the reason they were not counted and never form blocks. The method string `union-v2/<hash>` is rd-tracker's own and is printed on every export.

**Usage estimates** price each turn's tokens at the published list rates bundled in `hooks/prices.ts` (dated in the Spend view and the export). They are **list-price estimates, not invoices**: a subscription bills differently, cache writes are priced on an assumption, and the engine's own side calls (compaction, titles) are not in the per-turn counts. The raw counts are kept, so any later price table can be applied.

**Files it writes, all under `~/.claude/rd-ledger/`:**

- `timezone`: one IANA zone name, frozen the first time the mod runs (rd-tracker's `store/timezone` is adopted when the bridge is configured). Never rewritten; a different detected zone is only reported.
- `salt`: 32 hex characters, written once; salts the repository-root hash.
- `components.json`: your mapping (entities, components, repository rules, pre-tag rules). Edit by hand or through Review; the file carries a `gen` counter and unknown keys survive a save. `mapping-history.ndjson` records every save.
- `sessions/YYYY/MM/<sessionId>.<seg>.json`: one **segment** per session per process open (and per local month, and again when a segment passes 3 MiB). It holds the session id, when it opened, how (`startup`, `resume`, `clear`, `fork`), the entrypoint word, the surface, the repository's basename and a salted hash of its root, the cwd's basename, the branch and its changes, the model, the cache-TTL change points, the events (time, origin kind, admitted or not, reason, queued) and the turns (times, model, four token counts, outcome), and counters. **Never** prompt text, answers, tool inputs, titles, full paths, your name, an email, or stderr. Every string from outside the mod is scanned for credential and email shapes first (a hit is stored as `[redacted:<kind>]` and counted), then cut to one line.
- `reviews/YYYY-Www.json`: the weekly review, append-only: a revision is written on Confirm and on Reopen, never on a click. A confirmed revision freezes each row's seconds, entity, activity and POE flag, your notes and other hours, the method and parameters, the zone, and digests of the mapping and of the week's events, so a later remap or setting change shows as `changed since confirmation` rather than silently moving confirmed hours.
- `bridge-YYYY.ndjson`: every hand-off to rd-tracker (an intent line before each call, the outcome after), the record that prevents a second send.
- `.lock/`: a `mkdir` lock taken for shared-file saves and hand-offs. The code never takes a lock over (two takeovers could both succeed): a lock older than 15 minutes, left by a crashed session, shows in Data health and the Overview offers **Clear stale lock**, which asks first and removes it. Until then saves and hand-offs wait.
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
- the register on the shared fake engine: open-or-continue, `/clear`, resume, month rollover, events written at once, flushes never torn, the sentinel prompt absent from every file, argv, toast, log, state value, drawn pane and export, the views and buttons on terminal, desktop and mobile, options round-trips, and every argv executable on the absolute allowlist.

## What to test

1. Look at the prompt footer: the chip reads `⧗ --` until the first ledger read, then `⧗ ` and today's R&D hours to one decimal (`⧗ 0.0h` on a day with none); it never shows a cut-off `…`, and it shows no cost.
2. Press it: the pane opens on the **Overview** (this week by component, the review queue, spend, deadlines, data health). Press **Session** for this session's hours, tokens, costs, models and agents, and either recommendations or "No recommendations for this session".
3. Press **Sessions** (or type `/rd sessions`): sessions this and last month are listed newest first; press **More** if there are over 40, pick an older one with **Open session…** (it may read "Reading the ledger…" for a moment), check its figures, press **Back**.
4. Type `/rd session` and the first eight characters of a session id from the list: that session opens. Eight characters that match nothing, or two sessions, answer one line and open nothing.
5. Reload the mod with the pane on a picked session: the same session is still shown.

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
- **Where the chip can sit:** the desktop raises only the prompt footer's mode row to plugins, which draws a grey chip; the terminal uses the hint line; VS Code and mobile draw neither, so use `/rd` there.
