// merge-lane: one merge lane per repository, shared by every Claude Code
// session on this machine, so concurrent sessions stop fighting over
// PR/CI/merge. One session holds the lane; the rest queue in priority order;
// a Bash gate refuses merges from sessions that do not hold it; the lane frees
// itself when the PR merges and the next session is woken.
//
// Where things are: core.ts decides (pure), lane.ts is the on-disk protocol,
// host.ts is the real I/O. This file wires them to the engine's events:
//   session.start    registers /lane, arms the 30 s tick when this session is on a lane
//   tool.call Bash   the merge gate (a guard: fails closed for merge commands only)
//   tool.call        the same gate for MCP GitHub merge tools
//   session.receive  takes the lane's own messages so they never reach the model
//   command.run      /lane and its verbs
//   session.end      gives the lane back and leaves the queue (on /clear too)
//   turn.start/complete  tracks a running turn so /lane take never opens a dialog mid-turn,
//                        and re-arms the tick after a hot reload (no session.start fires then)

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { LaneRole } from '../types'
import {
  ago,
  agoText,
  ciSummary,
  classifyCommand,
  classifyMcp,
  cleanText,
  decideGate,
  ENVELOPE_PREFIX,
  isDefaultBranch,
  isPersonOrigin,
  judgedOf,
  looksStale,
  makeEnvelope,
  mayAutoBreak,
  mergeOutcome,
  MUTATING_VERBS,
  normalizeNamedRepo,
  normalizeRemote,
  parseEnvelope,
  parseHolderRecord,
  parseLaneArgs,
  prFromArg,
  prText,
  repoKeyOf,
  resolveDir,
  SESSION_ID,
  shortId,
  statusLine,
} from './core'
import type { HolderRecord, HolderView, LaneCommand, MergeIntent, QueueEntry, RanLike, StatusView } from './core'
import {
  acquire,
  aliveTimes,
  breakHolder,
  ensureLane,
  lanePaths,
  notifyHead,
  pruneDead,
  readHolder,
  readQueue,
  release,
  removeQueueEntry,
  sweep,
  touchAlive,
  updateRecord,
  writeOverlay,
  writeQueueEntry,
} from './lane'
import type { Delivery, LaneIO, LanePaths, ListedEntry, MkdirResult } from './lane'

const TICK_MS = 30_000
/** How soon after session.start (or the first hook after a hot reload) the lane is looked at. */
const RESUME_MS = 1_000
const POLL_MS = 60_000
const MAX_NOTIFIED = 20

const repoKeyAtom = atom({ plugin: 'merge-lane', key: 'repoKey' } as const, null)
const roleAtom = atom({ plugin: 'merge-lane', key: 'role' } as const, 'none')
const prAtom = atom({ plugin: 'merge-lane', key: 'pr' } as const, null)
const nonceAtom = atom({ plugin: 'merge-lane', key: 'nonce' } as const, null)
const notifiedAtom = atom({ plugin: 'merge-lane', key: 'notifiedNonces' } as const, [])
const sessionAtom = atom({ plugin: 'merge-lane', key: 'sessionId' } as const, null)
const entryAtom = atom({ plugin: 'merge-lane', key: 'entry' } as const, null)
const autoAtom = atom({ plugin: 'merge-lane', key: 'autoOverride' } as const, null)
const bypassAtom = atom({ plugin: 'merge-lane', key: 'isBypassed' } as const, false)
const polledAtom = atom({ plugin: 'merge-lane', key: 'polledAt' } as const, 0)
const turnAtom = atom({ plugin: 'merge-lane', key: 'turnId' } as const, null)

const USAGE = [
  '/lane                                show the lane: holder, its PR and CI, the queue',
  '/lane request [pr|branch] [--high]   join the queue (takes the lane at once when it is free)',
  '/lane release                        give the lane back, or leave the queue',
  '/lane prioritize <id|pr>             put a queued session first',
  '/lane take [--yes]                   break the current holder and take the lane',
  '/lane auto on|off                    auto-proceed when the lane comes to this session',
  '/lane off | /lane on                 let this session merge without the lane, or gate it again',
].join('\n')

const INERT = 'merge-lane: this session is not in a git repository with an origin remote (or HOME is unset), so there is no lane here and nothing is gated.'

const AUTO_DENY =
  'merge-lane: gh pr merge --auto is refused: auto-merge lands later without holding the lane or re-verifying CI against current main. Merge directly while holding the lane instead (the allowAutoMerge option turns this refusal off).'

const FAILED_CLOSED =
  'merge-lane: the merge gate failed, so this merge was refused rather than let through unchecked. Run /lane to see the lane; /lane off lets this session merge without it.'

type Options = {
  auto: boolean
  staleMinutes: number
  maxHoldMinutes: number
  enforce: boolean
  allowAutoMerge: boolean
}

/**
 * The per-load runtime: options, the tick's timer and the in-session mutex.
 * A hot reload builds a new one (and drops the old timer with the old module).
 */
type Runtime = {
  opts: Options
  timer: Timer | undefined
  isTicking: boolean
  chain: Promise<unknown>
  /** Whether this load has looked at the lane once: session.start, or lazily after a hot reload. */
  hasResumed: boolean
}

/** One lane as this session sees it: where it lives on disk and who is asking. */
type Ctx = {
  io: LaneIO
  p: LanePaths
  /** The normalized remote, e.g. github.com/owner/repo: safe to show (no userinfo). */
  repo: string
  repoKey: string
  selfId: string
  cwd: string
}

/** Where a gated merge lands: its lane's repo, the directory it runs in, and whether that is this session's own repo. */
type Target = { repo: string; cwd: string; isSessionRepo: boolean }

