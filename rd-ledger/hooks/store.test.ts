import { describe, expect, test } from 'claude-code/testing'

import { admitEvent, agentKeyOf, isOversize, MAX_TURNS, SEGMENT_BYTES_MAX, decodeSession, encodeSession, isPlainAbsolute, isSegmentName, isTmpName, MAX_EVENTS, newSegment, ownEngineCost, rootHashOf, segmentPath, segOf, tmpPath, ttlAt, withBranch, withCacheTtl, withClose, withCost, withEvent, withTurn } from './store'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const T0 = 1_800_000_000_000
const base = (over: Partial<Parameters<typeof newSegment>[0]> = {}) =>
  newSegment({ sessionId: SID, openedAt: T0, source: 'startup', entrypoint: 'claude-desktop', interactive: false, surface: 'desktop', repoKey: 'shop', repoKind: 'repo', rootHash: 'abcdef012345', cwdBase: 'shop', branch: 'claude/x', model: 'claude-fable-5-1', engineCostAtOpen: null, ...over })

describe('admission', () => {
  test('the SPEC §4 table, including the desktop-surface rule for sdk', async () => {
    expect(admitEvent('composer', 'cli', 'terminal')).toEqual({ admit: 1, reason: 'human' })
    expect(admitEvent('bridge', 'claude-desktop', 'mobile')).toEqual({ admit: 1, reason: 'human' })
    expect(admitEvent('sdk', 'claude-desktop', 'desktop')).toEqual({ admit: 1, reason: 'human-desktop-host' })
    expect(admitEvent('sdk', 'claude-desktop', null)).toEqual({ admit: 0, reason: 'sdk-nested' })
    expect(admitEvent('sdk', 'claude-desktop', 'terminal')).toEqual({ admit: 0, reason: 'sdk-nested' })
    expect(admitEvent('sdk', 'sdk-cli', 'desktop')).toEqual({ admit: 0, reason: 'automation-entrypoint' })
    expect(admitEvent('composer', 'sdk-ts', 'terminal')).toEqual({ admit: 0, reason: 'automation-entrypoint' })
    expect(admitEvent('composer', null, 'terminal')).toEqual({ admit: 0, reason: 'entrypoint-unknown' })
    expect(admitEvent('sdk', null, 'desktop')).toEqual({ admit: 0, reason: 'entrypoint-unknown' })
    for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'plugin', 'slack-ping', 'unclassified'])
      expect(admitEvent(kind, 'cli', 'terminal')).toEqual({ admit: 0, reason: `origin:${kind}` })
    expect(admitEvent('we\nird', 'cli', 'terminal').reason).toBe('origin:we ird')
  })
})

