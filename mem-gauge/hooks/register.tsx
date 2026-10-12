// mem-gauge: a memory gauge under the composer and a Memory pane that shows
// what is eating this Mac's RAM across Claude sessions, agents, models and
// other apps, with rule-based advice. Every session running the mod publishes
// a small heartbeat file under ~/.claude/mem-gauge/sessions/, so any one
// session's pane sees them all. Drawings read $.state only; processes run from
// the timer, a command or a press, never while drawing.
//
// The engine requires `$` to be handed only to functions declared at the top of
// this file, so every function that touches `$` lives here; the parsing and the
// advice rules are pure and live in parse.ts and advice.ts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiskReport, SessionRow, Snapshot, WrapRequest } from '../types'
import { advise, applyHome, compactReport, diskActionArgv, diskActionLabel, diskActionQuestion, diskAdvice, quitAppArgv, summaryLine } from './advice'
import type { Advice, AdviceOptions, DiskAdvice } from './advice'
import {
  bar,
  basename,
  buildMachine,
  claimUnregistered,
  cleanBranch,
  decodeEngineSession,
  decodeMachine,
  diskLine,
  engineRow,
  decodeWrapRequest,
  descendants,
  encodeMachine,
  footerParts,
  formatBytes,
  glyph,
  formatMB,
  isCollectable,
  isEngineName,
  isSessionId,
  parseDfAll,
  parseDu,
  oneLine,
  parseEntry,
  parsePs,
  ringSvg,
  rowOf,
  shortModel,
  sortRows,
  statusLine,
  summaryParts,
  statusOf,
  topApps,
  treeMB,
} from './parse'
import type { MachineFile, Proc, RegistryEntry } from './parse'

type Dollar = EngineInterface

// $.state values, one literal plugin/key reference each, so `claude plugin
// validate` holds them to types/index.d.ts. Written only from handlers, timers
// and events, never while drawing.
const snapshotRef = atom({ plugin: 'mem-gauge', key: 'snapshot' } as const, null)
const enginePidRef = atom({ plugin: 'mem-gauge', key: 'enginePid' } as const, null)
const pidCheckedRef = atom({ plugin: 'mem-gauge', key: 'pidChecked' } as const, false)
const lastActivityRef = atom({ plugin: 'mem-gauge', key: 'lastActivityAt' } as const, 0)
const askedRef = atom({ plugin: 'mem-gauge', key: 'asked' } as const, {})
const labelRef = atom({ plugin: 'mem-gauge', key: 'label' } as const, null)
const figuresRef = atom({ plugin: 'mem-gauge', key: 'figures' } as const, null)
const wrapRef = atom({ plugin: 'mem-gauge', key: 'wrapRequest' } as const, null)
const showAllRef = atom({ plugin: 'mem-gauge', key: 'showAllSessions' } as const, false)
const diskRef = atom({ plugin: 'mem-gauge', key: 'disk' } as const, null)
const applyingRef = atom({ plugin: 'mem-gauge', key: 'applying' } as const, [] as string[])

const PANE = 'mem-gauge'
const DISK_PANE = 'mem-gauge-disk'
/** The disk pane re-reads the volumes and folders when its report is older than this. */
const DISK_REFRESH_AFTER_MS = 60_000
/** The folders that usually eat a Mac developer's disk, measured with `du -sk` when the disk pane opens. */
const DISK_FOLDERS: readonly { rel: string; label: string }[] = [
  { rel: '.claude/projects', label: 'Claude transcripts (~/.claude/projects)' },
  { rel: '.claude/file-history', label: 'Claude file history' },
  { rel: 'Library/Developer/Xcode/DerivedData', label: 'Xcode DerivedData' },
  { rel: 'Library/Developer/CoreSimulator/Devices', label: 'iOS simulator devices' },
  { rel: 'Library/Caches', label: 'Library caches' },
  { rel: '.Trash', label: 'Trash' },
]
const ASK = 'Ask to wrap'
const APPLY = 'Apply'
/** An Apply's command (a find over a big folder, simctl) may take a while. */
const APPLY_TIMEOUT_MS = 120_000
/** An app asked to quit may first show a save sheet; the request is delivered either way. */
const QUIT_TIMEOUT_MS = 30_000
/** The disk icon on surfaces with no vector element: stacked discs (U+26C1). */
const DISK_GLYPH = '\u26C1'
/** The pane lists this many active sessions, biggest first, until View all is pressed. */
const TOP_SESSIONS = 10
const ASK_EVERY_MS = 10 * 60_000
/** /mem and a press of the gauge re-read when the snapshot is older than this. */
const REFRESH_AFTER_MS = 10_000
const TIMEOUT_MS = 5000
/** du over a big folder (the simulator devices run past 5 s on a full Mac); the pane says it is reading meanwhile. */
const DU_TIMEOUT_MS = 10_000
/** A shared machine reading younger than this (plus jitter) is reused, not re-collected. */
const FRESH_MS = 25_000
const JITTER_MS = 5000
/** A wrap request older than this is dropped unseen. */
const WRAP_TTL_MS = 30 * 60_000
const MAX_FILES = 200
const MAX_GC_PER_TICK = 10
/** Engine session records read per tick for sessions that do not run the mod. */
const MAX_ENGINE_ROWS = 60
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting'])
/** A request stamped further ahead than this is refused: a future `at` would never expire. */
const CLOCK_SKEW_MS = 60_000
/**
 * The origins that count as the person: their own Enter, the Remote Control
 * bridge, and the SDK host (the desktop Code tab drives the engine through
 * it). Only these open (and focus) the pane. Every other origin, and any kind
 * this list does not know, gets one summary line in a session that draws (no
 * other session's label lands in this transcript on a peer's or a schedule's
 * say-so), and the table only where nothing can draw (-p).
 */
const PANE_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
/**
 * Inconclusive pid probes (sh or ps failed or timed out) retried before giving
 * up; a clear answer (an engine, or ps naming something else) is cached at once.
 */
const MAX_PID_PROBES = 5
/** sysctl names read on every collection; memory size and cores never change, so they are read once. */
const DYNAMIC_SYSCTL = ['kern.memorystatus_level', 'vm.swapusage', 'vm.loadavg']

type TickResult = { snapshot: Snapshot; wrap: WrapRequest | null; newRequest: WrapRequest | null }

// Per-load plumbing, not state: register() sets the options, and a hot reload
// starts these over together with the timers it cancels; session.start (or the
// next turn) arms again.
let config = { intervalMs: 30_000, advice: { idleMinutes: 30 } as AdviceOptions, showStatus: true, footerButtons: true, footerCompact: false }
let timer: { cancel: () => void } | null = null
let running: Promise<TickResult | null> | null = null
let diskScan: Promise<void> | null = null
// Apply presses in flight, by tip key, each under a token so only the press that claimed releases
// (a reload resets the map; a claim from before it can no longer clear a new one). Mirrored to $.state for drawing.
let applying = new Map<string, number>()
let applyToken = 0
let dirCache: string | null = null
let hardware: { totalBytes: number; cores: number } | null = null
// Inconclusive pid probes this load; a hot reload allows a few more, which is harmless.
let pidProbes = 0