export const register: Register = (on, options) => {
  // Nothing the lane needs to remember lives here: that is on disk and in
  // $.state. This only holds what dies with the module anyway.
  const rt: Runtime = {
    opts: readOptions(options),
    timer: undefined,
    isTicking: false,
    chain: Promise.resolve(),
    hasResumed: false,
  }
  const opts = rt.opts

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'lane',
        description: 'Merge lane: who holds it, the queue; request, release, prioritize or take it',
        argumentHint: '[request [pr] [--high] | release | prioritize <id|pr> | take | auto on|off | off | on]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`merge-lane: /lane was not registered (${errorText(error)})`, { to: 'debug' })
    }
    // On a lane already (a resumed queue)? Pick the tick back up.
    resumeOnce(rt, $)
    return next(e)
  })

  // The gate. Classify first, with no I/O: a command that does not merge
  // passes untouched and runs no process. Subagents' calls are gated the same.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const intent = typeof e.command === 'string' ? classifyCommand(e.command) : null
    if (intent === null) return next(e)
    return gateRun($, rt, intent, () => next(e))
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    let isMerge = true
    try {
      isMerge = opts.enforce && classifyCommand(e.command) !== null
    } catch {
      isMerge = opts.enforce
    }
    return isMerge ? { deny: FAILED_CLOSED } : next(e)
  })

  on('tool.call', async ($, e, next) => {
    const intent = classifyMcp(String(e.tool), e as unknown as Readonly<Record<string, unknown>>)
    if (intent === null) return next(e)
    return gateRun($, rt, intent, () => next(e))
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    let isMerge = true
    try {
      isMerge = opts.enforce && classifyMcp(String(e.tool), e as unknown as Readonly<Record<string, unknown>>) !== null
    } catch {
      isMerge = opts.enforce
    }
    return isMerge ? { deny: FAILED_CLOSED } : next(e)
  })

  // The lane's own messages. Anything carrying the prefix is consumed, valid
  // or not, so a stale or forged "lane is free" never reaches the model. A
  // valid one is a hint only: the lane is re-read from disk and taken only by
  // the atomic mkdir, by the session at the head of the queue.
  on('session.receive', async ($, e, next) => {
    resumeOnce(rt, $)
    const parsed = typeof e.text === 'string' ? parseEnvelope(e.text) : 'not-ours'
    if (parsed === 'not-ours') return next(e)
    if (parsed === 'invalid') return { consumed: 'merge-lane: unreadable lane message' }
    if (parsed.kind === 'ping') return { consumed: 'merge-lane: ping' }
    try {
      const ctx = await contextFor($)
      if (ctx !== null && ctx.repoKey === parsed.repoKey) {
        const own = (await readQueue(ctx.io, ctx.p)).find(entry => entry.sessionId === ctx.selfId)
        const isForUs = parsed.kind === 'lane.changed' || own?.nonce === parsed.nonce
        if (isForUs) await serialize(rt, () => step($, ctx, rt, 'hint'))
      }
    } catch (error) {
      $.ui.log(`merge-lane: lane message not handled (${errorText(error)})`, { to: 'debug' })
    }
    return { consumed: `merge-lane: ${parsed.kind}` }
  }).catch(($, e, next) =>
    typeof e.text === 'string' && e.text.startsWith(ENVELOPE_PREFIX) ? { consumed: 'merge-lane: lane message dropped' } : next(e),
  )

  on('command.run', { command: 'lane' }, async ($, e) => {
    const command = parseLaneArgs(e.args)
    if (MUTATING_VERBS.has(command.verb) && !isPersonOrigin(e.origin.kind)) {
      return { text: `merge-lane: only the person at the prompt can run /lane ${command.verb}; type it yourself.` }
    }
    try {
      return { text: await laneCommand($, rt, command) }
    } catch (error) {
      return { text: `merge-lane: /lane ${command.verb} failed (${errorText(error)}). Run /lane to see where the lane stands.` }
    }
  }).catch(() => ({ text: 'merge-lane: /lane did not finish in time. Run /lane to see where the lane stands.' }))

  // Leaving: give the lane back and leave the queue under the ENDING id (a
  // /clear goes on under a new one, with no session.start after it). One
  // short shared budget, so no notify here: the head's tick finds the lane free.
  on('session.end', async ($, e, next) => {
    stopTick(rt)
    try {
      // /lane off and /lane auto were typed for the ending id: the id a /clear
      // goes on under starts gated, following the auto option.
      await update($, bypassAtom, () => false)
      await update($, autoAtom, () => null)
    } catch {
      // the lane cleanup below matters more; never let this stop it
    }
    try {
      const home = await $.env.get('HOME')
      const repo = await sessionRepo($)
      if (home !== undefined && home.startsWith('/') && repo !== null && SESSION_ID.test(e.sessionId)) {
        const root = laneRoot(home)
        const io = hostIO($, root)
        const p = lanePaths(root, await repoKeyOf(repo))
        const record = parseHolderRecord(await io.read(p.holderFile))
        if (record !== null && record.sessionId === e.sessionId) {
          await breakHolder(io, p, { sessionId: record.sessionId, since: record.since })
        }
        await removeQueueEntry(io, p, e.sessionId, true)
      }
      $.ui.status(undefined)
    } catch (error) {
      $.ui.log(`merge-lane: session end cleanup failed (${errorText(error)})`, { to: 'debug' })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    resumeOnce(rt, $)
    // The main loop's turn only: turn.complete clears that one alone, so a subagent's would stick.
    // TurnStartInput does not declare agentId, so it is read defensively in case the engine sends it.
    if ((e as typeof e & { agentId?: string }).agentId === undefined) {
      try {
        await update($, turnAtom, () => e.turnId)
      } catch {
        // observing only
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      resumeOnce(rt, $)
      try {
        await update($, turnAtom, () => null)
      } catch {
        // observing only
      }
    }
    return next(e)
  })
}

/* ------------------------------------------------------------------------ */
/* Context                                                                   */
/* ------------------------------------------------------------------------ */

/** Runs lane changes of this session one at a time (the tick, the gate, a hint, a command). Never nest it. */
function serialize<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
  const run = rt.chain.then(fn)
  rt.chain = run.catch(() => undefined)
  return run
}

/**
 * A hot reload drops the tick with the old module and fires no session.start,
 * so the first turn or lane message after it looks at the lane once; a
 * session on the lane re-arms its tick there (publish), others stay quiet.
 */
function resumeOnce(rt: Runtime, $: EngineInterface): void {
  if (rt.hasResumed) return
  rt.hasResumed = true
  // On a timer, as the tick itself runs: never as work left running after the hook returned.
  $.clock.after(RESUME_MS, () => void runTick(rt, $))
}

function ensureTick(rt: Runtime, $: EngineInterface): void {
  if (rt.timer === undefined) rt.timer = $.clock.every(TICK_MS, () => void runTick(rt, $))
}

function stopTick(rt: Runtime): void {
  rt.timer?.cancel()
  rt.timer = undefined
}

async function runTick(rt: Runtime, $: EngineInterface): Promise<void> {
  if (rt.isTicking) return
  rt.isTicking = true
  try {
    const ctx = await contextFor($)
    if (ctx === null) stopTick(rt)
    else await serialize(rt, () => step($, ctx, rt, 'tick'))
  } catch (error) {
    $.ui.log(`merge-lane: tick failed (${errorText(error)})`, { to: 'debug' })
  } finally {
    rt.isTicking = false
  }
}

function readOptions(options: PluginOptions): Options {
  const num = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  return {
    auto: options.auto !== false,
    staleMinutes: num(options.staleMinutes, 10, 2, 24 * 60),
    maxHoldMinutes: num(options.maxHoldMinutes, 30, 0, 24 * 60),
    enforce: options.enforce !== false,
    allowAutoMerge: options.allowAutoMerge === true,
  }
}

function laneRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/merge-lane`
}

async function sessionRepo($: EngineInterface): Promise<string | null> {
  const repo = await $.session.repo()
  return repo?.remote ? normalizeRemote(repo.remote) : null
}

/** The lane for `repo` (the session's own by default); null where there is none: no HOME, no remote. */
async function contextFor($: EngineInterface, repo?: string): Promise<Ctx | null> {
  const home = await $.env.get('HOME')
  if (home === undefined || !home.startsWith('/')) return null
  const selfId = await $.session.id()
  if (!SESSION_ID.test(selfId)) return null
  const resolved = repo ?? (await sessionRepo($))
  if (resolved === null) return null
  const repoKey = await repoKeyOf(resolved)
  const root = laneRoot(home)
  return { io: hostIO($, root), p: lanePaths(root, repoKey), repo: resolved, repoKey, selfId, cwd: await $.session.cwd() }
}

/** Resets what $.state says about this session when the id changed under it (a /clear). */
async function syncSession($: EngineInterface, ctx: Ctx): Promise<void> {
  if ((await read($, sessionAtom)) === ctx.selfId) return
  await update($, sessionAtom, () => ctx.selfId)
  await update($, roleAtom, () => 'none')
  await update($, prAtom, () => null)
  await update($, nonceAtom, () => null)
  await update($, entryAtom, () => null)
  await update($, polledAtom, () => 0)
}

async function labelFor($: EngineInterface, ctx: Ctx): Promise<string> {
  const branch = await gitLine($, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd)
  const name = branch !== null && branch !== 'HEAD' ? branch : (ctx.cwd.split('/').filter(part => part !== '').pop() ?? 'session')
  return cleanText(name, 48)
}

/**
 * Writes this session's standing to $.state and the status line under the
 * composer, and keeps the tick armed exactly while it is on the lane.
 */
async function publish($: EngineInterface, ctx: Ctx, rt: Runtime, holder: HolderView, queue: readonly QueueEntry[]): Promise<LaneRole> {
  const { selfId } = ctx
  const isBypassed = await read($, bypassAtom)
  const record = holder.kind === 'held' ? holder.record : null
  const index = queue.findIndex(entry => entry.sessionId === selfId)
  const own = queue[index]
  let view: StatusView
  if (record?.sessionId === selfId) {
    view = { role: 'holder', pr: record.pr, queued: queue.length, isBypassed }
    await update($, prAtom, () => record.pr)
    await update($, entryAtom, () => null)
  } else if (own !== undefined) {
    const ahead = record ?? queue[index - 1]
    view = {
      role: 'queued',
      position: index + 1,
      total: queue.length,
      behindLabel: ahead?.label ?? null,
      behindPr: ahead?.pr ?? null,
      isBypassed,
    }
    await update($, prAtom, () => own.pr)
    await update($, nonceAtom, () => own.nonce)
    await update($, entryAtom, () => own)
  } else {
    view = { role: 'none', isBypassed }
    await update($, prAtom, () => null)
    await update($, nonceAtom, () => null)
    await update($, entryAtom, () => null)
  }
  await update($, roleAtom, () => view.role)
  await update($, repoKeyAtom, () => ctx.repoKey)
  $.ui.status(statusLine(view))
  if (view.role === 'none') stopTick(rt)
  else ensureTick(rt, $)
  return view.role
}

/* ------------------------------------------------------------------------ */
/* The tick                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * One authoritative pass over the lane for this session, every 30 s while it
 * is involved (and on any hint). The holder heartbeats, polls its PR and
 * hands the lane on when it merged or when it has held too long with others
 * waiting. A queued session prunes dead entries, and at the head of the queue
 * takes a free lane, or breaks a holder that is stale by time AND whose
 * session the engine says is not running. Messages only make this sooner.
 */
async function step($: EngineInterface, ctx: Ctx, rt: Runtime, via: 'tick' | 'hint' | 'request'): Promise<LaneRole> {
  const { io, p, selfId } = ctx
  await syncSession($, ctx)
  const now = await io.now()
  let holder = await readHolder(io, p)
  let queue = await readQueue(io, p)
  const record = holder.kind === 'held' ? holder.record : null

  if (record?.sessionId === selfId) {
    await io.touch(p.heartbeat)
    await touchAlive(io, p, selfId, now)
    if (record.pr !== null && now - (await read($, polledAtom)) >= POLL_MS) {
      await update($, polledAtom, () => now)
      const seen = await prView($, record.pr, ctx.repo, ctx.cwd)
      if (seen?.state === 'MERGED' || seen?.state === 'CLOSED') {
        await releaseLane($, ctx, rt, `PR #${record.pr} ${seen.state === 'MERGED' ? 'merged' : 'was closed'}`)
        return 'none'
      }
    }
    const maxHold = rt.opts.maxHoldMinutes * 60_000
    if (maxHold > 0 && queue.length > 0 && now - Math.max(record.since, record.attemptAt ?? 0) > maxHold) {
      await releaseLane($, ctx, rt, `held ${ago(now - record.since)} with no merge landing while others wait`)
      return 'none'
    }
    await sweep(io, p, now)
    return publish($, ctx, rt, holder, queue)
  }

  if ((await read($, roleAtom)) === 'holder') {
    $.ui.toast(
      record === null ? 'merge lane lost: it was released or broken' : `merge lane lost: ${record.label}${prText(record.pr)} holds it now`,
    )
  }

  let own = queue.find(entry => entry.sessionId === selfId)
  if (own === undefined) {
    // A live entry pruned by mistake (a stalled tick and a failed ping) goes back in its place.
    const kept = await read($, entryAtom)
    if (kept !== null && kept.sessionId === selfId) {
      await writeQueueEntry(io, p, kept)
      queue = await readQueue(io, p)
      own = queue.find(entry => entry.sessionId === selfId)
    }
  }
  if (own === undefined) return publish($, ctx, rt, holder, queue)

  await touchAlive(io, p, selfId, now)
  queue = await pruneDead(io, p, queue, selfId, now)
  if (queue[0]?.sessionId === selfId) {
    if (holder.kind === 'held') {
      const alive = await aliveTimes(io, p)
      const liveness = {
        now,
        heartbeatAt: holder.heartbeatAt,
        aliveAt: record === null ? undefined : alive.get(record.sessionId),
        staleMinutes: rt.opts.staleMinutes,
      }
      if (looksStale(liveness)) {
        const delivery = record === null ? 'absent' : await io.send(record.sessionId, makeEnvelope({ kind: 'ping' }))
        if (delivery === 'absent' && mayAutoBreak({ ...liveness, isDelivered: false })) {
          const broke = await breakHolder(io, p, judgedOf(holder))
          if (broke === 'broken') {
            $.ui.log(`merge-lane: broke a stale lock${record === null ? '' : ` held by ${record.label}`}`, { to: 'debug' })
          }
          holder = await readHolder(io, p)
        }
      }
    }
    if (holder.kind === 'free' && (await acquireFromQueue($, ctx, own, via !== 'request', rt))) {
      return publish($, ctx, rt, await readHolder(io, p), await readQueue(io, p))
    }
  }
  return publish($, ctx, rt, holder, queue)
}

