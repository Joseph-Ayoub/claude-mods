// The on-disk lane protocol, over a small I/O interface so tests can run it
// against an in-memory world.
//
// One lane per repository lives in ~/.claude/merge-lane/<key>/:
//   holder/              the lock: made with mkdir (exit 0 means acquired)
//   holder/holder.json   who holds it; written to tmp/ and renamed in, never in place
//   holder/heartbeat     touched by the holder every tick (touch never creates holder/)
//   queue/<id>.json      one file per waiting session, written by that session alone
//   priority/<id>.json   /lane prioritize's overlay, so nobody rewrites another's queue file
//   alive/<id>           touched by every involved session every tick
//   tomb.<uuid>/         a lock being broken or released (renamed away, then removed)
// No file is read-modify-written by two sessions. The only claims are mkdir
// and rename, each atomic, and a breaker keeps a renamed lock only when it is
// the one it judged (core.isSameHolder); otherwise it puts it back.

import type { HolderRecord, HolderView, Judged, QueueEntry } from './core'
import {
  isEntrySuspect,
  isSameHolder,
  makeEnvelope,
  orderQueue,
  parseHolderRecord,
  parseJsonObject,
  parseQueueEntry,
  SESSION_ID,
} from './core'

export type MkdirResult = 'created' | 'exists' | 'error'

/** Whether a message reached a running session: the engine's own word, or unknown when the send failed. */
export type Delivery = 'delivered' | 'absent' | 'unknown'

export type ListedEntry = { name: string; kind: string; mtimeMs: number }

/**
 * Everything the protocol does to the world. The host's implementation runs
 * `mkdir`, `mv`, `rm`, `touch` through `$.process.run` and the rest through
 * `$.fs` and `$.session.send`; the tests' runs in memory.
 */
export interface LaneIO {
  now(): Promise<number>
  uuid(): string
  /** `mkdir <path>` without -p: the lock claim. */
  mkdir(path: string): Promise<MkdirResult>
  /** `mkdir -p` for the lane's own directories. */
  mkdirp(paths: readonly string[]): Promise<boolean>
  /** `mv <from> <to>` onto a name that does not exist: false when `from` is gone. */
  rename(from: string, to: string): Promise<boolean>
  /** `rm -rf`, inside the lane root only. */
  remove(paths: readonly string[]): Promise<void>
  /** `touch`: creates the file, never its directory. */
  touch(path: string): Promise<boolean>
  read(path: string): Promise<string | undefined>
  /** A plain write that creates directories; only for files one session owns. */
  write(path: string, text: string): Promise<void>
  list(dir: string): Promise<readonly ListedEntry[]>
  mtime(path: string): Promise<number | undefined>
  send(sessionId: string, text: string): Promise<Delivery>
}

export type LanePaths = {
  root: string
  lane: string
  holder: string
  holderFile: string
  heartbeat: string
  queue: string
  alive: string
  priority: string
  tmp: string
}

export class LaneError extends Error {}

/** Leftover tombs and temp files older than this are swept. */
const SWEEP_AFTER_MS = 10 * 60_000
const MAX_NOTIFY = 20

export function lanePaths(root: string, repoKey: string): LanePaths {
  const lane = `${root}/${repoKey}`
  return {
    root,
    lane,
    holder: `${lane}/holder`,
    holderFile: `${lane}/holder/holder.json`,
    heartbeat: `${lane}/holder/heartbeat`,
    queue: `${lane}/queue`,
    alive: `${lane}/alive`,
    priority: `${lane}/priority`,
    tmp: `${lane}/tmp`,
  }
}

export async function ensureLane(io: LaneIO, p: LanePaths): Promise<void> {
  if (!(await io.mkdirp([p.queue, p.alive, p.priority, p.tmp]))) {
    throw new LaneError('could not create the lane directory')
  }
}

/**
 * The holder as it stands. A lock with a missing or torn holder.json is held
 * (just made, or its writer died mid-claim); its age is the directory's, so
 * it only ever turns stale by time and an orphan does not block forever.
 */
export async function readHolder(io: LaneIO, p: LanePaths): Promise<HolderView> {
  const dirMtime = await io.mtime(p.holder)
  if (dirMtime === undefined) return { kind: 'free' }
  const record = parseHolderRecord(await io.read(p.holderFile))
  const beat = await io.mtime(p.heartbeat)
  return { kind: 'held', record, heartbeatAt: Math.max(beat ?? 0, dirMtime), dirMtime }
}

