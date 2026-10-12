// rd-ledger: a contemporaneous, metadata-only ledger of R&D engagement time
// and AI usage (SPEC v1.1). Every human prompt submission becomes one event
// (its origin and verdict, never its text), every model turn one usage row,
// each written into this process's own segment file under
// ~/.claude/rd-ledger/sessions/YYYY/MM/. A timer folds every segment of this
// and last month into a rollup in $.state; the pane (/rd, /rd session,
// /rd sessions, /rd review, /rd spend) and the footer chip draw that rollup
// and nothing else.
//
// The engine requires `$` to be handed only to functions declared at the top
// of this file, so every function that touches `$` lives here. Everything that
// decides anything (admission, union-v2, pricing, the review, the export, the
// bridge plan) is pure and lives in the sibling modules; this file reads and
// writes files, runs argv, and draws.
//
// Writes: a file is written whole to a temp beside it, both paths are stat'ed
// (a symbolic link at either refuses the write), then `/bin/mv -f -h` swaps it
// in. Shared files (components.json, reviews, the bridge log) are rewritten
// only under the `mkdir` lock. Nothing here reads the prompt, the answer or a
// transcript: `promptMeta(e)` is prompt.submit's only reading of its event.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, BridgeInfo, BridgeLogEntry, BridgeLogKind, HandoffEntry, Mapping, QueueDecision, RecordSource, ReviewRevision, Rollup, SessionRecord, SessionSummary, UnionEvent, UnionParams, View, WeekRow } from '../types'
import { addArgv, argvForLog, bridgeLine, compareArgv, detectBridge, importArgv, parseAddLine, parseBridgeLog, parseCompareJson, parseImportJson, planHandoff } from './bridge'
import { buildExport, EXPORT_FILES, manifestText } from './exporter'
import { sha256 } from './hash'
import { applyQueueDecision, deadlines, historyLine, loadMapping, mappingDigest, mergeImport, saveMapping } from './mapping'
import { dayNumber, footerLabel, overviewText, SESSIONS_SHOWN, SESSIONS_SHOWN_MAX, sessionOptions, sessionsText, sessionText, shownRows, spendText, summaryLine } from './report'
import { buildConfirm, buildReopen, encodeReview, inputsDigest, latestConfirmed, latestRevision, loadReview, parseOtherHours } from './review'
import { computeRollup } from './rollup'
import {
  CAP,
  DEFAULT_PARAMS,
  IGNORED,
  NON_RD,
  UNMAPPED,
  bridgeLogPath,
  decodeSession,
  encodeSession,
  exportDir,
  isPlainAbsolute,
  isSalt,
  isSegmentName,
  isTmpName,
  lockDir,
  makeSalt,
  mappingHistoryPath,
  mappingPath,
  monthDir,
  newSegment,
  reviewPath,
  reviewsDir,
  rootHashOf,
  saltPath,
  segOf,
  segmentPath,
  sessionsDir,
  storeDir,
  timezonePath,
  tmpPath,
  withBranch,
  withCacheTtl,
  withClose,
  withCost,
  withEvent,
  withTurn,
 isOversize, withSurface } from './store'
import type { TurnInput } from './store'
import { cleanBranch, cleanField, hasOwn, hoursText, isMonth, isSessionId, isWeek, oneLine, repoKeyOf } from './text'
import { addDays, detectZone, isoWeek, isoWithOffset, isZone, localDate, monthOfTs, previousMonth, weekDates, weekOfTs, zoneFromLocaltimeTarget } from './tz'
import { allocate, buildBlocks, methodString, segmentKey } from './union'

type Dollar = EngineInterface
type BridgeMode = 'corroborate' | 'source-of-truth' | 'off'
type Stat = { kind: string; size: number; mtimeMs: number; isLink: boolean; realPath?: string }

// $.state values, one literal plugin/key reference each, so `claude plugin
// validate` holds them to types/index.d.ts. Written from handlers, timers and
// events, never while drawing.
// Shape-tagged: a reload of code whose rollup lacks the session fields reads the old value as absent (verifier V2).
const rollupRef = atom({ plugin: 'rd-ledger', key: 'rollup' } as const, null as Rollup | null, { shape: 'rollup-sessions-v2' })
const viewRef = atom({ plugin: 'rd-ledger', key: 'view' } as const, 'overview' as View)
const selectedSessionRef = atom({ plugin: 'rd-ledger', key: 'selectedSession' } as const, null as string | null)
const sessionsShownRef = atom({ plugin: 'rd-ledger', key: 'sessionsShown' } as const, SESSIONS_SHOWN)
const busyRef = atom({ plugin: 'rd-ledger', key: 'busy' } as const, null as string | null)
const lastErrorRef = atom({ plugin: 'rd-ledger', key: 'lastError' } as const, null as string | null)
const pendingRowsRef = atom({ plugin: 'rd-ledger', key: 'pendingRows' } as const, {} as Record<string, { activity: Activity; poe: boolean }>)
const draftNotesRef = atom({ plugin: 'rd-ledger', key: 'draftNotes' } as const, {} as Record<string, string>)
const draftOtherHoursRef = atom({ plugin: 'rd-ledger', key: 'draftOtherHours' } as const, {} as Record<string, string>)
const recordPathRef = atom({ plugin: 'rd-ledger', key: 'recordPath' } as const, null as string | null)
const armTokenRef = atom({ plugin: 'rd-ledger', key: 'armToken' } as const, null as string | null)
const compareRef = atom({ plugin: 'rd-ledger', key: 'compare' } as const, null)

const PANE = 'rd-ledger'
const PANE_TITLE = 'R&D ledger'
/** The version printed in the export; kept equal to .claude-plugin/plugin.json. */
const MOD_VERSION = '0.1.0'
const ADMISSION_VERSION = 'admission-v1'
/** Turns, branch changes and cost figures coalesce into one flush this long after the first mark. */
const FLUSH_MS = 500
const MAX_BACKOFF_MS = 60_000
const TIMEOUT_MS = 5000
/** Every rdt call: rd-tracker's review derives the week, which can take a while. */
const RDT_TIMEOUT_MS = 60_000
/** A refresh after the person's own turn waits for the turn burst to settle. */
const TURN_REFRESH_MS = 5000
/** The pane re-reads on open when its rollup is older than this. */
const STALE_MS = 60_000
/** A lock older than this counts as stale: it is reported in Data health and the person clears it; the code never takes a lock over (verifier V10). */
const LOCK_STALE_MS = 15 * 60_000
/** Destinations sent per Confirm; the rest go on the next Confirm. */
const MAX_HANDOFF_PER_CONFIRM = 12
/** A hand-off stops sending past this hold time (the rest waits for the next Confirm), well inside LOCK_STALE_MS. */
const HANDOFF_TIME_GUARD_MS = 10 * 60_000

/** One line about a lock that could not be taken: another session's, or a stale one the person must clear. */
const lockHeldNote = (staleMs: number | null): string =>
  staleMs === null ? 'another session holds the store lock' : `a store lock left by a crashed session ${Math.round(staleMs / 60_000)} minutes ago blocks it; clear it in the pane`
const TMP_TTL_MS = 60 * 60_000
const MAX_SWEEP = 10
/** session.end shares a short budget with core's own end: a temp written later than this after the end began is left for the sweep. */
const END_MV_BUDGET_MS = 1000
/** A Compare row is marked when the two figures are further apart than this share. */
const COMPARE_MARK = 0.1
const WRITE = 'Write'
const COMPARE = 'Compare'
const HAND_OFF = 'Hand off'
const CLEAR_LOCK = 'Clear lock'
const CANCEL = 'Cancel'
const USAGE = 'Usage: /rd [session [<first 8 of a session id>] | sessions | review | spend | export [YYYY | YYYY-MM] | import]'
const BUCKETS: ReadonlySet<string> = new Set([UNMAPPED, IGNORED, NON_RD])
const STORE_LABEL = '~/.claude/rd-ledger'
const ACTIVITY_LABEL: Record<Activity, string> = { direct_research: 'Research', direct_support: 'Support', non_qualified: 'Non-R&D' }

type Config = { refreshMs: number; params: UnionParams; cacheTtl: '5m' | '1h'; rdtRepo: string; bridgeMode: BridgeMode; personLabel: string; footerButton: boolean }
type Boot = { home: string | null; zone: string; salt: string | null; storeIsLink: boolean; surface: string | null; interactive: boolean }
type Known = { mapping: Mapping; mappingText: string | null; problems: string[]; mappingReadOnly: boolean; segments: SessionRecord[]; bridge: BridgeInfo }

// Per-load plumbing, not state: register() resets it, and a hot reload starts
// it over together with the timers it cancels; session.start arms again and
// continues the open segment through $.state.recordPath.
let config: Config = {
  refreshMs: 5 * 60_000,
  params: DEFAULT_PARAMS,
  cacheTtl: '5m',
  rdtRepo: '',
  bridgeMode: 'corroborate',
  personLabel: '',
  footerButton: true,
}
let boot: Boot | null = null
let homeCache: string | null | undefined
let timer: { cancel: () => void } | null = null
let loadToken = ''
let turnRefresh: { cancel: () => void } | null = null
let refreshing: Promise<void> | null = null
let flushTimer: { cancel: () => void } | null = null
let flushing: Promise<void> | null = null
let flushAgain = false
let dirty = false
let backoffMs = 0
let writeSerial = 0
/** The repository root the open segment was keyed from; the root hash is re-derived from it when the salt arrives late. */
let lastRoot: string | null = null
let current: SessionRecord | null = null
let currentPath: string | null = null
// Every change to which segment is open, and every row appended, runs in turn:
// two prompts submitted together must both land, and two hooks must never
// open two segments for one session.
let mutating: Promise<unknown> = Promise.resolve()
let fileCache = new Map<string, { record: SessionRecord | null; mtimeMs: number; size: number; readAt: number }>()
// What the last refresh read beside the rollup: the Review view's Select
// options and the mapping problems, and what Confirm digests. Replaced whole
// by each refresh, read by drawings only after the rollup write that follows it.
let known: Known | null = null

const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** An error's kind only: a message could carry a path or command output. */
const kindOf = (err: unknown): string => (err instanceof Error && err.name ? oneLine(err.name, 40) : 'error')

const isBucket = (component: string): boolean => BUCKETS.has(component)

/** A problem loadMapping reports that a save would make permanent (an entry dropped, a field not kept). */
const isBlockingProblem = (p: string): boolean => / dropped: /.test(p) || /not kept on save/.test(p) || /will not be rewritten/.test(p)

/** The person's own origins (SPEC §6): their Enter, the Remote Control bridge, and the SDK host when this record's surface is the desktop. */
const isPersonOrigin = (kind: string, surface: string | null): boolean => kind === 'composer' || kind === 'bridge' || (kind === 'sdk' && surface === 'desktop')


/** The bridge status the pane and Health show (SPEC §7). */
const bridgeStatus = (info: BridgeInfo): Rollup['health']['bridge'] => {
  if (config.bridgeMode === 'off') return 'off'
  if (config.rdtRepo === '') return 'standalone'
  return info.present ? config.bridgeMode : 'unreachable'
}

