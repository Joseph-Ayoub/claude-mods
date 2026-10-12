// rd-ledger: the rollup the pane and footer draw (SPEC §6.6). Workstream W1.
// Pure: decoded segments in, a Rollup out. The register owns the file cache.
//
// One pass of union-v2 runs over every admitted event in scope (this and last
// month), so a block that starts on a Sunday night and the week that follows
// see the same blocks; the week, the day totals and the queue are then cuts of
// that one allocation table, which is why they always sum to each other.

import type { Activity, AgentSummary, Allocation, Block, EngineCost, Health, Mapping, QueueRow, Recommendation, ReviewFile, ReviewRevision, Rollup, SessionRecord, SessionRow, SessionSummary, SpendRow, TokenCounts, TurnRecord, UnionEvent, UnionParams, WeekRow } from '../types'
import { isNewLocation, pretag } from './mapping'
import { PRICES_AS_OF, priceRow, priceTurn, spendByMonth } from './prices'
import { emptyReview, latestConfirmed, missingLiveRows, reviewStatus, rowStatus } from './review'
import { CAP, IGNORED, NON_RD, ownEngineCost, ttlAt, UNMAPPED } from './store'
import { compactInt, money, oneLine } from './text'
import { modelText } from './report'
import { addDays, dayBounds, isoWeek, localDate, monthOfTs, previousMonth, weekDates } from './tz'
import { allocate, buildBlocks, flags, methodString, segmentKey } from './union'

export type RollupInput = {
  now: number
  zone: string
  params: UnionParams
  defaultTtl: '5m' | '1h'
  /** Every decoded segment in scope (this and last month) */
  segments: readonly import('../types').SessionRecord[]
  mapping: Mapping
  /** The review files for the weeks in scope, by week */
  reviews: ReadonlyMap<string, ReviewFile>
  /** Health figures the register knows and the rollup only carries */
  health: Pick<Health, 'zoneDetectedNow' | 'unreadable' | 'daysSinceExport' | 'storeIsLink' | 'lockStaleMs' | 'bridge' | 'readOnly'>
  deadlines: import('../types').Deadline[]
  /** The segment this process is writing, for `thisSessionId` and the Session view's engine figure; null before one opens */
  current?: { sessionId: string; seg: string } | null
  /** The session the Session view shows (a full id), so its summary is carried even past the newest rows */
  selected?: string | null
}