/** The queue in lane order, priority overlays applied; unreadable files are skipped for this read. */
export async function readQueue(io: LaneIO, p: LanePaths): Promise<QueueEntry[]> {
  const entries: QueueEntry[] = []
  for (const file of await io.list(p.queue)) {
    const stem = jsonStem(file)
    if (stem === null) continue
    const entry = parseQueueEntry(await io.read(`${p.queue}/${file.name}`), stem)
    if (entry !== null) entries.push(entry)
  }
  const overlays = new Map<string, number>()
  if (entries.length > 0) {
    for (const file of await io.list(p.priority)) {
      const stem = jsonStem(file)
      if (stem === null || !entries.some(entry => entry.sessionId === stem)) continue
      const at = parseJsonObject(await io.read(`${p.priority}/${file.name}`))?.at
      if (typeof at === 'number' && Number.isFinite(at)) overlays.set(stem, at)
    }
  }
  return orderQueue(entries, overlays)
}

/** When each session's alive file was last touched, by session id. */
export async function aliveTimes(io: LaneIO, p: LanePaths): Promise<Map<string, number>> {
  const times = new Map<string, number>()
  for (const file of await io.list(p.alive)) {
    if (file.kind === 'file' && SESSION_ID.test(file.name)) times.set(file.name, file.mtimeMs)
  }
  return times
}

export async function touchAlive(io: LaneIO, p: LanePaths, selfId: string, now: number): Promise<void> {
  await io.write(`${p.alive}/${selfId}`, String(now))
}

export async function writeQueueEntry(io: LaneIO, p: LanePaths, entry: QueueEntry): Promise<void> {
  await io.write(`${p.queue}/${entry.sessionId}.json`, JSON.stringify(entry))
}

/** Removes a session's queue file and any overlay on it (its alive file too, when it is gone for good). */
export async function removeQueueEntry(io: LaneIO, p: LanePaths, sessionId: string, isGone = false): Promise<void> {
  const paths = [`${p.queue}/${sessionId}.json`, `${p.priority}/${sessionId}.json`]
  await io.remove(isGone ? [...paths, `${p.alive}/${sessionId}`] : paths)
}

/** Fronts a queued session: its overlay, written by whoever prioritized it. */
export async function writeOverlay(io: LaneIO, p: LanePaths, sessionId: string, at: number, by: string): Promise<void> {
  await io.write(`${p.priority}/${sessionId}.json`, JSON.stringify({ at, by }))
}

/** Writes holder.json beside the lock by rename, so no reader sees it torn; false when holder/ is gone. */
async function writeRecord(io: LaneIO, p: LanePaths, record: HolderRecord): Promise<boolean> {
  const tmp = `${p.tmp}/${record.sessionId}.${io.uuid()}.json`
  await io.write(tmp, JSON.stringify(record))
  if (await io.rename(tmp, p.holderFile)) return true
  await io.remove([tmp])
  return false
}

/**
 * Claims the lane: `mkdir holder/`, then holder.json. `held` when another
 * session has it; a LaneError when the lock cannot be made at all (a missing
 * parent, permissions), which the caller must not read as `held`.
 */
export async function acquire(io: LaneIO, p: LanePaths, record: HolderRecord): Promise<'acquired' | 'held'> {
  await ensureLane(io, p)
  const made = await io.mkdir(p.holder)
  if (made === 'exists') return 'held'
  if (made === 'error') throw new LaneError('could not create the lane lock')
  if (!(await writeRecord(io, p, record)) && !(await writeRecord(io, p, record))) {
    // The lock is ours but unlabeled: give it up rather than hold a lane nobody can name.
    const tomb = `${p.lane}/tomb.${io.uuid()}`
    if (await io.rename(p.holder, tomb)) await io.remove([tomb])
    throw new LaneError('could not record the lane holder')
  }
  await io.touch(p.heartbeat)
  return 'acquired'
}

/**
 * Breaks the lock by renaming it to a tomb: only one rename of holder/
 * succeeds, so of two breakers one wins and the other reads `gone`. The
 * winner keeps the tomb only if it holds the lock it judged; a fresh lock
 * that slipped in between is put back (`changed`). Never `rm -rf holder/`
 * in place, which could delete a lock someone just took.
 */
export async function breakHolder(io: LaneIO, p: LanePaths, judged: Judged): Promise<'broken' | 'gone' | 'changed'> {
  const tomb = `${p.lane}/tomb.${io.uuid()}`
  if (!(await io.rename(p.holder, tomb))) return 'gone'
  const found = parseHolderRecord(await io.read(`${tomb}/holder.json`))
  if (!isSameHolder(found, judged)) {
    await restore(io, p, tomb)
    return 'changed'
  }
  await io.remove([tomb])
  return 'broken'
}

