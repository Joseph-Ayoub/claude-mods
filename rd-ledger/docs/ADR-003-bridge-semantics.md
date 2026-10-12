# ADR-003 — Bridge to rd-tracker: `rdt` subprocess calls; corroborate by default

**Status:** accepted for the mechanism; the default mode is Joseph's (J2). **Context (verified
in rd-tracker's code):** there is no file import path. Rows enter the store from outside the
nightly parser only through `rdt add` (manual_entries) and `rdt spend` (spend), both in
`rdt/review.py`. Manual entries are a separate stream never merged into union blocks
(`add_manual_entry`, SPEC §6.8), so a manual entry for a day the nightly parse also covers is
counted twice. `rdt review --json` prints a week's state, but it is NOT read-only: `run_review` takes the
repo lock and derives the week's proposals before printing (`review.py:5294-5298`; panel SEN-2).

**Decision.** The bridge is `rdt` by argv, never a file written into rd-tracker. Three modes:
`off`; `corroborate` (the mod writes nothing; a **Compare** button in Review runs
`rdt review --json` only after a dialog saying that rd-tracker re-derives the open week, and
shows its Claude Code hours per day beside the mod's); `source-of-truth` (Confirm week runs
`rdt add` once per destination `(date, rdt entity, rdt component)` from the frozen rows,
planned against the yearly bridge log under a `mkdir` lock with an intent line before each
call; a changed amount is logged `needs-manual-adjust`, never sent twice, because rd-tracker
has no update command; a process-of-experimentation flag is sent only with the person's typed
justification). **Spend hand-off is removed from v1** (PRV-2): rd-tracker's spend rows are
invoice-backed and list-price consumption is an estimate; it stays in the export, labelled.

**Recommendation to Joseph.** Default `corroborate`. `source-of-truth` costs (PRV-6):
(a) double counting unless the nightly ingest excludes Claude Code (`rdt ingest --source …`
without `claude_code`), and even then a Codex or OpenCode block overlapping the same minutes
counts twice because manual entries are never merged into blocks; (b) rd-tracker labels a
manual entry `reconstructed` when its week is already confirmed there, so the order of the two
confirmations decides claimability; (c) event-level audit (admission verdicts, blocks) is lost. The right long-term form of source-of-truth is a `claude_code_live` source
parser in rd-tracker that ingests the mod's `sessions.ndjson` (SPEC §13), which is a
rd-tracker change and needs his OK.

**Consequences.** The mod never reads `store/state.db`, never runs `git`, `publish`, `ingest`,
`spend` or `review --answers`; the only rd-tracker files it reads are the two registry YAMLs,
through the venv interpreter with `-I` and a fixed `safe_load` program by argv, for the id
import. Nothing runs against rd-tracker on open, refresh or a timer.