/** `YYYY-MM-DDTHHMM` local: the export folder's name. */
const stampOf = (now: number, zone: string): string => {
  const iso = isoWithOffset(now, zone)
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`
  return /^\d{4}-\d{2}-\d{2}T\d{4}$/.test(stamp) ? stamp : `${localDate(now, zone)}T0000`
}

// --- small $ helpers -------------------------------------------------------------

/** `HOME` as a plain absolute path, or null (the mod then runs read-only in memory). */
async function homeOf($: Dollar): Promise<string | null> {
  if (homeCache !== undefined) return homeCache
  try {
    const home = await $.env.get('HOME')
    homeCache = isPlainAbsolute(home) ? home.replace(/\/+$/, '') || null : null
  } catch {
    homeCache = null
  }
  return homeCache
}

async function setError($: Dollar, text: string | null): Promise<void> {
  await update($, lastErrorRef, () => (text === null ? null : oneLine(text, 200))).catch(() => undefined)
}

async function readText($: Dollar, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

async function statOf($: Dollar, path: string, resolve = false): Promise<Stat | null> {
  try {
    return (resolve ? await $.fs.stat(path, { resolve: true }) : await $.fs.stat(path)) as Stat
  } catch {
    return null
  }
}

async function existsQuiet($: Dollar, path: string): Promise<boolean> {
  try {
    return (await $.fs.exists(path)) === true
  } catch {
    return false
  }
}

async function listQuiet($: Dollar, path: string): Promise<{ name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[]> {
  try {
    return (await $.fs.list(path)) as { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[]
  } catch {
    return []
  }
}

/** One argv; null when it could not start or was refused. */
async function runProc($: Dollar, argv: string[], init: { cwd?: string; timeoutMs?: number } = {}): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    const r = await $.process.run(argv, { timeoutMs: init.timeoutMs ?? TIMEOUT_MS, ...(init.cwd ? { cwd: init.cwd } : {}) })
    return { exitCode: r.exitCode, stdout: r.stdout }
  } catch {
    return null
  }
}

async function removeQuiet($: Dollar, path: string): Promise<void> {
  await runProc($, ['/bin/rm', '-f', path])
}

/**
 * Writes `text` to `finalPath` whole: a temp beside it, both paths stat'ed (a
 * link at either refuses), then `mv -f -h`. Returns null on success, else one
 * line saying what failed (never a path). `skipMv` leaves the temp for the
 * sweep, when session.end's budget is spent.
 */
async function writeAtomic($: Dollar, finalPath: string, text: string, tag: string, skipMv = false): Promise<string | null> {
  if (boot?.storeIsLink) return 'the store folder is a symbolic link, so nothing is written through it'
  // The target's folder must be a real folder under the real store: a linked month folder is never written through (verifier V4).
  if (boot?.home) {
    // The nearest folder that exists decides (a missing month or year folder is created by the write itself): it must be a real folder under the real store (verifier N5).
    const store = storeDir(boot.home)
    let folder = finalPath.slice(0, finalPath.lastIndexOf('/'))
    let ps: Stat | null = null
    for (let i = 0; i < 6 && folder.length >= store.length; i += 1) {
      ps = await statOf($, folder, true)
      if (ps) break
      folder = folder.slice(0, folder.lastIndexOf('/'))
    }
    const ss = await statOf($, store, true)
    // Nothing of the store exists yet (first run): the write creates real folders, so there is nothing to lead elsewhere.
    if (ps && ss) {
      if (ps.isLink) return 'a store folder is a symbolic link; the write was refused'
      const folderReal = (ps as { realPath?: string }).realPath ?? ''
      const storeReal = (ss as { realPath?: string }).realPath ?? ''
      if (folderReal !== '' && storeReal !== '' && folderReal !== storeReal && !folderReal.startsWith(`${storeReal}/`)) return 'a store folder leads outside the store; the write was refused'
    } else if (ps?.isLink) return 'a store folder is a symbolic link; the write was refused'
  }
  writeSerial += 1
  const tmp = tmpPath(finalPath, tag, writeSerial)
  if ((await statOf($, tmp))?.isLink) return 'a temp file is a symbolic link; the write was refused'
  try {
    await $.fs.write(tmp, text)
  } catch {
    return 'a store file could not be written'
  }
  const [a, b] = await Promise.all([statOf($, tmp), statOf($, finalPath)])
  if (a?.isLink || b?.isLink) {
    await removeQuiet($, tmp)
    return 'a store file is a symbolic link; the write was refused'
  }
  if (skipMv) return null
  const r = await runProc($, ['/bin/mv', '-f', '-h', tmp, finalPath])
  if (!r || r.exitCode !== 0) {
    await removeQuiet($, tmp)
    return 'a store file could not be replaced'
  }
  return null
}

/**
 * Runs `fn` under the store's `mkdir` lock. A lock is never taken over by the
 * code: two sessions taking over the same stale lock could both end up holding
 * it (verifier V10), so a lock older than LOCK_STALE_MS is reported in Data
 * health and in the toast, and the person clears it with a confirmed button.
 */
async function withLock<T>($: Dollar, home: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; staleMs: number | null }> {
  const dir = lockDir(home)
  const held = (await runProc($, ['/bin/mkdir', dir]))?.exitCode === 0
  if (!held) return { ok: false, staleMs: await lockStaleMs($, home) }
  try {
    return { ok: true, value: await fn() }
  } finally {
    await runProc($, ['/bin/rmdir', dir])
  }
}

/** The age of a held lock past LOCK_STALE_MS, or null (no lock, a young one, or one whose age is unknown). */
async function lockStaleMs($: Dollar, home: string): Promise<number | null> {
  const s = await statOf($, lockDir(home))
  if (!s || s.isLink || s.mtimeMs <= 0) return null
  const age = (await $.clock.now()) - s.mtimeMs
  return age > LOCK_STALE_MS ? age : null
}

/** The person clears a stale lock (a crashed session's): confirmed, one rmdir, then a refresh. */
async function clearStaleLock($: Dollar): Promise<void> {
  const home = boot?.home
  if (!home) return
  const age = await lockStaleMs($, home)
  if (age === null) {
    $.ui.toast('R&D ledger: no stale lock to clear.')
    return
  }
  if (!(await ask($, `Clear the store lock left by another session ${Math.round(age / 60_000)} minutes ago? Only do this when no other rd-ledger session is handing off or saving right now.`, CLEAR_LOCK))) return
  // Re-checked after the answer: a lock cleared and re-taken meanwhile is a live one, never removed (verifier V14).
  const ageNow = await lockStaleMs($, home)
  if (ageNow === null || ageNow < age) {
    $.ui.toast('R&D ledger: the lock changed while the question was open; nothing was removed.')
    return
  }
  const r = await runProc($, ['/bin/rmdir', lockDir(home)])
  $.ui.toast(r && r.exitCode === 0 ? 'R&D ledger: the stale lock is cleared.' : 'R&D ledger: the lock could not be removed.')
  void refresh($)
}

/** A press that must not run twice at once: claims `busy`, or toasts and declines. */
async function claimBusy($: Dollar, what: string): Promise<boolean> {
  let claimed = false
  await update($, busyRef, held => {
    if (held !== null) return held
    claimed = true
    return what
  })
  if (!claimed) $.ui.toast('R&D ledger: another action is still running.')
  return claimed
}

async function releaseBusy($: Dollar, what: string): Promise<void> {
  await update($, busyRef, held => (held === what ? null : held)).catch(() => undefined)
}

// --- boot: the store, the zone, the salt ----------------------------------------------

/**
 * The zone, frozen at first run (ADR-005): the store's file; else rd-tracker's
 * `store/timezone` when a repository is configured; else the runtime's Intl;
 * else TZ; else the /etc/localtime link target; else UTC with an error (and
 * then nothing is frozen, so the next start tries again).
 */
async function freezeZone($: Dollar, home: string | null, writable: boolean): Promise<{ zone: string; error: string | null }> {
  if (home) {
    const saved = (await readText($, timezonePath(home)))?.trim() ?? ''
    if (saved !== '' && isZone(saved)) return { zone: saved, error: null }
  }
  let zone: string | null = null
  if (config.rdtRepo !== '' && config.bridgeMode !== 'off') {
    const theirs = (await readText($, `${config.rdtRepo}/store/timezone`))?.trim() ?? ''
    if (theirs !== '' && isZone(theirs)) zone = theirs
  }
  zone ??= detectZone()
  if (zone === null) {
    const tz = await $.env.get('TZ').catch(() => undefined)
    if (typeof tz === 'string' && isZone(tz)) zone = tz
  }
  if (zone === null) {
    const target = (await statOf($, '/etc/localtime', true))?.realPath
    if (typeof target === 'string') zone = zoneFromLocaltimeTarget(target)
  }
  if (zone === null) return { zone: 'UTC', error: 'the time zone could not be read, so UTC is used until it can be' }
  if (home && writable) await writeAtomic($, timezonePath(home), `${zone}\n`, 'tz')
  return { zone, error: null }
}

/** The install's salt: read, or written once from material only this install saw. Null when it cannot be kept. */
async function ensureSalt($: Dollar, home: string | null, writable: boolean, now: number): Promise<string | null> {
  if (!home) return null
  const saved = (await readText($, saltPath(home)))?.trim() ?? ''
  if (isSalt(saved)) return saved
  if (!writable) return null
  const sid = await $.session.id().catch(() => '')
  const salt = makeSalt(`${sid}|${now}`)
  // Under the store lock: two first-run processes must not hash the same repository differently (verifier V10).
  const held = await withLock($, home, async () => {
    const again = (await readText($, saltPath(home)))?.trim() ?? ''
    if (isSalt(again)) return again
    return (await writeAtomic($, saltPath(home), `${salt}\n`, 'salt')) === null ? salt : null
  })
  if (held.ok) return held.value
  // The lock was busy: the other session may be writing the salt this moment; read it once more, and the next refresh tries again (verifier N6).
  const later = (await readText($, saltPath(home)))?.trim() ?? ''
  return isSalt(later) ? later : null
}

async function bootStore($: Dollar, start: { surface: string | null; interactive: boolean } | null): Promise<Boot> {
  const now = await $.clock.now()
  const home = await homeOf($)
  const storeIsLink = home ? (await statOf($, storeDir(home), true))?.isLink === true : false
  // Data health reports a linked store; the boot writes nothing through it.
  boot = { home, zone: boot?.zone ?? 'UTC', salt: null, storeIsLink, surface: start?.surface ?? boot?.surface ?? null, interactive: start?.interactive ?? boot?.interactive ?? false }
  // Temp names carry a serial; seeding it from the clock keeps them unique across a hot reload (verifier V8).
  if (writeSerial === 0) writeSerial = now % 1_000_000_000
  const writable = home !== null && !storeIsLink
  const frozen = await freezeZone($, home, writable)
  const salt = await ensureSalt($, home, writable, now)
  boot = { ...boot, zone: frozen.zone, salt }
  const errors = [home ? null : 'HOME is not a plain absolute path, so the ledger runs read-only in memory', storeIsLink ? 'the store folder is a symbolic link, so nothing is written' : null, frozen.error].filter(Boolean)
  if (errors.length > 0) await setError($, `rd-ledger: ${errors.join('; ')}`)
  return boot
}

async function ensureBoot($: Dollar): Promise<Boot> {
  return boot ?? (await bootStore($, null))
}

// --- the segment: open, continue, record, flush ---------------------------------------

function markDirty($: Dollar): void {
  dirty = true
  if (flushTimer) return
  flushTimer = $.clock.after(FLUSH_MS, () => {
    flushTimer = null
    void flush($)
  })
}

async function flushOnce($: Dollar, skipMv: boolean): Promise<void> {
  const record = current
  const path = currentPath
  if (!record || !path || !boot?.home) return
  dirty = false
  const err = await writeAtomic($, path, encodeSession(record), record.seg, skipMv)
  if (err === null) {
    if (backoffMs > 0) await setError($, null)
    backoffMs = 0
    return
  }
  dirty = true
  backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs === 0 ? 1000 : backoffMs * 2)
  await setError($, `rd-ledger: ${err}; retrying in ${Math.round(backoffMs / 1000)} s`)
  if (!flushTimer) {
    flushTimer = $.clock.after(backoffMs, () => {
      flushTimer = null
      if (dirty) void flush($)
    })
  }
}

/** Runs `fn` after every earlier segment change has settled (one at a time, in order). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutating.then(fn, fn)
  mutating = run.catch(() => undefined)
  return run
}

/** One flush of the open segment at a time; a mark during one re-flushes after it, and every caller waits for the last. */
function flush($: Dollar, skipMv = false): Promise<void> {
  if (flushing) {
    flushAgain = true
    return flushing
  }
  let mine: Promise<void> | null = null
  mine = (async () => {
    try {
      do {
        flushAgain = false
        await flushOnce($, skipMv)
      } while (flushAgain)
    } finally {
      if (flushing === mine) flushing = null
    }
  })()
  flushing = mine
  return mine
}

/** Opens a new segment for `sessionId` at `at` and writes it at once. */
async function openSegment($: Dollar, sessionId: string, source: RecordSource, at: number): Promise<void> {
  if (!isSessionId(sessionId)) return
  const b = await ensureBoot($)
  const repo = await $.session.repo().catch(() => null)
  const cwd = await $.session.cwd().catch(() => '')
  const root = repo?.root ?? cwd
  lastRoot = root || null
  const entrypoint = (await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)) ?? null
  const model = await $.session.model().catch(() => null)
  const usage = await $.session.usage().catch(() => null)
  let openedAt = at
  const pathAt = (t: number): string | null => (b.home ? segmentPath(b.home, monthOfTs(t, b.zone), sessionId, segOf(t)) : null)
  let path = pathAt(openedAt)
  // Two opens in one millisecond never share a file: a writer rewrites only the segment it opened.
  for (let i = 0; path !== null && i < 5 && (await existsQuiet($, path)); i += 1) {
    openedAt += 1
    path = pathAt(openedAt)
  }
  current = newSegment({
    sessionId,
    openedAt,
    source,
    entrypoint,
    interactive: b.interactive,
    surface: b.surface,
    repoKey: root ? repoKeyOf(root, b.home) : null,
    repoKind: repo ? 'repo' : 'dir',
    rootHash: b.salt && b.home && root ? rootHashOf(b.salt, root, b.home) : null,
    cwdBase: cwd ? repoKeyOf(cwd, b.home) : 'unknown',
    branch: null,
    model: typeof model === 'string' ? model : null,
    engineCostAtOpen: typeof usage?.cost?.usd === 'number' ? usage.cost.usd : null,
  })
  currentPath = path
  await update($, recordPathRef, () => path)
  if (path) await flush($)
}

/**
 * session.start's open-or-continue (SPEC §3.1): the segment named in
 * $.state.recordPath continues when it decodes, belongs to this session and is
 * open (a hot reload or a worker respawn); anything else opens a new one. An
 * undecodable file there is never rewritten.
 */
async function openOrContinue($: Dollar, at?: number): Promise<void> {
  const b = await ensureBoot($)
  const sid = await $.session.id().catch(() => '')
  const saved = await read($, recordPathRef).catch(() => null)
  if (saved && b.home && saved.startsWith(`${sessionsDir(b.home)}/`)) {
    const text = await readText($, saved)
    const onDisk = text === null ? null : decodeSession(text)
    if (onDisk && onDisk.sessionId === sid && onDisk.closedAt === null) {
      // The copy in memory is newer when this load wrote it (turns not yet flushed).
      if (!(current && currentPath === saved && current.nextSeq >= onDisk.nextSeq)) current = onDisk
      currentPath = saved
      return
    }
  }
  await openSegment($, sid, 'unknown', at ?? (await $.clock.now()))
}

/** The open segment for a row at `ts`: a new one when the session changed or the local month rolled over. */
async function segmentFor($: Dollar, ts: number): Promise<SessionRecord | null> {
  const b = await ensureBoot($)
  // A hot reload forgets the open segment; a row that beats session.start continues it from recordPath.
  if (!current) await openOrContinue($, ts)
  const sid = await $.session.id().catch(() => '')
  if (current && current.closedAt === null && current.sessionId === sid) {
    const rollover = monthOfTs(ts, b.zone) !== monthOfTs(current.openedAt, b.zone) ? 'month' : isOversize(current) ? 'size' : null
    if (rollover === null) return current
    const prev = current
    current = withClose(prev, rollover, ts)
    await flush($)
    await openSegment($, sid, prev.source, ts)
    // The month's new segment carries the engine's figure on, so own cost is never counted twice.
    if (current && current !== prev) current = { ...current, engineCostAtOpen: prev.engineCostUsd ?? prev.engineCostAtOpen, engineCostUsd: prev.engineCostUsd }
    return current
  }
  if (current && current.closedAt === null) {
    current = withClose(current, 'session-changed', ts)
    await flush($)
  }
  if (!isSessionId(sid)) return null
  await openSegment($, sid, 'unknown', ts)
  return current
}

/** The hook's only reading of a submission: its origin's kind and whether a turn was running (SPEC §2). */
function promptMeta(e: { origin?: { kind?: unknown }; turnId?: unknown }): { originKind: string; isQueued: boolean } {
  const kind = e.origin?.kind
  return { originKind: typeof kind === 'string' ? kind : 'unknown', isQueued: e.turnId !== undefined }
}

async function recordEvent($: Dollar, meta: { originKind: string; isQueued: boolean }): Promise<void> {
  const ts = await $.clock.now()
  const recorded = await serial(async () => {
    const r = await segmentFor($, ts)
    if (!r) return false
    current = withEvent(r, { ts, origin: meta.originKind, queued: meta.isQueued }, ts)
    return true
  })
  // Events are written at once: human pace, and none may be lost to a reload.
  if (recorded) await flush($)
}

async function recordTurn($: Dollar, input: TurnInput): Promise<void> {
  await serial(async () => {
    const r = await segmentFor($, input.endTs)
    if (!r) return
    const next = withTurn(r, input, input.endTs)
    if (next === r) return
    current = next
    markDirty($)
  })
}

/** The branch of the session's working folder, read off the turn's path; a change marks the segment. */
async function detectBranch($: Dollar): Promise<void> {
  if (!current || current.repoKind !== 'repo' || current.closedAt !== null) return
  const cwd = await $.session.cwd().catch(() => '')
  if (!cwd) return
  const r = await runProc($, ['/usr/bin/git', '-c', 'core.fsmonitor=false', '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  if (!r || r.exitCode !== 0 || !current) return
  const branch = cleanBranch(r.stdout)
  const now = await $.clock.now()
  await serial(async () => {
    if (!current || current.closedAt !== null) return
    const next = withBranch(current, branch, now)
    if (next === current) return
    current = next
    markDirty($)
  })
}

// --- refresh: segments → rollup ------------------------------------------------------------

async function bridgeInfoOf($: Dollar): Promise<BridgeInfo> {
  if (config.bridgeMode === 'off') return { present: false, reason: 'off' }
  return detectBridge(config.rdtRepo, path => existsQuiet($, path))
}

async function daysSinceExport($: Dollar, home: string | null, today: string): Promise<number | null> {
  if (!home) return null
  const names = (await listQuiet($, `${storeDir(home)}/export`)).map(e => e.name).filter(n => /^\d{4}-\d{2}-\d{2}T\d{4}$/.test(n)).sort()
  const newest = names[names.length - 1]
  return newest ? Math.max(0, dayNumber(today) - dayNumber(newest.slice(0, 10))) : null
}

/**
 * Every segment in the months' folders (changed files only re-read). With
 * `fromMemory` the open segment is taken from memory (it may hold rows not yet
 * flushed); without it, as the export needs, every segment comes from its file.
 */
async function readSegments($: Dollar, b: Boot, months: readonly string[], now: number, fromMemory: boolean): Promise<{ segments: SessionRecord[]; unreadable: number }> {
  const segments: SessionRecord[] = []
  let unreadable = 0
  let swept = 0
  if (b.home) {
    for (const month of months) {
      const dir = monthDir(b.home, month)
      for (const entry of await listQuiet($, dir)) {
        const path = `${dir}/${entry.name}`
        if (isTmpName(entry.name)) {
          if (fromMemory && swept < MAX_SWEEP && !entry.isLink && entry.mtimeMs > 0 && now - entry.mtimeMs > TMP_TTL_MS) {
            swept += 1
            await removeQuiet($, path)
          }
          continue
        }
        if (!isSegmentName(entry.name) || entry.isLink) continue
        if (fromMemory && current && path === currentPath) continue
        const cached = fileCache.get(path)
        let record: SessionRecord | null
        // The racy rule: a file written in the same millisecond it was read is read again.
        if (cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size && entry.mtimeMs < cached.readAt - 1) record = cached.record
        else {
          const text = await readText($, path)
          record = text === null ? null : decodeSession(text)
          fileCache.set(path, { record, mtimeMs: entry.mtimeMs, size: entry.size, readAt: now })
        }
        if (record) segments.push(record)
        else unreadable += 1
      }
    }
  }
  if (fromMemory && current && months.includes(monthOfTs(current.openedAt, b.zone))) segments.push(current)
  return { segments, unreadable }
}

async function refreshOnce($: Dollar): Promise<void> {
  const b = await ensureBoot($)
  if (!isZone(b.zone)) {
    await setError($, 'rd-ledger: the frozen time zone is not one this runtime knows')
    return
  }
  const now = await $.clock.now()
  const month = monthOfTs(now, b.zone)
  const { segments, unreadable } = await readSegments($, b, [month, previousMonth(month)], now, true)
  const mappingText = b.home ? await readText($, mappingPath(b.home)) : null
  const loaded = loadMapping(mappingText)
  const today = localDate(now, b.zone)
  const weeks = [isoWeek(today), isoWeek(addDays(today, -7))]
  const reviews = new Map(await Promise.all(weeks.map(async w => [w, loadReview(b.home ? await readText($, reviewPath(b.home, w)) : null, w).review] as const)))
  const bridge = await bridgeInfoOf($)
  if (boot && boot.salt === null && b.home && !b.storeIsLink) {
    const salt = await ensureSalt($, b.home, true, now)
    if (salt) {
      boot = { ...boot, salt }
      // The segment opened without a salt gets its root hash now, so its hours resolve through key#hash (verifier N6).
      if (current && current.rootHash === null && lastRoot) {
        current = { ...current, rootHash: rootHashOf(salt, lastRoot, b.home), updatedAt: now }
        markDirty($)
      }
    }
  }
  const year = Number(today.slice(0, 4))
  // The returns still ahead: last tax year's until its extended date passes, then this year's.
  const seen = new Set<string>()
  const ahead = [...deadlines(loaded.mapping, year - 1, today), ...deadlines(loaded.mapping, year, today)].filter(d => {
    const key = `${d.date}|${d.label}|${d.entity ?? ''}`
    if (d.date < today || seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rollup = computeRollup({
    now,
    zone: b.zone,
    params: config.params,
    defaultTtl: config.cacheTtl,
    segments,
    mapping: loaded.mapping,
    reviews,
    health: {
      zoneDetectedNow: detectZone(),
      unreadable,
      daysSinceExport: await daysSinceExport($, b.home, today),
      storeIsLink: b.storeIsLink,
      lockStaleMs: b.home ? await lockStaleMs($, b.home) : null,
      bridge: bridgeStatus(bridge),
      readOnly: b.home === null || b.storeIsLink,
    },
    deadlines: ahead,
    current: current ? { sessionId: current.sessionId, seg: current.seg } : null,
    selected: await read($, selectedSessionRef).catch(() => null),
  })
  known = { mapping: loaded.mapping, mappingText, problems: loaded.problems, mappingReadOnly: loaded.readOnly, segments, bridge }
  await update($, rollupRef, () => rollup)
}

/** One refresh at a time: the timer, a turn, a press or a command during one joins it. */
function refresh($: Dollar): Promise<void> {
  if (refreshing) return refreshing
  let mine: Promise<void> | null = null
  mine = (async () => {
    try {
      await refreshOnce($)
    } catch (err) {
      await setError($, `rd-ledger: refresh failed (${kindOf(err)})`)
    } finally {
      if (refreshing === mine) refreshing = null
    }
  })()
  refreshing = mine
  return mine
}

/** The refresh timer, armed once per load; the token in state lets only the newest load's timer refresh. */
async function arm($: Dollar): Promise<void> {
  if (timer) return
  loadToken ||= `load-${(await $.clock.now()).toString(36)}`
  const token = loadToken
  await update($, armTokenRef, () => token)
  timer = $.clock.every(config.refreshMs, () => {
    void (async () => {
      if ((await read($, armTokenRef).catch(() => null)) !== token) return
      await refresh($)
    })()
  })
}

function refreshAfterTurn($: Dollar): void {
  turnRefresh?.cancel()
  turnRefresh = $.clock.after(TURN_REFRESH_MS, () => {
    turnRefresh = null
    void refresh($)
  })
}

async function freshRollup($: Dollar, maxAgeMs = STALE_MS): Promise<Rollup | null> {
  const r = await read($, rollupRef).catch(() => null)
  if (r && (await $.clock.now()) - r.at <= maxAgeMs) return r
  await refresh($)
  return read($, rollupRef).catch(() => null)
}

// --- the pane ----------------------------------------------------------------------------

/** A rollup that carries the session fields (an older one, kept across a reload, does not). */
const hasSessions = (r: Rollup | null): r is Rollup => r !== null && Array.isArray(r.sessions) && typeof r.details === 'object' && r.details !== null
/** The full summary the rollup carries for `id`, or null. */
const detailOf = (r: Rollup, id: string | null): SessionSummary | null => (id !== null && hasOwn(r.details, id) ? (r.details[id] ?? null) : null)

/**
 * Makes the rollup carry the full summary of a session picked past the newest
 * rows: a refresh reads the selection from state, and a second one runs when
 * the first had already started before the selection landed (joined refresh).
 */
async function ensureDetails($: Dollar, id: string): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    const r = await read($, rollupRef).catch(() => null)
    if (!hasSessions(r) || !r.sessions.some(x => x.sessionId === id) || detailOf(r, id)) return
    await refresh($)
  }
}

/**
 * Today's recorded seconds for the footer chip, from the cached rollup only;
 * null before one exists (or when an older build's rollup lacks the figure),
 * which the label draws as `--`. A declaration, so the allowlist check can
 * follow `$` into it.
 */
async function todayFigure($: Dollar): Promise<number | null> {
  const rollup = await read($, rollupRef)
  return rollup && typeof rollup.todayS === 'number' ? rollup.todayS : null
}

/** Opens the pane; `selected` (when given) is the session the Session view shows, null for this process's own. */
async function openPane($: Dollar, view: View | null, selected?: string | null) {
  if (selected !== undefined) await update($, selectedSessionRef, () => selected)
  if (view) await update($, viewRef, () => view)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
  const r = await read($, rollupRef).catch(() => null)
  if (!r || (await $.clock.now()) - r.at > STALE_MS) void refresh($)
  return opened
}

// --- mapping saves -----------------------------------------------------------------------

/**
 * Applies `change` to components.json under the lock (SPEC §3.3): re-read,
 * refused when the file cannot be rewritten as it stands, when a save would
 * erase hand-edited entries the loader dropped, or when its `gen` moved since
 * the view was drawn; else written at `gen + 1` with one history line.
 */
async function changeMapping($: Dollar, change: (m: Mapping) => Mapping | null, describe: string): Promise<string | null> {
  const b = await ensureBoot($)
  const home = b.home
  if (!home || b.storeIsLink) return 'the store is read-only'
  const expectedGen = known?.mapping.gen ?? null
  const now = await $.clock.now()
  const held = await withLock($, home, async (): Promise<string | null> => {
    const text = await readText($, mappingPath(home))
    const loaded = loadMapping(text)
    if (loaded.readOnly) return 'components.json cannot be rewritten as it stands; fix it by hand'
    const blocking = loaded.problems.filter(isBlockingProblem)
    if (blocking.length > 0) return `components.json has ${blocking.length} ${blocking.length === 1 ? 'problem' : 'problems'} a save would erase; fix ${blocking.length === 1 ? 'it' : 'them'} by hand first (listed in Review)`
    if (expectedGen !== null && loaded.mapping.gen !== expectedGen) return 'components.json changed on disk; the view is refreshed, pick again'
    const next = change(loaded.mapping)
    if (!next) return 'that choice cannot be saved'
    const gen = loaded.mapping.gen + 1
    const err = await writeAtomic($, mappingPath(home), saveMapping({ ...next, gen }), 'map')
    if (err) return err
    const history = (await readText($, mappingHistoryPath(home))) ?? ''
    const sep = history === '' || history.endsWith('\n') ? '' : '\n'
    await writeAtomic($, mappingHistoryPath(home), `${history}${sep}${historyLine(now, gen, describe)}\n`, 'hist')
    return null
  })
  return held.ok ? held.value : `${lockHeldNote(held.staleMs)}; try again in a moment`
}

/** A queue row's Select pick: `c:<component>`, `ignore`, or `nonrd:<entity>`. */
async function pickQueue($: Dollar, key: string, value: string): Promise<void> {
  const decision: QueueDecision | null =
    value === 'ignore' ? { ignore: true } : value.startsWith('c:') ? { component: value.slice(2) } : value.startsWith('nonrd:') ? { nonRd: true, entity: value.slice(6) } : null
  if (!decision) return
  const err = await changeMapping($, m => applyQueueDecision(m, key, decision), `map ${key} to ${value}`)
  if (err) {
    $.ui.toast(`R&D ledger: ${err}.`)
    await refresh($)
    return
  }
  $.ui.toast(`R&D ledger: ${oneLine(key, 80)} mapped.`)
  await refresh($)
}

// --- review drafts, Confirm, Reopen ------------------------------------------------------

async function setActivity($: Dollar, row: WeekRow, activity: Activity): Promise<void> {
  await update($, pendingRowsRef, m => {
    const prior = hasOwn(m, row.key) ? m[row.key] : undefined
    return { ...m, [row.key]: { activity, poe: activity === 'non_qualified' ? false : (prior?.poe ?? row.poe) } }
  })
}

async function togglePoe($: Dollar, row: WeekRow, week: string): Promise<void> {
  const pending = await read($, pendingRowsRef)
  const prior = hasOwn(pending, row.key) ? pending[row.key] : undefined
  const poe = prior?.poe ?? row.poe
  if (!poe) {
    const notes = await read($, draftNotesRef)
    const note = notes[`${row.component}|${week}`] ?? ''
    if (note.trim() === '') {
      $.ui.toast(`R&D ledger: add a note for ${oneLine(row.component, 64)} (${week}) before turning POE on.`)
      return
    }
  }
  await update($, pendingRowsRef, m => ({ ...m, [row.key]: { activity: prior?.activity ?? row.activity, poe: !poe } }))
}

/** The admitted events of `week`, as the inputs digest reads them. */
const weekEvents = (segments: readonly SessionRecord[], week: string, zone: string): UnionEvent[] =>
  segments.flatMap(r => r.events.filter(ev => ev.admit === 1 && weekOfTs(ev.ts, zone) === week).map(ev => ({ ts: ev.ts, sessionId: r.sessionId, seg: r.seg, seq: ev.seq })))

/** Confirm week: freeze the rows with the drafts applied as a `confirm` revision; under source-of-truth, hand off. */
async function confirmWeek($: Dollar): Promise<void> {
  if (!(await claimBusy($, 'confirm'))) return
  try {
    await refresh($)
    const b = await ensureBoot($)
    const rollup = await read($, rollupRef)
    const home = b.home
    if (!rollup || !known || !home || b.storeIsLink) {
      $.ui.toast('R&D ledger: nothing to confirm (the store is read-only or not read yet).')
      return
    }
    const week = rollup.week
    const [pending, notesDraft, otherDraft] = await Promise.all([read($, pendingRowsRef), read($, draftNotesRef), read($, draftOtherHoursRef)])
    const otherHours: Record<string, number | null> = {}
    for (const [id, text] of Object.entries(otherDraft)) {
      const parsed = parseOtherHours(text)
      if (parsed !== null && typeof parsed === 'object') {
        $.ui.toast(`R&D ledger: other hours for ${oneLine(id, 40)}: ${parsed.error}.`)
        return
      }
      otherHours[id] = parsed
    }
    const rows: Record<string, { seconds: number; entity: string; activity: Activity; poe: boolean; source: 'pretag' | 'confirmed' }> = {}
    for (const row of rollup.weekRows) {
      const draft = hasOwn(pending, row.key) ? pending[row.key] : undefined
      rows[row.key] = { seconds: row.seconds, entity: row.entity, activity: draft?.activity ?? row.activity, poe: draft?.poe ?? row.poe, source: draft ? 'confirmed' : 'pretag' }
    }
    const now = await $.clock.now()
    const digestIn = inputsDigest(weekEvents(known.segments, week, b.zone))
    const digestMap = mappingDigest(known.mappingText ?? '')
    const held = await withLock($, home, async (): Promise<ReviewRevision | string> => {
      const loaded = loadReview(await readText($, reviewPath(home, week)), week)
      if (loaded.readOnly) return `the review file for ${week} cannot be rewritten as it stands`
      const prior = latestRevision(loaded.review)
      const notes: Record<string, string> = { ...(prior?.notes ?? {}) }
      for (const [key, text] of Object.entries(notesDraft)) if (key.endsWith(`|${week}`)) notes[key] = text
      const built = buildConfirm(loaded.review, {
        at: now,
        method: rollup.method,
        params: rollup.params,
        zone: rollup.zone,
        mappingDigest: digestMap,
        inputsDigest: digestIn,
        rows,
        otherHours: { ...(prior?.otherHours ?? {}), ...otherHours },
        notes,
        weekEnd: weekDates(week)[6] as string,
      })
      if ('refused' in built) return built.refused
      const err = await writeAtomic($, reviewPath(home, week), encodeReview(built.review), 'rev')
      if (err) return err
      return latestRevision(built.review) as ReviewRevision
    })
    if (!held.ok) {
      $.ui.toast(`R&D ledger: ${lockHeldNote(held.ok ? null : held.staleMs)}.`)
      return
    }
    if (typeof held.value === 'string') {
      $.ui.toast(`R&D ledger: not confirmed: ${oneLine(held.value, 160)}.`)
      return
    }
    const revision = held.value
    const isWeekKey = (k: string): boolean => k.endsWith(`|${week}`)
    const weekRowKeys = new Set(rollup.weekRows.map(r => r.key))
    await update($, pendingRowsRef, m => Object.fromEntries(Object.entries(m).filter(([k]) => !weekRowKeys.has(k))))
    await update($, draftNotesRef, m => Object.fromEntries(Object.entries(m).filter(([k]) => !isWeekKey(k))))
    await update($, draftOtherHoursRef, () => ({}))
    $.ui.toast(`R&D ledger: week ${week} confirmed (rev ${revision.rev}).`)
    await refresh($)
    if (config.bridgeMode === 'source-of-truth' && known.bridge.present) await handOff($, week, revision, known.bridge, known.mapping)
  } finally {
    await releaseBusy($, 'confirm')
  }
}

async function reopenWeek($: Dollar): Promise<void> {
  if (!(await claimBusy($, 'reopen'))) return
  try {
    const b = await ensureBoot($)
    const rollup = await read($, rollupRef)
    const home = b.home
    if (!rollup || !home || b.storeIsLink) return
    const week = rollup.week
    const now = await $.clock.now()
    const held = await withLock($, home, async (): Promise<ReviewRevision | string> => {
      const loaded = loadReview(await readText($, reviewPath(home, week)), week)
      if (loaded.readOnly) return `the review file for ${week} cannot be rewritten as it stands`
      const built = buildReopen(loaded.review, now)
      if ('refused' in built) return built.refused
      const err = await writeAtomic($, reviewPath(home, week), encodeReview(built.review), 'rev')
      return err ?? (latestConfirmed(loaded.review) as ReviewRevision)
    })
    if (!held.ok || typeof held.value === 'string') {
      $.ui.toast(`R&D ledger: not reopened: ${held.ok ? oneLine(held.value as string, 160) : lockHeldNote(held.staleMs)}.`)
      return
    }
    // The reopened week's notes become drafts again, so POE can stay on without retyping them.
    const notes = held.value.notes
    await update($, draftNotesRef, m => ({ ...m, ...notes }))
    $.ui.toast(`R&D ledger: week ${week} reopened.`)
    await refresh($)
  } finally {
    await releaseBusy($, 'reopen')
  }
}

// --- the bridge: Compare, hand-off, import ---------------------------------------------

async function ask($: Dollar, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, { options: [yes, CANCEL], header: PANE_TITLE })) === yes
  } catch {
    return false
  }
}

async function compareWeek($: Dollar): Promise<void> {
  if (!(await claimBusy($, 'compare'))) return
  try {
    const rollup = await read($, rollupRef)
    const info = known?.bridge
    if (!rollup || !info?.present || config.bridgeMode === 'off') {
      $.ui.toast('R&D ledger: rd-tracker is not reachable.')
      return
    }
    let argv: string[]
    try {
      argv = compareArgv(info, weekDates(rollup.week)[0] as string)
    } catch (err) {
      $.ui.toast(`R&D ledger: Compare cannot run (${kindOf(err)}).`)
      return
    }
    const question = `Compare ${rollup.week} with rd-tracker? rd-tracker re-derives the week's proposals (rdt review takes its repository lock and rewrites its derived week); this pane then shows its Claude Code hours per day beside these.`
    if (!(await ask($, question, COMPARE))) return
    const r = await runProc($, argv, { cwd: info.repo, timeoutMs: RDT_TIMEOUT_MS })
    const result = r && r.exitCode === 0 ? parseCompareJson(r.stdout, await $.clock.now()) : null
    if (!result) {
      $.ui.toast('R&D ledger: rd-tracker gave no answer this pane can read.')
      return
    }
    await update($, compareRef, () => result)
  } finally {
    await releaseBusy($, 'compare')
  }
}

