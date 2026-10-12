# ADR-001 — Store shape: one JSON segment per session per process, atomic by rename

**Status:** accepted (lead, 2026-10-12). **Context:** the plugin file API has `read`, `write`
(whole file), `list`, `stat`, `exists`; no append, no rename, no lock, a 4 MiB read cap.
Several sessions run at once on the same Mac and must never lose each other's writes.

**Decision (revised by the panel, SEN-1/DBM-2).** Each process that opens a session writes
its own **segment** `sessions/YYYY/MM/<sessionId>.<seg>.json` (`seg` = the open time in
base-36 ms) and is its only writer; a new segment starts at each local month boundary; a hot
reload continues the open segment through `$.state.recordPath`; a resume in a new process
opens a new segment; readers combine a session's segments by id. Every write serializes the
whole segment to a sibling temp file named for the segment and the flush count and renames
it over the final name with `/bin/mv -f -h` by argv after a stat that refuses symlinks
(rename is atomic on APFS). Events are written at once; turns are coalesced for 500 ms. Shared files (`components.json`,
`reviews/*.json`, `bridge.ndjson`, `timezone`) are small and rewritten whole the same way,
under a `mkdir` lock with a `gen` counter in the file, so a concurrent edit is refused,
never overwritten (DBM-7). Aggregates (the week, the month) are computed by reading the session files in
scope with an mtime cache; nothing aggregate is persisted except the export.

**Alternatives rejected.** (a) Monthly NDJSON appended by every session: no append API, so
every write would be a read-modify-write of a growing file under a 4 MiB cap, with
cross-session races on the one file. (b) `$.store`: a single JSON blob under 4 MiB owned by
the plugin runtime, invisible to the person and unsuited to multi-session writes. (c) SQLite
through a subprocess: a dependency the mod cannot ship and a lock discipline the engine's
process API does not give.

**Consequences.** A segment is rewritten on each flush; segments are capped at 8,000 events
and 8,000 turns (about 2 MB, under the 4 MiB read limit) with drop counters; decode keeps
unknown keys and never truncates (DBM-6). Reading a month means listing one
directory and reading changed files; the cache keeps that cheap. A torn temp file is harmless;
a torn final file cannot happen by rename.