const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** An error's kind only: a message could carry a path or command output. */
const kindOf = (err: unknown): string => (err instanceof Error && err.name ? err.name : 'error')

/** `HOME` from the environment, as an absolute path; never '~'. */
async function dataDir($: Dollar): Promise<string | null> {
  if (dirCache) return dirCache
  try {
    const home = await $.env.get('HOME')
    dirCache = home && home.startsWith('/') ? `${home.replace(/\/+$/, '')}/.claude/mem-gauge` : null
  } catch {
    dirCache = null
  }
  return dirCache
}

/** stdout of one argv, or null when it failed to start, timed out, or said nothing. */
async function runText($: Dollar, argv: string[], cwd: string | undefined, timeoutMs = TIMEOUT_MS): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return r.stdout.trim() === '' ? null : r.stdout
  } catch {
    return null
  }
}

async function readText($: Dollar, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

async function writeText($: Dollar, path: string, text: string): Promise<boolean> {
  try {
    await $.fs.write(path, text)
    return true
  } catch {
    return false
  }
}

/** Removes one of mem-gauge's own files ($.fs has no remove). */
async function removeFile($: Dollar, path: string): Promise<void> {
  try {
    await $.process.run(['rm', '-f', path], { timeoutMs: TIMEOUT_MS })
  } catch {
    // A file left behind is collected by a later tick.
  }
}

/** One sysctl for every name, vm_stat, df and ps, in parallel. */
async function collectMachine($: Dollar, now: number, cwd: string | undefined): Promise<MachineFile> {
  const known = hardware
  const [sysctl, vmStat, df, ps] = await Promise.all([
    runText($, ['sysctl', ...(known ? [] : ['hw.memsize', 'hw.ncpu']), ...DYNAMIC_SYSCTL], cwd),
    runText($, ['vm_stat'], cwd),
    runText($, ['df', '-k', '/'], cwd),
    runText($, ['ps', '-axo', 'pid=,ppid=,rss=,comm='], cwd),
  ])
  const procs = ps === null ? [] : parsePs(ps)
  // The cached constants are handed to the same parser as sysctl's own lines.
  const constants = known ? `hw.memsize: ${known.totalBytes}\nhw.ncpu: ${known.cores}\n` : ''
  const stats = buildMachine(now, { sysctl: constants + (sysctl ?? '') || null, vmStat, df })
  if (!known && stats.totalBytes !== null && stats.cores !== null) hardware = { totalBytes: stats.totalBytes, cores: stats.cores }
  return { v: 1, at: now, stats, procs: procs.length > 0 ? procs : null }
}

/**
 * The shared reading when another session took it recently; otherwise this
 * session collects and shares it. Two sessions collecting at once is the only
 * race, and it is harmless, so there is no lock.
 */
async function machineReading($: Dollar, dir: string | null, now: number, cwd: string | undefined): Promise<MachineFile> {
  if (dir) {
    const text = await readText($, `${dir}/machine.json`)
    const shared = text === null ? null : decodeMachine(text)
    if (shared && shared.at <= now && now - shared.at < FRESH_MS + Math.random() * JITTER_MS) return shared
  }
  const fresh = await collectMachine($, now, cwd)
  if (dir) await writeText($, `${dir}/machine.json`, encodeMachine(fresh))
  return fresh
}

/**
 * The engine's pid: the parent of a `sh` this plugin starts, accepted only when
 * ps names it claude/node/bun. There is no pid API, so an unverified answer
 * stays null and the pane says "unknown" rather than show a wrong number.
 */
async function enginePid($: Dollar, cwd: string | undefined): Promise<number | null> {
  if (await read($, pidCheckedRef)) return read($, enginePidRef)
  // A clear answer is cached for the session; anything else (a failed or
  // timed-out sh or ps, an empty answer) is retried on later ticks, so one
  // transient failure does not leave "this session unknown" for good.
  let answer: { pid: number | null } | null = null
  try {
    const echoed = await $.process.run(['sh', '-c', 'echo $PPID'], { cwd, timeoutMs: TIMEOUT_MS })
    const candidate = Number(echoed.stdout.trim())
    if (echoed.exitCode === 0 && Number.isSafeInteger(candidate) && candidate > 1) {
      const comm = await $.process.run(['ps', '-o', 'comm=', '-p', String(candidate)], { cwd, timeoutMs: TIMEOUT_MS })
      const name = basename(comm.stdout.trim())
      if (comm.exitCode === 0 && name !== '') answer = { pid: isEngineName(name) ? candidate : null }
    }
  } catch {
    // Could not start or timed out: inconclusive.
  }
  if (!answer) {
    pidProbes += 1
    if (pidProbes < MAX_PID_PROBES) return null
    answer = { pid: null }
  }
  const pid = answer.pid
  await update($, enginePidRef, () => pid)
  await update($, pidCheckedRef, () => true)
  return pid
}

/** "<repo basename> · <branch>" from the session's root and its cwd's checked-out branch. */
async function refreshLabel($: Dollar): Promise<void> {
  try {
    const root = await $.session.root()
    const cwd = await $.session.cwd()
    const out = await runText($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    const branch = out === null ? null : cleanBranch(out)
    const name = oneLine(basename(root), 100) || 'session'
    await update($, labelRef, () => (branch ? `${name} · ${branch}` : name))
  } catch {
    // The label falls back to the cwd's basename.
  }
}

/** This session's registry entry: figures only, never prompt text or a secret. */
async function ownEntry($: Dollar, sessionId: string, pid: number | null, rssMB: number | null, cwd: string, now: number): Promise<RegistryEntry> {
  const [usage, model, agents] = await Promise.all([
    $.session.usage().catch(() => null),
    $.session.model().catch(() => ''),
    $.agent.list().catch(() => []),
  ])
  const label = await read($, labelRef)
  const lastActivityAt = await read($, lastActivityRef)
  const figures = await read($, figuresRef)
  const rateLimit = usage && usage.rateLimits.length > 0 ? Math.max(...usage.rateLimits.map(r => r.percentUsed)) : null
  const startedAt = usage?.startedAt ?? now
  return {
    v: 1,
    sessionId,
    pid,
    label: label ?? (oneLine(basename(cwd), 100) || 'session'),
    cwd,
    model,
    rssMB,
    contextPercent: usage?.context.percent ?? figures?.contextPercent ?? null,
    rateLimitPercent: rateLimit ?? figures?.rateLimitPercent ?? null,
    // list() keeps finished agents until the engine drops them.
    agents: agents.filter(a => ACTIVE_AGENT.has(a.status)).length,
    // Before any turn the session has been idle since it started.
    lastActivityAt: Math.max(lastActivityAt, startedAt),
    startedAt,
    updatedAt: now,
  }
}

type RegistryFile = { path: string; entry: RegistryEntry | null; mtimeMs: number }

/** Every other session's entry; an unreadable file is kept as null for garbage collection. */
async function readRegistry($: Dollar, dir: string, thisId: string): Promise<RegistryFile[]> {
  let list: { name: string; kind: string; mtimeMs: number }[] = []
  try {
    list = await $.fs.list(`${dir}/sessions`)
  } catch {
    return [] // no folder yet
  }
  const files = list
    .filter(f => f.kind === 'file' && f.name.endsWith('.json') && isSessionId(f.name.slice(0, -5)) && f.name !== `${thisId}.json`)
    .slice(0, MAX_FILES)
  const texts = await Promise.all(files.map(f => readText($, `${dir}/sessions/${f.name}`)))
  return files.map((f, i) => {
    const text = texts[i] ?? null
    const entry = text === null ? null : parseEntry(text)
    // A file whose content names another id is treated as unreadable.
    return { path: `${dir}/sessions/${f.name}`, entry: entry && `${entry.sessionId}.json` === f.name ? entry : null, mtimeMs: f.mtimeMs }
  })
}

/** Picks up (and removes) a wrap request another session left for this one. */
async function takeWrapRequest($: Dollar, dir: string, sessionId: string, now: number): Promise<WrapRequest | null> {
  const path = `${dir}/requests/${sessionId}.json`
  const text = await readText($, path)
  if (text === null) return null
  await removeFile($, path)
  const request = decodeWrapRequest(text)
  return request && isCurrent(request, now) ? request : null
}

/** A wrap request still worth showing: not expired, and not stamped in the future. */
const isCurrent = (request: WrapRequest, now: number): boolean =>
  request.at <= now + CLOCK_SKEW_MS && now - request.at < WRAP_TTL_MS

/**
 * Removes request files nobody picked up (the target crashed or never ran
 * mem-gauge), so the folder does not grow. Only session-id-named files are
 * touched; the cap keeps one tick's work bounded.
 */
async function collectRequests($: Dollar, dir: string, now: number): Promise<void> {
  let list: { name: string; kind: string; mtimeMs: number }[] = []
  try {
    list = await $.fs.list(`${dir}/requests`)
  } catch {
    return // no folder yet
  }
  const old = list
    .filter(f => f.kind === 'file' && f.name.endsWith('.json') && isSessionId(f.name.slice(0, -5)) && now - f.mtimeMs > WRAP_TTL_MS)
    .slice(0, MAX_GC_PER_TICK)
  for (const f of old) await removeFile($, `${dir}/requests/${f.name}`)
}

/** One full tick; runTick keeps two from overlapping. */
async function tick($: Dollar): Promise<TickResult> {
  const now = await $.clock.now()
  // Re-read every tick: /clear moves the process to a new id with no session.start.
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd().catch(() => '')
  const runCwd = cwd || undefined
  const dir = await dataDir($)

  const [machine, pid] = await Promise.all([machineReading($, dir, now, runCwd), enginePid($, runCwd)])
  const procs: Proc[] = machine.procs ?? []
  const thisMB = pid === null ? null : treeMB(procs, pid)

  const own = await ownEntry($, sessionId, pid, thisMB, cwd, now)
  // After /clear the old id's heartbeat would read as a second live session on
  // the same pid. session.end removes it, but that hook can lose its 1.5 s
  // bound, so the first tick under the new id removes it too.
  const previous = (await read($, snapshotRef))?.sessionId
  const clearedId = previous && previous !== sessionId && isSessionId(previous) ? previous : null
  if (dir && clearedId) await removeFile($, `${dir}/sessions/${clearedId}.json`)
  const registry = dir ? await readRegistry($, dir, sessionId) : []
  const others = registry.filter(f => !clearedId || !f.path.endsWith(`/${clearedId}.json`))
  if (dir && isSessionId(sessionId)) await writeText($, `${dir}/sessions/${sessionId}.json`, JSON.stringify(own))

  const index = machine.procs ? { at: machine.at, byPid: new Map(procs.map(p => [p.pid, p])) } : null
  const rows = [rowOf(own, 'live', now, sessionId)]
  const claude = new Set<number>(pid === null ? [] : descendants(procs, pid))
  let collected = 0
  for (const { path, entry, mtimeMs } of others) {
    const status = entry ? statusOf(entry, now, index) : null
    if (collected < MAX_GC_PER_TICK && isCollectable(entry, status, now, mtimeMs)) {
      collected += 1
      await removeFile($, path)
      continue
    }
    if (!entry || !status) continue
    rows.push(rowOf(entry, status, now, sessionId))
    if (status !== 'gone' && entry.pid !== null) for (const p of descendants(procs, entry.pid)) claude.add(p)
  }

  // Several sessions asking at once (or one asking again) overwrite one file and
  // raise one toast: while a request is already showing, a new one only
  // refreshes it.
  const before = await read($, wrapRef)
  const wasShowing = before !== null && isCurrent(before, now)
  const taken = dir && isSessionId(sessionId) ? await takeWrapRequest($, dir, sessionId, now) : null
  if (taken) await update($, wrapRef, () => taken)
  // Derived, not re-read: every read of one dispatch may see the moment it
  // began, so a read here could miss the write above (and then clear it).
  const held = taken ?? before
  const wrap = held && isCurrent(held, now) ? held : null
  if (!taken && before && !wrap) await update($, wrapRef, () => null)
  const newRequest = taken && !wasShowing ? taken : null
  if (dir) await collectRequests($, dir, now)

  // Claims the unregistered engines' trees too, so neither they nor their MCP
  // servers are listed as "other apps". Each one with a session record of the
  // engine's own (~/.claude/sessions/<pid>.json) is listed by name with its
  // memory; the rest are summed on one line.
  const claimed = machine.procs ? claimUnregistered(procs, claude) : null
  let unregistered: { count: number; rssMB: number } | null = null
  if (claimed) {
    unregistered = { count: 0, rssMB: 0 }
    const home = await homeDir($)
    const listed = new Set(rows.map(r => r.sessionId))
    for (const root of claimed.roots.slice(0, MAX_ENGINE_ROWS)) {
      const text = home ? await readText($, `${home}/.claude/sessions/${root.pid}.json`) : null
      const session = text ? decodeEngineSession(text, root.pid, now) : null
      if (session && !listed.has(session.sessionId)) {
        listed.add(session.sessionId)
        rows.push(engineRow(root.pid, root.rssMB, session))
      } else {
        unregistered.count += 1
        unregistered.rssMB += root.rssMB
      }
    }
    for (const root of claimed.roots.slice(MAX_ENGINE_ROWS)) {
      unregistered.count += 1
      unregistered.rssMB += root.rssMB
    }
  }
  const snapshot: Snapshot = {
    at: now,
    sessionId,
    machine: machine.stats,
    thisSessionMB: thisMB,
    sessions: sortRows(rows).slice(0, 60),
    unregistered,
    topApps: topApps(procs, claude, 10),
  }
  await update($, snapshotRef, () => snapshot)
  return { snapshot, wrap, newRequest }
}

function publishStatus($: Dollar, snapshot: Snapshot, wrap: WrapRequest | null): void {
  // Never clear with `undefined`: on the desktop host that call stops every
  // later render from reaching this plugin (seen on app 2.31226 / CLI 2.1.293),
  // so a line pinned by an earlier load stays until the session restarts.
  if (config.showStatus) $.ui.status(statusLine(snapshot, wrap))
}

/** One tick at a time: a tick that outlasts the period, or a /mem during one, joins it. */
function runTick($: Dollar): Promise<TickResult | null> {
  if (running) return running
  let mine: Promise<TickResult | null> | null = null
  mine = (async () => {
    try {
      const result = await tick($)
      if (result.newRequest) {
        const frees = result.newRequest.freesMB === null ? '' : ` (frees about ${formatMB(result.newRequest.freesMB)})`
        $.ui.toast(`Memory: another session asked this one to wrap up${frees}. Nothing runs on its own.`, { timeoutMs: 10_000 })
      }
      publishStatus($, result.snapshot, result.wrap)
      return result
    } catch (err) {
      $.ui.log(`mem-gauge: tick failed (${kindOf(err)})`, { to: 'debug' })
      return null
    } finally {
      // Only the tick that holds the slot clears it (a hot reload resets the slot under a running tick).
      if (running === mine) running = null
    }
  })()
  running = mine
  return mine
}

function arm($: Dollar): void {
  if (timer) return
  timer = $.clock.every(config.intervalMs, () => {
    void runTick($)
  })
}

async function markActive($: Dollar): Promise<void> {
  const now = await $.clock.now()
  await update($, lastActivityRef, () => now)
}

/** Opens the pane: from /mem or a press of the gauge, so it is placed at any width. */
async function openPane($: Dollar) {
  const wrap = await read($, wrapRef)
  const opened = await $.ui.open({ id: PANE, title: 'Memory', focus: true, closeOnEscape: true })
  // Only a placed pane counts as seen: an unplaced one keeps the reminder.
  if (wrap && opened.isPlaced) {
    await update($, wrapRef, () => null)
    const shown = await read($, snapshotRef)
    if (shown) publishStatus($, shown, null)
  }
  const snapshot = await read($, snapshotRef)
  if (!snapshot || (await $.clock.now()) - snapshot.at > REFRESH_AFTER_MS) void runTick($)
  return opened
}

/** `HOME`, derived from the data dir (which is `$HOME/.claude/mem-gauge`). */
async function homeDir($: Dollar): Promise<string | null> {
  const dir = await dataDir($)
  return dir ? dir.replace(/\/\.claude\/mem-gauge$/, '') : null
}

/** Reads every volume (`df -kP`, 5 s) and the usual big folders (`du -sk` each, in parallel, 10 s each) into the disk report. */
async function diskReading($: Dollar): Promise<void> {
  const now = await $.clock.now()
  const cwd = (await $.session.cwd().catch(() => '')) || undefined
  const home = await homeDir($)
  const paths = DISK_FOLDERS.map(f => (home ? `${home}/${f.rel}` : null))
  const [df, ...dus] = await Promise.all([
    runText($, ['df', '-kP'], cwd),
    ...paths.map(path => (path ? runText($, ['du', '-sk', path], cwd, DU_TIMEOUT_MS) : Promise.resolve(null))),
  ])
  const report: DiskReport = {
    at: now,
    volumes: df ? parseDfAll(df) : [],
    folders: DISK_FOLDERS.map((f, i) => ({ path: paths[i] ?? f.rel, label: f.label, bytes: dus[i] ? parseDu(dus[i]) : null })),
  }
  await update($, diskRef, () => report)
}

/** One disk reading at a time: a Refresh during one joins it; `fresh` waits for it and then reads again (after an Apply). */
async function runDiskScan($: Dollar, fresh = false): Promise<void> {
  if (diskScan) {
    if (!fresh) return diskScan
    await diskScan.catch(() => undefined)
  }
  let mine: Promise<void> | null = null
  mine = diskReading($)
    .catch(err => {
      $.ui.log(`mem-gauge: disk reading failed (${kindOf(err)})`, { to: 'debug' })
    })
    .finally(() => {
      // Only the scan that holds the slot clears it: a hot reload resets the slot under a running scan.
      if (diskScan === mine) diskScan = null
    })
  diskScan = mine
  return mine
}

async function openDiskPane($: Dollar) {
  const opened = await $.ui.open({ id: DISK_PANE, title: 'Disk', focus: true, closeOnEscape: true })
  const now = await $.clock.now()
  const report = await read($, diskRef)
  if (!report || now - report.at > DISK_REFRESH_AFTER_MS) void runDiskScan($)
  const snapshot = await read($, snapshotRef)
  if (!snapshot || now - snapshot.at > REFRESH_AFTER_MS) void runTick($)
  return opened
}

/**
 * Claims a tip's Apply from the press until it is over (dialog included): a
 * second press meanwhile is ignored. The module set is the truth (a reload
 * resets it); $.state mirrors it so the pane draws Applying.
 */
async function beginApply($: Dollar, key: string): Promise<number | null> {
  if (applying.has(key)) return null
  const token = ++applyToken
  applying.set(key, token)
  try {
    await update($, applyingRef, held => (held.includes(key) ? held : [...held, key]))
  } catch (err) {
    // The claim is only as good as its mirror: a press that cannot draw Applying is let go.
    if (applying.get(key) === token) applying.delete(key)
    $.ui.log(`mem-gauge: apply state (${kindOf(err)})`, { to: 'debug' })
    return null
  }
  return token
}

async function endApply($: Dollar, key: string, token: number): Promise<void> {
  if (applying.get(key) !== token) return
  applying.delete(key)
  await update($, applyingRef, held => held.filter(k => k !== key)).catch(() => undefined)
}

/**
 * Apply on a Disk tip: confirms in the engine's own dialog, then runs the
 * one fixed command for that action (argv, no shell, paths from $HOME and a
 * fixed list) with a long timeout, says how it went, and re-reads the sizes.
 * A press while it runs, a dismissed dialog, or Cancel does nothing.
 */
async function applyDisk($: Dollar, tip: DiskAdvice): Promise<void> {
  if (!tip.action) return
  const key = `disk:${tip.key}`
  const token = await beginApply($, key)
  if (token === null) return
  let ran = false
  try {
    let choice: string
    try {
      choice = await $.ui.ask(diskActionQuestion(tip.action), { options: [APPLY, 'Cancel'], header: 'Disk' })
    } catch {
      return
    }
    if (choice !== APPLY) return
    const home = applyHome(await homeDir($))
    if (!home) {
      $.ui.toast('Disk: cannot apply, HOME is unknown or not a plain absolute path.')
      return
    }
    const label = diskActionLabel(tip.action)
    try {
      const r = await $.process.run(diskActionArgv(tip.action, home), { timeoutMs: APPLY_TIMEOUT_MS })
      ran = true
      $.ui.toast(
        r.exitCode === 0
          ? `Disk: done, ${label}. Re-reading sizes.`
          : `Disk: ${label} finished with errors (exit ${r.exitCode}); some entries may be protected. Re-reading sizes.`,
      )
    } catch (err) {
      // A timeout may have removed part of the folder: re-read either way.
      ran = true
      $.ui.toast(`Disk: could not finish ${label} (${kindOf(err)}); some entries may be gone. Re-reading sizes.`)
    }
  } finally {
    await endApply($, key, token)
  }
  if (ran) void runDiskScan($, true)
}

/**
 * Apply on a Memory tip: Ask to wrap (the existing flow, with its own
 * confirmation), compact this session, quit an app gracefully (confirmed), or
 * open the Disk pane. A tip with no action has no button.
 */
async function applyMemory($: Dollar, tip: Advice, rowsById: ReadonlyMap<string, SessionRow>): Promise<void> {
  const action = tip.action
  if (!action) return
  if (action.kind === 'ask-wrap') {
    const target = rowsById.get(action.sessionId)
    if (target) await askToWrap($, target)
    return
  }
  if (action.kind === 'open-disk') {
    await openDiskPane($)
    return
  }
  const key = `memory:${tip.key}`
  const token = await beginApply($, key)
  if (token === null) return
  try {
    if (action.kind === 'compact') {
      let choice: string
      try {
        choice = await $.ui.ask('Compact this session now (the conversation so far is summarized to free context)?', { options: [APPLY, 'Cancel'], header: 'Memory' })
      } catch {
        return
      }
      if (choice !== APPLY) return
      try {
        await $.command.run({ command: 'compact' })
        $.ui.toast('Memory: /compact queued; it runs when the session is idle.')
      } catch (err) {
        $.ui.toast(`Memory: could not run /compact (${kindOf(err)}).`)
      }
      return
    }
    // quit-app
    const argv = quitAppArgv(action.app)
    if (!argv) {
      $.ui.toast('Memory: that app name cannot be passed to osascript safely; quit it yourself.')
      return
    }
    let choice: string
    try {
      choice = await $.ui.ask(`Quit ${action.app} the normal way (it may ask you to save first)?`, { options: [APPLY, 'Cancel'], header: 'Memory' })
    } catch {
      return
    }
    if (choice !== APPLY) return
    try {
      const r = await $.process.run(argv, { timeoutMs: QUIT_TIMEOUT_MS })
      $.ui.toast(r.exitCode === 0 ? `Memory: ${action.app} was asked to quit.` : `Memory: ${action.app} did not take the quit (exit ${r.exitCode}).`)
    } catch (err) {
      $.ui.toast(
        kindOf(err) === 'TimeoutError'
          ? `Memory: ${action.app} was asked to quit; it may be waiting on a save dialog.`
          : `Memory: could not ask ${action.app} to quit (${kindOf(err)}).`,
      )
    }
    void runTick($)
  } finally {
    await endApply($, key, token)
  }
}

/**
 * Leaves a request file for another session's copy of this mod, which shows
 * its person a toast and a marker. No model reads it and nothing runs on its
 * own: a peer message would wake that session into a turn (spending the very
 * memory this frees) and could be read as an instruction to ship.
 */
async function askToWrap($: Dollar, row: SessionRow): Promise<void> {
  const now = await $.clock.now()
  const asked = await read($, askedRef)
  if (now - (asked[row.sessionId] ?? 0) < ASK_EVERY_MS) {
    $.ui.toast('Memory: that session was asked less than 10 minutes ago.')
    return
  }
  let choice: string
  try {
    choice = await $.ui.ask(
      `It has been idle ${row.idleMinutes ?? '?'} min and holds ${formatMB(row.rssMB)}. Ask "${row.label}" to wrap up?`,
      { options: [ASK, 'Cancel'], header: 'Memory' },
    )
  } catch {
    return // dismissed, or nobody to ask
  }
  if (choice !== ASK) return
  const dir = await dataDir($)
  const from = await $.session.id().catch(() => '')
  const isSent =
    dir !== null &&
    isSessionId(row.sessionId) &&
    isSessionId(from) &&
    (await writeText($, `${dir}/requests/${row.sessionId}.json`, JSON.stringify({ from, at: now, freesMB: row.rssMB })))
  if (!isSent) {
    $.ui.toast('Memory: could not leave the request (the mem-gauge folder is not writable).')
    return
  }
  await update($, askedRef, map => {
    const kept: Record<string, number> = {}
    for (const [id, at] of Object.entries(map ?? {})) if (now - at < ASK_EVERY_MS) kept[id] = at
    kept[row.sessionId] = now
    return kept
  })
  $.ui.toast(`Memory: asked "${row.label}" to wrap up. It sees a notice; nothing runs on its own.`)
}

export const register: Register = (on, options) => {
  config = {
    intervalMs: clamp(options['intervalSeconds'], 30, 10, 600) * 1000,
    advice: { idleMinutes: clamp(options['idleMinutes'], 30, 1, 24 * 60) },
    showStatus: options['statusLine'] === true,
    footerButtons: options['footerButtons'] !== false,
    // One chip for both figures: the desktop's footer strip clips past two or three chips (option footerCompact).
    footerCompact: options['footerCompact'] === true,
  }
  timer = null
  running = null
  diskScan = null
  applying = new Map()
  dirCache = null
  hardware = null
  pidProbes = 0

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'mem',
        description: "Show what is using this Mac's memory across Claude sessions, agents and apps",
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`mem-gauge: /mem not registered (${kindOf(err)})`, { to: 'debug' })
    }
    try {
      await $.command.register({
        name: 'disk',
        description: "Show this Mac's disk: the volume's use, every mounted volume, the usual big folders",
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`mem-gauge: /disk not registered (${kindOf(err)})`, { to: 'debug' })
    }
    arm($)
    // A load starts with no Apply in flight: a reload mid-Apply must not leave a button at Applying.
    await update($, applyingRef, () => []).catch(() => undefined)
    // The first reading runs once the start has settled, never holding up the first prompt.
    $.clock.after(0, () => {
      void refreshLabel($).then(() => runTick($))
    })
    return next(e)
  })

  // Activity marks the session busy; turn.start fires for the main loop only.
  // Its prompt text is never read.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await markActive($)
      arm($)
    } catch {
      // Observing only.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        await markActive($)
        arm($)
        // The branch may have changed during the turn; git runs off the turn's path.
        $.clock.after(0, () => {
          void refreshLabel($)
        })
      } catch {
        // Observing only.
      }
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const rate = e.rateLimits.length > 0 ? Math.max(...e.rateLimits.map(r => r.percentUsed)) : null
      await update($, figuresRef, () => ({ contextPercent: e.context.percent ?? null, rateLimitPercent: rate }))
    } catch {
      // Observing only.
    }
    return result
  })

  // One rm inside the shared 1.5 s bound, started beside core's end step rather
  // than before it, so a slow spawn never eats core's share; a crash never gets
  // here, so other sessions' ticks collect what is left.
  on('session.end', async ($, e, next) => {
    const [result] = await Promise.all([
      next(e),
      (async () => {
        const dir = await dataDir($)
        if (dir && isSessionId(e.sessionId)) await removeFile($, `${dir}/sessions/${e.sessionId}.json`)
      })(),
    ])
    return result
  })

  // Read-only, so any origin may run it, but only the person's own origins
  // (PANE_ORIGINS) open the focused pane. When the pane is placed the row says
  // only that (the row is read by the model and kept in the transcript). The
  // per-session table is the answer only to the person where the pane is not
  // placed, or where nothing draws; any other origin gets one summary line.
  on('command.run', { command: 'mem' }, async ($, e) => {
    let snapshot = await read($, snapshotRef)
    // A tick already in flight (the timer's) is not joined when a reading is
    // cached: its process waits are not this hook's, and /mem answers at once.
    if (!snapshot || (!running && (await $.clock.now()) - snapshot.at > REFRESH_AFTER_MS)) {
      snapshot = (await runTick($))?.snapshot ?? snapshot
    }
    // A plain -p run draws on no surface yet "places" every pane: answer it with the table.
    const surfaces = await $.session.surfaces().catch(() => [])
    const isPerson = PANE_ORIGINS.has(e.origin.kind)
    if (surfaces.length > 0 && isPerson) {
      let isPlaced = false
      try {
        isPlaced = (await openPane($)).isPlaced
      } catch {
        isPlaced = false
      }
      if (isPlaced) return { text: 'Memory pane opened.' }
    }
    if (!snapshot) return { text: 'mem-gauge: no reading yet (the collectors could not run).' }
    return { text: surfaces.length > 0 && !isPerson ? summaryLine(snapshot) : compactReport(snapshot, config.advice) }
  }).catch(async ($, e) => {
    // Past its budget or failed: answer from the last reading rather than leave
    // a registered command with no output.
    const snapshot = await read($, snapshotRef).catch(() => null)
    if (!snapshot) return { text: 'mem-gauge: no reading yet.' }
    return { text: PANE_ORIGINS.has(e.origin.kind) ? compactReport(snapshot, config.advice) : summaryLine(snapshot) }
  })

  on('command.run', { command: 'disk' }, async ($, e) => {
    const surfaces = await $.session.surfaces().catch(() => [])
    if (surfaces.length > 0 && PANE_ORIGINS.has(e.origin.kind)) {
      let isPlaced = false
      try {
        isPlaced = (await openDiskPane($)).isPlaced
      } catch {
        isPlaced = false
      }
      if (isPlaced) return { text: 'Disk pane opened.' }
    }
    const snapshot = await read($, snapshotRef)
    if (!snapshot) return { text: 'mem-gauge: no reading yet.' }
    return { text: diskLine(snapshot) }
  }).catch(async ($) => {
    const snapshot = await read($, snapshotRef).catch(() => null)
    return { text: snapshot ? diskLine(snapshot) : 'mem-gauge: no reading yet.' }
  })

  // The gauge on the terminal: the hint line under the prompt, after the engine's
  // own line so its pills stay live. Only the terminal raises the hint line to
  // plugins (the desktop host does not), so every other surface passes.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'terminal') return engine
    const snapshot = await read($, snapshotRef)
    if (!snapshot) return engine
    const wrap = await read($, wrapRef)
    const open = () => void openPane($).catch(() => undefined)
    // No vector element here: the quintile glyph in red stands in for the ring, and "Disk" for the icon.
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        {engine}
        <Box marginLeft={2} flexDirection="row" gap={1}>
          <Text color="red" bold>{glyph(snapshot.machine.usedPercent)}</Text>
          <Button key="mem-gauge" plain dimColor label={statusLine(snapshot, wrap)} onPress={open} />
        </Box>
      </Box>
    )
  })

  // The gauge on the desktop: the prompt footer's mode row, the one site under
  // the composer the desktop raises. That strip clips what does not fit, draws
  // no vector element (an Svg there is simply absent), ignores a Box's hover
  // and display, draws every Button before every Text whatever the tree's
  // order, and a Button is the only thing it draws pressable, always as a
  // native chip; it draws no Client either. Joseph chose the chips: by
  // default the two figures are Buttons that open the panes, the memory
  // quintile ring with the used percent and the disk glyph with the free
  // space. With footerButtons off the row is plain text and /mem and /disk
  // open the panes. Pressure is read in the pane; under
  // pressure or a wrap request the memory figure reads "! 60%".
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'desktop') return engine
    const snapshot = await read($, snapshotRef)
    if (!snapshot) return engine
    const wrap = await read($, wrapRef)
    const m = snapshot.machine
    const { Box, Text, Button } = $.ui.resolve(e)
    const { used, disk, alarm } = footerParts(snapshot, wrap)
    const openMemory = () => void openPane($).catch(() => undefined)
    const openDisk = () => void openDiskPane($).catch(() => undefined)
    if (config.footerButtons && config.footerCompact) {
      // Both figures in one chip, so the strip holds other mods' chips too; Disk is a button in the Memory pane.
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="mem-gauge" plain label={`${glyph(m.usedPercent)} ${alarm ? '! ' : ''}${used} · ${DISK_GLYPH} ${disk}`} onPress={openMemory} />
          {engine}
        </Box>
      )
    }
    if (config.footerButtons) {
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="mem-gauge" plain label={`${glyph(m.usedPercent)} ${alarm ? '! ' : ''}${used}`} onPress={openMemory} />
          <Button key="mem-gauge-disk" plain label={`${DISK_GLYPH} ${disk}`} onPress={openDisk} />
          {engine}
        </Box>
      )
    }
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text color="red" bold>
          {glyph(m.usedPercent)}
        </Text>
        {alarm ? <Text color="red" bold>{`! ${used}`}</Text> : <Text>{used}</Text>}
        <Text dimColor>{`${DISK_GLYPH} ${disk}`}</Text>
        {engine}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snapshot = await read($, snapshotRef)
    const asked = await read($, askedRef)
    const wrap = await read($, wrapRef)
    const showAll = await read($, showAllRef)
    const applying = await read($, applyingRef)
    const now = await $.clock.now()
    const cols = Math.max(24, Math.floor(e.props.bodyColumns))

    const controls = (
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void runTick($)} />
        <Button key="disk" label="Disk" hotkey="d" onPress={() => void openDiskPane($).catch(() => undefined)} />
        <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => void $.ui.close({ id: PANE }).catch(() => undefined)} />
      </Box>
    )
    if (!snapshot) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Reading memory…</Text>
          {controls}
        </Box>
      )
    }

    const m = snapshot.machine
    const used = m.usedPercent === null ? '--' : `${Math.round(m.usedPercent)}%`
    let gauge
    if (e.surface === 'terminal') {
      gauge = <Text bold>{bar(m.usedPercent, Math.min(32, cols - 14))}</Text>
    } else {
      const { Svg } = $.ui.resolve(e)
      gauge = (
        <Svg source={ringSvg(m.usedPercent, m.pressure)} alt={`Memory ${used} used, pressure ${m.pressure}`} width={88} height={88} />
      )
    }

    // Label left, figure right-aligned in one column.
    const totals: readonly [string, string][] = [
      ['Used', `${formatBytes(m.usedBytes)} of ${formatBytes(m.totalBytes)}`],
      ['Free', formatBytes(m.freeBytes)],
      ['Compressed', formatBytes(m.compressedBytes)],
      ['Swap', `${formatBytes(m.swapUsedBytes)} of ${formatBytes(m.swapTotalBytes)}`],
      ['Load', `${m.load1 === null ? '?' : m.load1.toFixed(1)} on ${m.cores ?? '?'} cores`],
    ]
    // Label left in a fixed column, figure flush with the pane's right edge.
    const totalsLabelWidth = 12

    // Columns sized to the body; model and idle drop out first on a narrow pane.
    const isWide = cols >= 70
    const width = { rss: 9, ctx: 6, agents: 7, idle: isWide ? 9 : 0, model: isWide ? 14 : 0 }
    const labelWidth = Math.max(8, cols - width.rss - width.ctx - width.agents - width.idle - width.model)
    // Text columns (session, model) read from the left; figure columns
    // (RSS, context, agents, idle) sit at the right of their column, and the
    // session column takes whatever the row has left, so the figures line up
    // on the pane's right edge on every surface and font. This session is the
    // bold row (no mark column).
    const cell = (w: number, text: string, dim: boolean, bold: boolean, align: 'left' | 'right' = 'left', grows = false) => (
      <Box width={w} flexGrow={grows ? 1 : 0} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
        <Text wrap="truncate" dimColor={dim} bold={bold}>
          {text}
        </Text>
      </Box>
    )
    const tableRow = (key: string, values: string[], dim: boolean, bold: boolean) => (
      <Box key={key} flexDirection="row">
        {cell(labelWidth, values[0] ?? '', dim, bold, 'left', true)}
        {isWide && cell(width.model, values[1] ?? '', dim, bold)}
        {cell(width.rss, values[2] ?? '', dim, bold, 'right')}
        {cell(width.ctx, values[3] ?? '', dim, bold, 'right')}
        {cell(width.agents, values[4] ?? '', dim, bold, 'right')}
        {isWide && cell(width.idle, values[5] ?? '', dim, bold, 'right')}
      </Box>
    )
    const live = snapshot.sessions.filter(s => s.status === 'live')
    // Active (not exited) sessions, biggest first; the top ten until View all.
    const active = snapshot.sessions.filter(s => s.status !== 'gone').sort((a, b) => (b.rssMB ?? -1) - (a.rssMB ?? -1))
    const listed = showAll ? active : active.slice(0, TOP_SESSIONS)
    const hidden = active.length - listed.length
    const toggle = (value: boolean) => void update($, showAllRef, () => value)
    const tips = advise(snapshot, config.advice)
    const rowsById = new Map(snapshot.sessions.map(s => [s.sessionId, s]))

    return (
      <Box flexDirection="column">
        {wrap && (
          <Text bold>
            ! Another session asked this one to wrap up
            {wrap.freesMB === null ? '' : ` (frees about ${formatMB(wrap.freesMB)})`}. Nothing runs on its own.
          </Text>
        )}
        <Box key="gauge" flexDirection="row" gap={2} alignItems="center">
          {gauge}
          <Box flexDirection="column">
            <Text bold>
              Memory {used} used · pressure {m.pressure}
            </Text>
            <Text dimColor>
              This session {snapshot.thisSessionMB === null ? 'unknown' : formatMB(snapshot.thisSessionMB)} · {live.length} live
              session{live.length === 1 ? '' : 's'}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {totals.map(([label, value]) => (
            <Box key={`total:${label}`} flexDirection="row">
              <Box width={totalsLabelWidth}>
                <Text dimColor>{label}</Text>
              </Box>
              <Box flexGrow={1} justifyContent="flex-end">
                <Text wrap="truncate">{value}</Text>
              </Box>
            </Box>
          ))}
        </Box>

        <Box key="sessions" flexDirection="column" marginTop={1}>
          <Text bold>
            Sessions{active.length > TOP_SESSIONS ? (showAll ? ` (all ${active.length} active)` : ` (top ${TOP_SESSIONS} of ${active.length} active)`) : ''}
          </Text>
          {tableRow('head', ['Session', 'Model', 'RSS', 'Ctx', 'Agents', 'Idle'], true, false)}
          {listed.map(s =>
            tableRow(
              `s:${s.sessionId}`,
              [
                s.status === 'live' ? s.label : `${s.label} (${s.status})`,
                s.hasMod === false ? '--' : shortModel(s.model),
                formatMB(s.rssMB),
                s.contextPercent === null ? '--' : `${Math.round(s.contextPercent)}%`,
                s.hasMod === false ? '--' : String(s.agents),
                s.idleMinutes === null ? '--' : `${s.idleMinutes}m`,
              ],
              s.status !== 'live',
              s.isThis,
            ),
          )}
          {hidden > 0 && (
            <Box marginTop={1}>
              <Button key="sessions-all" label={`View all (${active.length})`} hotkey="a" onPress={() => toggle(true)} />
            </Box>
          )}
          {showAll && active.length > TOP_SESSIONS && (
            <Box marginTop={1}>
              <Button key="sessions-top" label={`View top ${TOP_SESSIONS}`} hotkey="a" onPress={() => toggle(false)} />
            </Box>
          )}
          {snapshot.unregistered !== null && snapshot.unregistered.count > 0 && (
            <Text dimColor wrap="truncate">
              + {snapshot.unregistered.count} Claude session{snapshot.unregistered.count === 1 ? '' : 's'} without a session record:{' '}
              {formatMB(snapshot.unregistered.rssMB)}
            </Text>
          )}
        </Box>

        {snapshot.topApps.length > 0 && (
          <Box key="apps" flexDirection="column" marginTop={1}>
            <Text bold>Other apps</Text>
            {snapshot.topApps.map(app => (
              <Box key={`app:${app.name}`} flexDirection="row">
                <Box width={Math.max(8, cols - 10)} flexGrow={1}>
                  <Text wrap="truncate">{app.name}</Text>
                </Box>
                <Box width={10} justifyContent="flex-end">
                  <Text>{formatMB(app.rssMB)}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        <Box key="optimize" flexDirection="column" marginTop={1}>
          <Text bold>Optimize</Text>
          {tips.length === 0 && <Text dimColor>Nothing to do right now.</Text>}
          {tips.map(tip => {
            const target = tip.sessionId ? rowsById.get(tip.sessionId) : undefined
            const askedAt = target ? asked[target.sessionId] : undefined
            const isRecent = tip.action?.kind === 'ask-wrap' && askedAt !== undefined && now - askedAt < ASK_EVERY_MS
            const inFlight = applying.includes(`memory:${tip.key}`)
            return (
              <Box key={`tip:${tip.key}`} flexDirection="row" gap={1}>
                <Text wrap="wrap">{tip.text}</Text>
                {tip.action && (
                  <Button
                    key={`apply:${tip.key}`}
                    label={isRecent ? 'Asked' : inFlight ? 'Applying…' : APPLY}
                    dimColor={isRecent || inFlight}
                    onPress={() => void applyMemory($, tip, rowsById).catch(() => undefined)}
                  />
                )}
              </Box>
            )
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            RSS is approximate (it undercounts compressed memory). A session without mem-gauge is listed from the
            engine's own record: name, memory and idle time only (model, context and agents read --).
          </Text>
        </Box>
        {controls}
      </Box>
    )
  })

  // The disk pane: the volume's use, every mounted volume, and the usual big folders.
  on('ui.render', { component: 'Pane', requestId: DISK_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snapshot = await read($, snapshotRef)
    const report = await read($, diskRef)
    const applying = await read($, applyingRef)
    const cols = Math.max(24, Math.floor(e.props.bodyColumns))

    const controls = (
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="disk-refresh" label="Refresh" hotkey="r" onPress={() => void runDiskScan($)} />
        <Button key="disk-close" label="Close" hotkey="c" role="dismiss" onPress={() => void $.ui.close({ id: DISK_PANE }).catch(() => undefined)} />
      </Box>
    )
    const m = snapshot?.machine ?? null
    const usedBytes = m && m.diskTotalBytes !== null && m.diskFreeBytes !== null ? Math.max(0, m.diskTotalBytes - m.diskFreeBytes) : null
    const usedPercent = m && usedBytes !== null && m.diskTotalBytes ? (usedBytes / m.diskTotalBytes) * 100 : null
    const used = usedPercent === null ? '--' : `${Math.round(usedPercent)}%`
    let gauge
    if (e.surface === 'terminal') {
      gauge = <Text bold>{bar(usedPercent, Math.min(32, cols - 14))}</Text>
    } else {
      const { Svg } = $.ui.resolve(e)
      gauge = <Svg source={ringSvg(usedPercent, 'ok', 88, true, `Disk ${used} used`)} alt={`Disk ${used} used`} width={88} height={88} />
    }

    const isWide = cols >= 64
    const sizeWidth = 10
    const nameWidth = Math.max(8, cols - sizeWidth * (isWide ? 4 : 2))
    // The volume name reads from the left and takes the row's slack; every
    // size column sits at the right of its column, flush with the pane's edge.
    const cell = (w: number, text: string, dim: boolean, bold = false, align: 'left' | 'right' = 'left', grows = false) => (
      <Box width={w} flexGrow={grows ? 1 : 0} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
        <Text wrap="truncate" dimColor={dim} bold={bold}>
          {text}
        </Text>
      </Box>
    )
    const volumeRow = (key: string, values: string[], dim: boolean, bold = false) => (
      <Box key={key} flexDirection="row">
        {cell(nameWidth, values[0] ?? '', dim, bold, 'left', true)}
        {isWide && cell(sizeWidth, values[1] ?? '', dim, bold, 'right')}
        {isWide && cell(sizeWidth, values[2] ?? '', dim, bold, 'right')}
        {cell(sizeWidth, values[3] ?? '', dim, bold, 'right')}
        {cell(sizeWidth, values[4] ?? '', dim, bold, 'right')}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {m ? (
          <Box key="gauge" flexDirection="row" gap={2} alignItems="center">
            {gauge}
            <Box flexDirection="column">
              <Text bold>Disk {used} used</Text>
              <Text dimColor>
                used {formatBytes(usedBytes)} of {formatBytes(m.diskTotalBytes)} · free {formatBytes(m.diskFreeBytes)}
              </Text>
            </Box>
          </Box>
        ) : (
          <Text dimColor>Reading disk…</Text>
        )}

        <Box key="volumes" flexDirection="column" marginTop={1}>
          <Text bold>Volumes</Text>
          {!report && <Text dimColor>Reading volumes and folders…</Text>}
          {report && volumeRow('head', ['Volume', 'Size', 'Used', 'Free', 'Used %'], true)}
          {report?.volumes.map(v =>
            volumeRow(
              `v:${v.mount}`,
              [v.name, formatBytes(v.totalBytes), formatBytes(v.usedBytes), formatBytes(v.freeBytes), `${Math.round((v.usedBytes / v.totalBytes) * 100)}%`],
              false,
              v.name === 'Macintosh HD',
            ),
          )}
          {report && report.volumes.length === 0 && <Text dimColor>df listed no volume.</Text>}
        </Box>

        {report && (
          <Box key="folders" flexDirection="column" marginTop={1}>
            <Text bold>Big folders</Text>
            {report.folders.map(f => (
              <Box key={`f:${f.path}`} flexDirection="row">
                <Box width={Math.max(8, cols - sizeWidth)} flexGrow={1}>
                  <Text wrap="truncate" dimColor={f.bytes === null}>
                    {f.label}
                  </Text>
                </Box>
                <Box width={sizeWidth} justifyContent="flex-end">
                  <Text dimColor={f.bytes === null}>{f.bytes === null ? '--' : formatBytes(f.bytes)}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {report && (
          <Box key="free" flexDirection="column" marginTop={1}>
            <Text bold>Free up safely</Text>
            {diskAdvice(report).length === 0 && <Text dimColor>Nothing worth freeing right now.</Text>}
            {diskAdvice(report).map(tip => {
              const inFlight = applying.includes(`disk:${tip.key}`)
              return (
                <Box key={`free:${tip.key}`} flexDirection="row" gap={1}>
                  <Text wrap="wrap">{tip.text}</Text>
                  {tip.action && (
                    <Button
                      key={`apply:${tip.key}`}
                      label={inFlight ? 'Applying…' : APPLY}
                      dimColor={inFlight}
                      onPress={() => void applyDisk($, tip).catch(() => undefined)}
                    />
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            Sizes come from df (5 s) and du (10 s each, on open and Refresh); a folder that is missing or takes longer shows --.
          </Text>
        </Box>
        {controls}
      </Box>
    )
  })
}
