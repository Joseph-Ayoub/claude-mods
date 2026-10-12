// rd-ledger: list-price estimates (SPEC §5, ADR-004). Workstream W1. Pure.

import type { Mapping, SessionRecord, SpendRow, TurnRecord } from '../types'
import { CAP, ttlAt } from './store'
import { oneLine } from './text'
import { monthOfTs } from './tz'
import { bucketOf } from './union'

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
export const CACHE_WRITE_MULTIPLIER = { '5m': 1.25, '1h': 2.0 } as const

/**
 * CONTRACT (W1). The price row for a model id (first prefix match), or null.
 * The prefix must end the id or be followed by a character that is not a
 * letter or digit (`-`, `[`, `@`, `.`), so `claude-opus-50` is unknown rather
 * than priced as `claude-opus-5`: an unknown model is named, never guessed.
 */
export const priceRow = (model: string | null): { prefix: string; input: number; output: number; cacheRead: number } | null => {
  if (typeof model !== 'string' || model.length === 0) return null
  for (const [prefix, input, output, cacheRead] of PRICES) {
    if (!model.startsWith(prefix)) continue
    const next = model.charAt(prefix.length)
    if (next === '' || !/[A-Za-z0-9]/.test(next)) return { prefix, input, output, cacheRead }
  }
  return null
}

const tokens = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** CONTRACT (W1). One turn's estimate in USD under `ttl`, or `priced: false` for an unknown model. */
export const priceTurn = (t: TurnRecord, ttl: '5m' | '1h'): { usd: number | null; priced: boolean } => {
  const row = priceRow(t.model)
  if (!row) return { usd: null, priced: false }
  const cacheWrite = row.input * CACHE_WRITE_MULTIPLIER[ttl === '1h' ? '1h' : '5m']
  const usd = (tokens(t.in) * row.input + tokens(t.out) * row.output + tokens(t.cr) * row.cacheRead + tokens(t.cw) * cacheWrite) / 1_000_000
  return { usd, priced: true }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * CONTRACT (W1). Spend rows for every (month, model, component, entity) over
 * the segments: the TTL per turn is the segment's change point at or before
 * the turn, else `defaultTtl`; component/entity through the mapping as
 * `allocate` resolves them (`__unmapped__` etc. for unresolved repos).
 *
 * The turn's own model names the row (the segment's model when the turn has
 * none, `unknown` when neither does). A row is `priced` only when every turn
 * in it was; its `usd` is then the sum, else null, so a partly unknown row
 * never reads as a complete figure. Rows sort by month, model, component,
 * entity.
 */
export const spendByMonth = (segments: readonly SessionRecord[], mapping: Mapping, defaultTtl: '5m' | '1h', zone: string): SpendRow[] => {
  const rows = new Map<string, SpendRow>()
  for (const r of segments) {
    const where = bucketOf(r, mapping)
    for (const t of r.turns) {
      if (!Number.isFinite(t.ts)) continue
      const month = monthOfTs(t.ts, zone)
      const model = oneLine(t.model ?? r.model ?? 'unknown', CAP.model) || 'unknown'
      const price = priceTurn({ ...t, model }, ttlAt(r, t.ts) ?? defaultTtl)
      const key = [month, model, where.component, where.entity].join('|')
      const row = rows.get(key) ?? { month, model, component: where.component, entity: where.entity, turns: 0, in: 0, out: 0, cr: 0, cw: 0, usd: 0, priced: true }
      row.turns += 1
      row.in += tokens(t.in)
      row.out += tokens(t.out)
      row.cr += tokens(t.cr)
      row.cw += tokens(t.cw)
      row.priced = row.priced && price.priced
      row.usd = row.priced && row.usd !== null && price.usd !== null ? row.usd + price.usd : null
      rows.set(key, row)
    }
  }
  return [...rows.values()].sort((a, b) => cmp(a.month, b.month) || cmp(a.model, b.model) || cmp(a.component, b.component) || cmp(a.entity, b.entity))
}