/**
 * The confirmed revision's rows per rd-tracker destination (date, entity,
 * component): component rows only, combined (several ledger components may
 * share an rd-tracker component), plus a zero entry for every destination a
 * `sent` line holds for this week that the revision no longer claims, so the
 * plan reports it as an adjustment. Rows that disagree on activity or POE are
 * not combined but reported.
 */
const handoffEntries = (rev: ReviewRevision, week: string, mapping: Mapping, log: readonly BridgeLogEntry[]): { entries: HandoffEntry[]; conflicts: string[] } => {
  type Group = { date: string; rdtEntity: string; rdtComponent: string | null; seconds: number; activities: Set<Activity>; poes: Set<boolean>; notes: string[]; components: string[] }
  const groups = new Map<string, Group>()
  const groupOf = (date: string, rdtEntity: string, rdtComponent: string | null): Group => {
    const key = `${date}|${rdtEntity}|${rdtComponent ?? ''}`
    const g = groups.get(key) ?? { date, rdtEntity, rdtComponent, seconds: 0, activities: new Set<Activity>(), poes: new Set<boolean>(), notes: [], components: [] }
    groups.set(key, g)
    return g
  }
  for (const key of Object.keys(rev.rows).sort()) {
    const row = rev.rows[key]
    const cut = key.lastIndexOf('|')
    const component = key.slice(0, cut)
    if (!row || cut < 0 || isBucket(component)) continue
    const comp = hasOwn(mapping.components, component) ? mapping.components[component] : undefined
    const g = groupOf(key.slice(cut + 1), row.entity, comp?.rdt ?? null)
    g.seconds += row.seconds
    g.activities.add(row.activity)
    g.poes.add(row.poe)
    g.components.push(component)
    const note = rev.notes[`${component}|${week}`]
    if (note && !g.notes.includes(note)) g.notes.push(note)
  }
  for (const e of log) if (e.kind === 'sent' && e.week === week && e.date) groupOf(e.date, e.rdtEntity, e.rdtComponent)
  const entries: HandoffEntry[] = []
  const conflicts: string[] = []
  for (const g of groups.values()) {
    if (g.activities.size > 1 || g.poes.size > 1) {
      conflicts.push(`${g.date} ${g.rdtComponent ?? g.rdtEntity}`)
      continue
    }
    entries.push({
      week,
      rev: rev.rev,
      date: g.date,
      rdtEntity: g.rdtEntity,
      rdtComponent: g.rdtComponent,
      hundredths: Math.round(g.seconds / 36),
      activity: [...g.activities][0] ?? 'non_qualified',
      poe: [...g.poes][0] === true,
      note: g.notes.length > 0 ? g.notes.join(' / ') : null,
      startIso: null,
      endIso: null,
    })
  }
  return { entries, conflicts }
}

