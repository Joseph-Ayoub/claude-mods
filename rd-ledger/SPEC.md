# rd-ledger — Specification v1.1 (post-panel)

A Claude Code mod (function-hooks plugin) that keeps a **contemporaneous, metadata-only
ledger of R&D engagement time and AI usage** for every Claude Code session it runs in,
shows it in a pane (`/rd`), lets the person map repositories to business components and
confirm each week (`/rd review`), prices usage at published list rates (`/rd spend`), and
exports a CPA-ready hardcopy (`/rd export`). When the person's `rd-tracker` checkout is
configured it bridges to it through `rdt` by argv; standalone users get the mod-owned store.

**Authority inherited, not re-decided:** rd-tracker `docs/SPEC.md` v1.1 (union-of-human-
engagement time model, metadata-only store, per-repo → component mapping with a weekly
review queue, pre-tag plus weekly human confirmation, AI spend quarantined from credit
QREs, estimates always labelled) and `docs/research/irs-rd-credit-compliance.md`
(R1–R46). **Nothing here is tax advice; what is claimed is the CPA's decision.**

**Panel:** v1.0 was reviewed by five seats; every finding and its disposition is in
`docs/PANEL-DISPOSITIONS.md`. v1.1 is the post-panel contract: builders implement it
without re-deciding privacy, data-model or compliance questions. The code contract is
`types/index.d.ts` plus the stub signatures in each `hooks/*.ts`; where this document and
the code disagree, the code is the contract and this document has a bug.

**Evidence base:** plugin API `claude-code.d.ts` build 2.1.295 (CLI 2.1.296 installed);
`mods/mem-gauge`; rd-tracker `rdt/review.py` (`rdt add` 5907-5921 and its output line 5716,
`run_review` takes the repo lock and derives at 5294-5298, so `rdt review --json` is NOT
read-only), `rdt/timeline.py` (apportion 369-394, gap tie 451-469, half-open midnight
522-527, flag date 585, `params_hash` 98-113), `rdt/config.py` 420-440 (gap 1800, floor
60, cap 14400, day flag 14), `rdt/sanitize.py` (deny-list 97-114, emails 118-160, entropy
179-266); the claude-api skill's price table cached 2026-10-06.

---

## 0. Decisions of record and the two left to Joseph

