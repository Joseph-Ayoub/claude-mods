# Panel dispositions — rd-ledger spec v1.0 → v1.1 (lead, 2026-10-12)

Five seats read SPEC v1.0 and the lead-owned code independently: senior engineer (SEN,
Opus·xhigh), cybersecurity (CYB, Opus·xhigh), tester (TES, Sonnet·high), data privacy and
legal (PRV, Opus·xhigh), data model (DBM, Opus·xhigh). Every seat said revise-then-build.
Each finding below carries the lead's disposition: **adopted** (in v1.1), **adopted in part**
(with the narrowing stated), **deferred** (a follow-up, named), or **declined** (with the reason).
Three findings were investigated before disposition: SEN-2 (confirmed: `rdt review --json`
takes the repo lock and derives), DBM-3 (confirmed: rd-tracker's hash is sha256 over
canonical JSON of six fields; `a5db146c` reproduced), CYB-6 (`mv -h` exists on macOS).

| Id | Severity | Disposition | Where in v1.1 |
|---|---|---|---|
| SEN-1 | blocker | adopted: segment files, open-or-continue, `recordPath` in state, opened on `classic.SessionStart` | §3.1, §2 |
| SEN-2 | blocker | adopted: no automatic `rdt review`; a Compare button with a disclosure; ADR-003 corrected; read-only JSON is a rd-tracker follow-up | §7, §13 |
| SEN-3 | major | adopted: caps 8,000; byte-size test | §3.1, §11 |
| SEN-4 | major | adopted: one in-flight flush per file, re-flush when dirty, unique temp names | §3.1 |
| SEN-5 | major | adopted: flush beside `next(e)`; readers treat `endedAt` null as last row; temp sweep | §3.1, §3.6 |
| SEN-6 | major | adopted in part: a Select pick applies at once (no Apply button); `draftOtherHours`, `pendingRows`, `draftNotes` in state; §10.1 regenerated from the types | §6.2, §10.1 |
| SEN-7 | major | adopted: the lead freezes `types/index.d.ts` and stub signatures; the lead writes mapping's read side and review's read side so rollup (W1) does not wait on W2 | §10 |
| SEN-8 | major | adopted: `mkdir` lock, intent line before the call, pending on restart → uncertain | §7 |
| SEN-9 | minor | adopted: records open on `classic.SessionStart`; cost at open 0 for startup, first figure otherwise | §3.1 |
| SEN-10 | minor | adopted: record after `next(e)`, no drop; slash-command parity is a live-check item | §4, §12 |
| SEN-11 | minor | adopted: `$.session.repo().root`, `$.fs.stat(resolve)`; `readlink` dropped; git for the branch only | §2 |
| SEN-12 | minor | adopted: TTL change points; 500 ms loss stated; events never batched (see DBM-4) | §3.1, §5 |
| CYB-1 | major | adopted: `sdk` admitted only when the record's surface is `desktop`; `sdk-nested` otherwise; live check with `claude -p` from Bash | §4, §12 |
| CYB-2 | major | adopted: `promptMeta(e)` projection; wider source bans; sentinel corpus covers state, toasts, logs, bridge log, export; `{ command: 'rd' }` matcher | §4, §8, §11 |
| CYB-3 | major | adopted: scan-and-redact at the storage boundary, redaction counts in Data health; export scan as backstop over keys too; engine ids exempt from entropy | §3.1, §8 |
| CYB-4 | major | adopted: `-I`, cwd = store, `safe_load` in the literal, ids filtered | §7 |
| CYB-5 | major | adopted: per-subcommand origin table; `$.ui.ask` exact-label match | §6 |
| CYB-6 | minor | adopted in part: absolute `/bin/mv`, `/bin/rm`, `/usr/bin/git`; `--flag=value` tokens; amounts > 0; the PATH fallback for `rdt` dropped (the venv interpreter is required); project-scope config check declined (defense in depth the engine already provides for command hooks) | §2, §7 |
| CYB-7 | minor | adopted: stat before `mv`, refuse links, `mv -f -h`; §3.6 names the sweep | §3.1, §3.6 |
| CYB-8 | minor | adopted: null-prototype tables, `hasOwn`, `_` rule at the top level only | §3.3 |
| CYB-9 | minor | adopted: pre-tag patterns are `prefix*` globs matched linearly, no regex | §3.3 |
| CYB-10 | minor | adopted: `~`/`root` placeholders, bare manifest names, paths replaced in the bridge log, stderr never stored | §3, §6.4 |
| CYB-11 | minor | adopted for the mod (NFC, `sk_live_`/`rk_live_`/`pk_live_`, `glpat-`, `npm_`, `AIza`); the rd-tracker copy is a follow-up for Joseph | `text.ts`, §13 |
| CYB-12 | minor | adopted: a `scripts/check.sh` runs `validate --json` against an exact allowlist of `$` calls and env reads; in-kit argv recorder | §11 |
| CYB-13 | minor | adopted: text answers carry counts and ids only; export and hand-off read files, never state | §6.1 |
| TES-1 | blocker | adopted: §4.1 determinism rules by rd-tracker line reference | §4.1 |
| TES-2 | major | adopted: three-gap boundary test | §11 |
| TES-3 | blocker | adopted (with SEN-1) | §3.1 |
| TES-4 | major | adopted: `/clear` test; the old record gets `endReason: 'clear'` and is closed | §11 |
| TES-5 | major | adopted (with CYB-2) | §11 |
| TES-6 | major | adopted: behavioral spies in the kit; source greps move to `scripts/check.sh` | §11 |
| TES-7 | major | adopted: lead-owned `hooks/testing/world.ts` and `hooks/fixtures/ground-truth.ts` | §10, §11 |
| TES-8 | major | adopted: failure-path tests listed | §11 |
| TES-9 | major | adopted: `detectZone(intl)` injection; zone tests incl. week-year edges and a sweep | §11 |
| TES-10 | major | adopted: bridge failure matrix; exit 0 with no row id = uncertain, never resent | §7, §11 |
| TES-11 | major | adopted: byte-size test; `eventsDropped` surfaces as a flag | §11, §4 |
| TES-12 | major | adopted: option pairs with one observable each; decision round-trips by reseeding a world | §11 |
| TES-13 | minor | adopted: spec regenerated from the code | — |
| TES-14 | minor | adopted: pre-tag matches any branch seen that day for that repo; first rule wins | §3.3 |
| TES-15 | minor | adopted: F3/F4 replace the vacuous property | §11 |
| TES-16 | minor | adopted: origin list typed from the union; goldens from F1; 10:1 at equality is not heavy | §4, §11 |
| TES-17 | minor | adopted: idempotent arming by token; joined refresh test | §6.7 (was §6.6), §11 |
| PRV-1 | blocker | adopted (with DBM-1): confirmed revisions freeze seconds, entity, method, params, zone, mapping digest, inputs digest; drift flagged; mapping saves logged | §3.4 |
| PRV-2 | blocker | adopted: spend hand-off and `bridgeSpend` removed from v1 | §7, §9 |
| PRV-3 | blocker | adopted: `--poe=1` only with a typed justification for that (component, week) | §6.2, §7 |
| PRV-4 | major | adopted: non-claimable rows export as buckets, no repo/branch names | §6.4 |
| PRV-5 | major | adopted: one note Input per (component, week), ≤ 300, required for POE; `activity_notes.csv` | §6.2, §6.4 |
| PRV-6 | major | adopted: ADR-003 (a) added; label and lag parsed; no start/end unless one block; bridge log exported | ADR-003, §7 |
| PRV-7 | major | adopted: redact in place, counts in the README, never abort | §6.4 |
| PRV-8 | major | adopted: "the store is the record, back it up"; days since last export in Data health; §3.6 names the sweep and the caps | §3.6, §6.1 |
| PRV-9 | minor | adopted: README carries §4 verbatim, the mod version and the sha256 of `union.ts` and `prices.ts`; the dictionary is a tested field list; `monthly_log.txt` | §6.4 |
| PRV-10 | minor | adopted: PROVISIONAL stamps, confirmed and provisional totals apart, `confirmedLagDays` | §6.4 |
| PRV-11 | minor | adopted: salted hash of the root relative to HOME; bridge argv logged with placeholders | §3.1, §3.5 |
| PRV-12 | minor | adopted: `personLabel` option, README header only | §9 |
| PRV-13 | minor | adopted: `2.4h today · ~$38 est.`; superseded 2026-10-12 by `▤ $<engine cost>`, then by `⧗<today's hours>h` (figures only, no names) | §6.5 |
| PRV-14 | minor | adopted: caveats | §6.1 |
| PRV-15 | minor | adopted: fictitious examples; real strings in the pre-publish scan | ADR-006 |
| DBM-1 | blocker | adopted (with PRV-1) | §3.4 |
| DBM-2 | blocker | adopted: segments rolled at the local month; a writer rewrites only its own segment | §3.1 |
| DBM-3 | blocker | adopted: pure sha256 over rd-tracker's canonical input; golden `a5db146c` | §4, `hash.ts` |
| DBM-4 | major | adopted: events written at once; turns batched | §3.1 |
| DBM-5 | major | adopted: `seq` per row; turn key `(turnId, sha8(agentId))` | §3.1 |
| DBM-6 | major | adopted: unknown fields kept in `extra` and written back; caps never truncate on decode; undecodable file → read-only; dropped rows counted | §3.1 |
| DBM-7 | major | adopted: shared-file saves under the `mkdir` lock with a `gen` counter; cache key `(mtimeMs, size)` plus the racy rule | §3.3, §6.7 (was §6.6) |
| DBM-8 | major | adopted: a Select pick writes `key#hash`; a new hash under a bare key raises a row; hash input pinned; root from `$.session.repo()` | §3.3 |
| DBM-9 | major | adopted: plan by destination; hundredths; uncertain on failure; `handedOff` derived; yearly log | §7 |
| DBM-10 | major | adopted: `method.json`; sessions re-encoded and sorted; round-trip test | §6.4 |
| DBM-11 | minor | adopted: revisions only on Confirm and Reopen; strictly increasing rev | §3.4 |
| DBM-12 | minor | adopted: cost at open 0 for startup | §3.1 |

Out-of-lens notes acted on: `parseAddRowId` reads `manual entry <n>` (PRV); rd-tracker's
`excluded` activity type is not a mod row class (DBM; a mapping `nonRd` rule covers it).
