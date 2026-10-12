import { describe, expect, test } from 'claude-code/testing'

import { CACHE_WRITE_MULTIPLIER, PRICES_AS_OF, estimateUsd, priceRow } from './prices'

describe('priceRow', () => {
  test('the first prefix match wins, longer prefixes first', () => {
    expect(priceRow('claude-opus-5-5')).toEqual({ prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 })
    expect(priceRow('claude-opus-5')?.prefix).toBe('claude-opus-5')
    expect(priceRow('claude-fable-5-1[1m]')?.prefix).toBe('claude-fable-5-1')
    expect(priceRow('claude-haiku-4-5-20251001')?.prefix).toBe('claude-haiku-4-5')
  })

  test('an unknown model is null, never guessed from a near prefix', () => {
    expect(priceRow('claude-opus-50')).toBeNull()
    expect(priceRow('gpt-6')).toBeNull()
    expect(priceRow('')).toBeNull()
    expect(priceRow(null)).toBeNull()
  })
})

describe('estimateUsd', () => {
  test('input, output, cache read and cache write (at 1.25x input) at list price', () => {
    expect(CACHE_WRITE_MULTIPLIER).toBe(1.25)
    expect(PRICES_AS_OF).toBe('2026-10-06')
    // Opus 5.5: 1M input $4, 1M output $20, 1M cache read $0.20, 1M cache write $5.
    expect(Math.abs((estimateUsd('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }) ?? 0) - 29.2)).toBeLessThan(1e-9)
    expect(Math.abs((estimateUsd('claude-sonnet-5-5', { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }) ?? 0) - 0.007)).toBeLessThan(1e-12)
  })

  test('an unknown model is null; negative or non-finite counts count as zero', () => {
    expect(estimateUsd('mystery-model', { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBeNull()
    expect(estimateUsd('claude-opus-5-5', { input: -5, output: Number.NaN, cacheRead: Infinity, cacheWrite: 0 })).toBe(0)
  })
})