| # | Fork | Decision | ADR |
|---|---|---|---|
| D1 | Store shape | One JSON **segment** file per session per process open, written only by that process, atomically (`/bin/mv -f -h` over a temp file); shared files are small whole-file rewrites under a `mkdir` lock with a `gen` counter | ADR-001 |
| D2 | Human event | `prompt.submit` from the person's own origins, gated by the entrypoint allowlist and, for `sdk`, by the record's surface being `desktop`; every event stored with its verdict | ADR-002 |
| D3 | Bridge | `rdt` by argv; nothing automatic touches rd-tracker; spend hand-off removed from v1 | ADR-003 |
| D4 | Pricing | Bundled dated prefix table, four raw counts kept, cache-write TTL an option with dated change points, every figure labelled an estimate | ADR-004 |
| D5 | Timezone | IANA zone frozen at first run (adopts rd-tracker's `store/timezone` when bridged); `Intl` day math with DST tests | ADR-005 |
| D6 | Distribution | Proposal only; nothing published until Joseph says yes | ADR-006 |
| D7 | UI | One pane with five views sharing one chrome; `/rd`, `/rd session [<id8>]`, `/rd sessions`, `/rd review`, `/rd spend` open it; `/rd export` and `/rd import` are actions | §6 |
| D8 | Hashing | Pure sha256 in `hooks/hash.ts` (method hash parity with rd-tracker, manifest, salted root hash, digests); no `shasum` process | §4, §3 |
| D9 | Method parity | The method string is rd-tracker's exact `union-v2/<sha8>` over its canonical six-field JSON; golden `a5db146c` for the canonical params in `America/New_York` | §4 |

**Left to Joseph:** **J1** distribution repo (ADR-006). **J2** bridge default: `corroborate`
(default until he decides) or `source-of-truth` (ADR-003 states both costs).

---

## 1. Goals, non-goals, tier

**Goals.** (G1) Capture engagement time and API usage as it happens, in the session, reading
no transcript. (G2) Show the week and the month at a glance. (G3) Resolve the unmapped-repo
queue and confirm the week with buttons, a Select and short notes. (G4) Export a Rev. Proc.
98-25-style hardcopy (data dictionary, method record, reprocessable records). (G5) Bridge to
rd-tracker without writing its files. (G6) Be installable from a marketplace.

**Non-goals.** Reading transcripts or prompt text; any network access; computing a credit;
replacing rd-tracker's ingest, narratives, packs or publish; editing rd-tracker's registries
or store; multi-person records; spend rows in rd-tracker (v1).

**Tier:** Full. Panel seats: senior engineer, cybersecurity, tester, data privacy/legal,
data model. Verifier: Opus·xhigh over the combined diff.

---

## 2. Hook surface (verified against the declaration file)

| Hook | Used for | Fields read | Never read |
|---|---|---|---|
| `session.start` | register `/rd`; arm the refresh timer (idempotent by token); freeze the zone on first run; open-or-continue the record (see §3.1) | `cwd`, `surface`, `isInteractive` | — |
| `classic.SessionStart` | open a record for `source` ∈ {`startup`, `resume`, `clear`, `fork`} under `e.session_id` (after `/clear` no `session.start` fires); `compact` is ignored | `session_id`, `source` | `session_title`, `transcript_path`, the rest |
| `prompt.submit` | one engagement event per human submission, recorded after `await next(e)` when the result carries no `drop`; the hook's only use of `e` is `promptMeta(e)` → `{ originKind, isQueued }` | `origin.kind`, `turnId` (presence) | **`text`**, `attachments`, `context`, `wait` |
| `turn.complete` | one usage row per turn, main loop and subagents | `turnId`, `agentId` (hashed), `durationMs`, `reason`, `usage.{model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` | **`answer`**, `refusal` |
| `session.measure` | the engine's cumulative cost (`cost.usd`) | `cost`, `changed` | `context`, `rateLimits` |
| `session.end` | close the record (`endedAt`, `reason`), flushed beside `next(e)` | `reason`, `sessionId` | `resume` |
| `classic.PostModelSwitch` | a dated cache-TTL change point | `cache_ttl` | the rest |
| `command.run` `{ command: 'rd' }` | the commands; `args` parsed as a closed word list | `command`, `args`, `origin.kind` | — |
| `ui.render` `Pane` `rd-ledger` | the pane | — | — |
| `ui.render` `SessionMode` (desktop) / `PromptHint` (terminal) | the footer figure (today's R&D hours) | — | — |

`$` nouns: `session` (`id`, `cwd`, `repo`, `model`, `surfaces`, `usage`), `fs` (`read`, `write`,
`list`, `stat`, `exists`), `process.run` (argv only; the executable is one of `/bin/mv`,
`/bin/rm`, `/bin/mkdir`, `/bin/rmdir`, `/usr/bin/git`, `<rdtRepo>/.venv/bin/python`), `env.get`
(`HOME`, `CLAUDE_CODE_ENTRYPOINT`, `TZ`), `clock` (`now`, `every`, `after`), `ui` (`open`,
`close`, `resolve`, `toast`, `ask`, `log`), `command.register`, `plugin.root` (to hash the mod's
own `union.ts` and `prices.ts` for the export), `state`. **Never:** `$.http`, `$.session.messages`,
`$.session.append`, `$.prompt.*`, `$.model.*`, `$.ui.status`, `$.store`, `$.agent.*`.
`scripts/check.sh` asserts `claude plugin validate --json` reports exactly this call list and
exactly those three env reads.

Engine facts relied on (memory `desktop-plugin-render-sites`, d.ts): the desktop raises
`SessionMode`, `Pane` and the transcript rows, not `PromptHint`; the `SessionMode` strip draws
`Text` and `Button` chips only; `session.start` fires once per process and again on a hot
reload or worker respawn with the same session id; `/clear` and `--resume` change or keep the
id without a `session.start`; `prompt.submit` fires at Enter even mid-turn; a hot reload
cancels pending timers but keeps `$.state`.

---

## 3. Store — `~/.claude/rd-ledger/`

```
~/.claude/rd-ledger/
├── timezone                          # one IANA name, frozen at first run, never rewritten
├── salt                              # 32 hex, written once; salts the root hash
├── components.json                   # the mapping (gen counter; unknown keys preserved)
├── mapping-history.ndjson            # one line per mapping save: at, gen, what changed
├── sessions/YYYY/MM/<sessionId>.<seg>.json   # one segment per session per process open, per local month
├── reviews/YYYY-Www.json             # weekly review: append-only revisions written on Confirm and Reopen only
├── bridge-YYYY.ndjson                # hand-offs: intent lines, outcomes; the idempotency record
├── .lock/                            # mkdir lock for shared-file saves and hand-offs; never taken over by code: a lock older than 15 min is reported and the person clears it
└── export/<YYYY-MM-DDTHHMM>/         # /rd export output
```

`HOME` from `$.env.get('HOME')` must be a plain absolute path (no `..`, no line break);
otherwise the mod runs read-only in memory and the pane says so. Session ids are UUIDs
(validated) before they name a file. The store or a month folder that is itself a symlink is
reported in Data health and never written through.

### 3.1 Session segment (`sessions/YYYY/MM/<sessionId>.<seg>.json`)

A **segment** is opened when a process opens a session (`classic.SessionStart` with source
`startup`, `resume`, `clear` or `fork`, or the first hook that finds no open segment), and a
new one when the local month of a new row differs from the segment's month or when the
encoded segment passes 3 MiB (checked every 250 rows; close reason `size`), so no file nears
the 4 MiB read limit. `seg` is the open
time in base-36 ms. A hot reload or worker respawn continues the open segment through
`$.state.recordPath`; a new process always opens a new segment; two processes resuming one id
write two segments. **A writer rewrites only the segment it opened.** Readers combine a
session's segments by `sessionId`. An undecodable file at `recordPath` is never rewritten: the
mod opens a new segment and counts the old one as unreadable.

```ts
type SessionRecord = {
  v: 1
  sessionId: string; seg: string
  openedAt: number; closedAt: number | null; closeReason: string | null
  source: 'startup' | 'resume' | 'clear' | 'fork' | 'unknown'
  entrypoint: string | null         // CLAUDE_CODE_ENTRYPOINT, ≤ 40
  interactive: boolean; surface: string | null
  repoKey: string | null            // basename of $.session.repo().root (main worktree), or the cwd basename; '~' for HOME, 'root' for /
  repoKind: 'repo' | 'dir'
  rootHash: string | null           // sha256(salt | root relative to HOME).slice(0,12); pinned input, no newline
  cwdBase: string; branch: string | null
  branchChanges: { ts; branch }[]   // ≤ 50
  model: string | null
  cacheTtlChanges: { ts; ttl: '5m' | '1h' }[]   // ≤ 50
  nextSeq: number                   // the next row's seq; monotonic within the segment
  events: EngagementEvent[]         // { seq, ts, origin, admit, reason, queued }; ≤ 8,000
  turns: TurnRecord[]               // { seq, ts, endTs, turnId, agentKey, agent, model, in, out, cr, cw, reason }; ≤ 8,000
  eventsDropped: number; turnsDropped: number; malformedRows: number; redactions: number
  engineCostAtOpen: number | null   // 0 for startup; the first figure seen otherwise
  engineCostUsd: number | null      // latest; own cost = latest − at open
  extra: Record<string, unknown>    // unknown top-level keys, preserved on rewrite
  updatedAt: number
}
```

**Not in it, ever:** prompt or answer text, tool inputs, titles, full paths, user name, email,
stderr. **Boundary discipline:** every string passes `cleanField(kind, value)` = leak scan over
the uncapped value (rd-tracker's `field()` rule: a hit stores `[redacted:<kind>]` and counts a
redaction), then `oneLine` with the field's cap; engine ids that pass a shape check (session
id, turn id) skip the entropy rule. **Identity:** rows carry `seq`; a turn is recorded once per
`(turnId, agentKey)` where `agentKey = sha8(agentId)` or `''`; the row key for any future
importer is `sessionId|seg|seq`.

**Writes.** Events are written at once (human pace). Turns, branch changes and cost figures
mark the segment dirty and a 500 ms `$.clock.after` flushes it. One flush per file is in flight
at a time; a mark during a flush re-flushes after it. A flush serializes the whole segment to
`<final>.tmp.<seg>.<n>` (`n` = the flush count), stats both paths (a link at either refuses
the write), then `/bin/mv -f -h` by argv. `session.end` runs its flush beside `next(e)`
(`Promise.all`) and skips the `mv` when the budget is nearly spent; readers treat
`closedAt: null` as "last row". Up to 500 ms of turn data can be lost on a hot reload; events
cannot. **Decode** never throws, never truncates (caps bound growth only), keeps unknown keys
in `extra`, counts rows it drops as `malformedRows`, and refuses a newer `v` (the file is then
read-only for this build and counted as unreadable).

### 3.2 Hashing (`hooks/hash.ts`)

Pure sha256 (tested against FIPS vectors). Uses: the method hash (§4), `rootHash`
(`sha256(salt + '|' + rootRelativeToHome)`, first 12 hex, no trailing newline), the export
manifest, the mapping and inputs digests. `sha8` (FNV-1a) remains for `agentKey` only.

### 3.3 Mapping (`components.json`)

```json
{
  "v": 1, "gen": 7,
  "_help": "Edit by hand or through /rd review. Top-level keys starting with _ are ignored.",
  "entities":   { "acme": { "name": "Example Co", "filing": "c-corp" } },
  "components": { "acme-app": { "name": "Example App", "entity": "acme", "activity": "direct_research", "poe": true, "rdt": "acme-app" } },
  "repos":      { "example-app#3f9a1c2b7d4e": { "component": "acme-app" },
                  "example-app": { "component": "acme-app" },
                  "scratch": { "ignore": true },
                  "household": { "nonRd": true, "entity": "acme" } },
  "pretag":     [ { "repo": "example-app", "branch": "docs/*", "activity": "non_qualified", "poe": false } ]
}
```

- Ids `^[a-z0-9][a-z0-9-]{0,63}$`; names ≤ 80 after `cleanField`; `activity` ∈
  `direct_research | direct_support | non_qualified`; `filing` ∈ `c-corp | s-corp | schedule-c |
  partnership | other`.
- Tables are null-prototype objects with `Object.hasOwn` lookups (`__proto__`, `constructor`
  and `toString` are ordinary keys). The `_` rule applies to top-level keys only.
- Resolution: `repos[key#hash]` → `repos[key]` → unmapped. A Select pick in Review always
  writes `key#hash` (when the hash is known); a bare key is an explicit "any location" entry
  the person types. A new hash under an already-mapped bare key raises a `new location?`
  queue row rather than resolving silently. `ignore` → `__ignored__`; `nonRd` → the entity's
  `non_qualified` bucket.
- Pre-tag: the first rule whose `repo` equals the row's `repoKey` and whose `branch` glob
  (`prefix*`, literal otherwise, linear match, ≤ 100 chars) matches any branch seen that day
  for that repo; else the component's `activity`/`poe`.
- Unknown keys preserved. First-run seed: `_help`, entity `default`, nothing else.
- Save: under the `mkdir` lock, re-read; refuse when the on-disk `gen` differs from the loaded
  `gen`; write `gen + 1` by temp + `mv`; append one line to `mapping-history.ndjson`.

### 3.4 Weekly review (`reviews/YYYY-Www.json`)

```ts
type ReviewFile = { v: 1; week: string; revisions: ReviewRevision[] }   // rev strictly increasing
type ReviewRevision = {
  rev: number; at: number; kind: 'confirm' | 'reopen'; confirmedAt: number | null
  method: string; params: UnionParams; zone: string
  mappingDigest: string; inputsDigest: string      // sha256 of the mapping file text; sha256 over sorted admitted (ts|sessionId|seg|seq) in the week
  rows: Record<string, ConfirmedRow>               // key `${component}|${date}`; `__unmapped__` and `__ignored__` rows frozen too
  otherHours: Record<string, number | null>        // per entity + `non_business`
  notes: Record<string, string>                    // key `${component}|${week}`, ≤ 300, cleanField'd
  confirmedLagDays: number | null                  // confirmedAt − the week's Sunday, in days
}
type ConfirmedRow = { seconds: number; entity: string; activity: Activity; poe: boolean; source: 'pretag' | 'confirmed' }
```
Drafts (`pendingRows`, `draftNotes`, `draftOtherHours`) live in `$.state`; a revision is
written only by **Confirm** (kind `confirm`) or **Reopen** (kind `reopen`). The rollup compares
live rows with the latest confirmed revision and marks any row whose seconds, entity or
existence differ as `changed since confirmation`; the export and the bridge read the frozen
rows. POE can be on only when the row's (component, week) note is non-empty.

### 3.5 Bridge log (`bridge-YYYY.ndjson`)

One JSON object per line: `{ at, kind: 'intent' | 'sent' | 'uncertain' | 'failed' | 'needs-manual-adjust',
week, rev, date, rdtEntity, rdtComponent, hours, argv, exitCode, rowId, label, lagDays, stdoutLine }`.
`argv` is logged with the interpreter spelled `python` and `<rdtRepo>` as a placeholder; no
stderr is stored. An `intent` line precedes every call; the outcome line follows. An `intent`
with no outcome (a crash) is `uncertain` on the next read and never re-sent.

### 3.6 Retention

The store **is** the record; the export is its hardcopy. Nothing is deleted except temp files
matching `isTmpName`, older than one hour, one `rm -f <absolute path>` each, never recursive.
Growth is bounded by the row caps (counters record drops). Back the store up off this Mac;
Data health shows days since the last export and prompts after each closed month.
§1.6001-1(e) materiality and the 20-year §39 carryforward are the reasons.

---

## 4. Engagement model — union-v2 parity

**Admission (stored per event):**

| Condition | admit | reason |
|---|---|---|
| origin `composer` or `bridge`, entrypoint ∈ {`claude-desktop`, `cli`} | 1 | `human` |
| origin `sdk`, entrypoint `claude-desktop`, record surface `desktop` | 1 | `human-desktop-host` |
| origin `sdk`, entrypoint `claude-desktop`, surface not `desktop` (a `claude -p` child of a desktop session inherits the variable) | 0 | `sdk-nested` |
| origin `sdk` otherwise | 0 | `automation-entrypoint` |
| entrypoint unset | 0 | `entrypoint-unknown` |
| any other origin kind (the `PromptOrigin` union, typed) | 0 | `origin:<kind>` |

Recorded after `await next(e)` only when the result has no `drop`. Slash commands typed by the
person: whether `prompt.submit` fires for them is a live-check item (§12); the README states
the parity gap either way (rd-tracker denies `<command-name` lines).

### 4.1 Determinism rules (rd-tracker parity, by line)

1. Instants keep millisecond precision, as rd-tracker's `instant()`/`elapsed()` keep
   fractional seconds (`timeline.py:309-327`); gaps and spans compare in milliseconds
   against `gapS × 1000` and `maxBlockS × 1000`; block seconds are `floor(span ms / 1000)`.
2. Order admitted events by `(ts, sessionId, seg, seq)`. Nothing collapses: rd-tracker's
   identity includes the ordinal, so two prompts of one session in the same second are two
   events there and here (ruled 2026-10-12 after W1's parity check).
3. Merge while `gap ≤ 1 800 000 ms` (1 800 000 merges, 1 800 001 splits).
4. A chain whose span `> maxBlockS × 1000 ms` splits at its largest gap; ties go to the gap
   nearest the chain's temporal midpoint, then the earlier gap (`timeline.py:451-469`);
   recurse.
5. Block seconds = floor((last − first) / 1000); a single-event block gets `floorS` (60) once,
   before the midnight split.
6. Midnight split: segments `[lo, hi)` half-open, the last closed on its end
   (`timeline.py:522-527`); seconds apportioned by event count with largest remainder, ties to
   the earlier segment (`timeline.py:369-394`).
7. Allocation: block seconds apportioned over its events with the same `apportion`; each
   event's seconds go to its session's `repoKey#rootHash` → component → entity, or to
   `__unmapped__` / `__ignored__` / the entity's `non_qualified` bucket for `nonRd`.
8. Flags, never auto-claimed: `block-over-4h` dated by the chain's first event
   (`timeline.py:585`); `day-over-cap` when a local day exceeds `dayFlagH`; `automation-heavy`
   when denied > 10 × admitted on a day (strictly greater); `rows-dropped` when any segment
   in scope has `eventsDropped > 0`.
9. Method string: `union-v2/` + first 8 hex of sha256 over
   `{"automation_ratio":10,"day_flag_hours":14,"idle_gap_seconds":G,"max_block_seconds":14400,"single_event_floor_seconds":60,"timezone":"<zone>"}`
   with sorted keys and no spaces (`timeline.py:98-113`). Golden: `a5db146c` for G = 1800 and
   `America/New_York`.
10. Integer seconds throughout; rounding once at display; every table's rows sum to its total
    in seconds.

---

## 5. Pricing (ADR-004)

`prices.ts`: `[prefix, input $/MTok, output $/MTok, cacheRead $/MTok]`, longer prefixes first,
first match wins, `PRICES_AS_OF = '2026-10-06'` (table in ADR-004 and the file). Cache writes
at `input × 1.25` under `5m` or `× 2.0` under `1h`: the TTL in force for a turn is the latest
change point at or before it in the turn's segment, else the `cacheTtl` option. Unknown model →
tokens kept, unpriced, named. Every figure reads "list-price estimate, not an invoice"; the
engine's own `cost.usd` (own cost per segment) is shown beside it as "engine /cost figure".
The estimate excludes the engine's side calls (compaction, titles) and says so.

---

## 6. Commands, pane, footer

**Origins.** The person's own origins are `composer`, `bridge`, and `sdk` when the session's
record surface is `desktop`. Views open only for them; every other origin gets one summary line of counts, headless or not.
Export, import and hand-off run only for them and only when `interactive` or surface
`desktop`. Every `$.ui.ask` proceeds only on an exact match of its affirmative label; a
dismissal or any other answer cancels. Text answers (headless or non-person) carry counts,
hours and validated ids only, never repo keys or branch names.

### 6.1 `/rd` (Overview)

1. **This week** (`Mon DD – Sun DD · <zone> · union-v2/<hash>`): components with entity, hours,
   status (`pretag` / `confirmed` / `changed since confirmation`); `__unmapped__` and
   `__ignored__` last; total; today.
2. **Queue:** "N repositories unmapped (H.H h)" and **Review** (`v`).
3. **Review status:** this week and last; bridge mode; rd-tracker reachability.
4. **Spend this month:** total estimate, top three models, the estimate label; **Spend** (`s`).
5. **Deadlines** (calendar tax year; "verify with your CPA"): per entity `filing`: C-corp 1120
   Apr 15 / ext Oct 15; S-corp 1120-S Mar 15 / ext Sep 15; Schedule C with 1040 Apr 15 / ext
   Oct 15; partnership 1065 Mar 15 / ext Sep 15; the next weekly review (Monday); "Form 6765
   Section G applies to tax years beginning after 2025 unless an exemption applies (R40, R41)".
6. **Data health:** sessions and segments in scope, unreadable files, denied events by reason,
   redactions, dropped rows, zone (and a different detected zone), price-table date, days since
   the last export, store symlink warning, a stale store lock (with the **Clear stale lock**
   button, `l`), bridge status.
7. **Session** (`i`), **Sessions** (`a`), **Overview** (`o`), **Review** (`v`), **Spend** (`s`),
   **Refresh** (`r`), **Export** (`e`), **Close** (`c`, Esc).

### 6.1a `/rd session [<id8>]` (Session)

One renderer (`sessionText` in `report.ts`) for this process's session (`/rd session`, the
**Session** button `i`) and for a selected one (`/rd session <id8>`, the
Sessions picker): the header (id8, opened local time, repository key, entrypoint, segments);
engaged hours (union-v2 over that session's own admitted events with the rollup's params),
prompts, main and agent turns; the four token counts and the cache-hit ratio
`cr / (in + cr + cw)`; the engine `/cost` figure beside the list-price estimate labelled
`est.` (unpriced turns are counted and named, never guessed); a by-model table (at most 8
models, the rest folded into one "N other models" row); an agents table (the main loop, then
up to 12 subagents by estimate, the rest folded into one "N others" row: turns, most-used
model, tokens, estimate, share of the session's estimate); then **Recommendations** or "No
recommendations for this session". A selected session shows **Back** to the list.

The engine figure is `engineCostUsd` of the session's latest segment (the engine's running
total for its most recent process, the number `/cost` prints there), less the first segment's
`engineCostAtOpen` when that segment's `source` is `clear` or `fork`, so a cleared or forked
predecessor's cost is never counted (`sessionEngineUsd` in `rollup.ts`, the one place
this view and the Sessions rows take it from). An earlier process of a resumed session is not
included (its figure stays in its own segment and the export); a segment opened at a month
boundary carries its process's figure over (register.tsx's rollover copies `engineCostUsd`), so
it never reads `$--` for that reason.

