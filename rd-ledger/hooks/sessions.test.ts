// rd-ledger: the per-session summaries and the cost recommendations (SPEC §6.1a,
// §6.1b). Ground-truth style: every expected figure below is worked by hand
// from the list prices in prices.ts, never read back from the code under test.

import { describe, expect, test } from 'claude-code/testing'

import type { AgentSummary, SessionRecord, TurnRecord } from '../types'
import { D1, PARAMS, ZONE } from './fixtures/ground-truth'
import { priceTurn } from './prices'
import { AGENTS_CAP, median, MODELS_CAP, pausedTurns, sessionEngineUsd, recAgentTier, recCacheTtl1h, recCacheTtl5m, recContextSize, recCostPerHour, recErroredTurns, recommendationsFor, sessionRow, summarizeSessions } from './rollup'
import type { PricedTurn, SessionFacts } from './rollup'
import { newSegment } from './store'

const M = 1_000_000
const MIN = 60_000
/** 2026-10-11 10:00 in New York. */
const T = D1 + 10 * 3_600_000
const SA = 'aaaaaaaa-1111-4111-8111-000000000001'
const SB = 'bbbbbbbb-2222-4222-8222-000000000002'
const AGENT = 'abcdef01'
const cents = (usd: number | null | undefined): number | null => (usd === null || usd === undefined ? null : Math.round(usd * 100))

const turn = (over: Partial<TurnRecord>): TurnRecord => ({ seq: 1, ts: T, endTs: T + 10_000, turnId: 'turn-1', agentKey: '', agent: 0, model: 'claude-opus-5-5', in: 0, out: 0, cr: 0, cw: 0, reason: 'answer', ...over })
const segment = (sessionId: string, openedAt: number, over: Partial<SessionRecord>): SessionRecord => ({
  ...newSegment({ sessionId, openedAt, source: 'startup', entrypoint: 'cli', interactive: true, surface: 'cli', repoKey: 'alpha', repoKind: 'repo', rootHash: null, cwdBase: 'alpha', branch: 'main', model: 'claude-opus-5-5', engineCostAtOpen: null }),
  ...over,
})
const ev = (seq: number, ts: number, admit: 0 | 1 = 1) => ({ seq, ts, origin: admit ? 'composer' : 'task-notification', admit, reason: admit ? 'human' : 'origin:task-notification', queued: 0 as const })

/**
 * Session A, two segments (a resume): four admitted prompts and one denied.
 * Prompts at 10:00, 10:10, 10:20 make one 1200 s block; the lone 12:01:40
 * prompt is floored to 60 s: engaged 1260 s.
 * claude-opus-5-5 is $4 in, $20 out, $0.20 cache read, $5 cache write (5m) per MTok;
 * claude-haiku-4-5 is $1 in, $5 out.
 *   t1 main opus: 100k in, 10k out, 200k cw  = 0.40 + 0.20 + 1.00 = $1.60
 *   t2 main opus: 5k out, 1M cr              = 0.10 + 0.20        = $0.30
 *   t3 agent haiku: 1M in, 100k out          = 1.00 + 0.50        = $1.50
 *   t4 main mystery-model: 500 in            = unpriced
 *   t5 agent haiku: 200k out                 = $1.00
 * Estimate $4.40. The engine figure is the latest segment's: the resumed
 * process started its own count at 0 and reached $1.25 (the first process's
 * $2.00 is not included, as /cost in the resumed process would not show it).
 */
