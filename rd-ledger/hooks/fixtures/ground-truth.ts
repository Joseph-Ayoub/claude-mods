// rd-ledger ground-truth fixtures F1–F4 (SPEC §11.1), hand-computed by the
// tester seat and re-checked by the lead. Zone America/New_York. Parameters:
// gap 1800 s, floor 60 s, max block 14400 s, day flag 14 h. Synthetic ids only.
//
// F1: D1 = local midnight 2026-10-11 (Sunday, EDT) = 2026-10-11T04:00:00Z =
// 1_791_691_200 s. Day 2 (Monday 2026-10-12) starts at D1 + 86400. Sessions:
// S1 repo `alpha` → component `comp-alpha`; S2 repo `beta` → `comp-beta`; S3
// repo `gamma` unmapped. Both components belong to entity `acme`.
//
// Arithmetic (t = seconds after D1):
//  B1 = e1..e5 (t 32400..35700; e4→e5 gap exactly 1800 merges; e5→e6 1801 splits):
//     3300 s over 5 events = 660 each; S1 has e1,e3,e5 = 1980; S2 has e2,e4 = 1320.
//  B2 = e6 alone: floored to 60 s (endTs = startTs).
//  Chain e7..e16 spans 15240 s > 14400: the unique largest gap (1800) is e10→e11,
//     so P1 = e7..e10 (5040 s, 1260 each: S2 e7,e9 = 2520; S3 e8,e10 = 2520) and
//     P2 = e11..e16 (8400 s), which crosses midnight at t 86400: 4 events before,
//     2 after → 5600 s to 10-11 (1400 each: S2 e11,e13 = 2800; S3 e12,e14 = 2800)
//     and 2800 s to 10-12 (1400 each: S2 e15 = 1400; S3 e16 = 1400).
//  B6 = e17..e19 (1000 s over 3 events): base 333 each, remainder 1 to the earliest
//     (e17 = 334): S1 e17+e19 = 667; S2 e18 = 333.
//  Day totals: 10-11 = 3300+60+5040+5600 = 14000; 10-12 = 2800+1000 = 3800.
//  Flag: block-over-4h dated 2026-10-11 (chain's first event). No day-over-cap.
//  Denied X1 (task-notification at t 36600) would merge B1 and B2 if admitted;
//  denied X2 (sdk automation at t 43200) would add a 60 s block.

import type { UnionParams } from '../../types'

export const ZONE = 'America/New_York'
export const PARAMS: UnionParams = { gapS: 1800, floorS: 60, maxBlockS: 14_400, dayFlagH: 14 }
export const D1 = 1_791_691_200_000
export const S1 = '11111111-aaaa-4bbb-8ccc-000000000001'
export const S2 = '22222222-aaaa-4bbb-8ccc-000000000002'
export const S3 = '33333333-aaaa-4bbb-8ccc-000000000003'
export const SEG = 'seg1'
const at = (t: number) => D1 + t * 1000

export type F1Event = { id: string; sessionId: string; t: number; admit: 0 | 1; origin: string; queued: 0 | 1 }

