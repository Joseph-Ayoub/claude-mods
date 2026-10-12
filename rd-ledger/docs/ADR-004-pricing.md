# ADR-004 — Pricing: dated prefix table, raw counts kept, estimates labelled

**Status:** accepted. **Context:** `turn.complete` carries `usage` with four counts
(`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`)
and the model id; the engine does not split cache creation by TTL. The AI Spend Ledger prices
by prefix from `ledger/data/prices.json` (as of 2026-08-28), which predates Opus 5.5 ($4/$20)
and Sonnet/Haiku 5.5; the claude-api skill's table (cached 2026-10-06) is current and gives
per-model cache-read rates (Fable 5.1 $0.25, Opus 5.5 $0.20, Sonnet 5.5 $0.20, others 0.1×).

**Decision.** A bundled table of `[prefix, input, output, cacheRead]` with longer prefixes
first, first match wins, `PRICES_AS_OF = '2026-10-06'`. Cache writes at 1.25× input under the
`5m` assumption (default) or 2× under `1h`; each `classic.PostModelSwitch` adds a dated TTL
change point to the segment and only turns after it are priced by it (SEN-12). Unknown models stay unpriced and named. The
store keeps the raw counts so any later table can be re-applied (reprocessability). Every
dollar figure is drawn and exported as "list-price estimate, not an invoice"; the engine's
own `cost.usd` is shown beside it. Consumption estimates are never spend in rd-tracker's sense
(its spend rows are invoice-backed), so there is no hand-off in v1 (PRV-2); the figure also
excludes the engine's side calls (compaction, titles) and the Spend view says so.

The table (`[prefix, input, output, cacheRead]` $/MTok, as of 2026-10-06):

```
claude-fable-5-1 10 50 0.25 · claude-mythos-5-1 10 50 0.25 · claude-fable-5 10 50 1.00 · claude-mythos 10 50 1.00
claude-opus-5-5 4 20 0.20 · claude-opus-5 5 25 0.50 · claude-opus-4-8 5 25 0.50 · claude-opus-4-7 5 25 0.50
claude-opus-4-6 5 25 0.50 · claude-opus-4-5 5 25 0.50 · claude-opus-4-1 15 75 1.50 · claude-opus-4 15 75 1.50
claude-sonnet-5-5 2 10 0.20 · claude-sonnet-5 2 10 0.20 · claude-sonnet-4-6 3 15 0.30 · claude-sonnet-4-5 3 15 0.30
claude-sonnet-4 3 15 0.30 · claude-3-7-sonnet 3 15 0.30 · claude-3-5-sonnet 3 15 0.30
claude-haiku-5-5 0.10 0.50 0.01 (≤100K-token prompts) · claude-haiku-4-5 1 5 0.10 · claude-3-5-haiku 0.8 4 0.08
claude-3-haiku 0.25 1.25 0.025 · claude-3-opus 15 75 1.50
```

**Consequences.** Figures differ from the AI Spend Ledger's (which reads the TTL split from
transcripts) by the cache-write assumption; the Spend view says which assumption is in force.
The table is refreshed by editing `prices.ts` and bumping the date.
