// usage-gauge: list-price estimates for the pane's per-model rows. Pure.
//
// The table, the as-of date, the cache-write multiplier and the first-prefix
// rule are copied from mods/rd-ledger/hooks/prices.ts (prices as of
// 2026-10-06). Mods are independent plugin folders, so this is a copy, not an
// import: change both together. The headline cost is never priced here; it is
// the engine's own ledger (`cost.usd`).

/** `[prefix, input $/MTok, output $/MTok, cacheRead $/MTok]`, longer prefixes first, first match wins. */
export const PRICES: readonly (readonly [string, number, number, number])[] = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1.0],
  ['claude-mythos', 10, 50, 1.0],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4-1', 15, 75, 1.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3],
  ['claude-sonnet-4-5', 3, 15, 0.3],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-3-7-sonnet', 3, 15, 0.3],
  ['claude-3-5-sonnet', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1],
  ['claude-3-5-haiku', 0.8, 4, 0.08],
  ['claude-3-haiku', 0.25, 1.25, 0.025],
  ['claude-3-opus', 15, 75, 1.5],
]
export const PRICES_AS_OF = '2026-10-06'
/**
 * The engine reports cache writes without their TTL, so every write is priced
 * at the 5-minute rate (1.25x input); a 1-hour write (2x) reads low.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25

export type PriceRow = { prefix: string; input: number; output: number; cacheRead: number }

/**
 * The price row for a model id (first prefix match), or null. The prefix must
 * end the id or be followed by a character that is not a letter or digit
 * (`-`, `[`, `@`, `.`), so `claude-opus-50` is unknown rather than priced as
 * `claude-opus-5`: an unknown model reads `--`, never a guess.
 */
export const priceRow = (model: string | null): PriceRow | null => {
  if (typeof model !== 'string' || model.length === 0) return null
  for (const [prefix, input, output, cacheRead] of PRICES) {
    if (!model.startsWith(prefix)) continue
    const next = model.charAt(prefix.length)
    if (next === '' || !/[A-Za-z0-9]/.test(next)) return { prefix, input, output, cacheRead }
  }
  return null
}

const tokens = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** What `counts` cost at list price for `model`, in USD; null for a model the table does not know. */
export const estimateUsd = (model: string | null, counts: TokenCounts): number | null => {
  const row = priceRow(model)
  if (!row) return null
  const cacheWrite = row.input * CACHE_WRITE_MULTIPLIER
  return (
    (tokens(counts.input) * row.input +
      tokens(counts.output) * row.output +
      tokens(counts.cacheRead) * row.cacheRead +
      tokens(counts.cacheWrite) * cacheWrite) /
    1_000_000
  )
}