/** Under source-of-truth: `rdt add` once per destination the plan sends, each between an intent line and its outcome line (SPEC §7). */
async function handOff($: Dollar, week: string, revision: ReviewRevision, info: Extract<BridgeInfo, { present: true }>, mapping: Mapping): Promise<void> {
  const home = boot?.home
  if (!home) return
  const logPath = bridgeLogPath(home, week.slice(0, 4))
  const parsed = parseBridgeLog(await readText($, logPath))
  if (parsed.malformed > 0) {
    $.ui.toast(`R&D ledger: nothing handed off: the bridge log has ${parsed.malformed} line${parsed.malformed === 1 ? '' : 's'} it cannot read; fix the log first.`)
    return
  }
  const { entries, conflicts } = handoffEntries(revision, week, mapping, parsed.entries)
  const plan = planHandoff(entries, parsed.entries)
  const blockedWhy = plan.blocked.map(entry => {
    const argv = addArgv(info, entry)
    return Array.isArray(argv) ? 'an earlier hand-off is pending or uncertain' : argv.refused
  })
  const notes: string[] = []
  if (plan.adjust.length > 0) notes.push(`${plan.adjust.length} need a manual adjustment in rd-tracker`)
  if (plan.blocked.length > 0) notes.push(`${plan.blocked.length} blocked (${oneLine(blockedWhy[0] ?? '', 80)})`)
  if (conflicts.length > 0) notes.push(`${conflicts.length} not combined (activity or POE differ)`)
  const now = await $.clock.now()
  // The adjust record is written whether or not anything is sent, and before the question (verifier N1): the export must carry the discrepancy.
  if (plan.adjust.length > 0) {
    const wrote = await withLock($, home, async () => {
      const text = (await readText($, logPath)) ?? ''
      const live = parseBridgeLog(text)
      if (live.malformed > 0) return false
      let next = text
      for (const entry of plan.adjust) {
        const already = live.entries.some(e => e.kind === 'needs-manual-adjust' && e.date === entry.date && e.rdtEntity === entry.rdtEntity && (e.rdtComponent ?? '') === (entry.rdtComponent ?? '') && e.hundredths === entry.hundredths)
        if (already) continue
        const sep = next === '' || next.endsWith('\n') ? '' : '\n'
        next = `${next}${sep}${bridgeLine({ at: now, kind: 'needs-manual-adjust', week, rev: revision.rev, date: entry.date, rdtEntity: entry.rdtEntity, rdtComponent: entry.rdtComponent, hundredths: entry.hundredths, argv: [], exitCode: null, rowId: null, label: null, lagDays: null, stdoutLine: '' })}\n`
      }
      return next === text || (await writeAtomic($, logPath, next, 'bridge')) === null
    })
    if (!wrote.ok || !wrote.value) notes.push(wrote.ok ? 'the adjust record could not be written' : lockHeldNote(wrote.staleMs))
  }
  if (plan.send.length === 0) {
    $.ui.toast(`R&D ledger: nothing new to hand off${notes.length > 0 ? `; ${notes.join('; ')}` : ''}.`)
    return
  }
  const batchSize = Math.min(plan.send.length, MAX_HANDOFF_PER_CONFIRM)
  const more = plan.send.length - batchSize
  if (!(await ask($, `Record ${batchSize} ${batchSize === 1 ? 'entry' : 'entries'} for ${week} in rd-tracker with rdt add${more > 0 ? ` (${more} more on the next Confirm)` : ''}?`, HAND_OFF))) return
  const counts = { sent: 0, failed: 0, uncertain: 0, skipped: 0 }
  let deferred = 0
  const held = await withLock($, home, async () => {
    // The time guard counts the hold, not the time the question sat open (verifier V12).
    const startedAt = await $.clock.now()
    // Every append re-reads the file: another session's lines are never overwritten from a snapshot (verifier V3).
    const append = async (entry: BridgeLogEntry): Promise<boolean> => {
      const text = (await readText($, logPath)) ?? ''
      const sep = text === '' || text.endsWith('\n') ? '' : '\n'
      return (await writeAtomic($, logPath, `${text}${sep}${bridgeLine(entry)}\n`, 'bridge')) === null
    }
    const liveLog = async (): Promise<BridgeLogEntry[] | null> => {
      const parsedNow = parseBridgeLog(await readText($, logPath))
      return parsedNow.malformed > 0 ? null : parsedNow.entries
    }
    const again = await liveLog()
    if (!again) return 'the bridge log changed and has lines it cannot read'
    const fresh = planHandoff(handoffEntries(revision, week, mapping, again).entries, again)
    const batch = fresh.send.slice(0, MAX_HANDOFF_PER_CONFIRM)
    deferred = fresh.send.length - batch.length
    for (const [i, entry] of batch.entries()) {
      // A hold must end well inside the stale threshold: past the time guard the rest waits for the next Confirm (verifier V3).
      if ((await $.clock.now()) - startedAt > HANDOFF_TIME_GUARD_MS) {
        deferred += batch.length - i
        break
      }
      const argv = addArgv(info, entry)
      if (!Array.isArray(argv)) continue
      // Re-check the destination against the file as it stands right now: a line another session wrote meanwhile stops this one.
      const current = await liveLog()
      if (!current) return 'the bridge log changed and has lines it cannot read'
      if (planHandoff([entry], current).send.length !== 1) {
        counts.skipped += 1
        continue
      }
      const base = { week, rev: revision.rev, date: entry.date, rdtEntity: entry.rdtEntity, rdtComponent: entry.rdtComponent, hundredths: entry.hundredths, argv: argvForLog(argv, info.repo) }
      // No intent on disk, no call: an unlogged call is how an hour gets counted twice.
      if (!(await append({ ...base, at: await $.clock.now(), kind: 'intent', exitCode: null, rowId: null, label: null, lagDays: null, stdoutLine: '' }))) return 'the bridge log could not be written'
      let kind: BridgeLogKind = 'uncertain'
      let exitCode: number | null = null
      let stdout = ''
      let added: { rowId: number; label: string; lagDays: number } | null = null
      try {
        const r = await $.process.run(argv, { cwd: info.repo, timeoutMs: RDT_TIMEOUT_MS })
        exitCode = r.exitCode
        stdout = r.stdout
        added = r.exitCode === 0 ? parseAddLine(r.stdout) : null
        kind = r.exitCode !== 0 ? 'failed' : added ? 'sent' : 'uncertain'
      } catch {
        kind = 'uncertain'
      }
      counts[kind === 'sent' ? 'sent' : kind === 'failed' ? 'failed' : 'uncertain'] += 1
      const line = oneLine(stdout.split('\n').find(l => l.startsWith('rdt add:')) ?? stdout, CAP.stdout)
      await append({ ...base, at: await $.clock.now(), kind, exitCode, rowId: added?.rowId ?? null, label: added?.label ?? null, lagDays: added?.lagDays ?? null, stdoutLine: line })
    }
    return null
  })
  if (!held.ok) {
    $.ui.toast(`R&D ledger: nothing handed off: ${lockHeldNote(held.staleMs)}.`)
    return
  }
  if (deferred > 0) notes.push(`${deferred} more on the next Confirm (at most ${MAX_HANDOFF_PER_CONFIRM} per Confirm)`)
  if (counts.skipped > 0) notes.push(`${counts.skipped} already handed off by another session`)
  const head = `R&D ledger: hand-off ${counts.sent} sent, ${counts.failed} failed, ${counts.uncertain} uncertain`
  $.ui.toast(`${head}${held.value ? ` (${held.value})` : ''}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}.`)
}