describe('segments', () => {
  test('a new segment: seg from the open time, startup cost at zero, fields cleaned', async () => {
    const r = base({ branch: 'feat/ghp_abcdefghijklmnop' })
    expect(r.seg).toBe(segOf(T0))
    expect(r.engineCostAtOpen).toBe(0)
    expect(r.branch).toBe('[redacted:github-token]')
    expect(r.redactions).toBe(1)
    expect(base({ source: 'resume' }).engineCostAtOpen).toBe(null)
    expect(base({ source: 'resume', engineCostAtOpen: 2 }).engineCostAtOpen).toBe(2)
    expect(base({ source: 'weird' as never }).source).toBe('unknown')
  })
  test('events and turns append with seq, bounded, never mutating', async () => {
    const r0 = base()
    const r1 = withEvent(r0, { ts: T0 + 1000, origin: 'sdk', queued: false }, T0 + 1000)
    expect(r0.events.length).toBe(0)
    expect(r1.events).toEqual([{ seq: 1, ts: T0 + 1000, origin: 'sdk', admit: 1, reason: 'human-desktop-host', queued: 0 }])
    expect(r1.nextSeq).toBe(2)
    const r2 = withTurn(r1, { endTs: T0 + 9000, durationMs: 4000, turnId: 't1', agentId: null, model: 'claude-fable-5-1', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, reason: 'answer' }, T0 + 9000)
    expect(r2.turns[0]).toEqual({ seq: 2, ts: T0 + 5000, endTs: T0 + 9000, turnId: 't1', agentKey: '', agent: 0, model: 'claude-fable-5-1', in: 10, out: 20, cr: 30, cw: 40, reason: 'answer' })
    // The same turn seen twice is recorded once; a subagent's turn with the same id is its own row, keyed by the agent id's hash.
    expect(withTurn(r2, { endTs: T0 + 9000, durationMs: 4000, turnId: 't1', agentId: null, model: null, usage: null, reason: 'answer' }, T0 + 9001)).toBe(r2)
    const r3 = withTurn(r2, { endTs: T0 + 9000, durationMs: 1, turnId: 't1', agentId: 'agent-7', model: null, usage: null, reason: 'weird' }, T0 + 9001)
    expect(r3.turns[1]).toMatchObject({ seq: 3, agent: 1, agentKey: agentKeyOf('agent-7'), reason: 'error', in: 0 })
    expect(withTurn(r3, { endTs: T0 + 9000, durationMs: 1, turnId: 't1', agentId: 'agent-7', model: null, usage: null, reason: 'answer' }, T0 + 9002)).toBe(r3)
    expect(r3.branchChanges).toEqual([{ ts: T0, branch: 'claude/x' }])
    expect(base({ branch: null }).branchChanges).toEqual([])
    const r4 = withBranch(r3, 'feat/y\n', T0 + 10_000)
    expect(r4.branch).toBe('feat/y')
    expect(r4.branchChanges).toEqual([{ ts: T0, branch: 'claude/x' }, { ts: T0 + 10_000, branch: 'feat/y' }])
    expect(withBranch(r4, 'feat/y', T0 + 11_000)).toBe(r4)
    const c1 = withCost(r4, 1.5, T0)
    expect(c1.engineCostUsd).toBe(1.5)
    expect(ownEngineCost(withCost(c1, 4, T0))).toBe(4)
    const resumed = withCost(base({ source: 'resume' }), 1.5, T0)
    expect(resumed.engineCostAtOpen).toBe(1.5)
    expect(ownEngineCost(withCost(resumed, 4, T0))).toBe(2.5)
    expect(ownEngineCost(r4)).toBe(null)
    expect(withCost(r4, Number.NaN, T0)).toBe(r4)
    const t1 = withCacheTtl(withCacheTtl(withCacheTtl(r4, '1h', T0 + 1), '1h', T0 + 2), '5m', T0 + 3)
    expect(t1.cacheTtlChanges).toEqual([{ ts: T0 + 1, ttl: '1h' }, { ts: T0 + 3, ttl: '5m' }])
    expect(ttlAt(t1, T0)).toBe(null)
    expect(ttlAt(t1, T0 + 2)).toBe('1h')
    expect(ttlAt(t1, T0 + 9)).toBe('5m')
    expect(withCacheTtl(r4, 'weird', T0)).toBe(r4)
    expect(withClose(r4, 'clear', T0 + 20_000)).toMatchObject({ closedAt: T0 + 20_000, closeReason: 'clear' })
  })
  test('a hostile origin kind is redacted in both the origin and the reason (verifier V11)', async () => {
    const r = withEvent(base(), { ts: T0, origin: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2', queued: false }, T0)
    expect(r.events[0]?.origin).toBe('[redacted:github-token]')
    expect(r.events[0]?.reason).toBe('origin:[redacted:github-token]')
    expect(r.redactions).toBe(1)
    const e = withEvent(base(), { ts: T0, origin: 'me@realmail.io', queued: false }, T0)
    expect(JSON.stringify(e).includes('realmail')).toBe(false)
  })
  test('SPEC §11.12: a segment at both row caps with every field at its cap in multibyte text rolls over by size long before the 4 MiB read limit', async () => {
    const wide = (n: number) => '\u00e9'.repeat(n)
    let r = base({ repoKey: wide(100), cwdBase: wide(100), branch: 'x'.repeat(200), model: wide(80) })
    const ev = (i: number) => ({ seq: i + 1, ts: T0 + i, origin: wide(40), admit: 1 as const, reason: `origin:${wide(40)}`.slice(0, 60), queued: 1 as const })
    const tr = (i: number) => ({ seq: 9000 + i, ts: T0 + i, endTs: T0 + i + 1, turnId: 'T'.repeat(80), agentKey: 'abcdef01', agent: 1 as const, model: wide(80), in: 2_000_000_000, out: 2_000_000_000, cr: 2_000_000_000, cw: 2_000_000_000, reason: 'refusal' as const })
    r = { ...r, events: Array.from({ length: MAX_EVENTS }, (_, i) => ev(i)), turns: Array.from({ length: MAX_TURNS }, (_, i) => tr(i)), nextSeq: 20_000 }
    const bytes = new TextEncoder().encode(encodeSession(r)).length
    // The worst case is far past the limit, which is exactly why the size rollover exists:
    expect(bytes).toBeGreaterThan(SEGMENT_BYTES_MAX)
    // At the first 250-row boundary past 3 MiB the segment reports oversize; before it, it does not.
    let firstOversize = -1
    for (let rows = 250; rows <= MAX_EVENTS; rows += 250) {
      const probe = { ...r, events: r.events.slice(0, rows), turns: r.turns.slice(0, rows) }
      if (isOversize(probe)) {
        firstOversize = rows
        break
      }
    }
    expect(firstOversize).toBeGreaterThan(0)
    const before = { ...r, events: r.events.slice(0, firstOversize - 250), turns: r.turns.slice(0, firstOversize - 250) }
    expect(new TextEncoder().encode(encodeSession(before)).length).toBeLessThan(SEGMENT_BYTES_MAX + 250 * 1024)
    expect(new TextEncoder().encode(encodeSession(before)).length).toBeLessThan(4 * 1024 * 1024)
  })
  test('the event cap counts drops instead of growing', async () => {
    let r = base()
    r = { ...r, events: Array.from({ length: MAX_EVENTS }, (_, i) => ({ seq: i + 1, ts: T0 + i, origin: 'composer', admit: 1 as const, reason: 'human', queued: 0 as const })), nextSeq: MAX_EVENTS + 1 }
    const r1 = withEvent(r, { ts: T0, origin: 'composer', queued: true }, T0)
    expect(r1.events.length).toBe(MAX_EVENTS)
    expect(r1.eventsDropped).toBe(1)
    expect(r1.nextSeq).toBe(MAX_EVENTS + 1)
  })
})

describe('encode and decode', () => {
  test('round trip, unknown keys preserved, hostile fields cleaned, malformed rows counted, bad shapes refused', async () => {
    const r = withTurn(withEvent(base(), { ts: T0 + 1, origin: 'composer', queued: true }, T0 + 1), { endTs: T0 + 5, durationMs: 2, turnId: 't', agentId: 'a', model: 'm', usage: {}, reason: 'aborted' }, T0 + 5)
    expect(decodeSession(encodeSession(r))).toEqual(r)
    const withExtra = JSON.parse(encodeSession(r)) as Record<string, unknown>
    withExtra['futureField'] = { keep: true }
    const decoded = decodeSession(JSON.stringify(withExtra))
    expect(decoded?.extra).toEqual({ futureField: { keep: true } })
    expect(JSON.parse(encodeSession(decoded as never))['futureField']).toEqual({ keep: true })
    expect(decodeSession('not json')).toBe(null)
    expect(decodeSession(JSON.stringify({ ...withExtra, v: 2 }))).toBe(null)
    expect(decodeSession(JSON.stringify({ ...withExtra, sessionId: '../x' }))).toBe(null)
    expect(decodeSession(JSON.stringify({ ...withExtra, seg: 'A/B' }))).toBe(null)
    expect(decodeSession(JSON.stringify({ v: 1, sessionId: SID, seg: 'x' }))).toBe(null)
    const hostile = JSON.stringify({ ...withExtra, branch: 'a\nb‮', model: 'x'.repeat(500), events: [{ ts: 'no' }, { ts: T0, origin: 'c\n', admit: 'yes', reason: 'r\n' }], turns: [{ ts: 1 }], rootHash: 'ZZZ', source: 'evil', cacheTtlChanges: [{ ts: 1, ttl: '2h' }, { ts: 2, ttl: '1h' }] })
    const d = decodeSession(hostile)
    expect(d?.branch).toBe('a b')
    expect(d?.model?.length).toBe(80)
    expect(d?.events).toEqual([{ seq: 0, ts: T0, origin: 'c', admit: 0, reason: 'r', queued: 0 }])
    expect(d?.turns).toEqual([])
    expect(d?.malformedRows).toBe(3)
    expect(d?.rootHash).toBe(null)
    expect(d?.source).toBe('unknown')
    expect(d?.cacheTtlChanges).toEqual([{ ts: 2, ttl: '1h' }])
  })
  test('decode never truncates rows past the caps', async () => {
    const many = { ...JSON.parse(encodeSession(base())), events: Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ({ seq: i + 1, ts: T0 + i, origin: 'composer', admit: 1, reason: 'human', queued: 0 })) }
    expect(decodeSession(JSON.stringify(many))?.events.length).toBe(MAX_EVENTS + 5)
  })
  test('paths, names and the root hash', async () => {
    expect(segmentPath('/Users/t/', '2026-10', SID, 'm2x')).toBe(`/Users/t/.claude/rd-ledger/sessions/2026/10/${SID}.m2x.json`)
    expect(tmpPath('/x/a.json', 'm2x', 7)).toBe('/x/a.json.tmp.m2x.7')
    expect(isTmpName(`${SID}.m2x.json.tmp.m2x.7`)).toBe(true)
    expect(isTmpName(`${SID}.m2x.json`)).toBe(false)
    expect(isSegmentName(`${SID}.m2x.json`)).toBe(true)
    expect(isSegmentName(`${SID}.json`)).toBe(false)
    expect(isSegmentName('x.m2x.json')).toBe(false)
    expect(isPlainAbsolute('/Users/t')).toBe(true)
    expect(isPlainAbsolute('/Users/../t')).toBe(false)
    expect(isPlainAbsolute('~')).toBe(false)
    expect(isPlainAbsolute(null)).toBe(false)
    expect(isPlainAbsolute('/a\nb')).toBe(false)
    const h = rootHashOf('s'.repeat(32), '/Users/t/shop', '/Users/t')
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(rootHashOf('s'.repeat(32), '/Users/t/shop', '/Users/t/')).toBe(h)
    expect(rootHashOf('t'.repeat(32), '/Users/t/shop', '/Users/t')).not.toBe(h)
    expect(rootHashOf('s'.repeat(32), '/opt/shop', '/Users/t')).not.toBe(h)
  })
})

describe('size rollover (verifier V6)', () => {
  test('a segment past SEGMENT_BYTES_MAX reports oversize at a 250-row boundary, never between', async () => {
    let r = base()
    r = { ...r, events: Array.from({ length: 250 }, (_, i) => ({ seq: i + 1, ts: T0 + i, origin: 'composer', admit: 1 as const, reason: 'human', queued: 0 as const })), nextSeq: 251 }
    expect(isOversize(r)).toBe(false)
    const heavy = { ...r, extra: { blob: 'x'.repeat(SEGMENT_BYTES_MAX + 1) } }
    expect(isOversize(heavy)).toBe(true)
    expect(isOversize({ ...heavy, events: heavy.events.slice(0, 249) })).toBe(false)
    expect(isOversize({ ...heavy, events: [] })).toBe(false)
  })
})