`<id8>` is exactly eight hex characters matched against the start of every session id in
scope: one match opens it; none or several answer one line (the several listed by full id)
and nothing opens; any other word answers the usage line. Only the newest 300 rows are
matched, and a miss says so ("none of the newest 300 sessions this or last month starts with
<id8>").

**Recommendations** (`rollup.ts`, one pure function per code; every figure a list-price
estimate; one plain sentence ending "(estimate)" where a figure appears). A turn is *paused*
when it began more than 5 minutes after the previous turn of the same `agentKey` ended. Per
chain (same `agentKey`, by ts), `maxCtx(i)` = the largest `cr + cw` of any earlier turn of that
chain: the most a longer TTL could have kept cached for turn `i`. Both cache rules require every
turn of the session to share one TTL (`ttlAt` per turn, else the option); when it changed
mid-session neither fires. `inp` and `rd` are the turn's model's input and cache-read prices.
The rule sentences state the assumption ("assuming the paused turns re-wrote their context").

| Code | When | Figure |
|---|---|---|
| `cache-ttl-1h` | TTL 5m throughout and ≥ 30 % of turns paused | Σ_paused min(cw, maxCtx) × (1.25 · inp − rd) − Σ_not paused cw × 0.75 · inp, shown only above $0.50 |
| `cache-ttl-5m` | TTL 1h throughout and < 10 % of turns paused | Σ_all cw × 0.75 · inp − Σ_paused cr × (1.25 · inp − rd) (each paused turn would re-write everything it read; a read is already bounded by the cache that existed), above $0.50 |
| `agent-tier` | a subagent with ≥ 15 turns whose most-used model is Opus- or Fable-tier (Mythos is priced as Fable), median output < 400 tokens, ≥ 20 % of the session's estimate | its estimate against the same tokens at `claude-sonnet-5-5` prices |
| `context-size` | ≥ 20 main-loop turns with median cache read ≥ 150 000 tokens | the main loop's cache-read cost; suggests /compact or a fresh session |
| `errored-turns` | ≥ 3 turns with reason `error` | their estimate |
| `cost-per-hour` | ≥ 0.25 h engaged, ≥ 5 sessions in scope, estimate per engaged hour ≥ 2 × the median over sessions with ≥ 0.25 h | the excess over the median rate |

### 6.1b `/rd sessions` (Sessions, the global ledger)

Every session in scope (this and last month; the rollup keeps the newest 300 as compact
`SessionRow`s), newest first: date, id8, repository (cut to 18), engaged hours, turns,
subagents, cost (the engine figure, else `~` and the estimate), recommendation count; the
median estimate per engaged hour above the table. The persisted `sessionsShown` (40, +40 per
**More** `m`, at most 300) sets both the rows listed and the picker's options; past it the
trailing line reads "N more — press More or /rd session <id8>". On the terminal and desktop an
**Open session…** `Select` opens a row in the Session view; mobile lists the rows with the
command hint. **Sessions** button `a`.

**State size.** Full `SessionSummary`s live in `Rollup.details` only for this session, the
selected one and the newest 40 rows. Picking a row outside them (the picker or
`/rd session <id8>`) sets `selectedSession` and refreshes (`RollupInput.selected`); the Session
view reads "Reading the ledger…" until it lands. A selection no longer among the newest 300
reads "That session is no longer among the newest 300 this or last month." The rollup atom is
shape-tagged, so a reload drops an older build's rollup instead of drawing one without these
fields (the views draw "Reading the ledger…" for such a value).

Both views are addressable (`/rd session`, `/rd session <id8>`, `/rd sessions`) and persist:
`view` and `selectedSession` live in `$.state`, so a reload draws the same view. A text answer
(headless) carries the same tables without the repository column or key (CYB-13).


### 6.2 `/rd review` (Review)

- **Unmapped repositories:** one row per `repoKey#hash` seen this week (hours, branches seen,
  `new location?` marker); a `Select` whose options are the components, `Ignore`, and
  `Non-R&D → <entity>` for each entity; a pick writes the mapping at once and recomputes.
- **Week rows:** per (component, date): hours, status, buttons **Research** / **Support** /
  **Non-R&D** / **POE on|off** (POE on refused with a toast until the note exists).
- **Notes:** one `Input` per (component, week): what was done, what was uncertain, what was
  tried (≤ 300). Required before POE.
- **Other hours:** one `Input` per entity and `non_business` (0–168; blank = not entered).
- **rd-tracker:** a **Compare** button (bridge present, mode not `off`) that runs
  `rdt review --json --week=<monday>` after a confirmation dialog stating that rd-tracker
  re-derives the week's proposals; the result shows rd-tracker's Claude Code hours per day
  (sum of `sessions[]` seconds where `harness` is `claude_code`) beside the mod's, rows over
  10 % apart marked. Never runs on open or refresh.
- **Confirm week** (`k`) writes a `confirm` revision; **Reopen** writes a `reopen` revision;
  under `source-of-truth`, Confirm asks once more and then hands off (§7).
- Mobile has no `Select`/`Input`: the view lists rows and says to use the terminal or desktop.

### 6.3 `/rd spend` (Spend)

This month and last: by model (turns, four token counts, estimate), by component and entity,
sessions, the engine figure, the TTL assumption per month, the price-table date.

### 6.4 `/rd export [YYYY | YYYY-MM]`

Confirms the folder, then writes (every cell `cleanField`-redacted in place, never aborting;
redaction counts by file and kind in the README):

| File | Content |
|---|---|
| `README.md` | caveat header; person (the `personLabel` option, else "not recorded — add on cover sheet"); data dictionary from `DICTIONARY` in `exporter.ts` (a test asserts every `SessionRecord`, event and turn field is listed); §4 and §4.1 verbatim; the admission table; the mod version and sha256 of `hooks/union.ts` and `hooks/prices.ts`; the retention note; redaction counts; PROVISIONAL stamp when any week in scope is open |
| `method.json` | params, zone, method string, admission version, price table + as-of, TTL option, rounding and scope rules, mod version, generated-at, unreadable count |
| `events.csv` | date, ts ISO with offset, sessionId, seg, seq, bucket-or-repoKey, rootHash (claimable rows only), branch (claimable rows only), origin, admit, reason, queued |
| `blocks.csv` | date, start, end, seconds, eventCount, method, flags |
| `allocations.csv` | date, blockStart, sessionId, bucket-or-component, entity, seconds, activity, poe, status (`confirmed` / `provisional` / `changed`), rev |
| `hours_by_component.csv` | week, component, entity, confirmedSeconds, liveSeconds, activity, poe, status, rev, confirmedLagDays |
| `activity_notes.csv` | week, component, note |
| `turns.csv` | ts, endTs, sessionId, seg, seq, agent, model, input, output, cacheRead, cacheWrite, ttl, estUsd, priced |
| `spend_by_month.csv` | month, model, bucket-or-component, entity, turns, tokens, estUsd, label `ESTIMATE list price, not an invoice` |
| `monthly_log.txt` | per month: per day blocks and hours by component, page-numbered (66 lines) |
| `reviews.json`, `components.json`, `bridge.ndjson` | copies (the bridge log for the scope year) |
| `sessions.ndjson` | every segment in scope, decoded, re-encoded, sorted by (sessionId, seg) |
| `MANIFEST.sha256` | `<sha256>  <bare file name>` per file |

Non-claimable rows (`__unmapped__`, `__ignored__`, `nonRd`, `non_qualified`) show the bucket
name in place of `repoKey`, `rootHash` and `branch` (PRV-4). Scope: segments whose rows fall in
the period (a segment crossing the boundary contributes only the rows inside it). CSV cells
via `csvCell`. Export reads the files, never `$.state`.

### 6.5 Footer

Desktop `SessionMode`: one `Button` chip `⧗2.4h`: the mark U+29D7 BLACK HOURGLASS (a
monochrome mathematical symbol, not an emoji; the emoji hourglass is U+231B), a space, and
today's recorded R&D hours with one decimal: `Rollup.todayS` (seconds of engaged union time
admitted today, local day, the figure the Overview's "today" line shows) divided by 3600.
Before the rollup exists the label is `⧗--`; a negative or non-finite figure reads `⧗0.0h`;
from 9999.95 hours a floor `⧗9999h+`, never a clipped number. The label is at most 10
characters, so the strip never clips it, and the mod never truncates it. It carries no cost:
the usage-gauge mod owns the session cost in the footer (`Rollup.engineUsd` stays, for the
Session view). One helper, `footerLabel(todayS)` in `report.ts`, draws it for both surfaces.
Pressing it opens the pane on the Overview (§6.1), the R&D tax ledger; the Session view is one
press away (the **Session** button `i`, `/rd session`). `footerButton` off → the same label as
dim `Text`. Terminal `PromptHint`: the same label as a plain pressable `Button` after the
engine's line, opening the Overview too. The figure comes from `$.state.rollup` (refreshed
after each own turn and on the timer), never computed while drawing.

