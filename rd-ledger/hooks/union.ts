// rd-ledger: union-v2 (SPEC §4.1). Workstream W1. Pure. Parity with
// rd-tracker's rdt/timeline.py is the acceptance criterion: apportion
// (369-394), the gap tie rule (451-469), half-open midnight segments (522-527),
// the flag date (585) and the method hash (98-113), golden `a5db146c`.
//
// Instants keep millisecond precision, as rd-tracker's instant()/elapsed() keep
// fractional seconds (timeline.py 309-327; SPEC §4.1 rule 1, ruled 2026-10-12):
// gaps and spans compare in milliseconds against gapS × 1000 and maxBlockS ×
// 1000, and a block's seconds are floor(span ms / 1000). Nothing collapses: two
// prompts of one session in the same second are two events there and here
// (rule 2). Seconds stay integers from the block on; nothing is rounded until
// the pane draws it, so every table sums exactly to its total (rule 10).

import type { Allocation, Block, Flag, Mapping, SessionRecord, UnionEvent, UnionParams } from '../types'
import { sha256 } from './hash'
import { resolveRepo } from './mapping'
import { IGNORED, NON_RD, UNMAPPED } from './store'
import { repoRef as refOf } from './text'
import { addDays, dayBounds, localDate } from './tz'

/** rd-tracker's automation ratio: a day is automation-heavy when denied > ratio × admitted. Fixed; part of the method hash. */
export const AUTOMATION_RATIO = 10

/** The key `allocate` looks a segment up by: `${sessionId}|${seg}` (the row key without its seq). */
export const segmentKey = (sessionId: string, seg: string): string => `${sessionId}|${seg}`

/** The instant as the union compares it: the event's millisecond timestamp itself. */
const instantOf = (ts: number): number => ts
/** Code-unit order: deterministic and locale-free, like Python's str comparison for ASCII ids. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** Python's `%`: the result takes the divisor's sign. */
const pyMod = (a: number, b: number): number => ((a % b) + b) % b

/** CONTRACT (W1). rd-tracker's `apportion`: split `total` over `weights` so the parts sum exactly; largest remainder, ties to the earlier index. */
export const apportion = (total: number, weights: readonly number[]): number[] => {
  const n = weights.length
  if (n === 0) return []
  const weightSum = weights.reduce((a, b) => a + b, 0)
  // rd-tracker raises here too (timeline.py 380-381); every caller in the mod passes event counts, which are positive.
  if (!(weightSum > 0)) throw new RangeError('apportion requires a positive total weight')
  const base = weights.map(w => Math.floor((total * w) / weightSum))
  const remainder = total - base.reduce((a, b) => a + b, 0)
  if (remainder !== 0) {
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => pyMod(total * (weights[j] as number), weightSum) - pyMod(total * (weights[i] as number), weightSum) || i - j)
    const step = remainder > 0 ? 1 : -1
    for (const i of order.slice(0, Math.abs(remainder))) base[i] = (base[i] as number) + step
  }
  return base
}

/** CONTRACT (W1). `union-v2/<sha8>` over rd-tracker's canonical six-field JSON (sorted keys, no spaces; automation_ratio 10). */
export const methodString = (p: UnionParams, zone: string): string => {
  // Keys written in sorted order by hand: JSON.stringify keeps insertion order, Python's sort_keys sorts.
  const blob = JSON.stringify({
    automation_ratio: AUTOMATION_RATIO,
    day_flag_hours: p.dayFlagH,
    idle_gap_seconds: p.gapS,
    max_block_seconds: p.maxBlockS,
    single_event_floor_seconds: p.floorS,
    timezone: zone,
  })
  return `union-v2/${sha256(blob).slice(0, 8)}`
}

type Timed = { e: UnionEvent; s: number }

/** The admitted events in union order (SPEC §4.1 rules 1-2): by instant, then sessionId, seg, seq; nothing collapses. */
const ordered = (events: readonly UnionEvent[]): Timed[] => {
  const timed = events.filter(e => Number.isFinite(e.ts)).map(e => ({ e, s: instantOf(e.ts) }))
  timed.sort((a, b) => a.s - b.s || cmp(a.e.sessionId, b.e.sessionId) || cmp(a.e.seg, b.e.seg) || a.e.seq - b.e.seq)
  return timed
}

/** Maximal runs whose consecutive gaps are ≤ gapS × 1000 ms (rule 3). */
const chains = (events: readonly Timed[], gapS: number): Timed[][] => {
  const out: Timed[][] = []
  for (const t of events) {
    const current = out[out.length - 1]
    const last = current?.[current.length - 1]
    if (current && last && t.s - last.s <= gapS * 1000) current.push(t)
    else out.push([t])
  }
  return out
}

