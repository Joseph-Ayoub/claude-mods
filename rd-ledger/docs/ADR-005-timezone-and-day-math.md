# ADR-005 — Timezone frozen at first run; Intl-based day math

**Status:** accepted. **Context:** rd-tracker freezes the methodology zone in
`store/timezone` (exact IANA spelling; `RDT_TZ` is a read-only override). Day totals, week
boundaries and the per-day cap depend on the zone and on DST (23/25-hour days). The plugin
runtime has no Node and no DOM; ECMAScript `Intl` is expected (a kit test proves it).

**Decision.** On first run the mod writes `~/.claude/rd-ledger/timezone`: rd-tracker's
`store/timezone` when the bridge is configured and that file is a valid zone, else
`Intl.DateTimeFormat().resolvedOptions().timeZone`, else `readlink /etc/localtime` parsed to a
zone name, else `UTC` with a visible notice. The file is never rewritten by the mod; a
different detected zone later is reported in Data health, not applied. Local dates and day
bounds come from `Intl.DateTimeFormat` parts; week = ISO week (Monday) of the local date.

**Consequences.** Pure, dependency-free `tz.ts` with DST fixtures for America/New_York
(2026-03-08, 2026-11-01), a half-hour zone and ISO week-year edges. When bridged, the zone is
adopted from rd-tracker's `store/timezone` so both records bucket days identically; the
`timezone` file is never rewritten, and a different detected zone is only reported.