### 6.6 Rollup and refresh

`rollup.ts` is pure: `computeRollup(input)` over decoded segments. The register keeps a cache
`path → { record, mtimeMs, size }` and re-reads a file when `(mtimeMs, size)` changed or when
`mtimeMs ≥ lastReadAt − 1` (the racy rule). Scope: this and last month's folders plus, for the
week view, the week's days. Refresh runs on `session.start` (after 0 ms), every
`refreshMinutes`, after each own main-loop turn (debounced 5 s), on pane open when older than
60 s, and on **Refresh**; never overlapping (joined); arming is idempotent by a token in state.

---

## 7. Bridge to rd-tracker (ADR-003)

**Discovery:** `rdtRepo` option (absolute, plain). Present when `<rdtRepo>/rdt/__init__.py`,
`<rdtRepo>/registries/components.yaml` and `<rdtRepo>/.venv/bin/python` exist (no PATH
fallback). Every call: `[<rdtRepo>/.venv/bin/python, '-I', '-m', 'rdt', <sub>, '--flag=value', …]`,
`cwd = rdtRepo`, 60 s timeout, env untouched; stdout through `oneLine(…, 200)`; stderr never
stored. Allowed subcommands: `add`, `review` (with `--json`, `--week=`, only from the Compare
button). Never `publish`, `ingest`, `spend`, `review --answers`, never git, never a store file.