const SENTINELS: ReadonlySet<string> = new Set([UNMAPPED, IGNORED, NON_RD])
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const add = <K>(m: Map<K, number>, key: K, n: number): void => {
  m.set(key, (m.get(key) ?? 0) + n)
}
/** The key with the most seconds; ties to the smaller key, so the answer never depends on input order. */
const dominant = (m: ReadonlyMap<string, number>): string => [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? ''

/**
 * The branches a segment showed on a local day: the one in force when the day
 * began (the last change before it, or the segment's only branch when it never
 * changed) and every change made during the day.
 */
const branchesOn = (r: SessionRecord, date: string, zone: string): string[] => {
  const { startTs, endTs } = dayBounds(date, zone)
  const out = new Set<string>()
  if (r.branchChanges.length === 0) {
    if (r.branch) out.add(r.branch)
    return [...out]
  }
  let atStart: string | null = null
  for (const c of r.branchChanges) {
    if (c.ts < startTs) atStart = c.branch
    else if (c.ts < endTs && c.branch) out.add(c.branch)
  }
  if (atStart) out.add(atStart)
  return [...out]
}

type Group = { component: string; date: string; seconds: number; entities: Map<string, number>; repos: Map<string, number>; records: Set<SessionRecord>; over4h: boolean }

/** The live rows of one ISO week against its latest confirmed revision (SPEC §3.4). */
const weekRowsFor = (week: string, allocations: readonly Allocation[], blocksByStart: ReadonlyMap<number, Block>, segments: ReadonlyMap<string, SessionRecord>, mapping: Mapping, review: ReviewFile, zone: string): WeekRow[] => {
  const dates = new Set(weekDates(week))
  const groups = new Map<string, Group>()
  for (const a of allocations) {
    if (!dates.has(a.date)) continue
    const key = `${a.component}|${a.date}`
    const g: Group = groups.get(key) ?? { component: a.component, date: a.date, seconds: 0, entities: new Map<string, number>(), repos: new Map<string, number>(), records: new Set<SessionRecord>(), over4h: false }
    g.seconds += a.seconds
    add(g.entities, a.entity, a.seconds)
    const record = segments.get(segmentKey(a.sessionId, a.seg))
    if (record) {
      g.records.add(record)
      if (record.repoKey) add(g.repos, record.repoKey, a.seconds)
    }
    if (blocksByStart.get(a.blockStartTs)?.flags.includes('over-4h')) g.over4h = true
    groups.set(key, g)
  }
  const confirmed: ReviewRevision | null = latestConfirmed(review)
  const rows: WeekRow[] = []
  for (const [key, g] of groups) {
    const entity = dominant(g.entities)
    const status = rowStatus(confirmed, key, g.seconds, entity)
    let tag: { activity: Activity; poe: boolean } = { activity: 'non_qualified', poe: false }
    if (!SENTINELS.has(g.component)) {
      const repoKey = dominant(g.repos)
      const branches = [...new Set([...g.records].filter(r => r.repoKey === repoKey).flatMap(r => branchesOn(r, g.date, zone)))].sort(cmp)
      tag = pretag(mapping, g.component, repoKey, branches)
    }
    const rowFlags: string[] = []
    if (g.over4h) rowFlags.push('over-4h')
    // Two nonRd rules naming different entities on one day share the `__non_rd__|date` key; say so rather than hide it.
    if (g.entities.size > 1) rowFlags.push('mixed-entities')
    rows.push({ key, component: g.component, entity, date: g.date, seconds: g.seconds, confirmedSeconds: status.confirmedSeconds, activity: status.activity ?? tag.activity, poe: status.poe ?? tag.poe, status: status.status, flags: rowFlags })
  }
  // A frozen row with no live time left is shown at zero, never dropped (DBM-1).
  for (const key of missingLiveRows(confirmed, new Set(groups.keys()))) {
    const frozen = (confirmed as ReviewRevision).rows[key]
    const cut = key.lastIndexOf('|')
    if (!frozen || cut < 0) continue
    rows.push({ key, component: key.slice(0, cut), entity: frozen.entity, date: key.slice(cut + 1), seconds: 0, confirmedSeconds: frozen.seconds, activity: frozen.activity, poe: frozen.poe, status: 'changed', flags: [] })
  }
  return rows.sort((a, b) => Number(SENTINELS.has(a.component)) - Number(SENTINELS.has(b.component)) || cmp(a.component, b.component) || cmp(a.date, b.date))
}

/** One queue row per repository location with unmapped time this week, or with a hash new under a mapped bare key (DBM-8). */
const queueFor = (dates: ReadonlySet<string>, allocations: readonly Allocation[], segments: ReadonlyMap<string, SessionRecord>, mapping: Mapping, zone: string): QueueRow[] => {
  type Entry = { row: QueueRow; sessions: Set<string>; branches: Set<string> }
  const rows = new Map<string, Entry>()
  for (const a of allocations) {
    // An empty repoRef (no repository known) cannot be mapped from the queue; its time still counts in weekUnmappedS.
    if (!dates.has(a.date) || a.repoRef === '') continue
    const record = segments.get(segmentKey(a.sessionId, a.seg))
    if (!record?.repoKey) continue
    const newLocation = isNewLocation(mapping, record.repoKey, record.rootHash)
    if (a.component !== UNMAPPED && !newLocation) continue
    const entry: Entry = rows.get(a.repoRef) ??{ row: { key: a.repoRef, repoKey: record.repoKey, rootHash: record.rootHash, seconds: 0, branches: [], sessions: 0, isNewLocation: newLocation }, sessions: new Set<string>(), branches: new Set<string>() }
    entry.row.seconds += a.seconds
    entry.sessions.add(a.sessionId)
    for (const b of branchesOn(record, a.date, zone)) entry.branches.add(b)
    rows.set(a.repoRef, entry)
  }
  return [...rows.values()]
    .map(x => ({ ...x.row, sessions: x.sessions.size, branches: [...x.branches].sort(cmp) }))
    .sort((a, b) => b.seconds - a.seconds || cmp(a.key, b.key))
}

/** This month's list-price total: the priced rows summed; null when rows exist and none could be priced. */
const monthUsd = (rows: readonly SpendRow[]): number | null => {
  const priced = rows.filter(r => r.priced && r.usd !== null)
  if (rows.length > 0 && priced.length === 0) return null
  return priced.reduce((sum, r) => sum + (r.usd as number), 0)
}

// --- sessions: the Session and Sessions views (SPEC §6.1a, §6.1b) ---------------------------
//
// Every figure here is a list-price estimate over the stored turns (the same
// priceTurn and TTL rule as spendByMonth), beside the engine's own /cost figure
// where a segment recorded one. Agents come from the turns' agentKey, never
// from a live agent list, so a closed session reads the same as an open one.

/** At most this many sessions reach the Sessions view, newest first. */
export const SESSIONS_CAP = 300
/** The newest rows that carry a full summary in the rollup (beside this session and the selected one). */
export const DETAILS_ROWS = 40
/** A summary lists at most this many subagents, then one `others` row. */
export const AGENTS_CAP = 12
/** A summary lists at most this many models, then one `others` row. */
export const MODELS_CAP = 8
/** A session counts toward the per-hour median, and the cost-per-hour rule, from this many engaged seconds. */
export const MIN_RATE_S = 900
/** A turn that starts this long after its chain's previous turn ended found a 5-minute cache expired. */
export const PAUSE_MS = 5 * 60_000
/** The model whose prices the agent-tier rule quotes. */
export const SONNET_MODEL = 'claude-sonnet-5-5'
/** The agentKey and model of a row that folds the rest together. */
export const OTHERS = 'others'

/** One stored turn with the model it is priced under, the TTL in force for it and its estimate. */
export type PricedTurn = { turn: TurnRecord; model: string; ttl: '5m' | '1h'; usd: number | null }

/** What the recommendation rules read of one session. */
export type SessionFacts = {
  /** Every turn of the session, in (ts, endTs, turnId) order */
  turns: readonly PricedTurn[]
  /** The TTL in force for every turn; null when it changed during the session (then neither cache rule speaks) */
  ttl: '5m' | '1h' | null
  engagedS: number
  estUsd: number | null
  agents: readonly AgentSummary[]
}

/** What the rules read of the whole scope. */
export type ScopeFacts = { sessionsInScope: number; medianUsdPerHour: number | null }

const count = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
const zeroTokens = (): TokenCounts => ({ in: 0, out: 0, cr: 0, cw: 0 })
const addTokens = (acc: TokenCounts, t: TurnRecord): void => {
  acc.in += count(t.in)
  acc.out += count(t.out)
  acc.cr += count(t.cr)
  acc.cw += count(t.cw)
}
/** The sum of the priced estimates; null when there are turns and none was priced. */
const sumUsd = (turns: readonly PricedTurn[]): number | null => {
  let usd = 0
  let priced = 0
  for (const p of turns) {
    if (p.usd === null) continue
    usd += p.usd
    priced += 1
  }
  return turns.length > 0 && priced === 0 ? null : usd
}
const pushTo = <K, V>(m: Map<K, V[]>, key: K, value: V): void => {
  const list = m.get(key)
  if (list) list.push(value)
  else m.set(key, [value])
}

/** The median of `values`; the mean of the middle two for an even count; null when empty. */
export const median = (values: readonly number[]): number | null => {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2
}

/**
 * The turns that began more than PAUSE_MS after the previous turn of the same
 * agent ended, each mapped to `maxCtx`: the largest context (cr + cw) any
 * earlier turn of its chain had built, which bounds what a longer TTL could
 * have kept cached for it. Each agent keeps its own cache prefix, so the chain
 * is per agentKey; the first turn of a chain is never paused (nothing was
 * cached yet). `turns` must be in ts order.
 */
export const pausedTurns = (turns: readonly PricedTurn[]): Map<PricedTurn, number> => {
  const out = new Map<PricedTurn, number>()
  const chains = new Map<string, { last: PricedTurn; maxCtx: number }>()
  for (const p of turns) {
    const chain = chains.get(p.turn.agentKey)
    if (chain && p.turn.ts - chain.last.turn.endTs > PAUSE_MS) out.set(p, chain.maxCtx)
    const ctx = count(p.turn.cr) + count(p.turn.cw)
    chains.set(p.turn.agentKey, { last: p, maxCtx: Math.max(chain?.maxCtx ?? 0, ctx) })
  }
  return out
}
/** `tokens` at `perMTok(row)` dollars per million for the turn's model; 0 for a model without a price row. */
const atRate = (p: PricedTurn, tokens: number, perMTok: (row: { input: number; cacheRead: number }) => number): number => {
  const row = priceRow(p.model)
  return row ? (tokens * perMTok(row)) / 1_000_000 : 0
}
/** What re-writing a token costs over reading it from cache: 1.25 × input − cache read. */
const rewriteOverRead = (row: { input: number; cacheRead: number }): number => 1.25 * row.input - row.cacheRead
/** What every cache write costs more under 1h (2.0 × input) than under 5m (1.25 × input). */
const longTtlPremium = (row: { input: number }): number => 0.75 * row.input

/** A TTL recommendation needs a net saving above this to be worth a line. */
const MIN_SAVING_USD = 0.5

/**
 * cache-ttl-1h: every turn under 5m and ≥ 30 % of turns paused. A paused turn's
 * avoidable rewrite is min(cw, maxCtx), the most its chain had cached; against
 * that, every turn that was not paused would pay the 1h premium on its writes.
 */
export const recCacheTtl1h = (f: SessionFacts): Recommendation | null => {
  if (f.ttl !== '5m' || f.turns.length === 0) return null
  const paused = pausedTurns(f.turns)
  if (paused.size / f.turns.length < 0.3) return null
  let saving = 0
  for (const p of f.turns) {
    const maxCtx = paused.get(p)
    saving += maxCtx !== undefined ? atRate(p, Math.min(count(p.turn.cw), maxCtx), rewriteOverRead) : -atRate(p, count(p.turn.cw), longTtlPremium)
  }
  if (!(saving > MIN_SAVING_USD)) return null
  return {
    code: 'cache-ttl-1h',
    text: `${paused.size} of ${f.turns.length} turns started more than 5 minutes after the one before; assuming the paused turns re-wrote their context, a 1-hour cache TTL would have saved about ${money(saving)} here (estimate).`,
    estSavingUsd: saving,
  }
}

/**
 * cache-ttl-5m: every turn under 1h and < 10 % of turns paused. Under 5m each
 * paused turn would have had to re-write everything it read (its cache read is
 * already bounded by the cache that existed); every write would have saved
 * the 1h premium.
 */
export const recCacheTtl5m = (f: SessionFacts): Recommendation | null => {
  if (f.ttl !== '1h' || f.turns.length === 0) return null
  const paused = pausedTurns(f.turns)
  if (paused.size / f.turns.length >= 0.1) return null
  let saving = 0
  for (const p of f.turns) {
    saving += atRate(p, count(p.turn.cw), longTtlPremium)
    if (paused.has(p)) saving -= atRate(p, count(p.turn.cr), rewriteOverRead)
  }
  if (!(saving > MIN_SAVING_USD)) return null
  return {
    code: 'cache-ttl-5m',
    text: `Only ${paused.size} of ${f.turns.length} turns came after a pause over 5 minutes; assuming the paused turns would re-write the context they read, the 5-minute cache TTL would have saved about ${money(saving)} here (estimate).`,
    estSavingUsd: saving,
  }
}

/** The Opus and Fable price tiers (Mythos rows carry Fable's prices). */
export const isTopTier = (model: string | null): boolean => /^claude-(opus|fable|mythos)(-|$)|^claude-3-opus/.test(priceRow(model)?.prefix ?? '')

/**
 * agent-tier: a subagent with ≥ 15 turns on an Opus- or Fable-tier model,
 * short answers (median output < 400 tokens) and ≥ 20 % of the session's
 * estimate; quotes its same tokens at Sonnet prices. The main loop is the
 * person's own model choice and is never named.
 */
export const recAgentTier = (f: SessionFacts): Recommendation[] => {
  const out: Recommendation[] = []
  if (f.estUsd === null || !(f.estUsd > 0)) return out
  for (const a of f.agents) {
    if (a.agentKey === '' || a.agentKey === OTHERS || a.turns < 15 || a.estUsd === null || !isTopTier(a.model)) continue
    if (a.estUsd < 0.2 * f.estUsd) continue
    const mine = f.turns.filter(p => p.turn.agentKey === a.agentKey)
    const mid = median(mine.map(p => count(p.turn.out)))
    if (mid === null || mid >= 400) continue
    let sonnet = 0
    for (const p of mine) if (p.usd !== null) sonnet += priceTurn({ ...p.turn, model: SONNET_MODEL }, p.ttl).usd ?? 0
    const saving = a.estUsd - sonnet
    if (!(saving > 0)) continue
    out.push({ code: 'agent-tier', text: `Agent ${/^[0-9a-f]{8}$/.test(a.agentKey) ? a.agentKey : '(unrecognized agent)'} ran ${a.turns} turns on ${modelText(a.model)} with a median of ${Math.round(mid)} output tokens; at Sonnet prices the same tokens would cost about ${money(sonnet)} instead of ${money(a.estUsd)} (estimate).`, estSavingUsd: saving })
  }
  return out
}

/** context-size: ≥ 20 main-loop turns re-reading a median of ≥ 150 000 cached tokens each. */
export const recContextSize = (f: SessionFacts): Recommendation | null => {
  const main = f.turns.filter(p => p.turn.agent === 0)
  if (main.length < 20) return null
  const mid = median(main.map(p => count(p.turn.cr)))
  if (mid === null || mid < 150_000) return null
  let reads = 0
  for (const p of main) reads += atRate(p, count(p.turn.cr), row => row.cacheRead)
  return { code: 'context-size', text: `The main loop re-read a median of ${compactInt(mid)} cached tokens on each of ${main.length} turns; cache reads cost ${money(reads)} of this session, so /compact or a fresh session for the next task would trim that (estimate).`, estSavingUsd: null }
}

/** errored-turns: ≥ 3 turns that ended in an error, and what they cost. */
export const recErroredTurns = (f: SessionFacts): Recommendation | null => {
  const errored = f.turns.filter(p => p.turn.reason === 'error')
  if (errored.length < 3) return null
  const usd = sumUsd(errored)
  const text = usd === null ? `${errored.length} turns ended in an error; their models have no price row, so their cost is not estimated.` : `${errored.length} turns ended in an error and cost about ${money(usd)} with no answer to show for it (estimate).`
  return { code: 'errored-turns', text, estSavingUsd: usd }
}

/** cost-per-hour: ≥ 0.25 h engaged, ≥ 5 sessions in scope, and at least twice the median estimate per engaged hour. */
export const recCostPerHour = (f: SessionFacts, scope: ScopeFacts): Recommendation | null => {
  const m = scope.medianUsdPerHour
  if (f.engagedS < MIN_RATE_S || scope.sessionsInScope < 5 || m === null || !(m > 0) || f.estUsd === null) return null
  const hours = f.engagedS / 3600
  const rate = f.estUsd / hours
  if (rate < 2 * m) return null
  return { code: 'cost-per-hour', text: `This session cost ${money(rate)} per engaged hour, at least twice the median of ${money(m)} across your sessions this and last month (estimate).`, estSavingUsd: f.estUsd - m * hours }
}

/** Every rule over one session, in a fixed order. */
export const recommendationsFor = (f: SessionFacts, scope: ScopeFacts): Recommendation[] =>
  [recCacheTtl1h(f), recCacheTtl5m(f), ...recAgentTier(f), recContextSize(f), recErroredTurns(f), recCostPerHour(f, scope)].filter((r): r is Recommendation => r !== null)

/** The key with the highest count; ties to the smaller key. */
const mostUsed = (m: ReadonlyMap<string, number>): string | null => [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? null
const byUsd = (a: { estUsd: number | null }, b: { estUsd: number | null }): number => (b.estUsd ?? -1) - (a.estUsd ?? -1)
/** A sum of estimates where null means "none priced": null only when every part is null. */
const sumNullable = (values: readonly (number | null)[]): number | null => (values.length > 0 && values.every(v => v === null) ? null : values.reduce<number>((s, v) => s + (v ?? 0), 0))

/** One agent's row: its turns, most-used model, tokens, estimate and share of the session's estimate. */
const agentOf = (agentKey: string, ps: readonly PricedTurn[], sessionUsd: number | null): AgentSummary => {
  const t = zeroTokens()
  const used = new Map<string, number>()
  for (const p of ps) {
    addTokens(t, p.turn)
    used.set(p.model, (used.get(p.model) ?? 0) + 1)
  }
  const usd = sumUsd(ps)
  return { agentKey, merged: 0, turns: ps.length, model: mostUsed(used), tokens: t, estUsd: usd, share: usd !== null && sessionUsd !== null && sessionUsd > 0 ? usd / sessionUsd : 0 }
}

/** The main loop, then the AGENTS_CAP subagents with the largest estimates, then one `others` row folding the rest. */
const capAgents = (all: AgentSummary[]): AgentSummary[] => {
  const main = all.filter(a => a.agentKey === '')
  const subs = all.filter(a => a.agentKey !== '').sort((a, b) => byUsd(a, b) || cmp(a.agentKey, b.agentKey))
  if (subs.length <= AGENTS_CAP) return [...main, ...subs]
  const rest = subs.slice(AGENTS_CAP)
  const tokens = zeroTokens()
  for (const a of rest) {
    tokens.in += a.tokens.in
    tokens.out += a.tokens.out
    tokens.cr += a.tokens.cr
    tokens.cw += a.tokens.cw
  }
  const others: AgentSummary = { agentKey: OTHERS, merged: rest.length, turns: rest.reduce((s, a) => s + a.turns, 0), model: null, tokens, estUsd: sumNullable(rest.map(a => a.estUsd)), share: rest.reduce((s, a) => s + a.share, 0) }
  return [...main, ...subs.slice(0, AGENTS_CAP), others]
}

/** The MODELS_CAP models with the largest estimates, then one `others` row folding the rest. */
const capModels = (all: SessionSummary['models']): SessionSummary['models'] => {
  const sorted = all.slice().sort((a, b) => byUsd(a, b) || cmp(a.model, b.model))
  if (sorted.length <= MODELS_CAP) return sorted
  const rest = sorted.slice(MODELS_CAP)
  return [...sorted.slice(0, MODELS_CAP), { model: OTHERS, turns: rest.reduce((s, m) => s + m.turns, 0), estUsd: sumNullable(rest.map(m => m.estUsd)), merged: rest.length }]
}

/**
 * A session's engine figure, the one number the Session view and
 * the Sessions row all show: the engine's running total in the latest
 * segment (what /cost prints in its most recent process), less the total the
 * first segment opened with when that segment began a `/clear` or a fork,
 * since that part belongs to the session it came from. A first segment opened
 * `unknown` means recording began mid-session, so its earlier cost is this
 * session's and stays. Null while the latest segment has no figure.
 */
export const sessionEngineUsd = (group: readonly SessionRecord[]): number | null => {
  const first = group[0]
  const latest = group[group.length - 1]
  if (!first || !latest || latest.engineCostUsd === null) return null
  const inherited = (first.source === 'clear' || first.source === 'fork') && first.engineCostAtOpen !== null ? first.engineCostAtOpen : 0
  return Math.max(0, latest.engineCostUsd - inherited)
}

/** The compact row the Sessions view lists. */
export const sessionRow = (s: SessionSummary): SessionRow => ({
  sessionId: s.sessionId,
  id8: s.id8,
  openedAt: s.openedAt,
  lastAt: s.lastAt,
  repoKey: s.repoKey,
  engagedS: s.engagedS,
  turns: s.turnsMain + s.turnsAgent,
  agentCount: s.agents.filter(a => a.agentKey !== '').reduce((n, a) => n + (a.agentKey === OTHERS ? a.merged : 1), 0),
  engineUsd: s.engineUsd,
  estUsd: s.estUsd,
  recCount: s.recommendations.length,
})

/**
 * Every session among the segments as a SessionSummary, newest first and not
 * capped, plus the median estimate per engaged hour over sessions with at
 * least MIN_RATE_S engaged. The recommendations are filled in once that
 * median is known, since the cost-per-hour rule reads it. Groups are built
 * with push, never spreads: a month can hold tens of thousands of turns.
 */
export const summarizeSessions = (segments: readonly SessionRecord[], params: UnionParams, zone: string, defaultTtl: '5m' | '1h'): { sessions: SessionSummary[]; medianUsdPerHour: number | null } => {
  const groups = new Map<string, SessionRecord[]>()
  for (const r of segments) pushTo(groups, r.sessionId, r)
  const built: { summary: SessionSummary; facts: SessionFacts }[] = []
  for (const [sessionId, group] of groups) {
    group.sort((a, b) => a.openedAt - b.openedAt || cmp(a.seg, b.seg))
    const admitted: UnionEvent[] = []
    const turns: PricedTurn[] = []
    let lastAt = Number.NEGATIVE_INFINITY
    let repoKey: string | null = null
    let entrypoint: string | null = null
    for (const r of group) {
      lastAt = Math.max(lastAt, r.openedAt, r.closedAt ?? Number.NEGATIVE_INFINITY)
      if (r.repoKey !== null) repoKey = r.repoKey
      if (r.entrypoint !== null) entrypoint = r.entrypoint
      for (const ev of r.events) {
        if (Number.isFinite(ev.ts)) lastAt = Math.max(lastAt, ev.ts)
        if (ev.admit === 1) admitted.push({ ts: ev.ts, sessionId: r.sessionId, seg: r.seg, seq: ev.seq })
      }
      for (const t of r.turns) {
        if (!Number.isFinite(t.ts)) continue
        if (Number.isFinite(t.endTs)) lastAt = Math.max(lastAt, t.endTs)
        const model = oneLine(t.model ?? r.model ?? 'unknown', CAP.model) || 'unknown'
        const ttl = ttlAt(r, t.ts) ?? defaultTtl
        turns.push({ turn: t, model, ttl, usd: priceTurn({ ...t, model }, ttl).usd })
      }
    }
    turns.sort((a, b) => a.turn.ts - b.turn.ts || a.turn.endTs - b.turn.endTs || cmp(a.turn.turnId, b.turn.turnId))
    const engagedS = buildBlocks(admitted, params, zone).reduce((s, b) => s + b.seconds, 0)
    const tokens = zeroTokens()
    for (const p of turns) addTokens(tokens, p.turn)
    const estUsd = sumUsd(turns)

    const byModel = new Map<string, PricedTurn[]>()
    const byAgent = new Map<string, PricedTurn[]>()
    let mainTurns = 0
    for (const p of turns) {
      pushTo(byModel, p.model, p)
      pushTo(byAgent, p.turn.agentKey, p)
      if (p.turn.agent === 0) mainTurns += 1
    }
    const allAgents = [...byAgent.entries()].map(([agentKey, ps]) => agentOf(agentKey, ps, estUsd))
    const ttls = new Set(turns.map(p => p.ttl))
    const first = group[0] as SessionRecord
    const summary: SessionSummary = {
      sessionId,
      id8: sessionId.slice(0, 8),
      openedAt: first.openedAt,
      lastAt: Number.isFinite(lastAt) ? lastAt : first.openedAt,
      repoKey,
      entrypoint,
      segments: group.length,
      engagedS,
      prompts: admitted.length,
      turnsMain: mainTurns,
      turnsAgent: turns.length - mainTurns,
      tokens,
      estUsd,
      unpricedTurns: turns.filter(p => p.usd === null).length,
      engineUsd: sessionEngineUsd(group),
      models: capModels([...byModel.entries()].map(([model, ps]) => ({ model, turns: ps.length, estUsd: sumUsd(ps), merged: 0 }))),
      agents: capAgents(allAgents),
      recommendations: [],
    }
    // The rules read every agent, not the capped list.
    built.push({ summary, facts: { turns, ttl: ttls.size === 1 ? (turns[0] as PricedTurn).ttl : ttls.size === 0 ? defaultTtl : null, engagedS, estUsd, agents: allAgents } })
  }
  const rates = built.filter(b => b.summary.engagedS >= MIN_RATE_S && b.summary.estUsd !== null).map(b => (b.summary.estUsd as number) / (b.summary.engagedS / 3600))
  const medianUsdPerHour = median(rates)
  const scope: ScopeFacts = { sessionsInScope: built.length, medianUsdPerHour }
  for (const b of built) b.summary.recommendations = recommendationsFor(b.facts, scope)
  const sessions = built.map(b => b.summary).sort((a, b) => b.openedAt - a.openedAt || cmp(a.sessionId, b.sessionId))
  return { sessions, medianUsdPerHour }
}

/**
 * CONTRACT (W1). The whole rollup: the current ISO week's rows (status from
 * review.ts `rowStatus`, frozen rows missing live reported as `changed` with
 * zero seconds), the queue (one row per repoRef unmapped this week, with
 * `isNewLocation`), today's seconds, spend for this and last month, the
 * engine cost sum, flags, review statuses for this and last week, day totals,
 * and Health (denied by reason, redactions, rows dropped, counts).
 *
 * Scope: rows, queue, day totals and the week sums cover the ISO week holding
 * today; reviews cover this and last week; spend and the engine cost go by
 * month; flags and Health cover every segment passed in. Health's rowsDropped
 * counts events and turns past the caps plus rows a decode found malformed.
 */
export const computeRollup = (input: RollupInput): Rollup => {
  const { now, zone, params, mapping, segments } = input
  const today = localDate(now, zone)
  const week = isoWeek(today)
  const lastWeek = isoWeek(addDays(today, -7))
  const month = monthOfTs(now, zone)
  const lastMonth = previousMonth(month)

  const byKey = new Map<string, SessionRecord>()
  const admitted: UnionEvent[] = []
  for (const r of segments) {
    byKey.set(segmentKey(r.sessionId, r.seg), r)
    for (const ev of r.events) if (ev.admit === 1) admitted.push({ ts: ev.ts, sessionId: r.sessionId, seg: r.seg, seq: ev.seq })
  }
  const blocks = buildBlocks(admitted, params, zone)
  const blocksByStart = new Map(blocks.map(b => [b.startTs, b] as const))
  const allocations = allocate(blocks, byKey, mapping)

  const reviewOf = (w: string): ReviewFile => input.reviews.get(w) ?? emptyReview(w)
  const weekRows = weekRowsFor(week, allocations, blocksByStart, byKey, mapping, reviewOf(week), zone)
  const lastWeekRows = weekRowsFor(lastWeek, allocations, blocksByStart, byKey, mapping, reviewOf(lastWeek), zone)
  const changed = (rows: readonly WeekRow[]): number => rows.filter(r => r.status === 'changed').length

  const dates = weekDates(week)
  const dayTotals: Record<string, number> = Object.fromEntries(dates.map(d => [d, 0]))
  let weekUnmappedS = 0
  let weekIgnoredS = 0
  let todayS = 0
  for (const a of allocations) {
    if (a.date === today) todayS += a.seconds
    if (!Object.prototype.hasOwnProperty.call(dayTotals, a.date)) continue
    dayTotals[a.date] = (dayTotals[a.date] as number) + a.seconds
    if (a.component === UNMAPPED) weekUnmappedS += a.seconds
    if (a.component === IGNORED) weekIgnoredS += a.seconds
  }

  const spend = spendByMonth(segments, mapping, input.defaultTtl, zone)
  const spendMonth = spend.filter(r => r.month === month)
  const spendLastMonth = spend.filter(r => r.month === lastMonth)

  let engineUsd = 0
  let engineSegments = 0
  for (const r of segments) {
    const own = ownEngineCost(r)
    if (own === null || monthOfTs(r.openedAt, zone) !== month) continue
    engineUsd += own
    engineSegments += 1
  }
  const engineCost: EngineCost | null = engineSegments > 0 ? { usd: engineUsd, segments: engineSegments } : null

  const denied = new Map<string, number>()
  let redactions = 0
  let rowsDropped = 0
  for (const r of segments) {
    for (const ev of r.events) if (ev.admit !== 1) add(denied, ev.reason, 1)
    redactions += r.redactions
    rowsDropped += r.eventsDropped + r.turnsDropped + r.malformedRows
  }

  const summarized = summarizeSessions(segments, params, zone, input.defaultTtl)
  const shown = summarized.sessions.slice(0, SESSIONS_CAP)
  const thisSession = input.current ? (summarized.sessions.find(x => x.sessionId === input.current?.sessionId) ?? null) : null
  // Full summaries only where a view can show one now: this session, the selected one, the newest rows.
  const detailIds = new Set(shown.slice(0, DETAILS_ROWS).map(x => x.sessionId))
  if (thisSession) detailIds.add(thisSession.sessionId)
  if (input.selected) detailIds.add(input.selected)
  const details: Record<string, SessionSummary> = {}
  for (const x of shown) if (detailIds.has(x.sessionId)) details[x.sessionId] = x
  if (thisSession) details[thisSession.sessionId] = thisSession

  return {
    at: now,
    zone,
    method: methodString(params, zone),
    params,
    week,
    today,
    weekRows,
    weekTotalS: Object.values(dayTotals).reduce((a, b) => a + b, 0),
    weekUnmappedS,
    weekIgnoredS,
    todayS,
    queue: queueFor(new Set(dates), allocations, byKey, mapping, zone),
    spendMonth,
    spendLastMonth,
    spendMonthUsd: monthUsd(spendMonth),
    engineCost,
    deadlines: input.deadlines,
    reviews: [reviewStatus(reviewOf(week), changed(weekRows)), reviewStatus(reviewOf(lastWeek), changed(lastWeekRows))],
    flags: flags(blocks, segments, params, zone),
    health: {
      zone,
      zoneDetectedNow: input.health.zoneDetectedNow,
      pricesAsOf: PRICES_AS_OF,
      sessionsInScope: new Set(segments.map(r => r.sessionId)).size,
      segmentsInScope: segments.length,
      unreadable: input.health.unreadable,
      deniedByReason: Object.fromEntries([...denied.entries()].sort((a, b) => cmp(a[0], b[0]))),
      redactions,
      rowsDropped,
      daysSinceExport: input.health.daysSinceExport,
      storeIsLink: input.health.storeIsLink,
      lockStaleMs: input.health.lockStaleMs,
      bridge: input.health.bridge,
      readOnly: input.health.readOnly,
    },
    dayTotals,
    sessions: shown.map(sessionRow),
    details,
    thisSessionId: thisSession?.sessionId ?? null,
    medianUsdPerHour: summarized.medianUsdPerHour,
    engineUsd: thisSession?.engineUsd ?? null,
  }
}