const sessionA = (): SessionRecord[] => [
  segment(SA, T - MIN, {
    closedAt: T + 3_600_000,
    engineCostAtOpen: 0,
    engineCostUsd: 2,
    events: [ev(1, T), ev(2, T + 10 * MIN), ev(3, T + 15 * MIN, 0), ev(4, T + 20 * MIN)],
    turns: [
      turn({ seq: 5, ts: T + 10_000, endTs: T + 20_000, turnId: 't1', in: 100_000, out: 10_000, cw: 200_000 }),
      turn({ seq: 6, ts: T + 30_000, endTs: T + 40_000, turnId: 't2', out: 5_000, cr: M }),
      turn({ seq: 7, ts: T + 50_000, endTs: T + 60_000, turnId: 't3', agentKey: AGENT, agent: 1, model: 'claude-haiku-4-5', in: M, out: 100_000 }),
    ],
  }),
  segment(SA, T + 2 * 3_600_000, {
    seg: 'segb',
    entrypoint: 'claude-desktop',
    engineCostAtOpen: 0,
    engineCostUsd: 1.25,
    events: [ev(1, T + 2 * 3_600_000 + 100_000)],
    turns: [
      turn({ seq: 2, ts: T + 7_250_000, endTs: T + 7_260_000, turnId: 't4', model: 'mystery-model', in: 500 }),
      turn({ seq: 3, ts: T + 7_350_000, endTs: T + 7_400_000, turnId: 't5', agentKey: AGENT, agent: 1, model: 'claude-haiku-4-5', out: 200_000 }),
    ],
  }),
]