| Mode | On Confirm | Compare button | Notes |
|---|---|---|---|
| `off` | nothing | hidden | — |
| `corroborate` (default pending J2) | nothing | shown | nothing is written into rd-tracker |
| `source-of-truth` | `rdt add` per destination `(date, rdtEntity, rdtComponent)` with hours > 0 from the **frozen** rows, planned against the bridge log | shown | see the cost paragraph |

**Hand-off plan** (`planHandoff`): destination key `(date, rdtEntity, rdtComponent ?? '')`;
target hours in whole hundredths; a destination with a `sent` line at the same hundredths is
skipped; a different amount → `needs-manual-adjust` (never a second `add`); any `uncertain`
blocks the destination until the person clears it in the log. Execution: take the `.lock`
(`mkdir`; a lock is never taken over by code, since two takeovers can both succeed: one
older than 15 minutes is shown in Data health and the Overview offers **Clear stale lock**,
confirmed, one `rmdir`), at most 12 destinations per Confirm and at most 10 minutes of
sending (the rest on the next Confirm), each: re-read the log and
re-plan that destination (a line another session wrote meanwhile stops it), write the
`intent` line by re-reading and appending (never from a snapshot), run, then `sent` (exit 0
and a parsed `manual entry <n>` line), `uncertain` (exit 0 with no row id, a timeout, a
rejection) or `failed` (non-zero exit; retried on the next Confirm). A `needs-manual-adjust`
line is written once per (destination, amount), under the lock, before the question and
whether or not anything is sent, so the discrepancy is on record even when nothing new goes. `--poe=1` only when the revision carries
a note for that (component, week); the note is passed as `--note=<provenance line> — <note>`.
`--start`/`--end` only when the destination's seconds come from one block. The label and lag
from rdt's line are stored; `reconstructed` is drawn in red.