/** Takes a free lane for this session's queue entry; the woken session gets its proceed prompt once per nonce. */
async function acquireFromQueue($: EngineInterface, ctx: Ctx, own: QueueEntry, shouldPrompt: boolean, rt: Runtime): Promise<boolean> {
  const { io, p, selfId } = ctx
  const now = await io.now()
  const record: HolderRecord = {
    sessionId: selfId,
    label: own.label,
    pr: own.pr,
    since: now,
    implicit: own.source === 'gate',
    repo: ctx.repo,
  }
  if ((await acquire(io, p, record)) !== 'acquired') return false
  await removeQueueEntry(io, p, selfId)
  await update($, entryAtom, () => null)
  await update($, nonceAtom, () => own.nonce)
  $.ui.toast(`merge lane is yours${prText(own.pr)}`)
  const notified = await read($, notifiedAtom)
  if (!notified.includes(own.nonce)) {
    await update($, notifiedAtom, () => [...notified, own.nonce].slice(-MAX_NOTIFIED))
    const isAuto = (await read($, autoAtom)) ?? rt.opts.auto
    // The mod's own words, so the model reads them framed as this plugin's message, never as the person's
    // (no asUser). Queued until idle and never awaited here: a hook awaiting its own submit can hang the turn.
    if (shouldPrompt && isAuto) void $.prompt.submit({ text: proceedText(own.pr) }).catch(() => undefined)
  }
  return true
}

function proceedText(pr: string | null): string {
  const lane = pr === null ? 'The merge lane is yours' : `The merge lane is yours for PR #${pr}`
  return `${lane}. Proceed with the merge: re-verify CI is green on the current head against current main, merge, then the lane auto-releases on merge (or /lane release).`
}

/** Gives the lane back (only when this session holds it) and wakes the next session. */
async function releaseLane(
  $: EngineInterface,
  ctx: Ctx,
  rt: Runtime,
  reason: string,
  isSessionRepo = true,
): Promise<{ isReleased: boolean; next: QueueEntry | null }> {
  const { io, p, selfId } = ctx
  const isReleased = (await release(io, p, selfId)) === 'released'
  let next: QueueEntry | null = null
  if (isReleased) {
    next = await notifyHead(io, p, ctx.repoKey, selfId)
    $.ui.toast(`merge lane released: ${reason}${next === null ? '' : `; ${next.label} is next`}`)
  }
  if (isSessionRepo) await publish($, ctx, rt, await readHolder(io, p), await readQueue(io, p))
  return { isReleased, next }
}

/* ------------------------------------------------------------------------ */
/* The gate                                                                  */
/* ------------------------------------------------------------------------ */

type Admission = { kind: 'allow'; isImplicit: boolean } | { kind: 'deny'; text: string }

async function gateRun<R extends RanLike>(
  $: EngineInterface,
  rt: Runtime,
  intent: MergeIntent,
  proceed: () => Promise<R>,
): Promise<R | { deny: string }> {
  if (!rt.opts.enforce || (await read($, bypassAtom))) return proceed()
  if (intent.isAuto && !rt.opts.allowAutoMerge) return { deny: AUTO_DENY }
  const target = await gateTarget($, intent)
  // No remote, no lane: nothing to merge to, so nothing to serialize.
  if (target === null) return allowUngated($, intent, 'no origin remote', proceed)
  // A lane guessed for a repo or directory the text cannot tell could refuse a merge no lane here owns.
  if (target === 'unresolved') return allowUngated($, intent, 'its repo or directory could not be told from the text', proceed)
  if (intent.kind === 'push-unknown') {
    const branch = await gitLine($, ['rev-parse', '--abbrev-ref', 'HEAD'], target.cwd)
    if (branch === null) return allowUngated($, intent, 'the current branch could not be read', proceed)
    if (!isDefaultBranch(branch)) return proceed()
  }
  const ctx = await contextFor($, target.repo)
  if (ctx === null) return allowUngated($, intent, 'no lane (HOME or the session id is unusable)', proceed)
  let admission: Admission
  try {
    admission = await serialize(rt, () => admit($, ctx, rt, intent, target.isSessionRepo))
  } catch (error) {
    return {
      deny: `merge-lane: could not check the merge lane (${errorText(error)}), so the merge was refused. Run /lane off to let this session merge without the lane.`,
    }
  }
  if (admission.kind === 'deny') return { deny: admission.text }
  const ran = await proceed()
  try {
    await serialize(rt, () => afterMerge($, ctx, rt, intent, admission.kind === 'allow' && admission.isImplicit, ran, target))
  } catch (error) {
    $.ui.log(`merge-lane: after-merge bookkeeping failed (${errorText(error)})`, { to: 'debug' })
  }
  return ran
}

/**
 * The lane a merge belongs to: `-R`/a URL/an API path first, then a
 * `cd`/`git -C` directory's origin, then the session's repo. `unresolved`
 * when the command names a repo or directory this cannot pin down (`"$DIR"`,
 * a folder with no origin): the session's own lane would only be a guess,
 * and a wrong guess refuses a merge that lane does not own.
 */
async function gateTarget($: EngineInterface, intent: MergeIntent): Promise<Target | null | 'unresolved'> {
  if (intent.isDirUnknown === true) return 'unresolved'
  const own = await sessionRepo($)
  const cwd = await $.session.cwd()
  const home = intent.dir === null ? undefined : await $.env.get('HOME')
  const dir = intent.dir === null ? null : resolveDir(intent.dir, home, cwd)
  if (intent.repo !== null) {
    const named = normalizeNamedRepo(intent.repo, own)
    if (named === null) return 'unresolved'
    return { repo: named, cwd: dir ?? cwd, isSessionRepo: named === own }
  }
  if (intent.dir !== null) {
    const remote = dir === null ? null : await gitLine($, ['-C', dir, 'remote', 'get-url', '--push', 'origin'])
    const named = remote === null ? null : normalizeRemote(remote)
    if (dir === null || named === null) return 'unresolved'
    return { repo: named, cwd: dir, isSessionRepo: named === own }
  }
  return own === null ? null : { repo: own, cwd, isSessionRepo: true }
}

/** Lets a merge through ungated, as the gate prefers to a wrong refusal, and says why in the debug log (never the command text). */
function allowUngated<R>($: EngineInterface, intent: MergeIntent, why: string, proceed: () => Promise<R>): Promise<R> {
  $.ui.log(`merge-lane: let a ${intent.kind} through ungated: ${why}`, { to: 'debug' })
  return proceed()
}