describe('summarizeSessions', () => {
  test('ground truth: engaged seconds, counts, tokens, both costs, models and agent shares', async () => {
    const empty = segment(SB, T + 24 * 3_600_000, { repoKey: null })
    const { sessions, medianUsdPerHour } = summarizeSessions([...sessionA(), empty], PARAMS, ZONE, '5m')
    expect(sessions.map(s => s.sessionId)).toEqual([SB, SA])
    const a = sessions[1]
    if (!a) throw new Error('session A missing')
    expect(a).toMatchObject({ id8: 'aaaaaaaa', openedAt: T - MIN, lastAt: T + 7_400_000, repoKey: 'alpha', entrypoint: 'claude-desktop', segments: 2, engagedS: 1260, prompts: 4, turnsMain: 3, turnsAgent: 2, unpricedTurns: 1 })
    expect(a.tokens).toEqual({ in: 1_100_500, out: 315_000, cr: M, cw: 200_000 })
    expect(cents(a.estUsd)).toBe(440)
    expect(cents(a.engineUsd)).toBe(125)
    expect(a.models.map(m => [m.model, m.turns, cents(m.estUsd)])).toEqual([
      ['claude-haiku-4-5', 2, 250],
      ['claude-opus-5-5', 2, 190],
      ['mystery-model', 1, null],
    ])
    const [main, sub] = a.agents as [AgentSummary, AgentSummary]
    expect(main).toMatchObject({ agentKey: '', turns: 3, model: 'claude-opus-5-5', tokens: { in: 100_500, out: 15_000, cr: M, cw: 200_000 } })
    expect(cents(main.estUsd)).toBe(190)
    expect(Math.abs(main.share - (1.9 / 4.4)) < 1e-9).toBe(true)
    expect(sub).toMatchObject({ agentKey: AGENT, turns: 2, model: 'claude-haiku-4-5' })
    expect(cents(sub.estUsd)).toBe(250)
    expect(Math.abs(sub.share - (2.5 / 4.4)) < 1e-9).toBe(true)
    // Paused turns (t4, t5) carry no cache writes, so the 1h TTL would only cost more: no line.
    expect(a.recommendations).toEqual([])
    expect(sessionRow(a)).toEqual({ sessionId: SA, id8: 'aaaaaaaa', openedAt: T - MIN, lastAt: T + 7_400_000, repoKey: 'alpha', engagedS: 1260, turns: 5, agentCount: 1, engineUsd: 1.25, estUsd: a.estUsd, recCount: 0 })

    const b = sessions[0]
    expect(b).toMatchObject({ engagedS: 0, prompts: 0, estUsd: 0, engineUsd: null, repoKey: null, models: [], agents: [], recommendations: [] })
    // Only A has a quarter hour engaged: $4.40 over 0.35 h.
    expect(Math.abs((medianUsdPerHour ?? Number.NaN) - 4.4 / 0.35) < 1e-9).toBe(true)
  })

  test('a session whose every turn is unpriced has a null estimate, never $0', async () => {
    const r = segment(SA, T, { turns: [turn({ model: 'mystery-model', in: M })] })
    const [s] = summarizeSessions([r], PARAMS, ZONE, '5m').sessions
    expect(s?.estUsd).toBeNull()
    expect(s?.unpricedTurns).toBe(1)
    expect(s?.agents[0]?.share).toBe(0)
  })

  test('the TTL in force per turn prices cache writes: 1h from its change point on', async () => {
    const r = segment(SA, T, {
      cacheTtlChanges: [{ ts: T + 30_000, ttl: '1h' }],
      turns: [turn({ ts: T + 10_000, turnId: 'a', cw: M }), turn({ ts: T + 40_000, turnId: 'b', cw: M })],
    })
    // $5.00 at 1.25x then $8.00 at 2x.
    expect(cents(summarizeSessions([r], PARAMS, ZONE, '5m').sessions[0]?.estUsd)).toBe(1300)
  })

  test('agents past the twelfth and models past the eighth fold into one others row; the list stays complete in its sums', async () => {
    // 14 subagents with $1..$14 of input each on claude-haiku-4-5 ($1/MTok); 10 models of 1 turn each.
    const agents = Array.from({ length: 14 }, (_, i) => turn({ seq: i + 1, turnId: `a${i}`, agentKey: (0xa0000000 + i).toString(16), agent: 1, model: 'claude-haiku-4-5', in: (i + 1) * M }))
    const models = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-3-haiku', 'claude-3-5-haiku', 'claude-opus-4-1', 'mystery-model'].map((model, i) => turn({ seq: 100 + i, turnId: `m${i}`, model, in: 1000 }))
    const [s] = summarizeSessions([segment(SA, T, { turns: [...agents, ...models] })], PARAMS, ZONE, '5m').sessions
    if (!s) throw new Error('no session')
    expect(s.agents).toHaveLength(1 + AGENTS_CAP + 1)
    const others = s.agents.at(-1) as AgentSummary
    // The two cheapest subagents ($1 and $2) fold together.
    expect(others).toMatchObject({ agentKey: 'others', merged: 2, turns: 2, model: null })
    expect(cents(others.estUsd)).toBe(300)
    expect(s.agents.reduce((n, a) => n + a.turns, 0)).toBe(24)
    expect(sessionRow(s).agentCount).toBe(14)
    expect(s.models).toHaveLength(MODELS_CAP + 1)
    expect(s.models.at(-1)).toMatchObject({ model: 'others', merged: 2 })
    expect(s.models.reduce((n, m) => n + m.turns, 0)).toBe(24)
  })

  test('64 000 turns in one session summarize in well under a few seconds (groups built with push)', async () => {
    const turns = Array.from({ length: 64_000 }, (_, i) => turn({ seq: i + 1, turnId: `t${i}`, ts: T + i * 1000, endTs: T + i * 1000 + 500, agentKey: i % 2 ? AGENT : '', agent: (i % 2) as 0 | 1, in: 10 }))
    const started = Date.now()
    const [s] = summarizeSessions([segment(SA, T, { turns })], PARAMS, ZONE, '5m').sessions
    expect(s?.turnsMain).toBe(32_000)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('the engine figure leaves out what a cleared or forked session inherited, and keeps the rest', async () => {
    const opened = (source: SessionRecord['source']): SessionRecord[] => [
      { ...segment(SA, T, { engineCostAtOpen: 96.38, engineCostUsd: 98 }), source },
      segment(SA, T + 3_600_000, { seg: 'later', source, engineCostAtOpen: 98, engineCostUsd: 100.08 }),
    ]
    // /clear at $96.38 into the process's running total: this session cost 100.08 - 96.38.
    expect(cents(sessionEngineUsd(opened('clear')))).toBe(370)
    expect(cents(sessionEngineUsd(opened('fork')))).toBe(370)
    expect(cents(summarizeSessions(opened('clear'), PARAMS, ZONE, '5m').sessions[0]?.engineUsd)).toBe(370)
    // A startup counts from 0, and an unknown open means recording began mid-session: the total is this session's.
    expect(cents(sessionEngineUsd(opened('startup')))).toBe(10008)
    expect(cents(sessionEngineUsd(opened('unknown')))).toBe(10008)
    expect(cents(sessionEngineUsd(opened('resume')))).toBe(10008)
    expect(sessionEngineUsd([segment(SA, T, { source: 'clear', engineCostAtOpen: 5, engineCostUsd: null })])).toBeNull()
  })

  test('median: odd, even and empty', async () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

// --- the rules, each positive and negative -----------------------------------------

const pt = (over: Partial<TurnRecord>, ttl: '5m' | '1h' = '5m'): PricedTurn => {
  const t = turn(over)
  return { turn: t, model: t.model ?? 'unknown', ttl, usd: priceTurn(t, ttl).usd }
}
/** The one TTL every turn shares, else null (summarizeSessions' rule); 5m for no turns. */
const uniformTtl = (turns: readonly PricedTurn[]): '5m' | '1h' | null => {
  const ttls = new Set(turns.map(p => p.ttl))
  return ttls.size === 0 ? '5m' : ttls.size === 1 ? (turns[0] as PricedTurn).ttl : null
}
/** Facts as summarizeSessions builds them: the estimate summed, one agent row per agentKey. */
const facts = (turns: PricedTurn[], ttl: '5m' | '1h' | null = uniformTtl(turns), engagedS = 3600): SessionFacts => {
  const priced = turns.filter(p => p.usd !== null)
  const estUsd = priced.length === 0 && turns.length > 0 ? null : priced.reduce((s, p) => s + (p.usd as number), 0)
  const keys = [...new Set(turns.map(p => p.turn.agentKey))]
  const agents: AgentSummary[] = keys.map(agentKey => {
    const mine = turns.filter(p => p.turn.agentKey === agentKey)
    const usd = mine.reduce((s, p) => s + (p.usd ?? 0), 0)
    return { agentKey, merged: 0, turns: mine.length, model: mine[0]?.model ?? null, tokens: { in: 0, out: 0, cr: 0, cw: 0 }, estUsd: usd, share: estUsd ? usd / estUsd : 0 }
  })
  return { turns, ttl, engagedS, estUsd, agents }
}
/** `n` main-loop turns `apart` ms after the previous one ended, each 10 s long. */
const chain = (n: number, apart: number, over: Partial<TurnRecord> = {}, ttl: '5m' | '1h' = '5m'): PricedTurn[] =>
  Array.from({ length: n }, (_, i) => pt({ seq: i + 1, turnId: `t${i}`, ts: T + i * (apart + 10_000), endTs: T + i * (apart + 10_000) + 10_000, ...over }, ttl))

describe('recommendations', () => {
  test('pausedTurns: per agent chain, more than 5 minutes after the previous end', async () => {
    const turns = [pt({ turnId: 'a', ts: T, endTs: T + 1000 }), pt({ turnId: 'b', agentKey: AGENT, agent: 1, ts: T + 2000, endTs: T + 3000 }), pt({ turnId: 'c', ts: T + 1000 + 5 * MIN, endTs: T + 1000 + 6 * MIN }), pt({ turnId: 'd', agentKey: AGENT, agent: 1, ts: T + 3001 + 5 * MIN, endTs: T + 4000 + 5 * MIN })]
    // c starts exactly 5 minutes after a ended (not paused); d 5 min + 1 ms after b (paused).
    expect([...pausedTurns(turns)].map(([p, maxCtx]) => [p.turn.turnId, maxCtx])).toEqual([['d', 0]])
    // maxCtx is the largest cr + cw any earlier turn of the chain built, not the previous turn's alone.
    const grew = [pt({ turnId: 'x', ts: T, endTs: T + 1000, cr: 300_000, cw: 200_000 }), pt({ turnId: 'y', ts: T + 2000, endTs: T + 3000, cr: 0, cw: 10_000 }), pt({ turnId: 'z', ts: T + 3001 + 5 * MIN, endTs: T + 4000 + 5 * MIN })]
    expect([...pausedTurns(grew).values()]).toEqual([500_000])
  })

  test('cache-ttl-1h: 9 of 10 turns paused under 5m, each re-writing the 1M its chain had cached, nets $40.20', async () => {
    // Each paused turn's avoidable rewrite is min(cw 1M, maxCtx 1M) = 1M: 9 x 1M x (1.25 x $4 - $0.20) = $43.20;
    // the one turn that was not paused would pay the 1h premium on its 1M write: 1M x 0.75 x $4 = $3.00.
    const r = recCacheTtl1h(facts(chain(10, 10 * MIN, { cw: M })))
    expect(r?.code).toBe('cache-ttl-1h')
    expect(cents(r?.estSavingUsd)).toBe(4020)
    expect(r?.text).toBe('9 of 10 turns started more than 5 minutes after the one before; assuming the paused turns re-wrote their context, a 1-hour cache TTL would have saved about $40.20 here (estimate).')
    expect(recCacheTtl1h(facts(chain(10, MIN, { cw: M })))).toBeNull()
    expect(recCacheTtl1h(facts(chain(10, 10 * MIN, { cw: M }, '1h')))).toBeNull()
    // Small rewrites (1k each, under maxCtx) save cents against one 10M write's premium.
    expect(recCacheTtl1h(facts([pt({ turnId: 'big', ts: T - 2 * MIN, endTs: T - MIN, cw: 10 * M }), ...chain(9, 10 * MIN, { cw: 1000 })]))).toBeNull()
  })

  test('neither cache rule speaks when the TTL changed during the session', async () => {
    const mixed = [...chain(5, 10 * MIN, { cw: M }), ...chain(5, 10 * MIN, { cw: M }, '1h').map(p => pt({ ...p.turn, ts: p.turn.ts + 100 * MIN, endTs: p.turn.endTs + 100 * MIN }, '1h'))]
    expect(facts(mixed).ttl).toBeNull()
    expect(recCacheTtl1h(facts(mixed))).toBeNull()
    expect(recCacheTtl5m(facts(mixed))).toBeNull()
    // The same turns all under 5m do speak.
    expect(recCacheTtl1h(facts(mixed.map(p => pt(p.turn, '5m'))))?.code).toBe('cache-ttl-1h')
  })

  test('cache-ttl-5m: no pauses under 1h with 1M cache writes each nets $30.00', async () => {
    const r = recCacheTtl5m(facts(chain(10, MIN, { cw: M }, '1h')))
    expect(r?.code).toBe('cache-ttl-5m')
    expect(cents(r?.estSavingUsd)).toBe(3000)
    expect(r?.text).toBe('Only 0 of 10 turns came after a pause over 5 minutes; assuming the paused turns would re-write the context they read, the 5-minute cache TTL would have saved about $30.00 here (estimate).')
    // One pause in ten is 10 %, not under it.
    const one = chain(10, MIN, { cw: M }, '1h')
    const shifted = one.map((p, i) => (i === 9 ? pt({ ...p.turn, ts: p.turn.ts + 10 * MIN, endTs: p.turn.endTs + 10 * MIN }, '1h') : p))
    expect(recCacheTtl5m(facts(shifted))).toBeNull()
    expect(recCacheTtl5m(facts(chain(10, MIN, { cw: M })))).toBeNull()
  })

  test("cache-ttl-1h: a paused turn's avoidable rewrite is capped by the largest context its chain built", async () => {
    // Under 5m: a 100k context, then 3 paused turns each writing 1M. Each counts min(1M, maxCtx) where maxCtx grows:
    // turn 2 sees 100k, turn 3 sees 1M (turn 2's write), turn 4 sees 1M: 2.1M x $4.80 = $10.08; the unpaused first turn's
    // 100k write would pay 100k x $3.00 = $0.30. Net $9.78.
    const turns = [pt({ turnId: 'a', ts: T, endTs: T + 1000, cw: 100_000 }), ...[1, 2, 3].map(i => pt({ turnId: `p${i}`, ts: T + i * 20 * MIN, endTs: T + i * 20 * MIN + 1000, cw: M }))]
    expect(cents(recCacheTtl1h(facts(turns))?.estSavingUsd)).toBe(978)
  })

  test("cache-ttl-5m stays silent on the verifier's literal counterexample: one pause re-reading 1M outweighs the premium saved", async () => {
    // 20 claude-opus-5-5 turns under 1h: 19 one minute apart, each writing 50k and reading nothing, then one 20 minutes
    // later reading 1M and writing nothing. Saved premium: 19 x 50k x 0.75 x $4 / M = $2.85. Forced rewrite under 5m:
    // the whole read, 1M x (1.25 x $4 - $0.20) / M = $4.80. Net -$1.95: no line.
    const flat = Array.from({ length: 19 }, (_, i) => pt({ seq: i + 1, turnId: `f${i}`, ts: T + i * 70_000, endTs: T + i * 70_000 + 10_000, cw: 50_000 }, '1h'))
    const end = (flat[18] as PricedTurn).turn.endTs
    const f = facts([...flat, pt({ seq: 20, turnId: 'late', ts: end + 20 * MIN, endTs: end + 21 * MIN, cr: M, cw: 0 }, '1h')])
    expect(pausedTurns(f.turns).size).toBe(1)
    expect(recCacheTtl5m(f)).toBeNull()
    // Without the pause the same writes would recommend 5m: $2.85.
    expect(cents(recCacheTtl5m(facts(flat))?.estSavingUsd)).toBe(285)
  })

  test("cache-ttl-5m stays silent on the growing-context case: one long pause re-reading a grown context outweighs the premium saved", async () => {
    // 20 claude-opus-5-5 turns under 1h: 19 one minute apart, each writing 50k onto a context that grows by 50k a turn
    // (turn i reads i x 50k), then one 20 minutes later reading 1M and writing nothing.
    // Saved premium: 19 x 50k x 0.75 x $4 / M = $2.85. Forced rewrite under 5m: the whole 1M read x $4.80 / M = $4.80.
    // Net -$1.95: no line.
    const grown = Array.from({ length: 19 }, (_, i) => pt({ seq: i + 1, turnId: `g${i}`, ts: T + i * 70_000, endTs: T + i * 70_000 + 10_000, cr: i * 50_000, cw: 50_000 }, '1h'))
    const last = grown[18] as PricedTurn
    const paused = pt({ seq: 20, turnId: 'late', ts: last.turn.endTs + 20 * MIN, endTs: last.turn.endTs + 21 * MIN, cr: M, cw: 0 }, '1h')
    const f = facts([...grown, paused])
    expect(pausedTurns(f.turns).size).toBe(1)
    expect(recCacheTtl5m(f)).toBeNull()
  })

  test('agent-tier: a short-answer Opus subagent with most of the cost gets a Sonnet-priced line; the main loop never does', async () => {
    // Each agent turn: 100k in, 300 out on claude-opus-5-5 = 0.40 + 0.006 = $0.406; x16 = $6.496.
    // At claude-sonnet-5-5 ($2 in, $10 out): 0.20 + 0.003 = $0.203; x16 = $3.248.
    const agentTurns = chain(16, MIN, { agentKey: AGENT, agent: 1, in: 100_000, out: 300 })
    const main = chain(2, MIN, { model: 'claude-sonnet-5-5', in: 1000 })
    const [r] = recAgentTier(facts([...main, ...agentTurns]))
    expect(r?.code).toBe('agent-tier')
    expect(r?.text).toContain(`Agent ${AGENT} ran 16 turns on claude-opus-5-5 with a median of 300 output tokens`)
    expect(r?.text).toContain('$3.25 instead of $6.50')
    expect(cents(r?.estSavingUsd)).toBe(325)
    expect(recAgentTier(facts([...main, ...chain(16, MIN, { agentKey: AGENT, agent: 1, in: 100_000, out: 500 })]))).toEqual([])
    expect(recAgentTier(facts([...main, ...chain(14, MIN, { agentKey: AGENT, agent: 1, in: 100_000, out: 300 })]))).toEqual([])
    expect(recAgentTier(facts([...main, ...chain(16, MIN, { agentKey: AGENT, agent: 1, model: 'claude-haiku-4-5', in: 100_000, out: 300 })]))).toEqual([])
    expect(recAgentTier(facts(chain(16, MIN, { in: 100_000, out: 300 })))).toEqual([])
    // Under 20 % of the session: a $100 main loop dwarfs the agent.
    expect(recAgentTier(facts([...chain(1, MIN, { in: 25 * M }), ...agentTurns]))).toEqual([])
  })

  test('context-size: 20 main turns reading 200k cached tokens each; 19 is not enough', async () => {
    // 20 x 200k x $0.20 / MTok = $0.80.
    const r = recContextSize(facts(chain(20, MIN, { cr: 200_000 })))
    expect(r?.code).toBe('context-size')
    expect(r?.text).toContain('a median of 200.0k cached tokens on each of 20 turns')
    expect(r?.text).toContain('$0.80')
    expect(r?.estSavingUsd).toBeNull()
    expect(recContextSize(facts(chain(19, MIN, { cr: 200_000 })))).toBeNull()
    expect(recContextSize(facts(chain(20, MIN, { cr: 140_000 })))).toBeNull()
  })

  test('errored-turns: three errors at $4.00 each; two are not a pattern; unpriced ones say so', async () => {
    const r = recErroredTurns(facts(chain(3, MIN, { in: M, reason: 'error' })))
    expect(r?.code).toBe('errored-turns')
    expect(cents(r?.estSavingUsd)).toBe(1200)
    expect(r?.text).toBe('3 turns ended in an error and cost about $12.00 with no answer to show for it (estimate).')
    expect(recErroredTurns(facts(chain(2, MIN, { in: M, reason: 'error' })))).toBeNull()
    expect(recErroredTurns(facts(chain(3, MIN, { model: 'mystery-model', reason: 'error' })))?.estSavingUsd).toBeNull()
  })

  test('cost-per-hour: twice the median with five sessions in scope and a quarter hour engaged', async () => {
    const f = { ...facts([]), engagedS: 3600, estUsd: 25 }
    const r = recCostPerHour(f, { sessionsInScope: 5, medianUsdPerHour: 10 })
    expect(r?.code).toBe('cost-per-hour')
    expect(r?.text).toBe('This session cost $25.00 per engaged hour, at least twice the median of $10.00 across your sessions this and last month (estimate).')
    expect(cents(r?.estSavingUsd)).toBe(1500)
    expect(recCostPerHour(f, { sessionsInScope: 4, medianUsdPerHour: 10 })).toBeNull()
    expect(recCostPerHour({ ...f, estUsd: 19.99 }, { sessionsInScope: 5, medianUsdPerHour: 10 })).toBeNull()
    expect(recCostPerHour({ ...f, engagedS: 899 }, { sessionsInScope: 5, medianUsdPerHour: 10 })).toBeNull()
    expect(recCostPerHour(f, { sessionsInScope: 5, medianUsdPerHour: null })).toBeNull()
  })

  test('recommendationsFor: fixed order, plain sentences, no emoji', async () => {
    const turns = [...chain(20, 10 * MIN, { cw: M, cr: 200_000 }), ...chain(3, MIN, { in: M, reason: 'error', turnId: 'err' }).map(p => pt({ ...p.turn, ts: p.turn.ts + 400 * MIN, endTs: p.turn.endTs + 400 * MIN }))]
    const recs = recommendationsFor(facts(turns), { sessionsInScope: 1, medianUsdPerHour: null })
    expect(recs.map(r => r.code)).toEqual(['cache-ttl-1h', 'context-size', 'errored-turns'])
    for (const r of recs) expect(/\p{Extended_Pictographic}/u.test(r.text)).toBe(false)
  })
})