**Registry import** (`/rd import`, and a button in Review): `[python, '-I', '-c', IMPORT_PROGRAM,
<entities.yaml>, <components.yaml>]` with `cwd` = the store folder; the literal program imports
`json`, `sys` and `yaml`, calls `yaml.safe_load` on the two paths given, prints
`{entities: {id: {name, filing?}}, components: {id: {name, entity}}}`; the mod keeps ids
passing `isId`, names through `cleanField`, merges without overwriting, sets `rdt` = id.

**Costs of `source-of-truth`, stated plainly (ADR-003):** (a) rd-tracker's nightly ingest still
parses Claude Code transcripts into blocks, and manual entries are a separate stream added on
top; excluding Claude Code from the nightly run (`rdt ingest --source …`) removes that but a
Codex or OpenCode block overlapping the same minutes still counts twice; (b) rd-tracker labels
a manual entry `reconstructed` when its week is already confirmed there, so the order of the
two confirmations decides claimability; (c) the entries lose rd-tracker's event-level audit.
The right form is a `claude_code_live` source parser in rd-tracker (§13).

---

## 8. Threat model and privacy

| Threat | Control | Test |
|---|---|---|
| Prompt or answer text reaches anything | `promptMeta(e)` is the hook's only use of `e`; `scripts/check.sh` bans `e.text`, `e.answer`, `...e`, `JSON.stringify(e`, `['text']`, `session.messages`, `$.http`; the sentinel test feeds `SNTL-7f3a9c e@x.test ghp_<40>` through every origin with attachments and context, and asserts it is absent from every `fs.write`, every argv, every toast and log, every `state.set` value, the drawn pane, the bridge log and an export | T-P1..P4 |
| Data leaves the Mac | no `$.http`; argv executables fixed to an absolute allowlist; in-kit recorder asserts every argv[0], git only `rev-parse`, rdt only `add`/`review`, python only `-I -c IMPORT_PROGRAM` or `-I -m rdt` | T-P4 |
| Hostile text (branch, repo, model, mapping name, rdt stdout) forges rows or toasts | `cleanField` at the boundary (scan + redact + one line + cap), NFC-normalized | T-S1 |
| Argument injection | argv only; ids by regex; numbers formatted; `--flag=value` single tokens; notes are a fixed provenance plus the person's cleaned note | T-S2 |
| Automation counted as human | entrypoint allowlist plus the `desktop` surface requirement for `sdk`; live check with `claude -p` from Bash | T-A1 |
| Export leaks a credential or an email | redaction at the boundary and again at export; counts in the README | T-S3 |
| CSV formula injection | `csvCell` | T-S4 |
| A peer, schedule or plugin pulls data into a transcript or runs an action | per-subcommand origin table; counts-only text answers | T-S5 |
| Store corruption on crash | temp + `mv -f -h`; stat refuses links; unreadable files counted, never rewritten | T-D1 |
| Lost or duplicated writes across sessions | segments per process; shared files under the `mkdir` lock with `gen` | T-D2 |
| Confirmed hours drift | frozen rows and digests; drift flagged, frozen rows exported | T-D6 |
| Mapping keys collide with object members | null-prototype tables | T-S6 |
| Pre-tag pattern stalls | linear glob, no regex | T-S7 |
| The mod acts on text found in data | it reads no transcript; every file string is a value; no `$.prompt.submit`, no `$.command.run` | T-P5 |
| Python import runs foreign code | `-I`, cwd = store, `safe_load` literal | T-S8 |
| Timezone or pricing drift | frozen zone; dated table; raw counts kept; detected zone reported | T-D4, T-D5 |