/**
 * The gate's admission: allow the holder (recording the attempt), take a free
 * lane nobody waits ahead for, or refuse and queue this session so it is
 * woken when its turn comes. A lane for another repo than the session's own
 * is served the same, minus the queue (no tick of this session watches it).
 */
async function admit($: EngineInterface, ctx: Ctx, rt: Runtime, intent: MergeIntent, isSessionRepo: boolean): Promise<Admission> {
  const { io, p, selfId } = ctx
  if (isSessionRepo) await syncSession($, ctx)
  await ensureLane(io, p)
  const now = await io.now()
  let holder = await readHolder(io, p)
  let queue = await readQueue(io, p)
  let decision = decideGate({ intent, selfId, holder, queue })
  if (decision.kind === 'deny' && decision.isFree) {
    // A dead session at the head must not keep a live one from a free lane.
    queue = await pruneDead(io, p, queue, selfId, now)
    decision = decideGate({ intent, selfId, holder, queue })
  }
  if (decision.kind === 'allow-holder') {
    await updateRecord(io, p, selfId, record => ({ ...record, attemptAt: now, pr: record.pr ?? intent.pr }))
    return { kind: 'allow', isImplicit: holder.kind === 'held' && holder.record?.implicit === true }
  }
  if (decision.kind === 'acquire') {
    const own = queue.find(entry => entry.sessionId === selfId)
    const isImplicit = own === undefined || own.source === 'gate'
    const record: HolderRecord = {
      sessionId: selfId,
      label: own?.label ?? (await labelFor($, ctx)),
      pr: intent.pr ?? own?.pr ?? null,
      since: now,
      implicit: isImplicit,
      repo: ctx.repo,
      attemptAt: now,
    }
    if ((await acquire(io, p, record)) === 'acquired') {
      if (own !== undefined) {
        await removeQueueEntry(io, p, selfId)
        // the session is already merging: its queued proceed prompt is spent
        const notified = await read($, notifiedAtom)
        await update($, notifiedAtom, () => [...notified, own.nonce].slice(-MAX_NOTIFIED))
      }
      if (isSessionRepo) await publish($, ctx, rt, await readHolder(io, p), await readQueue(io, p))
      return { kind: 'allow', isImplicit }
    }
    holder = await readHolder(io, p)
    queue = await readQueue(io, p)
    if (holder.kind === 'held' && holder.record?.sessionId === selfId) return { kind: 'allow', isImplicit: holder.record.implicit }
  }
  if (isSessionRepo && !queue.some(entry => entry.sessionId === selfId)) {
    await writeQueueEntry(io, p, {
      sessionId: selfId,
      label: await labelFor($, ctx),
      pr: intent.pr,
      priority: 'normal',
      requestedAt: now,
      nonce: io.uuid(),
      source: 'gate',
    })
    await touchAlive(io, p, selfId, now)
    queue = await readQueue(io, p)
  }
  if (isSessionRepo) await publish($, ctx, rt, holder, queue)
  return { kind: 'deny', text: denyText(ctx, holder, queue, now, isSessionRepo) }
}

function denyText(ctx: Ctx, holder: HolderView, queue: readonly QueueEntry[], now: number, isQueued: boolean): string {
  const record = holder.kind === 'held' ? holder.record : null
  const head = queue[0]
  const standing =
    holder.kind === 'held'
      ? record === null
        ? 'being taken by another session'
        : `held by ${record.label} · ${shortId(record.sessionId)}${prText(record.pr)} since ${agoText(now - record.since)}`
      : `free, but ${head?.label ?? 'another session'}${prText(head?.pr ?? null)} is first in the queue`
  const index = queue.findIndex(entry => entry.sessionId === ctx.selfId)
  if (!isQueued || index === -1) {
    return `merge-lane: the merge lane for ${ctx.repo} is ${standing}. Try the merge again once it frees (this session's /lane covers only its own repo's lane).`
  }
  return (
    `merge-lane: the merge lane for ${ctx.repo} is ${standing}; you are #${index + 1} of ${queue.length} in the queue. ` +
    'This session is queued and gets a prompt when its turn comes: do not retry the merge or work around this gate. ' +
    `The person can run /lane prioritize ${shortId(ctx.selfId)} to put it first, or /lane take to break a stale lock.`
  )
}

/**
 * After a merge the gate let through: a merge that landed releases the lane
 * and wakes the next session; a failed one hands it on when the gate took
 * the lane just for it; anything unclear asks gh once, and otherwise the
 * holder's PR poll releases it later. A lane of another repo is always
 * handed on, since no tick of this session watches it.
 */
async function afterMerge($: EngineInterface, ctx: Ctx, rt: Runtime, intent: MergeIntent, isImplicit: boolean, ran: RanLike, target: Target): Promise<void> {
  const { io, p, selfId } = ctx
  const holder = await readHolder(io, p)
  const record = holder.kind === 'held' ? holder.record : null
  if (record === null || record.sessionId !== selfId) return
  let outcome = mergeOutcome(intent, ran, record.pr)
  if (outcome === 'unknown') {
    const selector = intent.pr ?? record.pr ?? intent.branch
    const seen = await prView($, selector, selector === null ? null : ctx.repo, target.cwd)
    if (seen?.state === 'MERGED') outcome = 'merged'
    else if (seen === null || seen.state === 'CLOSED') outcome = isImplicit ? 'failed' : 'pending'
    else {
      outcome = 'pending'
      const found = seen.number
      if (record.pr === null && found !== null) await updateRecord(io, p, selfId, held => ({ ...held, pr: found }))
    }
  }
  const pr = intent.pr ?? record.pr
  const what =
    intent.kind === 'push-main' || intent.kind === 'push-unknown' ? 'the push to the default branch' : pr === null ? 'the merge' : `PR #${pr}`
  if (outcome === 'merged') {
    await releaseLane($, ctx, rt, `${what} landed`, target.isSessionRepo)
  } else if ((outcome === 'failed' && isImplicit) || !target.isSessionRepo) {
    await releaseLane($, ctx, rt, outcome === 'failed' ? 'the merge did not go through' : 'the merge ran', target.isSessionRepo)
  } else if (intent.pr !== null && record.pr === null) {
    const named = intent.pr
    await updateRecord(io, p, selfId, held => ({ ...held, pr: named }))
  }
}

/* ------------------------------------------------------------------------ */
/* /lane                                                                     */
/* ------------------------------------------------------------------------ */