async function runImport($: Dollar): Promise<string> {
  if (!(await claimBusy($, 'import'))) return 'R&D ledger: another action is still running.'
  try {
    const b = await ensureBoot($)
    const info = await bridgeInfoOf($)
    if (!info.present || !b.home) return 'R&D ledger: import needs the rd-tracker repository (the rdtRepo option).'
    let argv: string[]
    try {
      argv = importArgv(info)
    } catch (err) {
      return `R&D ledger: import cannot run (${kindOf(err)}).`
    }
    const r = await runProc($, argv, { cwd: storeDir(b.home), timeoutMs: RDT_TIMEOUT_MS })
    const imported = r && r.exitCode === 0 ? parseImportJson(r.stdout) : null
    if (!imported) return 'R&D ledger: rd-tracker gave no registry this ledger can read.'
    let added: string[] = []
    const err = await changeMapping(
      $,
      m => {
        const merged = mergeImport(m, imported)
        added = merged.added
        return merged.mapping
      },
      'import from rd-tracker',
    )
    await refresh($)
    if (err) return `R&D ledger: not imported: ${err}.`
    return added.length === 0 ? 'R&D ledger: rd-tracker has no entity or component this ledger lacks.' : `R&D ledger: imported ${added.length}: ${added.join(', ')}.`
  } finally {
    await releaseBusy($, 'import')
  }
}