Data minimization: session id, segment, sequence numbers, repo and cwd basenames (`~`/`root`
placeholders), branch, model id, origin kind, entrypoint word, timestamps, token counts,
salted root hash. No user name, email, path, title, or stderr.

---

## 9. Options (`userConfig`, persisted by the engine under `pluginConfigs`)

| Option | Type | Default | Observable (the test pair) |
|---|---|---|---|
| `footerButton` | boolean | true | Button vs Text (`⧗<hours>h`) in the footer |
| `refreshMinutes` | number 1–60 | 5 | refresh count after advancing N minutes |
| `idleGapMinutes` | number 5–120 | 30 | the merge result and the method hash |
| `cacheTtl` | `5m` / `1h` | `5m` | ×1.25 vs ×2.0 |
| `rdtRepo` | string | `` | bridge discovery argv and the Compare button |
| `bridgeMode` | `corroborate` / `source-of-truth` / `off` | `corroborate` | Confirm's hand-off and the Compare button |
| `personLabel` | string | `` | the export README header |

(`bridgeSpend` was removed with the spend hand-off, PRV-2.)

Out-of-range or non-numeric values fall back to the default (clamped). Decisions persist in
files; a test reseeds a fresh world with the first world's files and asserts identical state.

---

## 10. Module layout, ownership and contracts

```
mods/rd-ledger/
├── .claude-plugin/plugin.json          (lead)
├── hooks/hooks.json                    (lead)
├── hooks/register.tsx                  every function that touches `$`; JSX; wiring        (W3)
├── hooks/text.ts                       oneLine, ids, cleanField, csvCell, leak scan, sha8 (lead)
├── hooks/hash.ts                       sha256, hex                                          (lead)
├── hooks/store.ts                      records, updaters, decode/encode, paths              (lead)
├── hooks/mapping.ts                    read side (lead); load/validate/save/import (W2)
├── hooks/review.ts                     read side (lead); confirm/reopen/notes/drafts (W2)
├── hooks/tz.ts                         zone math                                            (W1)
├── hooks/union.ts                      union-v2, apportion, flags, method                  (W1)
├── hooks/prices.ts                     table, priceTurn, spend rows                         (W1)
├── hooks/rollup.ts                     computeRollup, summarizeSessions, recommendation rules (W1)
├── hooks/report.ts                     text answers, footer label, session views, log pages (W3)
├── hooks/exporter.ts                   export file set, DICTIONARY, method.json             (W3)
├── hooks/bridge.ts                     discovery, argv, plan, log, parsers                  (W4)
├── hooks/testing/world.ts              the shared fake engine beneath the plugin            (lead)
├── hooks/fixtures/ground-truth.ts      F1–F4 events and expected tables                     (lead)
├── hooks/*.test.ts                     per module; register.test.ts (W3 + W5)
├── scripts/check.sh                    validate --json allowlist + source bans              (lead)
├── types/index.d.ts                    the contract                                         (lead)
├── SPEC.md, docs/, README.md
```