async function laneCommand($: EngineInterface, rt: Runtime, command: LaneCommand): Promise<string> {
  if (command.verb === 'help') return USAGE
  if (command.verb === 'unknown') return `merge-lane: unknown /lane command.\n${USAGE}`
  if (command.verb === 'auto') {
    const word = command.rest[0]
    if (word !== 'on' && word !== 'off') return 'merge-lane: /lane auto on|off'
    await update($, autoAtom, () => word === 'on')
    return word === 'on'
      ? 'merge-lane: auto-proceed on for this session: when the lane comes to it, the proceed-with-merge prompt is submitted for it.'
      : 'merge-lane: auto-proceed off for this session: when the lane comes to it you get a toast, and the merge is yours to start.'
  }
  if (command.verb === 'off' || command.verb === 'on') {
    const isBypassed = command.verb === 'off'
    await update($, bypassAtom, () => isBypassed)
    const ctx = await contextFor($)
    if (ctx === null) $.ui.status(statusLine({ role: 'none', isBypassed }))
    else await serialize(rt, async () => publish($, ctx, rt, await readHolder(ctx.io, ctx.p), await readQueue(ctx.io, ctx.p)))
    return isBypassed
      ? 'merge-lane: the merge gate is off for this session: its merges skip the lane until /lane on. Other sessions still queue.'
      : 'merge-lane: the merge gate is on again for this session.'
  }
  const ctx = await contextFor($)
  if (ctx === null) return INERT
  if (command.verb === 'status') return laneStatus($, ctx, rt)
  if (command.verb === 'request') return serialize(rt, () => laneRequest($, ctx, rt, command))
  if (command.verb === 'release') return serialize(rt, () => laneRelease($, ctx, rt))
  if (command.verb === 'prioritize') return serialize(rt, () => lanePrioritize($, ctx, rt, command))
  return laneTake($, ctx, rt, command)
}

async function laneStatus($: EngineInterface, ctx: Ctx, rt: Runtime): Promise<string> {
  const { io, p, selfId } = ctx
  await syncSession($, ctx)
  const now = await io.now()
  const holder = await readHolder(io, p)
  const queue = await readQueue(io, p)
  const alive = await aliveTimes(io, p)
  const lines = [`Merge lane for ${ctx.repo}`]
  if (holder.kind === 'free') {
    lines.push('  Holder: none, the lane is free')
  } else if (holder.record === null) {
    lines.push(`  Holder: a session mid-claim (lock made ${agoText(now - holder.dirMtime)}, no record yet)`)
  } else {
    const record = holder.record
    const you = record.sessionId === selfId ? ' (this session)' : ''
    const taken = record.takenFrom === undefined ? '' : `, taken from ${record.takenFrom}`
    lines.push(
      `  Holder: ${record.label} · ${shortId(record.sessionId)}${you}${prText(record.pr)}, since ${agoText(now - record.since)}, heartbeat ${agoText(now - holder.heartbeatAt)}${taken}`,
    )
    if (looksStale({ now, heartbeatAt: holder.heartbeatAt, aliveAt: alive.get(record.sessionId), staleMinutes: rt.opts.staleMinutes })) {
      lines.push('  It looks stale: /lane take breaks it')
    }
    if (record.pr !== null) lines.push(`  ${await prLine($, ctx, record.pr)}`)
  }
  if (queue.length === 0) {
    lines.push('  Queue: empty')
  } else {
    lines.push('  Queue:')
    queue.forEach((entry, index) => {
      const you = entry.sessionId === selfId ? ' (this session)' : ''
      const high = entry.priority === 'high' ? ', high' : ''
      lines.push(`    ${index + 1}. ${entry.label} · ${shortId(entry.sessionId)}${you}${prText(entry.pr)}${high}, waiting ${ago(now - entry.requestedAt)}`)
    })
  }
  const isAuto = (await read($, autoAtom)) ?? rt.opts.auto
  const gate = !rt.opts.enforce ? 'off (enforce option)' : (await read($, bypassAtom)) ? 'off (/lane off)' : 'on'
  lines.push(`  This session: auto-proceed ${isAuto ? 'on' : 'off'}, gate ${gate}`, '', USAGE)
  await serialize(rt, () => publish($, ctx, rt, holder, queue))
  return lines.join('\n')
}

/** The holder's PR and its CI, read with gh; never gh's raw output. */
async function prLine($: EngineInterface, ctx: Ctx, pr: string): Promise<string> {
  const ran = await runGh($, ['pr', 'view', pr, '--json', 'state,mergeStateStatus,statusCheckRollup', '-R', ctx.repo], ctx.cwd)
  if (ran === null) return `PR #${pr}: CI unknown (gh is not available)`
  if (ran.exitCode !== 0) return `PR #${pr}: CI unknown (gh pr view failed)`
  let value: unknown
  try {
    value = JSON.parse(ran.stdout)
  } catch {
    return `PR #${pr}: CI unknown (unreadable gh output)`
  }
  if (typeof value !== 'object' || value === null) return `PR #${pr}: CI unknown (unreadable gh output)`
  const { state, mergeStateStatus, statusCheckRollup } = value as Record<string, unknown>
  const ci = ciSummary(statusCheckRollup)
  return `PR #${pr}: ${cleanText(String(state ?? '?'), 20)} · merge state ${cleanText(String(mergeStateStatus ?? '?'), 24)} · checks ${ci.passed} passed, ${ci.failing} failing, ${ci.pending} pending`
}

/** A PR from `/lane request`'s argument: a number or URL as given, a branch through gh, none through the checked-out branch. */
async function resolvePr($: EngineInterface, ctx: Ctx, arg: string | undefined): Promise<string | null> {
  if (arg !== undefined) {
    const direct = prFromArg(arg)
    if (direct !== null) return direct
    if (!/^[\w.][\w./-]{0,199}$/.test(arg)) return null
  }
  const seen = await prView($, arg ?? null, arg === undefined ? null : ctx.repo, ctx.cwd)
  return seen?.number ?? null
}

async function laneRequest($: EngineInterface, ctx: Ctx, rt: Runtime, command: LaneCommand): Promise<string> {
  const { io, p, selfId } = ctx
  await syncSession($, ctx)
  await ensureLane(io, p)
  const now = await io.now()
  const arg = command.rest[0]
  const holder = await readHolder(io, p)
  if (holder.kind === 'held' && holder.record?.sessionId === selfId) {
    const pr = arg === undefined ? null : await resolvePr($, ctx, arg)
    // a request makes the hold explicit: a failed merge no longer hands the lane on
    await updateRecord(io, p, selfId, record => ({ ...record, implicit: false, pr: pr ?? record.pr }))
    await publish($, ctx, rt, await readHolder(io, p), await readQueue(io, p))
    return `merge-lane: this session already holds the merge lane${prText(pr ?? holder.record.pr)}.`
  }
  const existing = (await readQueue(io, p)).find(entry => entry.sessionId === selfId)
  const pr = await resolvePr($, ctx, arg)
  const entry: QueueEntry = {
    sessionId: selfId,
    label: await labelFor($, ctx),
    pr: pr ?? existing?.pr ?? null,
    priority: command.isHigh || existing?.priority === 'high' ? 'high' : 'normal',
    requestedAt: existing?.requestedAt ?? now,
    nonce: existing?.nonce ?? io.uuid(),
    source: 'request',
  }
  await writeQueueEntry(io, p, entry)
  await touchAlive(io, p, selfId, now)
  await update($, entryAtom, () => entry)
  const role = await step($, ctx, rt, 'request')
  if (role === 'holder') {
    return `merge-lane: the merge lane is yours${prText(entry.pr)}. It frees itself when the PR merges, or run /lane release.`
  }
  const after = await readQueue(io, p)
  const index = after.findIndex(item => item.sessionId === selfId)
  const now2 = await readHolder(io, p)
  const ahead = now2.kind === 'held' ? now2.record : after[index - 1]
  const behind = ahead === null || ahead === undefined ? '' : ` behind ${ahead.label}${prText(ahead.pr)}`
  const isAuto = (await read($, autoAtom)) ?? rt.opts.auto
  return `merge-lane: queued #${index + 1} of ${after.length}${behind}. When the lane comes to this session it gets a toast${isAuto ? ' and the proceed-with-merge prompt' : ''}.`
}