// --- export -------------------------------------------------------------------------

/** `/rd export [YYYY | YYYY-MM]`: asks, then writes every file of SPEC §6.4 and the manifest, read from the files (never $.state). */
async function runExport($: Dollar, period: string | null): Promise<string> {
  const b = await ensureBoot($)
  const home = b.home
  if (!home || b.storeIsLink) return 'R&D ledger: the store is read-only, so nothing can be exported.'
  const now = await $.clock.now()
  const today = localDate(now, b.zone)
  const scope = period === null ? { year: today.slice(0, 4), month: null } : /^\d{4}$/.test(period) ? { year: period, month: null } : isMonth(period) ? { year: period.slice(0, 4), month: period } : null
  if (!scope) return `R&D ledger: ${USAGE}`
  if (!(await claimBusy($, 'export'))) return 'R&D ledger: another action is still running.'
  try {
    const stamp = stampOf(now, b.zone)
    const shown = `${STORE_LABEL}/export/${stamp}/`
    const count = EXPORT_FILES.length + 1
    if (!(await ask($, `Write ${count} files to ${shown}?`, WRITE))) return 'R&D ledger: export cancelled.'
    // The open segment is flushed first: the export reads files, never memory.
    await flush($)
    const months = scope.month ? [scope.month] : Array.from({ length: 12 }, (_, i) => `${scope.year}-${String(i + 1).padStart(2, '0')}`)
    const { segments, unreadable } = await readSegments($, b, months, now, false)
    const mappingText = (await readText($, mappingPath(home))) ?? ''
    const mapping = loadMapping(mappingText === '' ? null : mappingText).mapping
    const prefix = `${scope.month ?? scope.year}-`
    const reviewNames = (await listQuiet($, reviewsDir(home))).map(e => e.name).filter(n => /^\d{4}-W\d{2}\.json$/.test(n)).map(n => n.slice(0, -5)).filter(w => isWeek(w) && weekDates(w).some(d => d.startsWith(prefix))).sort()
    const reviews = await Promise.all(reviewNames.map(async w => loadReview(await readText($, reviewPath(home, w)), w).review))
    // The log is keyed by ISO week-year, which can differ from the calendar year at the edges: read the neighbours too and keep what is dated in scope (verifier V10).
    const years = [String(Number(scope.year) - 1), scope.year, String(Number(scope.year) + 1)]
    const logTexts = await Promise.all(years.map(y => readText($, bridgeLogPath(home, y))))
    const bridgeLog = logTexts.flatMap(t => parseBridgeLog(t).entries).filter(e => e.date === null || e.date.startsWith(prefix))
    const events: UnionEvent[] = segments.flatMap(r => r.events.filter(ev => ev.admit === 1).map(ev => ({ ts: ev.ts, sessionId: r.sessionId, seg: r.seg, seq: ev.seq })))
    const blocks = buildBlocks(events, config.params, b.zone)
    const allocations = allocate(blocks, new Map(segments.map(r => [segmentKey(r.sessionId, r.seg), r] as const)), mapping)
    const source = async (name: string): Promise<string> => {
      const text = await readText($, `${$.plugin.root}/hooks/${name}`)
      return text === null ? 'unreadable' : sha256(text)
    }
    const { files, redactions } = buildExport({
      scope,
      segments,
      blocks,
      allocations,
      reviews,
      mapping,
      mappingText,
      bridgeLog,
      zone: b.zone,
      params: config.params,
      method: methodString(config.params, b.zone),
      defaultTtl: config.cacheTtl,
      version: MOD_VERSION,
      now,
      personLabel: config.personLabel,
      sources: { unionSha256: await source('union.ts'), pricesSha256: await source('prices.ts') },
      unreadable,
      admissionVersion: ADMISSION_VERSION,
    })
    const all = [...files, { name: 'MANIFEST.sha256', text: manifestText(files.map(f => ({ name: f.name, sha256: sha256(f.text) }))) }]
    const dir = exportDir(home, stamp)
    for (const out of all) {
      const err = await writeAtomic($, `${dir}/${out.name}`, out.text, 'x')
      if (err) return `R&D ledger: export stopped: ${err}.`
    }
    const total = Object.values(redactions).reduce((s, n) => s + n, 0)
    const byKind = Object.entries(redactions)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${oneLine(k, 40)} ${n}`)
      .slice(0, 4)
    const text = `R&D ledger: exported ${all.length} files to ${shown} · ${total} ${total === 1 ? 'redaction' : 'redactions'}${byKind.length > 0 ? ` (${byKind.join(', ')})` : ''}`
    $.ui.toast(text)
    void refresh($)
    return `${text}.`
  } finally {
    await releaseBusy($, 'export')
  }
}

/** The surface in force: the segment's, else the boot's, else the first surface drawing now, which is then kept on both. */
async function learnSurface($: Dollar, drawing: string | null): Promise<string | null> {
  const known = current?.surface ?? boot?.surface ?? null
  if (known !== null) return known
  if (drawing === null) return null
  if (boot) boot = { ...boot, surface: drawing }
  await serial(async () => {
    if (!current || current.surface !== null) return
    const now = await $.clock.now()
    current = withSurface(current, drawing, now)
    markDirty($)
  })
  return drawing
}

// --- the command ----------------------------------------------------------------------

async function runCommand($: Dollar, args: string, originKind: string): Promise<string> {
  const words = oneLine(args, 60).toLowerCase().split(' ').filter(Boolean)
  const sub = words[0] ?? 'overview'
  const b = await ensureBoot($)
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  const isHeadless = surfaces.length === 0
  // The desktop app attaches its surface after session.start (verified live 2026-10-12: surface null at start, composer origin): learn it here.
  const surfaceNow = await learnSurface($, surfaces[0] ?? null)
  const isPerson = isPersonOrigin(originKind, surfaceNow)
  const mayAct = isPerson && (b.interactive || surfaceNow === 'desktop')
  if (sub === 'overview' || sub === 'review' || sub === 'spend') {
    const view: View = sub
    const rollup = await freshRollup($)
    if (!isHeadless && isPerson) {
      let isPlaced = false
      try {
        isPlaced = (await openPane($, view)).isPlaced
      } catch {
        isPlaced = false
      }
      if (isPlaced) return 'R&D ledger pane opened.'
    }
    if (!rollup) return 'R&D ledger: no figures yet.'
    if (!isPerson) return summaryLine(rollup)
    return view === 'spend' ? spendText(rollup) : overviewText(rollup, 100)
  }
  if (sub === 'session' || sub === 'sessions') {
    const view: View = sub
    const rollup = await freshRollup($)
    // Views are for the person's own origins; anything else gets the one summary line (§6).
    if (!isPerson) return rollup ? summaryLine(rollup) : 'R&D ledger: no figures yet.'
    let selected: string | null = null
    if (view === 'session' && words.length > 1) {
      const id8 = words[1] as string
      if (words.length > 2 || !/^[0-9a-f]{8}$/.test(id8)) return USAGE
      const matches = (rollup?.sessions ?? []).filter(x => isSessionId(x.sessionId) && x.sessionId.toLowerCase().startsWith(id8))
      if (matches.length === 0) return `R&D ledger: none of the newest 300 sessions this or last month starts with ${id8}; nothing opened.`
      if (matches.length > 1) return `R&D ledger: ${matches.length} sessions start with ${id8} (${matches.map(x => x.sessionId.toLowerCase()).join(', ')}); nothing opened.`
      selected = (matches[0] as { sessionId: string }).sessionId
    }
    if (!isHeadless) {
      let isPlaced = false
      try {
        isPlaced = (await openPane($, view, selected)).isPlaced
      } catch {
        isPlaced = false
      }
      if (isPlaced) {
        // The pane reads "Reading the ledger…" until a session past the newest rows has its summary.
        if (selected !== null) void ensureDetails($, selected).catch(() => undefined)
        return 'R&D ledger pane opened.'
      }
    }
    if (selected !== null) {
      await update($, selectedSessionRef, () => selected)
      await ensureDetails($, selected)
    }
    const latest = await read($, rollupRef).catch(() => null)
    if (!hasSessions(latest)) return 'R&D ledger: no figures yet.'
    if (view === 'sessions') return sessionsText(latest, { showRepo: false, shown: SESSIONS_SHOWN, hasMore: false })
    const summary = detailOf(latest, selected ?? latest.thisSessionId)
    return summary ? sessionText(summary, latest.zone, { showRepo: false }) : 'R&D ledger: no figures for this session yet.'
  }
  if (sub === 'export') {
    if (!mayAct) return 'R&D ledger: export runs only from your own prompt in an interactive session.'
    return runExport($, words[1] ?? null)
  }
  if (sub === 'import') {
    if (!mayAct) return 'R&D ledger: import runs only from your own prompt in an interactive session.'
    const text = await runImport($)
    $.ui.toast(text)
    return text
  }
  return USAGE
}

export const register: Register = (on, options) => {
  const mode = options['bridgeMode']
  const repo = typeof options['rdtRepo'] === 'string' ? options['rdtRepo'].trim().replace(/\/+$/, '') : ''
  config = {
    refreshMs: clamp(options['refreshMinutes'], 5, 1, 60) * 60_000,
    params: { ...DEFAULT_PARAMS, gapS: Math.round(clamp(options['idleGapMinutes'], 30, 5, 120) * 60) },
    cacheTtl: options['cacheTtl'] === '1h' ? '1h' : '5m',
    rdtRepo: isPlainAbsolute(repo) ? repo : '',
    bridgeMode: mode === 'source-of-truth' || mode === 'off' ? mode : 'corroborate',
    personLabel: typeof options['personLabel'] === 'string' ? oneLine(options['personLabel'], 80) : '',
    footerButton: options['footerButton'] !== false,
  }
  boot = null
  homeCache = undefined
  timer = null
  loadToken = ''
  turnRefresh = null
  refreshing = null
  flushTimer = null
  flushing = null
  flushAgain = false
  dirty = false
  backoffMs = 0
  writeSerial = 0
  lastRoot = null
  current = null
  currentPath = null
  mutating = Promise.resolve()
  fileCache = new Map()
  known = null

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'rd', description: 'R&D ledger: this session, all sessions, this week, the review queue, spend estimates, export', immediate: true })
    } catch (err) {
      $.ui.log(`rd-ledger: /rd not registered (${kindOf(err)})`, { to: 'debug' })
    }
    try {
      await bootStore($, { surface: typeof e.surface === 'string' ? e.surface : null, interactive: e.isInteractive === true })
      await serial(() => openOrContinue($))
      await arm($)
      // The branch and the first rollup run once the start has settled, never holding up the first prompt.
      $.clock.after(0, () => {
        void detectBranch($).then(() => refresh($))
      })
    } catch (err) {
      await setError($, `rd-ledger: start failed (${kindOf(err)})`)
    }
    return next(e)
  })

  // After /clear no session.start fires: the classic hook opens the new id's
  // segment (closing the old one 'clear' when session.end did not). A start
  // or resume the session.start above already opened is only labelled.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    try {
      const source = e.source
      if (e.agent_id !== undefined || (source !== 'startup' && source !== 'resume' && source !== 'clear' && source !== 'fork')) return result
      const sid = typeof e.session_id === 'string' ? e.session_id : ''
      if (!isSessionId(sid)) return result
      const now = await $.clock.now()
      const opened = await serial(async () => {
        if (current && current.closedAt === null && current.sessionId === sid) {
          if (current.source === 'unknown') {
            current = { ...current, source, ...(source === 'startup' ? { engineCostAtOpen: 0 } : {}) }
            markDirty($)
          }
          return false
        }
        if (current && current.closedAt === null) {
          current = withClose(current, source === 'clear' ? 'clear' : source, now)
          await flush($)
        }
        await openSegment($, sid, source, now)
        return true
      })
      if (opened) {
        $.clock.after(0, () => {
          void detectBranch($)
        })
      }
    } catch {
      // Observing only: a start is never held up.
    }
    return result
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const meta = promptMeta(e)
    const result = await next(e)
    try {
      await learnSurface($, (await $.session.surfaces().catch(() => [] as readonly string[]))[0] ?? null)
      if (!('drop' in result) || result.drop === undefined) await recordEvent($, meta)
    } catch {
      // Recording never blocks a prompt.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      const usage = e.usage
      await recordTurn($, {
        endTs: await $.clock.now(),
        durationMs: e.durationMs,
        turnId: e.turnId,
        agentId: e.agentId ?? null,
        model: typeof usage?.model === 'string' ? usage.model : null,
        usage: usage
          ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens }
          : null,
        reason: e.reason,
      })
      if (e.agentId === undefined) {
        await arm($)
        // The branch may have changed during the turn; git runs off the turn's path.
        $.clock.after(0, () => {
          void detectBranch($)
        })
        refreshAfterTurn($)
      }
    } catch {
      // Observing only.
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const usd = e.cost?.usd
      const now = await $.clock.now()
      if (typeof usd === 'number') {
        await serial(async () => {
          if (!current || current.closedAt !== null) return
          const nextRecord = withCost(current, usd, now)
          if (nextRecord === current) return
          current = nextRecord
          markDirty($)
        })
      }
    } catch {
      // Observing only.
    }
    return result
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    try {
      const ttl = e.cache_ttl
      const now = await $.clock.now()
      if (e.agent_id === undefined) {
        await serial(async () => {
          if (!current || current.closedAt !== null) return
          const nextRecord = withCacheTtl(current, ttl, now)
          if (nextRecord === current) return
          current = nextRecord
          markDirty($)
        })
      }
    } catch {
      // Observing only.
    }
    return result
  }).catch(($, e, next) => next(e))

  // The close is flushed beside core's own end step rather than before it, so a
  // slow spawn never eats core's share; a temp written past the budget is left
  // for the sweep and readers treat `closedAt: null` as "last row".
  on('session.end', async ($, e, next) => {
    const [result] = await Promise.all([
      next(e),
      (async () => {
        try {
          const started = await $.clock.now()
          const closed = await serial(async () => {
            if (!current || current.closedAt !== null || current.sessionId !== e.sessionId) return false
            flushTimer?.cancel()
            flushTimer = null
            current = withClose(current, typeof e.reason === 'string' ? e.reason : 'other', started)
            return true
          })
          if (!closed) return
          const late = (await $.clock.now()) - started > END_MV_BUDGET_MS
          await flush($, late)
        } catch {
          // A crash never gets here either; the segment then reads as open.
        }
      })(),
    ])
    return result
  })

  on('command.run', { command: 'rd' }, async ($, e) => {
    return { text: await runCommand($, e.args, e.origin.kind) }
  }).catch(async ($, e) => {
    // Past its budget or failed: answer from the last rollup rather than leave a registered command with no output.
    const rollup = await read($, rollupRef).catch(() => null)
    if (!rollup) return { text: 'R&D ledger: no figures yet.' }
    return { text: isPersonOrigin(e.origin.kind, current?.surface ?? boot?.surface ?? null) ? overviewText(rollup, 100) : summaryLine(rollup) }
    // (the .catch path answers from state alone; the surface it knows is the one learnt earlier)
  })

  // The figure on the terminal: after the engine's own hint line, so its pills stay live.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'terminal') return engine
    const label = footerLabel(await todayFigure($))
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        {engine}
        <Box marginLeft={2}>
          <Button key="rd-ledger" plain dimColor label={label} onPress={() => void openPane($, 'overview').catch(() => undefined)} />
        </Box>
      </Box>
    )
  })

  // The figure on the desktop: the footer's mode strip draws Text and Button
  // chips only and clips what does not fit, so the label is the hourglass mark and
  // today's R&D hours (≤ 10 characters). A press opens the Overview, the R&D tax
  // ledger; with footerButton off it is plain text and /rd opens the pane.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'desktop') return engine
    const label = footerLabel(await todayFigure($))
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {config.footerButton ? (
          <Button key="rd-ledger" plain label={label} onPress={() => void openPane($, 'overview').catch(() => undefined)} />
        ) : (
          <Text dimColor>{label}</Text>
        )}
        {engine}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rollup = await read($, rollupRef)
    const view = await read($, viewRef)
    const selected = await read($, selectedSessionRef)
    const sessionsShown = await read($, sessionsShownRef)
    const busy = await read($, busyRef)
    const lastError = await read($, lastErrorRef)
    const cols = Math.max(24, Math.floor(e.props.bodyColumns))
    const setView = (v: View) => () => void update($, viewRef, () => v).catch(() => undefined)
    const showSession = (id: string | null) => () =>
      void update($, selectedSessionRef, () => id)
        .then(() => update($, viewRef, () => 'session' as View))
        .then(() => (id === null ? undefined : ensureDetails($, id)))
        .catch(() => undefined)

    const chrome = (
      <Box key="chrome" flexDirection="row" gap={2}>
        <Button key="view-session" label="Session" hotkey="i" onPress={showSession(null)} />
        <Button key="view-sessions" label="Sessions" hotkey="a" onPress={setView('sessions')} />
        <Button key="view-overview" label="Overview" hotkey="o" onPress={setView('overview')} />
        <Button key="view-review" label="Review" hotkey="v" onPress={setView('review')} />
        <Button key="view-spend" label="Spend" hotkey="s" onPress={setView('spend')} />
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
        <Button key="export" label="Export" hotkey="e" onPress={() => void runExport($, null).catch(() => undefined)} />
        {rollup?.health.lockStaleMs !== null && rollup?.health.lockStaleMs !== undefined && (
          <Button key="clear-lock" label="Clear stale lock" hotkey="l" onPress={() => void clearStaleLock($).catch(() => undefined)} />
        )}
        <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => void $.ui.close({ id: PANE }).catch(() => undefined)} />
      </Box>
    )
    const status = (
      <Box key="status" flexDirection="column">
        {busy !== null && <Text dimColor>{`Working: ${oneLine(busy, 20)}…`}</Text>}
        {lastError !== null && <Text color="red">{oneLine(lastError, cols)}</Text>}
      </Box>
    )
    if (!rollup) {
      return (
        <Box flexDirection="column">
          {chrome}
          {status}
          <Text dimColor>Reading the ledger…</Text>
        </Box>
      )
    }
    const lines = (text: string, prefix: string) =>
      text.split('\n').map((line, i) => (
        <Text key={`${prefix}-${i}`} wrap="truncate" bold={line !== '' && !line.startsWith(' ')}>
          {line === '' ? ' ' : line}
        </Text>
      ))

    if ((view === 'session' || view === 'sessions') && !hasSessions(rollup)) {
      return (
        <Box flexDirection="column">
          {chrome}
          {status}
          <Text dimColor>Reading the ledger…</Text>
        </Box>
      )
    }

    if (view === 'session') {
      const listed = selected === null || rollup.sessions.some(x => x.sessionId === selected)
      const summary = listed ? detailOf(rollup, selected ?? rollup.thisSessionId) : null
      const missing =
        selected === null
          ? 'No figures for this session yet; they appear after its first prompt or turn.'
          : !listed
            ? 'That session is no longer among the newest 300 this or last month.'
            : 'Reading the ledger…'
      return (
        <Box flexDirection="column">
          {chrome}
          {status}
          {selected !== null && (
            <Box key="session-nav" flexDirection="row" marginTop={1}>
              <Button key="back" label="Back" onPress={setView('sessions')} />
            </Box>
          )}
          <Box key="body" flexDirection="column" marginTop={1}>
            {summary ? lines(sessionText(summary, rollup.zone, { showRepo: true }), 'se') : <Text dimColor>{missing}</Text>}
          </Box>
        </Box>
      )
    }

    if (view === 'sessions') {
      const shown = shownRows(sessionsShown)
      const options = sessionOptions(rollup, shown)
      const open = (value: string) => {
        if (!isSessionId(value) || !rollup.sessions.some(x => x.sessionId === value)) return
        showSession(value)()
      }
      const more =
        rollup.sessions.length > shown ? (
          <Box key="more" marginTop={1}>
            <Button key="more" label="More" hotkey="m" onPress={() => void update($, sessionsShownRef, n => Math.min(SESSIONS_SHOWN_MAX, shownRows(n) + SESSIONS_SHOWN)).catch(() => undefined)} />
          </Box>
        ) : null
      const listing = lines(sessionsText(rollup, { showRepo: true, shown, hasMore: true }), 'ss')
      if (e.surface !== 'mobile' && options.length > 0) {
        const { Select } = $.ui.resolve(e)
        return (
          <Box flexDirection="column">
            {chrome}
            {status}
            <Box key="picker" marginTop={1}>
              <Select key="open-session" label="Open session…" options={options} onSelect={open} />
            </Box>
            <Box key="body" flexDirection="column" marginTop={1}>
              {listing}
            </Box>
            {more}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {chrome}
          {status}
          <Box key="body" flexDirection="column" marginTop={1}>
            {listing}
          </Box>
          {more}
        </Box>
      )
    }

    if (view === 'overview' || view === 'spend') {
      return (
        <Box flexDirection="column">
          {chrome}
          {status}
          <Box key="body" flexDirection="column" marginTop={1}>
            {view === 'overview' ? lines(overviewText(rollup, cols), 'ov') : lines(spendText(rollup), 'sp')}
          </Box>
        </Box>
      )
    }

    // Review (SPEC §6.2).
    const week = rollup.week
    const mapping = known?.mapping ?? null
    const problems = known?.problems ?? []
    const pending = await read($, pendingRowsRef)
    const notes = await read($, draftNotesRef)
    const other = await read($, draftOtherHoursRef)
    const compare = await read($, compareRef)
    const review = rollup.reviews.find(r => r.week === week) ?? null
    const isMobile = e.surface === 'mobile'
    const bridged = rollup.health.bridge === 'corroborate' || rollup.health.bridge === 'source-of-truth'
    const components = [...new Set(rollup.weekRows.filter(r => !isBucket(r.component)).map(r => r.component))].sort()
    const entityIds = mapping ? Object.keys(mapping.entities).sort() : []
    const options = mapping
      ? [
          ...Object.keys(mapping.components)
            .sort()
            .map(id => {
              const c = mapping.components[id]
              return { value: `c:${id}`, label: oneLine(`${c?.name ?? id} (${c?.entity ?? ''})`, 80) }
            }),
          { value: 'ignore', label: 'Ignore' },
          ...entityIds.map(id => ({ value: `nonrd:${id}`, label: oneLine(`Non-R&D → ${mapping.entities[id]?.name ?? id}`, 80) })),
        ]
      : []

    let editors = null
    if (!isMobile) {
      const { Select, Input } = $.ui.resolve(e)
      editors = {
        select: (key: string) => <Select key={`map:${key}`} label={`Map ${oneLine(key, 60)}`} options={options} onSelect={(value: string) => void pickQueue($, key, value).catch(() => undefined)} />,
        note: (component: string) => {
          const noteKey = `${component}|${week}`
          const save = (value: string) => void update($, draftNotesRef, m => ({ ...m, [noteKey]: cleanField(value, CAP.note).value ?? '' })).catch(() => undefined)
          return <Input key={`note:${component}`} label={`Note for ${component}: what was done, what was uncertain, what was tried`} value={notes[noteKey] ?? ''} onInput={save} onSubmit={save} />
        },
        other: (id: string, label: string) => {
          const save = (value: string) => void update($, draftOtherHoursRef, m => ({ ...m, [id]: cleanField(value, 12).value ?? '' })).catch(() => undefined)
          return <Input key={`other:${id}`} label={label} placeholder="hours, 0 to 168" value={other[id] ?? ''} onInput={save} onSubmit={save} />
        },
      }
    }

    const dayRows = weekDates(week).map(date => {
      const ours = (rollup.dayTotals[date] ?? 0) / 3600
      const theirs = compare?.byDate[date] ?? 0
      const apart = Math.max(ours, theirs) > 0 && Math.abs(ours - theirs) / Math.max(ours, theirs) > COMPARE_MARK
      return `${date}  ledger ${ours.toFixed(2)} h  rd-tracker ${theirs.toFixed(2)} h  Δ ${(ours - theirs).toFixed(2)}${apart ? '  ! over 10 %' : ''}`
    })

    return (
      <Box flexDirection="column">
        {chrome}
        {status}
        <Text key="head" bold>{`Review ${week} · ${review?.confirmed ? `confirmed rev ${review.rev}` : 'open'}${review && review.changedRows > 0 ? ` · ${review.changedRows} changed since confirmation` : ''}`}</Text>
        {isMobile && <Text key="mobile">Use the terminal or the desktop to map repositories, set activities, write notes and confirm the week.</Text>}
        {problems.length > 0 && (
          <Box key="problems" flexDirection="column" marginTop={1}>
            <Text bold>{`components.json: ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`}</Text>
            {problems.slice(0, 10).map((p, i) => (
              <Text key={`problem-${i}`} wrap="truncate">{`  ${oneLine(p, cols)}`}</Text>
            ))}
          </Box>
        )}
        <Box key="queue" flexDirection="column" marginTop={1}>
          <Text bold>{`Unmapped repositories (${rollup.queue.length})`}</Text>
          {rollup.queue.length === 0 && <Text dimColor>  none this week</Text>}
          {rollup.queue.map(q => (
            <Box key={`q-${q.key}`} flexDirection="column">
              <Text wrap="truncate">{`  ${oneLine(q.key, 60)}  ${hoursText(q.seconds)}  ${q.branches.map(b => oneLine(b, 40)).join(', ')}${q.isNewLocation ? '  new location?' : ''}`}</Text>
              {editors?.select(q.key)}
            </Box>
          ))}
        </Box>
        <Box key="rows" flexDirection="column" marginTop={1}>
          <Text bold>Week rows</Text>
          {rollup.weekRows.length === 0 && <Text dimColor>  no hours this week</Text>}
          {rollup.weekRows.map(row => {
            const draft = hasOwn(pending, row.key) ? pending[row.key] : undefined
            const activity = draft?.activity ?? row.activity
            const poe = draft?.poe ?? row.poe
            const marks = [...row.flags.map(f => (f === 'mixed-entities' ? '[mixed entities]' : `[${oneLine(f, 20)}]`)), draft ? '[draft]' : ''].filter(Boolean).join(' ')
            const statusText = row.status === 'changed' ? 'changed since confirmation' : row.status
            return (
              <Box key={`row-${row.key}`} flexDirection="column">
                <Text wrap="truncate">{`  ${row.date}  ${oneLine(row.component, 40)}  ${oneLine(row.entity || '-', 20)}  ${hoursText(row.seconds)}  ${statusText}  ${ACTIVITY_LABEL[activity]}${poe ? '  POE' : ''}${marks ? `  ${marks}` : ''}`}</Text>
                {!isMobile && !isBucket(row.component) && (
                  <Box flexDirection="row" gap={1}>
                    <Button key={`act:${row.key}:research`} label="Research" onPress={() => void setActivity($, row, 'direct_research').catch(() => undefined)} />
                    <Button key={`act:${row.key}:support`} label="Support" onPress={() => void setActivity($, row, 'direct_support').catch(() => undefined)} />
                    <Button key={`act:${row.key}:nonrd`} label="Non-R&D" onPress={() => void setActivity($, row, 'non_qualified').catch(() => undefined)} />
                    <Button key={`poe:${row.key}`} label={poe ? 'POE on' : 'POE off'} onPress={() => void togglePoe($, row, week).catch(() => undefined)} />
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
        {editors && components.length > 0 && (
          <Box key="notes" flexDirection="column" marginTop={1}>
            <Text bold>Notes (required before POE)</Text>
            {components.map(c => editors.note(c))}
          </Box>
        )}
        {editors && (
          <Box key="other" flexDirection="column" marginTop={1}>
            <Text bold>Other hours this week</Text>
            {entityIds.map(id => editors.other(id, `Other hours, ${oneLine(mapping?.entities[id]?.name ?? id, 60)}`))}
            {editors.other('non_business', 'Non-business hours')}
          </Box>
        )}
        {bridged && compare && (
          <Box key="compare" flexDirection="column" marginTop={1}>
            <Text bold>{`rd-tracker Claude Code hours${compare.method ? ` (${oneLine(compare.method, 40)})` : ''}`}</Text>
            {dayRows.map((line, i) => (
              <Text key={`cmp-${i}`} wrap="truncate">{`  ${line}`}</Text>
            ))}
          </Box>
        )}
        {!isMobile && (
          <Box key="actions" flexDirection="row" gap={2} marginTop={1}>
            <Button key="confirm" label="Confirm week" hotkey="k" onPress={() => void confirmWeek($).catch(() => undefined)} />
            {review?.confirmed && <Button key="reopen" label="Reopen" onPress={() => void reopenWeek($).catch(() => undefined)} />}
            {bridged && <Button key="compare" label="Compare" onPress={() => void compareWeek($).catch(() => undefined)} />}
            {bridged && (
              <Button
                key="import"
                label="Import from rd-tracker"
                onPress={() =>
                  void runImport($)
                    .then(text => $.ui.toast(text))
                    .catch(() => undefined)
                }
              />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