/** timeline.py 451-469: the largest gap; ties to the gap nearest the temporal midpoint, then the earlier. */
const largestGapIndex = (chain: readonly Timed[]): number => {
  let best = 1
  let bestKey: [number, number, number] | null = null
  const midpoint = (chain.length - 1) / 2
  for (let i = 1; i < chain.length; i++) {
    const key: [number, number, number] = [-((chain[i] as Timed).s - (chain[i - 1] as Timed).s), Math.abs(i - 0.5 - midpoint), i]
    if (bestKey === null || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      bestKey = key
      best = i
    }
  }
  return best
}

const spanOf = (piece: readonly Timed[]): number => (piece[piece.length - 1] as Timed).s - (piece[0] as Timed).s

/** Rule 4: split at the largest gap and recurse until every piece fits the cap. */
const splitOverCap = (chain: Timed[], maxBlockS: number): Timed[][] => {
  if (chain.length < 2 || spanOf(chain) <= maxBlockS * 1000) return [chain]
  const i = largestGapIndex(chain)
  return [...splitOverCap(chain.slice(0, i), maxBlockS), ...splitOverCap(chain.slice(i), maxBlockS)]
}

/** Rule 6: half-open `[lo, hi)` day segments, the last closed on its end; seconds by event count (timeline.py 500-540). */
const splitAtMidnights = (piece: readonly Timed[], seconds: number, zone: string, pieceFlags: string[]): Block[] => {
  const start = (piece[0] as Timed).s
  const end = (piece[piece.length - 1] as Timed).s
  const boundaries: number[] = []
  let day = localDate(start, zone)
  for (;;) {
    const next = addDays(day, 1)
    const boundary = dayBounds(next, zone).startTs
    if (boundary >= end) break
    boundaries.push(boundary)
    day = next
  }
  const edges = [start, ...boundaries, end]
  const buckets: { lo: number; hi: number; members: Timed[] }[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i] as number
    const hi = edges[i + 1] as number
    const last = i === edges.length - 2
    buckets.push({ lo, hi, members: piece.filter(t => (lo <= t.s && t.s < hi) || (last && t.s === hi)) })
  }
  const nonEmpty = buckets.filter(b => b.members.length > 0)
  const shares = apportion(seconds, nonEmpty.map(b => b.members.length))
  return nonEmpty.map((b, i) => ({
    date: localDate(b.lo, zone),
    startTs: b.lo,
    endTs: b.hi,
    seconds: shares[i] as number,
    events: b.members.map(t => t.e),
    flags: [...pieceFlags],
  }))
}

/**
 * CONTRACT (W1). Blocks from admitted events: order by (ts,
 * sessionId, seg, seq); nothing collapses; merge while gap ≤ gapS × 1000 ms; split chains over maxBlockS at the largest gap
 * (midpoint-first tie, then earlier; recursive); single-event blocks get
 * floorS once; then split at local midnights with half-open segments and
 * event-count apportionment. Blocks never cross a local day.
 */
export const buildBlocks = (events: readonly UnionEvent[], p: UnionParams, zone: string): Block[] => {
  const out: Block[] = []
  for (const chain of chains(ordered(events), p.gapS)) {
    const overCap = spanOf(chain) > p.maxBlockS * 1000
    for (const piece of splitOverCap(chain, p.maxBlockS)) {
      // timeline.py: a lone event is floored; a multi-event piece keeps int() of its true span, even 0 s.
      const seconds = piece.length === 1 ? Math.max(0, p.floorS) : Math.floor(spanOf(piece) / 1000)
      out.push(...splitAtMidnights(piece, seconds, zone, overCap ? ['over-4h'] : []))
    }
  }
  return out
}

/**
 * Where a segment's time and spend land: its repository resolved through the
 * mapping to a component and entity, or a sentinel bucket (entity '' for
 * unmapped and ignored, the rule's entity for nonRd). The one resolver that
 * `allocate` and `spendByMonth` share, so hours and dollars never disagree.
 */
export const bucketOf = (r: SessionRecord, mapping: Mapping): { component: string; entity: string } => {
  const res = r.repoKey ? resolveRepo(mapping, r.repoKey, r.rootHash) : null
  if (res?.kind === 'component') return { component: res.component, entity: res.entity }
  if (res?.kind === 'ignored') return { component: IGNORED, entity: '' }
  if (res?.kind === 'nonRd') return { component: NON_RD, entity: res.entity }
  return { component: UNMAPPED, entity: '' }
}

/**
 * CONTRACT (W1). Allocations: each block's seconds apportioned over its events
 * (equal weights); each event's seconds to its segment's `repoRef`
 * (`repoKey#rootHash` or the bare key) resolved through the mapping to a
 * component and entity, or `__unmapped__` / `__ignored__` / `__non_rd__`
 * (entity '' for unmapped and ignored; the rule's entity for nonRd).
 *
 * One allocation per (block, session, segment), in the order the segment first
 * appears in the block. `segments` is keyed by `segmentKey(sessionId, seg)`;
 * an event whose segment is missing, or whose segment names no repository,
 * lands in `__unmapped__` with an empty repoRef rather than anywhere guessed.
 */