/** Puts a wrongly taken lock back. mkdir is the claim: if another session took the lane meanwhile, the moved holder has lost it and sees so on its next tick. */
async function restore(io: LaneIO, p: LanePaths, tomb: string): Promise<void> {
  if ((await io.mkdir(p.holder)) === 'created') {
    await io.rename(`${tomb}/holder.json`, p.holderFile)
    await io.rename(`${tomb}/heartbeat`, p.heartbeat)
  }
  await io.remove([tomb])
}

/** Gives the lane back, only when holder.json names this session; through a tomb like a break. */
export async function release(io: LaneIO, p: LanePaths, selfId: string): Promise<'released' | 'not-holder'> {
  const view = await readHolder(io, p)
  if (view.kind !== 'held' || view.record === null || view.record.sessionId !== selfId) return 'not-holder'
  const outcome = await breakHolder(io, p, { sessionId: selfId, since: view.record.since })
  return outcome === 'broken' ? 'released' : 'not-holder'
}

/** Rewrites this session's holder.json with changes (its PR, a merge attempt); false when it no longer holds. */
export async function updateRecord(
  io: LaneIO,
  p: LanePaths,
  selfId: string,
  change: (record: HolderRecord) => HolderRecord,
): Promise<boolean> {
  const record = parseHolderRecord(await io.read(p.holderFile))
  if (record === null || record.sessionId !== selfId) return false
  return writeRecord(io, p, change(record))
}

/**
 * Drops queue entries whose session is gone: only on a positive failure, an
 * alive file older than two minutes AND a ping the engine says was not
 * delivered. A sleeping laptop's old timestamps alone prune nothing.
 */
export async function pruneDead(
  io: LaneIO,
  p: LanePaths,
  queue: readonly QueueEntry[],
  selfId: string,
  now: number,
): Promise<QueueEntry[]> {
  const alive = await aliveTimes(io, p)
  const kept: QueueEntry[] = []
  for (const entry of queue) {
    if (entry.sessionId === selfId || !isEntrySuspect(now, alive.get(entry.sessionId))) {
      kept.push(entry)
      continue
    }
    if ((await io.send(entry.sessionId, makeEnvelope({ kind: 'ping' }))) !== 'absent') {
      kept.push(entry)
      continue
    }
    await removeQueueEntry(io, p, entry.sessionId, true)
  }
  return kept
}

/**
 * Wakes the queue head after a release. The message is a hint (the head's own
 * tick takes a free lane anyway): a head the engine cannot deliver to and
 * whose alive file is old is pruned and the next is tried, so a dead head
 * never stalls the sessions behind it.
 */
export async function notifyHead(io: LaneIO, p: LanePaths, repoKey: string, selfId: string): Promise<QueueEntry | null> {
  for (let attempt = 0; attempt < MAX_NOTIFY; attempt++) {
    if ((await readHolder(io, p)).kind !== 'free') return null
    const head = (await readQueue(io, p))[0]
    if (head === undefined || head.sessionId === selfId) return head ?? null
    const delivery = await io.send(head.sessionId, makeEnvelope({ kind: 'lane.available', repoKey, nonce: head.nonce }))
    if (delivery !== 'absent') return head
    const now = await io.now()
    if (!isEntrySuspect(now, (await aliveTimes(io, p)).get(head.sessionId))) return head
    await removeQueueEntry(io, p, head.sessionId, true)
  }
  return null
}

/** Removes tombs and temp files a crash left behind. */
export async function sweep(io: LaneIO, p: LanePaths, now: number): Promise<void> {
  const stale: string[] = []
  for (const entry of await io.list(p.lane)) {
    if (!entry.name.startsWith('tomb.')) continue
    const mtime = await io.mtime(`${p.lane}/${entry.name}`)
    if (mtime !== undefined && now - mtime > SWEEP_AFTER_MS) stale.push(`${p.lane}/${entry.name}`)
  }
  for (const entry of await io.list(p.tmp)) {
    if (entry.kind === 'file' && now - entry.mtimeMs > SWEEP_AFTER_MS) stale.push(`${p.tmp}/${entry.name}`)
  }
  if (stale.length > 0) await io.remove(stale)
}

function jsonStem(file: ListedEntry): string | null {
  if (file.kind !== 'file' || !file.name.endsWith('.json')) return null
  const stem = file.name.slice(0, -'.json'.length)
  return SESSION_ID.test(stem) ? stem : null
}