async function laneRelease($: EngineInterface, ctx: Ctx, rt: Runtime): Promise<string> {
  const { io, p, selfId } = ctx
  await syncSession($, ctx)
  const holder = await readHolder(io, p)
  if (holder.kind === 'held' && holder.record?.sessionId === selfId) {
    const released = await releaseLane($, ctx, rt, '/lane release')
    if (!released.isReleased) return 'merge-lane: the lane changed hands before it could be released; run /lane to see it.'
    return released.next === null
      ? 'merge-lane: released the merge lane; nobody is waiting.'
      : `merge-lane: released the merge lane; woke ${released.next.label} · ${shortId(released.next.sessionId)}${prText(released.next.pr)}.`
  }
  const queue = await readQueue(io, p)
  if (queue.some(entry => entry.sessionId === selfId)) {
    await update($, entryAtom, () => null)
    await removeQueueEntry(io, p, selfId)
    await publish($, ctx, rt, holder, await readQueue(io, p))
    return 'merge-lane: left the merge lane queue.'
  }
  return 'merge-lane: this session neither holds nor waits for the merge lane.'
}

async function lanePrioritize($: EngineInterface, ctx: Ctx, rt: Runtime, command: LaneCommand): Promise<string> {
  const { io, p, selfId } = ctx
  await syncSession($, ctx)
  const now = await io.now()
  const queue = await readQueue(io, p)
  const arg = command.rest[0]
  const pr = arg === undefined ? null : prFromArg(arg)
  const isPrefix = arg !== undefined && /^[A-Za-z0-9_-]{4,128}$/.test(arg)
  const matches = queue.filter(entry =>
    arg === undefined ? entry.sessionId === selfId : (pr !== null && entry.pr === pr) || (isPrefix && entry.sessionId.startsWith(arg)),
  )
  if (matches.length === 0) {
    const holder = await readHolder(io, p)
    const record = holder.kind === 'held' ? holder.record : null
    if (record !== null && arg !== undefined && (record.pr === pr || (isPrefix && record.sessionId.startsWith(arg)))) {
      return `merge-lane: ${record.label}${prText(record.pr)} already holds the lane.`
    }
    return arg === undefined
      ? 'merge-lane: this session is not queued; name a session id (from /lane) or a PR number.'
      : `merge-lane: no queued session matches ${cleanText(arg, 40)}; /lane lists the ids.`
  }
  if (matches.length > 1) {
    return `merge-lane: ${cleanText(arg ?? '', 40)} matches ${matches.length} sessions (${matches.map(entry => shortId(entry.sessionId)).join(', ')}); give more of the id.`
  }
  const target = matches[0]
  if (target === undefined) return 'merge-lane: nothing to prioritize.'
  await writeOverlay(io, p, target.sessionId, now, selfId)
  const after = await readQueue(io, p)
  if ((await readHolder(io, p)).kind === 'free') {
    if (after[0]?.sessionId === selfId) await step($, ctx, rt, 'request')
    else await notifyHead(io, p, ctx.repoKey, selfId)
  }
  await publish($, ctx, rt, await readHolder(io, p), await readQueue(io, p))
  const position = (await readQueue(io, p)).findIndex(entry => entry.sessionId === target.sessionId)
  return position === -1
    ? `merge-lane: fronted ${target.label} · ${shortId(target.sessionId)}${prText(target.pr)}; it now holds the lane.`
    : `merge-lane: fronted ${target.label} · ${shortId(target.sessionId)}${prText(target.pr)}; it is now #${position + 1} of ${after.length}.`
}

/**
 * Breaks the current holder and takes the lane. The person confirms in a
 * dialog first (never mid-turn: then they rerun it idle); a dismissed dialog
 * is No. --yes skips the dialog only for a lock that looks stale: a live
 * holder may be mid-merge, so breaking it always takes the dialog's yes. The
 * break is judged against the holder as it stood when asked, so a lock that
 * changed hands meanwhile is left alone.
 */
async function laneTake($: EngineInterface, ctx: Ctx, rt: Runtime, command: LaneCommand): Promise<string> {
  const { io, p, selfId } = ctx
  const now = await io.now()
  const holder = await readHolder(io, p)
  const record = holder.kind === 'held' ? holder.record : null
  if (record?.sessionId === selfId) return 'merge-lane: this session already holds the merge lane.'
  if (holder.kind === 'held') {
    const alive = await aliveTimes(io, p)
    const isStale = looksStale({
      now,
      heartbeatAt: holder.heartbeatAt,
      aliveAt: record === null ? undefined : alive.get(record.sessionId),
      staleMinutes: rt.opts.staleMinutes,
    })
    if (!(command.isYes && isStale)) {
      if ((await read($, turnAtom)) !== null) {
        return isStale
          ? 'merge-lane: a turn is running; run /lane take once it ends, or /lane take --yes to break the stale lock now.'
          : 'merge-lane: a turn is running and the holder looks live; run /lane take once the turn ends to confirm breaking it.'
      }
      const who = record === null ? 'An unlabeled lock' : `${record.label} · ${shortId(record.sessionId)}${prText(record.pr)}`
      const question = `${who} holds the merge lane (heartbeat ${agoText(now - holder.heartbeatAt)}, ${isStale ? 'looks stale' : 'looks live'}). Break it and take the lane?`
      const answer = await $.ui.ask(question, ['Take the lane', 'Keep it']).catch(() => 'Keep it')
      if (answer !== 'Take the lane') return 'merge-lane: kept; nothing changed.'
    }
  }
  return serialize(rt, async () => {
    await syncSession($, ctx)
    if (holder.kind === 'held') {
      const broke = await breakHolder(io, p, judgedOf(holder))
      if (broke === 'changed') return 'merge-lane: the lane changed hands while you decided; run /lane take again.'
    }
    const own = (await readQueue(io, p)).find(entry => entry.sessionId === selfId)
    const taken: HolderRecord = {
      sessionId: selfId,
      label: own?.label ?? (await labelFor($, ctx)),
      pr: own?.pr ?? null,
      since: await io.now(),
      implicit: false,
      repo: ctx.repo,
    }
    if (record !== null) taken.takenFrom = `${record.label} · ${shortId(record.sessionId)}`
    if ((await acquire(io, p, taken)) !== 'acquired') return 'merge-lane: another session claimed the lane first; run /lane to see it.'
    if (own !== undefined) {
      await removeQueueEntry(io, p, selfId)
      const notified = await read($, notifiedAtom)
      await update($, notifiedAtom, () => [...notified, own.nonce].slice(-MAX_NOTIFIED))
    }
    if (record !== null) await io.send(record.sessionId, makeEnvelope({ kind: 'lane.changed', repoKey: ctx.repoKey }))
    await publish($, ctx, rt, await readHolder(io, p), await readQueue(io, p))
    return holder.kind === 'free'
      ? 'merge-lane: the lane was free; it is yours now.'
      : `merge-lane: took the merge lane${record === null ? '' : ` from ${record.label} · ${shortId(record.sessionId)}`}.`
  })
}