export const allocate = (blocks: readonly Block[], segments: ReadonlyMap<string, SessionRecord>, mapping: Mapping): Allocation[] => {
  const out: Allocation[] = []
  for (const block of blocks) {
    if (block.events.length === 0) continue
    const shares = apportion(block.seconds, block.events.map(() => 1))
    const bySegment = new Map<string, { sessionId: string; seg: string; seconds: number }>()
    block.events.forEach((ev, i) => {
      const key = segmentKey(ev.sessionId, ev.seg)
      const known = bySegment.get(key)
      if (known) known.seconds += shares[i] as number
      else bySegment.set(key, { sessionId: ev.sessionId, seg: ev.seg, seconds: shares[i] as number })
    })
    for (const [key, part] of bySegment) {
      const record = segments.get(key)
      const repoKey = record?.repoKey ?? null
      const where = record ? bucketOf(record, mapping) : { component: UNMAPPED, entity: '' }
      out.push({ date: block.date, blockStartTs: block.startTs, sessionId: part.sessionId, seg: part.seg, repoRef: repoKey ? refOf(repoKey, record?.rootHash ?? null) : '', component: where.component, entity: where.entity, seconds: part.seconds })
    }
  }
  return out
}

const FLAG_ORDER: Record<Flag['kind'], number> = { 'block-over-4h': 0, 'day-over-cap': 1, 'automation-heavy': 2, 'rows-dropped': 3 }

/**
 * CONTRACT (W1). Flags: `block-over-4h` per over-cap chain dated by its first
 * event; `day-over-cap` per local day over dayFlagH hours; `automation-heavy`
 * per day where denied > 10 × admitted (strictly); `rows-dropped` once per
 * segment with eventsDropped > 0, dated by the segment's open date.
 *
 * Blocks carry no chain id, so the over-cap chains are rebuilt from them:
 * consecutive `over-4h` blocks whose events lie within `gapS` of each other
 * are pieces of one chain (distinct chains are by definition more than `gapS`
 * apart). Day sums are block seconds per local date; the automation counts are
 * the segments' raw event rows per local date.
 */
export const flags = (blocks: readonly Block[], segments: readonly SessionRecord[], p: UnionParams, zone: string): Flag[] => {
  const out: Flag[] = []
  const sorted = [...blocks].filter(b => b.events.length > 0).sort((a, b) => a.startTs - b.startTs)
  let chain: { first: number; last: number; events: number } | null = null
  const closeChain = (): void => {
    if (chain) out.push({ kind: 'block-over-4h', date: localDate(chain.first, zone), detail: `chain of ${chain.events} events spans ${Math.floor((chain.last - chain.first) / 1000)} s before the split (cap ${p.maxBlockS} s)` })
    chain = null
  }
  for (const b of sorted) {
    const first = instantOf((b.events[0] as UnionEvent).ts)
    const last = instantOf((b.events[b.events.length - 1] as UnionEvent).ts)
    if (!b.flags.includes('over-4h')) {
      closeChain()
      continue
    }
    const open = chain as { first: number; last: number; events: number } | null
    if (open && first - open.last <= p.gapS * 1000) chain = { first: open.first, last, events: open.events + b.events.length }
    else {
      closeChain()
      chain = { first, last, events: b.events.length }
    }
  }
  closeChain()

  const perDay = new Map<string, number>()
  for (const b of blocks) perDay.set(b.date, (perDay.get(b.date) ?? 0) + b.seconds)
  for (const [date, seconds] of perDay) {
    if (seconds > p.dayFlagH * 3600) out.push({ kind: 'day-over-cap', date, detail: `${seconds} s engaged, over the ${p.dayFlagH} h day flag` })
  }

  const counts = new Map<string, { admitted: number; denied: number }>()
  for (const r of segments) {
    for (const ev of r.events) {
      if (!Number.isFinite(ev.ts)) continue
      const date = localDate(ev.ts, zone)
      const c = counts.get(date) ?? { admitted: 0, denied: 0 }
      if (ev.admit === 1) c.admitted += 1
      else c.denied += 1
      counts.set(date, c)
    }
  }
  for (const [date, c] of counts) {
    if (c.denied > AUTOMATION_RATIO * c.admitted) out.push({ kind: 'automation-heavy', date, detail: `${c.denied} denied to ${c.admitted} admitted prompts` })
  }

  for (const r of segments) {
    if (r.eventsDropped > 0) out.push({ kind: 'rows-dropped', date: localDate(r.openedAt, zone), detail: `${r.eventsDropped} prompts past the segment cap were not recorded` })
  }

  return out.sort((a, b) => cmp(a.date, b.date) || FLAG_ORDER[a.kind] - FLAG_ORDER[b.kind] || cmp(a.detail, b.detail))
}
