import { describe, expect, test } from 'claude-code/testing'

import type { Mapping, SessionRecord, TurnRecord } from '../types'
import { emptyMapping } from './mapping'
import { CACHE_WRITE_MULTIPLIER, PRICES, priceRow, priceTurn, spendByMonth } from './prices'
import { newSegment } from './store'

const NY = 'America/New_York'
const S1 = '11111111-aaaa-4bbb-8ccc-000000000001'
const S2 = '22222222-aaaa-4bbb-8ccc-000000000002'
/** 2026-10-11T13:00:00Z, Sunday 09:00 in New York. */
const T0 = Date.UTC(2026, 9, 11, 13)
const M = 1_000_000
/** Dollars to whole micro-dollars, so float sums compare exactly. */
const micro = (usd: number | null): number | null => (usd === null ? null : Math.round(usd * 1e6))

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({ seq: 1, ts: T0, endTs: T0 + 1000, turnId: 'turn-1', agentKey: '', agent: 0, model: 'claude-opus-5-5', in: 0, out: 0, cr: 0, cw: 0, reason: 'answer', ...over })

const segment = (sessionId: string, repoKey: string | null, turns: TurnRecord[], extra: Partial<SessionRecord> = {}): SessionRecord => ({
  ...newSegment({ sessionId, openedAt: T0 - 3_600_000, source: 'startup', entrypoint: 'cli', interactive: true, surface: 'cli', repoKey, repoKind: 'repo', rootHash: null, cwdBase: 'x', branch: 'main', model: 'claude-sonnet-5', engineCostAtOpen: null }),
  turns,
  ...extra,
})

const mapping = (): Mapping => {
  const m = emptyMapping()
  m.entities['acme'] = { name: 'Example Co', filing: 'c-corp' }
  m.components['acme-app'] = { name: 'Example App', entity: 'acme', activity: 'direct_research', poe: true, rdt: null }
  m.repos['shop'] = { component: 'acme-app' }
  m.repos['scratch'] = { ignore: true }
  m.repos['house'] = { nonRd: true, entity: 'acme' }
  return m
}

describe('price table', () => {
  test('every row is reachable by its own prefix and by a dated id, and prices each token class', async () => {
    for (const [prefix, input, output, cacheRead] of PRICES) {
      expect(priceRow(prefix)).toEqual({ prefix, input, output, cacheRead })
      expect(priceRow(`${prefix}-20260101`)?.prefix).toBe(prefix)
      const model = prefix
      expect(micro(priceTurn(turn({ model, in: M }), '5m').usd)).toBe(micro(input))
      expect(micro(priceTurn(turn({ model, out: M }), '5m').usd)).toBe(micro(output))
      expect(micro(priceTurn(turn({ model, cr: M }), '5m').usd)).toBe(micro(cacheRead))
      expect(micro(priceTurn(turn({ model, cw: M }), '5m').usd)).toBe(micro(input * 1.25))
      expect(micro(priceTurn(turn({ model, cw: M }), '1h').usd)).toBe(micro(input * 2.0))
    }
    expect(CACHE_WRITE_MULTIPLIER).toEqual({ '5m': 1.25, '1h': 2.0 })
  })

  test('claude-opus-5-5 is priced by its own row, never by claude-opus-5', async () => {
    expect(priceRow('claude-opus-5-5')).toEqual({ prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 })
    expect(priceRow('claude-opus-5-5-20261001')?.prefix).toBe('claude-opus-5-5')
    expect(priceRow('claude-opus-5-5[1m]')?.prefix).toBe('claude-opus-5-5')
    expect(priceRow('claude-opus-5')?.prefix).toBe('claude-opus-5')
    expect(micro(priceTurn(turn({ model: 'claude-opus-5-5', in: M, out: M }), '5m').usd)).toBe(24_000_000)
    expect(micro(priceTurn(turn({ model: 'claude-opus-5', in: M, out: M }), '5m').usd)).toBe(30_000_000)
  })

  test('an unknown model keeps its tokens unpriced; a longer id never borrows a shorter row', async () => {
    expect(priceTurn(turn({ model: 'mystery-model', in: M }), '5m')).toEqual({ usd: null, priced: false })
    expect(priceTurn(turn({ model: null, in: M }), '5m')).toEqual({ usd: null, priced: false })
    expect(priceRow('claude-opus-50')).toBeNull()
    expect(priceRow('')).toBeNull()
    expect(micro(priceTurn(turn({ in: -5, out: Number.NaN }), '5m').usd)).toBe(0)
  })
})

describe('spend by month', () => {
  test('a TTL change point mid-segment prices later turns only; the default covers turns before it', async () => {
    const r = segment(S1, 'shop', [turn({ seq: 1, ts: T0, cw: M }), turn({ seq: 2, ts: T0 + 120_000, cw: M })], { cacheTtlChanges: [{ ts: T0 + 60_000, ttl: '1h' }] })
    const rows = spendByMonth([r], mapping(), '5m', NY)
    expect(rows).toHaveLength(1)
    // claude-opus-5-5 input 4: 1M cache write at 5m = 5.00, at 1h = 8.00.
    expect(micro(rows[0]?.usd ?? null)).toBe(13_000_000)
    const allOneHour = spendByMonth([r], mapping(), '1h', NY)
    expect(micro(allOneHour[0]?.usd ?? null)).toBe(16_000_000)
  })

  test('rows group by (month, model, component, entity) with sentinel buckets; unknown models stay unpriced', async () => {
    const rows = spendByMonth(
      [
        segment(S1, 'shop', [turn({ ts: T0, in: M }), turn({ seq: 2, ts: T0 + 1000, in: M }), turn({ seq: 3, ts: Date.UTC(2026, 8, 15, 15), in: M, model: 'claude-sonnet-5' })]),
        segment(S2, 'gamma', [turn({ ts: T0, model: null, out: M })]),
        segment(S2, 'scratch', [turn({ ts: T0, model: 'mystery-model', in: M })], { seg: 'x2' }),
        segment(S2, 'house', [turn({ ts: T0, model: 'claude-haiku-5-5', in: M })], { seg: 'x3' }),
        segment(S2, null, [turn({ ts: Date.UTC(2026, 10, 1, 3, 59), in: M })], { seg: 'x4' }),
      ],
      mapping(),
      '5m',
      NY,
    )
    expect(rows.map(r => [r.month, r.model, r.component, r.entity, r.turns, r.in, r.out, micro(r.usd), r.priced])).toEqual([
      ['2026-09', 'claude-sonnet-5', 'acme-app', 'acme', 1, M, 0, 2_000_000, true],
      ['2026-10', 'claude-haiku-5-5', '__non_rd__', 'acme', 1, M, 0, 100_000, true],
      ['2026-10', 'claude-opus-5-5', '__unmapped__', '', 1, M, 0, 4_000_000, true],
      ['2026-10', 'claude-opus-5-5', 'acme-app', 'acme', 2, 2 * M, 0, 8_000_000, true],
      ['2026-10', 'claude-sonnet-5', '__unmapped__', '', 1, 0, M, 10_000_000, true],
      ['2026-10', 'mystery-model', '__ignored__', '', 1, M, 0, null, false],
    ])
  })
})