export const F1_EVENTS: readonly F1Event[] = [
  { id: 'e1', sessionId: S1, t: 32400, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e2', sessionId: S2, t: 33000, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e3', sessionId: S1, t: 33900, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e4', sessionId: S2, t: 33900, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e5', sessionId: S1, t: 35700, admit: 1, origin: 'composer', queued: 1 },
  { id: 'X1', sessionId: S3, t: 36600, admit: 0, origin: 'task-notification', queued: 0 },
  { id: 'e6', sessionId: S3, t: 37501, admit: 1, origin: 'composer', queued: 0 },
  { id: 'X2', sessionId: S2, t: 43200, admit: 0, origin: 'sdk', queued: 0 },
  { id: 'e7', sessionId: S2, t: 73800, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e8', sessionId: S3, t: 75480, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e9', sessionId: S2, t: 77160, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e10', sessionId: S3, t: 78840, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e11', sessionId: S2, t: 80640, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e12', sessionId: S3, t: 82320, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e13', sessionId: S2, t: 84000, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e14', sessionId: S3, t: 85680, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e15', sessionId: S2, t: 87360, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e16', sessionId: S3, t: 89040, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e17', sessionId: S1, t: 118800, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e18', sessionId: S2, t: 119300, admit: 1, origin: 'composer', queued: 0 },
  { id: 'e19', sessionId: S1, t: 119800, admit: 1, origin: 'composer', queued: 0 },
]

/** The admitted events as union.ts takes them (seq = position in F1_EVENTS, 1-based). */
export const F1_UNION_EVENTS = F1_EVENTS.map((e, i) => ({ ts: at(e.t), sessionId: e.sessionId, seg: SEG, seq: i + 1, admit: e.admit })).filter(e => e.admit === 1).map(({ admit: _a, ...rest }) => rest)

export const F1_EXPECTED_BLOCKS: readonly { date: string; startT: number; endT: number; seconds: number; eventIds: string[]; flags: string[] }[] = [
  { date: '2026-10-11', startT: 32400, endT: 35700, seconds: 3300, eventIds: ['e1', 'e2', 'e3', 'e4', 'e5'], flags: [] },
  { date: '2026-10-11', startT: 37501, endT: 37501, seconds: 60, eventIds: ['e6'], flags: [] },
  { date: '2026-10-11', startT: 73800, endT: 78840, seconds: 5040, eventIds: ['e7', 'e8', 'e9', 'e10'], flags: ['over-4h'] },
  { date: '2026-10-11', startT: 80640, endT: 86400, seconds: 5600, eventIds: ['e11', 'e12', 'e13', 'e14'], flags: ['over-4h'] },
  { date: '2026-10-12', startT: 86400, endT: 89040, seconds: 2800, eventIds: ['e15', 'e16'], flags: ['over-4h'] },
  { date: '2026-10-12', startT: 118800, endT: 119800, seconds: 1000, eventIds: ['e17', 'e18', 'e19'], flags: [] },
]

/** Per (date, session) allocation seconds. */
export const F1_EXPECTED_ALLOCATIONS: readonly { date: string; sessionId: string; component: string; seconds: number }[] = [
  { date: '2026-10-11', sessionId: S1, component: 'comp-alpha', seconds: 1980 },
  { date: '2026-10-11', sessionId: S2, component: 'comp-beta', seconds: 1320 + 2520 + 2800 },
  { date: '2026-10-11', sessionId: S3, component: '__unmapped__', seconds: 60 + 2520 + 2800 },
  { date: '2026-10-12', sessionId: S2, component: 'comp-beta', seconds: 1400 + 333 },
  { date: '2026-10-12', sessionId: S3, component: '__unmapped__', seconds: 1400 },
  { date: '2026-10-12', sessionId: S1, component: 'comp-alpha', seconds: 667 },
]

export const F1_DAY_TOTALS = { '2026-10-11': 14000, '2026-10-12': 3800 } as const
export const F1_EXPECTED_FLAGS = [{ kind: 'block-over-4h', date: '2026-10-11' }] as const
export const F1_MAPPING_JSON = JSON.stringify({
  v: 1, gen: 1,
  entities: { acme: { name: 'Example Co', filing: 'c-corp' } },
  components: { 'comp-alpha': { name: 'Alpha', entity: 'acme', activity: 'direct_research', poe: true, rdt: 'comp-alpha' }, 'comp-beta': { name: 'Beta', entity: 'acme', activity: 'direct_support', poe: false, rdt: null } },
  repos: { alpha: { component: 'comp-alpha' }, beta: { component: 'comp-beta' } },
  pretag: [],
})
/** Repo keys per session for F1 (no root hash: bare keys). */
export const F1_REPOS: Record<string, string> = { [S1]: 'alpha', [S2]: 'beta', [S3]: 'gamma' }

/** F2: ten events 1800 s apart from 2026-10-13T14:00:00Z; the midpoint tie rule cuts at i = 5 → two 7200 s pieces = 14400 s (an earliest-tie rule would give 14460). */
export const F2_START = Date.UTC(2026, 9, 13, 14, 0, 0)
export const F2_EVENTS = Array.from({ length: 10 }, (_, k) => ({ ts: F2_START + k * 1800_000, sessionId: S1, seg: SEG, seq: k + 1 }))
export const F2_EXPECTED_TOTAL = 14400

/** F3: spring-forward 2026-03-08 in New York (EST until 07:00Z, then EDT). */
export const F3_EVENTS = [
  { ts: Date.UTC(2026, 2, 8, 4, 50), sessionId: S1, seg: SEG, seq: 1 }, // Mar 7 23:50 EST
  { ts: Date.UTC(2026, 2, 8, 5, 10), sessionId: S1, seg: SEG, seq: 2 }, // Mar 8 00:10 EST → one block across midnight, 600/600
  { ts: Date.UTC(2026, 2, 8, 6, 40), sessionId: S1, seg: SEG, seq: 3 }, // 01:40 EST
  { ts: Date.UTC(2026, 2, 8, 7, 10), sessionId: S1, seg: SEG, seq: 4 }, // 03:10 EDT: elapsed 1800 s → merges (a local-clock difference would read 90 min)
  { ts: Date.UTC(2026, 2, 9, 3, 50), sessionId: S1, seg: SEG, seq: 5 }, // Mar 8 23:50 EDT
  { ts: Date.UTC(2026, 2, 9, 4, 10), sessionId: S1, seg: SEG, seq: 6 }, // Mar 9 00:10 EDT → 600/600
]
export const F3_DAY_TOTALS = { '2026-03-07': 600, '2026-03-08': 3000, '2026-03-09': 600 } as const
export const F3_DAY_LENGTH_MS = 82_800_000

/** F4: fall-back 2026-11-01 in New York (EDT until 06:00Z, then EST). */
export const F4_EVENTS = [
  { ts: Date.UTC(2026, 10, 1, 5, 10), sessionId: S1, seg: SEG, seq: 1 }, // 01:10 EDT
  { ts: Date.UTC(2026, 10, 1, 5, 35), sessionId: S1, seg: SEG, seq: 2 }, // 01:35 EDT: merges (1500 s)
  { ts: Date.UTC(2026, 10, 1, 6, 10), sessionId: S1, seg: SEG, seq: 3 }, // 01:10 EST: 2100 s later → splits; a local-time sort would misorder it
]
export const F4_EXPECTED_BLOCK_SECONDS = [1500, 60] as const
export const F4_DAY_TOTALS = { '2026-11-01': 1560 } as const
export const F4_DAY_LENGTH_MS = 90_000_000
