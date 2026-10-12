import { describe, expect, test } from 'claude-code/testing'

import { makeEnvelope } from './core'
import type { HolderRecord, QueueEntry } from './core'
import {
  acquire,
  breakHolder,
  LaneError,
  lanePaths,
  notifyHead,
  pruneDead,
  readHolder,
  readQueue,
  release,
  touchAlive,
  updateRecord,
  writeQueueEntry,
} from './lane'
import type { Delivery } from './lane'
import { MemFs, memIO } from './world'

const MIN = 60_000
const ROOT = '/home/t/.claude/merge-lane'
const KEY = '0123456789abcdef'

function setup(start = 100 * MIN) {
  let now = start
  const fs = new MemFs(() => now)
  const live = new Set<string>()
  const sent: string[] = []
  const deliver = (sessionId: string): Delivery => (live.has(sessionId) ? 'delivered' : 'absent')
  const io = memIO(fs, deliver, sent)
  const p = lanePaths(ROOT, KEY)
  return {
    fs,
    io,
    p,
    live,
    sent,
    tick: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

const record = (sessionId: string, since: number): HolderRecord => ({
  sessionId,
  label: `${sessionId}-branch`,
  pr: null,
  since,
  implicit: false,
  repo: 'github.com/o/r',
})

const queued = (sessionId: string, requestedAt: number): QueueEntry => ({
  sessionId,
  label: sessionId,
  pr: null,
  priority: 'normal',
  requestedAt,
  nonce: `nonce-${sessionId}`,
  source: 'request',
})

const holderId = async (w: ReturnType<typeof setup>) => {
  const view = await readHolder(w.io, w.p)
  return view.kind === 'held' ? (view.record?.sessionId ?? 'unlabeled') : null
}

describe('locking', () => {
  test('positive: one acquire wins, the next reads held; release frees it and leaves no tomb', async () => {
    const w = setup()
    expect(await acquire(w.io, w.p, record('aaaa', w.now()))).toBe('acquired')
    expect(await acquire(w.io, w.p, record('bbbb', w.now()))).toBe('held')
    expect(await holderId(w)).toBe('aaaa')
    expect(await release(w.io, w.p, 'bbbb')).toBe('not-holder')
    expect(await holderId(w)).toBe('aaaa')
    expect(await release(w.io, w.p, 'aaaa')).toBe('released')
    expect(await holderId(w)).toBeNull()
    expect((w.fs.list(`${ROOT}/${KEY}`) ?? []).filter(entry => entry.name.startsWith('tomb.'))).toHaveLength(0)
  })

  test('two-breaker race: the late breaker finds a fresh lock in its tomb, puts it back, and does not acquire', async () => {
    const w = setup()
    await acquire(w.io, w.p, record('dead', 0))
    const judged = { sessionId: 'dead', since: 0 }
    // A breaks and takes the lane first ...
    expect(await breakHolder(w.io, w.p, judged)).toBe('broken')
    expect(await acquire(w.io, w.p, record('aaaa', w.now()))).toBe('acquired')
    // ... then B acts on the same (now outdated) judgement.
    expect(await breakHolder(w.io, w.p, judged)).toBe('changed')
    expect(await holderId(w)).toBe('aaaa')
    expect(await acquire(w.io, w.p, record('bbbb', w.now()))).toBe('held')
    expect((w.fs.list(`${ROOT}/${KEY}`) ?? []).filter(entry => entry.name.startsWith('tomb.'))).toHaveLength(0)
  })

  test('two breakers at once: exactly one of them ends up holding the lane', async () => {
    const w = setup()
    await acquire(w.io, w.p, record('dead', 0))
    const judged = { sessionId: 'dead', since: 0 }
    const breakThenTake = async (sessionId: string) => {
      if ((await breakHolder(w.io, w.p, judged)) === 'changed') return 'lost'
      return acquire(w.io, w.p, record(sessionId, w.now()))
    }
    const results = await Promise.all([breakThenTake('aaaa'), breakThenTake('bbbb')])
    expect(results.filter(result => result === 'acquired')).toHaveLength(1)
    const winner = results[0] === 'acquired' ? 'aaaa' : 'bbbb'
    expect(await holderId(w)).toBe(winner)
  })

  test('fail-safe: a broken holder can neither relabel nor heartbeat its lock back into being', async () => {
    const w = setup()
    await acquire(w.io, w.p, record('aaaa', w.now()))
    expect(await breakHolder(w.io, w.p, { sessionId: 'aaaa', since: w.now() })).toBe('broken')
    expect(await updateRecord(w.io, w.p, 'aaaa', held => ({ ...held, pr: '9' }))).toBe(false)
    expect(await w.io.touch(w.p.heartbeat)).toBe(false)
    expect(w.fs.has(w.p.holder)).toBe(false)
  })

  test('fail-safe: a lock that cannot be made is an error, never read as held', async () => {
    const w = setup()
    const broken = { ...w.io, mkdir: async () => 'error' as const }
    let failure: unknown
    try {
      await acquire(broken, w.p, record('aaaa', w.now()))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(LaneError)
  })

  test('a lock with no record yet is held, aged by its directory', async () => {
    const w = setup()
    w.fs.mkdirp(w.p.holder)
    const view = await readHolder(w.io, w.p)
    expect(view.kind).toBe('held')
    expect(view.kind === 'held' ? view.record : 'x').toBeNull()
  })
})

describe('queue liveness', () => {
  test('a dead head is pruned on release and the next live session is woken with its own nonce', async () => {
    const w = setup()
    await writeQueueEntry(w.io, w.p, queued('dead', 1))
    await writeQueueEntry(w.io, w.p, queued('live', 2))
    await touchAlive(w.io, w.p, 'dead', w.now())
    w.tick(5 * MIN)
    await touchAlive(w.io, w.p, 'live', w.now())
    w.live.add('live')
    const head = await notifyHead(w.io, w.p, KEY, 'releaser')
    expect(head?.sessionId).toBe('live')
    expect((await readQueue(w.io, w.p)).map(one => one.sessionId)).toEqual(['live'])
    expect(w.fs.has(`${w.p.alive}/dead`)).toBe(false)
    expect(w.sent).toContain(`live ${makeEnvelope({ kind: 'lane.available', repoKey: KEY, nonce: 'nonce-live' })}`)
  })

  test('negative: an unreachable head whose alive file is fresh is kept (its own tick takes the lane)', async () => {
    const w = setup()
    await writeQueueEntry(w.io, w.p, queued('busy', 1))
    await touchAlive(w.io, w.p, 'busy', w.now())
    const head = await notifyHead(w.io, w.p, KEY, 'releaser')
    expect(head?.sessionId).toBe('busy')
    expect((await readQueue(w.io, w.p)).map(one => one.sessionId)).toEqual(['busy'])
  })

  test('fail-safe: after a sleep every alive file is old, but sessions that answer the ping stay queued', async () => {
    const w = setup()
    for (const id of ['aaaa', 'bbbb', 'cccc']) {
      await writeQueueEntry(w.io, w.p, queued(id, 1))
      await touchAlive(w.io, w.p, id, w.now())
    }
    w.tick(90 * MIN)
    w.live.add('aaaa')
    w.live.add('bbbb')
    const kept = await pruneDead(w.io, w.p, await readQueue(w.io, w.p), 'aaaa', w.now())
    expect(kept.map(one => one.sessionId)).toEqual(['aaaa', 'bbbb'])
  })

  test('negative: a send that errors is not proof of death', async () => {
    const w = setup()
    const flaky = { ...w.io, send: async () => 'unknown' as const }
    await writeQueueEntry(w.io, w.p, queued('aaaa', 1))
    w.tick(30 * MIN)
    const kept = await pruneDead(flaky, w.p, await readQueue(w.io, w.p), 'me', w.now())
    expect(kept).toHaveLength(1)
  })
})