/* ------------------------------------------------------------------------ */
/* Host I/O                                                                  */
/* ------------------------------------------------------------------------ */
//
// The lane's I/O on the real host and the few git/gh reads the mod makes. It
// lives in this file because the engine follows `$` only into functions of
// the hooks module itself; the protocol (lane.ts) sees only the LaneIO.

const FS_TIMEOUT_MS = 10_000
const GH_TIMEOUT_MS = 20_000
const GIT_TIMEOUT_MS = 10_000

/**
 * LaneIO over `$`. `mkdir`, `mv`, `rm` and `touch` are the atomic primitives
 * `$.fs` lacks, run by argv (no shell). Every path must sit under the lane
 * root: a path built wrong is refused before any process runs, so `rm -rf`
 * can never reach outside ~/.claude/merge-lane.
 */
function hostIO($: EngineInterface, root: string): LaneIO {
  const inside = (path: string): string => {
    if (!path.startsWith(`${root}/`) || path.split('/').includes('..')) {
      throw new Error('merge-lane refused a path outside its lane directory')
    }
    return path
  }
  const run = (argv: readonly string[]) => $.process.run(argv, { timeoutMs: FS_TIMEOUT_MS })
  return {
    now: () => $.clock.now(),
    uuid: () => crypto.randomUUID(),
    async mkdir(path): Promise<MkdirResult> {
      const made = await run(['mkdir', inside(path)])
      if (made.exitCode === 0) return 'created'
      // mkdir exits 1 for "File exists" and for a missing parent or EACCES alike
      if (/File exists/i.test(made.stderr)) return 'exists'
      return (await $.fs.exists(path)) ? 'exists' : 'error'
    },
    async mkdirp(paths) {
      return (await run(['mkdir', '-p', ...paths.map(inside)])).exitCode === 0
    },
    async rename(from, to) {
      return (await run(['mv', inside(from), inside(to)])).exitCode === 0
    },
    async remove(paths) {
      if (paths.length > 0) await run(['rm', '-rf', ...paths.map(inside)])
    },
    async touch(path) {
      return (await run(['touch', inside(path)])).exitCode === 0
    },
    async read(path) {
      try {
        return await $.fs.read(inside(path))
      } catch {
        return undefined
      }
    },
    async write(path, text) {
      await $.fs.write(inside(path), text)
    },
    async list(dir): Promise<readonly ListedEntry[]> {
      try {
        return (await $.fs.list(inside(dir))).map(entry => ({
          name: entry.name,
          kind: entry.kind,
          mtimeMs: entry.mtimeMs,
        }))
      } catch {
        return []
      }
    },
    async mtime(path) {
      try {
        return (await $.fs.stat(inside(path))).mtimeMs
      } catch {
        return undefined
      }
    },
    async send(sessionId, text): Promise<Delivery> {
      try {
        const sent = await $.session.send({ to: { sessionId }, text })
        return sent.isDelivered ? 'delivered' : 'absent'
      } catch {
        // A send that failed says nothing about the other session: never prune on it.
        return 'unknown'
      }
    },
  }
}

type GhResult = { exitCode: number; stdout: string }

/**
 * Runs `gh` by argv with a 20 s bound. A desktop-launched process may not have
 * Homebrew on its PATH, so a gh that cannot start is retried through a login
 * zsh, its arguments passed as positional parameters (never spliced into the
 * script). Null when gh cannot run at all.
 */
async function runGh($: EngineInterface, args: readonly string[], cwd?: string): Promise<GhResult | null> {
  const init = cwd === undefined ? { timeoutMs: GH_TIMEOUT_MS } : { timeoutMs: GH_TIMEOUT_MS, cwd }
  try {
    const ran = await $.process.run(['gh', ...args], init)
    return { exitCode: ran.exitCode, stdout: ran.stdout }
  } catch {
    try {
      const ran = await $.process.run(['/bin/zsh', '-lc', 'exec gh "$@"', 'gh', ...args], init)
      return ran.exitCode === 127 ? null : { exitCode: ran.exitCode, stdout: ran.stdout }
    } catch {
      return null
    }
  }
}

/** One line of a git read (`git <args>`), trimmed; null when git fails. */
async function gitLine($: EngineInterface, args: readonly string[], cwd?: string): Promise<string | null> {
  try {
    const init = cwd === undefined ? { timeoutMs: GIT_TIMEOUT_MS } : { timeoutMs: GIT_TIMEOUT_MS, cwd }
    const ran = await $.process.run(['git', ...args], init)
    const line = ran.stdout.trim().split('\n')[0]?.trim() ?? ''
    return ran.exitCode === 0 && line !== '' ? line : null
  } catch {
    return null
  }
}

/** A PR's state and number from `gh pr view`, or null when gh cannot say. */
async function prView(
  $: EngineInterface,
  selector: string | null,
  repo: string | null,
  cwd: string,
): Promise<{ state: string; number: string | null } | null> {
  const args = ['pr', 'view']
  if (selector !== null) args.push(selector)
  args.push('--json', 'number,state')
  // -R needs a selector; without one gh reads the branch checked out in cwd
  if (selector !== null && repo !== null) args.push('-R', repo)
  const ran = await runGh($, args, cwd)
  if (ran === null || ran.exitCode !== 0) return null
  try {
    const value: unknown = JSON.parse(ran.stdout)
    if (typeof value !== 'object' || value === null) return null
    const { state, number } = value as { state?: unknown; number?: unknown }
    if (typeof state !== 'string') return null
    return {
      state: cleanText(state, 20).toUpperCase(),
      number: typeof number === 'number' && Number.isInteger(number) ? String(number) : null,
    }
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return cleanText(message, 160) || 'unknown error'
}