Rule from mem-gauge: `$` is handed only to functions declared at the top level of
`register.tsx`; every other module is pure. The exported names and signatures in each stub are
the contract (`// CONTRACT` marks them); a builder who needs more adds a new export and says
so in its return; it never changes a marked signature or a lead-owned file.

The `$.state` contract is `types/index.d.ts` → `PluginState['rd-ledger']` (the single
source; not restated here).

---

## 11. Tests (every workstream; the verifier re-runs all)

1. **Ground truth F1** (`fixtures/ground-truth.ts`, from the tester seat): 19 admitted and 2
   denied events, 3 sessions, 2 days in `America/New_York`; expected 6 blocks, 11 allocations,
   per-day and per-component seconds asserted exactly; the hand arithmetic is in the fixture
   file. **F2** gap-tie probe (midpoint rule → 14400). **F3** spring-forward 2026-03-08 and
   **F4** fall-back 2026-11-01 with their expected blocks and `dayBounds` lengths.
2. **Admission:** every origin kind (typed from the union) × entrypoint × surface.
3. **Union:** gaps 1 799 999 / 1 800 000 / 1 800 001 ms from any sub-second offset; the cap
   split; same-second events of one session both count; apportion sums; F3/F4; the
   `rows-dropped` flag; 10:1 at equality not flagged, 11:1 flagged.
4. **Pricing:** every row; `claude-opus-5-5` not priced by the `claude-opus-5` row; unknown;
   both multipliers; a TTL change point mid-segment prices later turns only.
5. **Method hash:** golden `a5db146c`; changes with the gap and the zone.
6. **Hash:** sha256 FIPS vectors (`abc`, empty, the 56-char string).
7. **Timezone:** `detectZone(intl)` with Intl absent and throwing; `isZone('Nope/Zone')`;
   ISO week edges 2025-12-29 → 2026-W01, 2027-01-01 → 2026-W53, 2027-01-04 → 2027-W01; a
   sweep over 2026 in New York (86400 except 82800 on 03-08 and 90000 on 11-01); Asia/Kolkata.
8. **Mapping:** `key#hash` outranks `key`; new hash under a bare key → queue row; `ignore`;
   `nonRd`; glob pre-tag; `__proto__`/`constructor`/`_scratch` keys; unknown keys preserved;
   `gen` mismatch refused; import merge never overwrites.
9. **Review:** drafts in state; Confirm freezes seconds/entity/digests; Reopen; strictly
   increasing rev; a repeated rev refused on decode; POE refused without a note; other hours
   validated; drift flagged after a remap.
10. **Kit (`register.test.ts`, on the shared world):** open-or-continue (double `session.start`
    keeps rows; a corrupt file at `recordPath` → zero `mv`, new segment); `/clear` closes the old
    segment with `closeReason: 'clear'` and opens a new one; resume in a new process → a second
    segment; month rollover at 23:59:59.999; events written at once and the turn flush
    coalesced; two flushes back to back → one whole file; `mv` exit 1 keeps dirty and backs off;
    `session.end` with a held `mv` (timeout ≥ 12 s); the sentinel corpus; `/rd` per origin
    placed/unplaced/headless; the five views and every button; Select pick writes `key#hash`;
    export writes every file and the manifest verifies against the in-memory sha256; a planted
    `ghp_` branch becomes `[redacted:github-token]` in the export, never a refusal; footer per
    surface and with the option off; `$.ui.status` never called; refresh joined; arming
    idempotent across a second `session.start`; option pairs (§9); decision round-trips;
    `/rd session`, `/rd sessions`, `/rd session <id8>` (one, none, several, malformed); the
    Sessions picker and Back; the view and selected session persisting across a fresh register.
14. **Sessions (`sessions.test.ts`):** a two-segment fixture with hand-worked engaged seconds,
    tokens, estimate, engine figure, models and agent shares; an all-unpriced session reads
    null; the TTL change point; each recommendation rule positive and negative. The footer label is tested in `report.test.ts` (`--`, 0.0h, a negative or
    non-finite figure, the 10-character bound) and the chip press in `register.test.ts`.
11. **Bridge:** argv exact for add/review/import (`-I`, `safe_load` literal, `--flag=value`);
    refused on bad ids or non-positive hours; `corroborate` never calls `add`; the hand-off
    matrix (exit 2 → failed and retried; exit 0 without a row id → uncertain, never resent;
    rejection/timeout → uncertain; five adds with the third failing → two sent; re-confirm sends
    the remaining; Confirm twice while held → one argv); `review --json` fixture and garbage;
    label and lag parsed; a renamed component with the same rdt id is not re-sent.
12. **Byte size:** a segment at both row caps with every field at its cap in multibyte text is
    the worst case and exceeds 3 MiB, which is why the size rollover exists: the test asserts the
    segment reports oversize at the first 250-row boundary past 3 MiB and that the segment just
    before that boundary is under 4 MiB; a 4 MiB+ file is counted unreadable and never rewritten.
13. **`scripts/check.sh`:** `claude plugin validate --json` calls and env reads equal the
    allowlist; source bans; `claude plugin test` green.

---

## 12. Live check (lead, after the verifier)

Load through this session's dev-mods folder (Joseph's one-time "Enable for this session"
answer), then: `/rd` draws; a typed prompt adds one admitted event (observed `origin.kind`
and entrypoint recorded in the README's "verified on" line); a `claude -p hi` run from Bash
adds nothing admitted (`sdk-nested` or no event); whether a typed slash command raises
`prompt.submit`; `turn.complete` rows with the model and the four counts; `/rd review` maps
this repo (`key#hash` written) and confirms the week; the segment file holds only schema
fields (grep for the typed prompt text returns nothing); `/rd export` writes the files and
`shasum -c MANIFEST.sha256` passes; the footer chip is visible; a `/clear` opens a new segment.

---

## 13. rd-tracker follow-ups (proposed, not built; need Joseph's OK)

- A read-only `rdt review --json` path (no derive, no lock), so Compare needs no disclosure.
- A `claude_code_live` source parser ingesting `sessions.ndjson` (row key `sessionId|seg|seq`,
  admission `human-live`), making `source-of-truth` first-class.
- The extra credential shapes (`sk_live_`, `rk_live_`, `pk_live_`, `glpat-`, `npm_`, `AIza`) and
  NFC normalization in `rdt/sanitize.py`.
- The `sdk-nested` gap: a `claude -p` child of a desktop session carries `entrypoint:
  claude-desktop` in its transcript too.
