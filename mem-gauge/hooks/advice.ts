// The OPTIMIZE section: fixed rules over a snapshot, no model call. Each rule
// names the session or app it is about and the memory a step would free, so
// the person can act on it without opening Activity Monitor.

import type { DiskReport, Snapshot } from '../types'

import { formatBytes, formatMB, pressureText, shortModel } from './parse'

/**
 * What the Memory pane's Apply button does for a tip. Every kind confirms
 * first and runs a fixed command or an existing flow; none takes text from a
 * process or a file into a shell (there is no shell: argv only).
 */
export type AdviceAction =
  | { kind: 'ask-wrap'; sessionId: string }
  | { kind: 'compact' }
  | { kind: 'quit-app'; app: string }
  | { kind: 'open-disk' }

export type Advice = {
  /** Stable key per rule and target, for list keys and tests. */
  key: string
  text: string
  /** The session this advice targets, when the pane may offer "Ask to wrap". */
  sessionId?: string
  /** What Apply does; absent, the tip is advice only (sequence agents, pause suites, a session with no mod). */
  action?: AdviceAction
}

/** What the Disk pane's Apply button does for a tip; each a fixed argv (diskActionArgv). */
export type DiskAction = { kind: 'clear-caches' | 'clear-derived-data' | 'delete-stale-simulators' | 'empty-trash' | 'prune-file-history' }

export type DiskAdvice = { key: string; text: string; action?: DiskAction }

export type AdviceOptions = { idleMinutes: number }

const IDLE_BIG_MB = 1024
const CONTEXT_HIGH = 80
const AGENTS_HIGH = 3
const USED_HIGH = 85
const DISK_LOW_BYTES = 10 * 1024 ** 3

/** The sessions the pane offers "Ask to wrap" for: other live sessions idle past the threshold and over 1 GB. */
export function idleSessions(snapshot: Snapshot, options: AdviceOptions) {
  return snapshot.sessions.filter(
    s =>
      !s.isThis &&
      s.status === 'live' &&
      s.idleMinutes !== null &&
      s.idleMinutes > options.idleMinutes &&
      (s.rssMB ?? 0) > IDLE_BIG_MB,
  )
}

export function advise(snapshot: Snapshot, options: AdviceOptions): Advice[] {
  const out: Advice[] = []
  const live = snapshot.sessions.filter(s => s.status === 'live')
  const m = snapshot.machine

  for (const s of idleSessions(snapshot, options)) {
    out.push({
      key: `idle:${s.sessionId}`,
      sessionId: s.sessionId,
      ...(s.hasMod === false ? {} : { action: { kind: 'ask-wrap' as const, sessionId: s.sessionId } }),
      // A row an earlier build kept in $.state has no hasMod; only an explicit false means no mod to ask.
      text:
        s.hasMod === false
          ? `${s.label}: idle ${s.idleMinutes} min, archive it from the sidebar (frees ${formatMB(s.rssMB)})`
          : `${s.label}: idle ${s.idleMinutes} min, wrap or archive (frees ${formatMB(s.rssMB)})`,
    })
  }

  for (const s of live) {
    if (s.contextPercent !== null && s.contextPercent > CONTEXT_HIGH) {
      out.push({
        key: `context:${s.sessionId}`,
        // Only this session can be compacted from here.
        ...(s.isThis ? { action: { kind: 'compact' as const } } : {}),
        text: `${s.label}: context ${Math.round(s.contextPercent)}%, /compact or hand off to a fresh session`,
      })
    }
  }

  const fanOut = live.filter(s => s.agents > AGENTS_HIGH).sort((a, b) => b.agents - a.agents)[0]
  if (fanOut) {
    out.push({
      key: `agents:${fanOut.sessionId}`,
      text: `${fanOut.label}: ${fanOut.agents} agents running, the largest fan-out; consider sequencing`,
    })
  }

  const isTight = (m.usedPercent !== null && m.usedPercent > USED_HIGH) || m.pressure === 'warn' || m.pressure === 'critical'
  const topApp = snapshot.topApps[0]
  if (isTight && topApp) {
    // No quit for the host of this very session (the Claude desktop app) or a bare engine: advice only.
    const isHost = /^claude(\.exe)?$/i.test(topApp.name)
    out.push({ key: 'app', ...(isHost ? {} : { action: { kind: 'quit-app' as const, app: topApp.name } }), text: `memory is tight: close ${topApp.name} (${formatMB(topApp.rssMB)})` })
  }

  if (m.load1 !== null && m.cores !== null && m.cores > 0 && m.load1 > 2 * m.cores) {
    out.push({ key: 'load', text: `load ${m.load1.toFixed(1)} on ${m.cores} cores: pause heavy test suites` })
  }

  if (m.diskFreeBytes !== null && m.diskFreeBytes < DISK_LOW_BYTES) {
    out.push({ key: 'disk', action: { kind: 'open-disk' }, text: `disk ${formatBytes(m.diskFreeBytes)} free: see the Disk pane for what is safe to free` })
  }

  return out
}

/**
 * The /mem answer to an origin that is not the person, in a session that can
 * draw: machine figures and a count only, so no other session's label, model
 * or size lands in this transcript on a peer's, a plugin's or a schedule's say-so.
 */
export function summaryLine(snapshot: Snapshot): string {
  const m = snapshot.machine
  const used = m.usedPercent === null ? '--' : `${Math.round(m.usedPercent)}%`
  const live = snapshot.sessions.filter(s => s.status === 'live').length
  return `Memory ${used} used · Pressure ${pressureText(m.pressure)} · ${live} live session${live === 1 ? '' : 's'}`
}

/**
 * The /mem answer where no pane can be drawn (a -p run, an unplaced pane). It
 * becomes a transcript row the model reads, so it carries labels (repo and
 * branch) but never a cwd, and at most ten sessions.
 */
export function compactReport(snapshot: Snapshot, options: AdviceOptions): string {
  const m = snapshot.machine
  const used = m.usedPercent === null ? '--' : `${Math.round(m.usedPercent)}%`
  const lines = [
    `Memory ${used} used (${formatBytes(m.usedBytes)} of ${formatBytes(m.totalBytes)}) · ` +
      `Pressure ${pressureText(m.pressure)} · compressed ${formatBytes(m.compressedBytes)} · ` +
      `swap ${formatBytes(m.swapUsedBytes)} of ${formatBytes(m.swapTotalBytes)} · ` +
      `load ${m.load1 === null ? '?' : m.load1.toFixed(1)} on ${m.cores ?? '?'} cores · disk ${formatBytes(m.diskFreeBytes)} free`,
    `This session: ${snapshot.thisSessionMB === null ? 'unknown' : formatMB(snapshot.thisSessionMB)} (approximate RSS)`,
  ]
  const live = snapshot.sessions.filter(s => s.status === 'live')
  lines.push(`Sessions (${live.length} live):`)
  for (const s of snapshot.sessions.slice(0, 10)) {
    const ctx = s.contextPercent === null ? 'ctx --' : `ctx ${Math.round(s.contextPercent)}%`
    const idle = s.idleMinutes === null ? 'idle --' : `idle ${s.idleMinutes}m`
    const tag = s.status === 'live' ? '' : ` (${s.status})`
    lines.push(
      `  ${s.isThis ? '*' : '-'} ${s.label} · ${shortModel(s.model)} · ${formatMB(s.rssMB)} · ${ctx} · ${s.agents} agents · ${idle}${tag}`,
    )
  }
  const other = snapshot.unregistered
  if (other && other.count > 0) {
    lines.push(`  + ${other.count} Claude session${other.count === 1 ? '' : 's'} without mem-gauge: ${formatMB(other.rssMB)}`)
  }
  if (snapshot.topApps.length > 0) {
    lines.push(`Top apps: ${snapshot.topApps.map(a => `${a.name} ${formatMB(a.rssMB)}`).join(', ')}`)
  }
  const tips = advise(snapshot, options)
  lines.push(tips.length === 0 ? 'Optimize: nothing to do.' : 'Optimize:')
  for (const tip of tips) lines.push(`  - ${tip.text}`)
  return lines.join('\n')
}

/** A folder counts as worth mentioning in the disk advice from this size. */
const DISK_TIP_MIN_BYTES = 512 * 1024 * 1024

/**
 * What is safe to free on the disk, from the Disk pane's folder sizes and
 * volumes: caches, build products, stale simulators, the Trash, old file
 * history. Only things that can be cleared are listed; the Claude transcripts
 * are the session history and never appear. Pure; drawn as plain lines.
 */
export function diskAdvice(report: DiskReport): DiskAdvice[] {
  const out: DiskAdvice[] = []
  const size = (suffix: string): number | null => {
    const f = report.folders.find(folder => folder.path.endsWith(suffix))
    return f && f.bytes !== null ? f.bytes : null
  }
  const big = (suffix: string): number | null => {
    const b = size(suffix)
    return b !== null && b >= DISK_TIP_MIN_BYTES ? b : null
  }
  const caches = big('/Library/Caches')
  if (caches !== null) out.push({ key: 'caches', action: { kind: 'clear-caches' }, text: `Library caches ${formatBytes(caches)}: safe to clear; apps rebuild what they need` })
  const derived = big('/Library/Developer/Xcode/DerivedData')
  if (derived !== null) out.push({ key: 'derived', action: { kind: 'clear-derived-data' }, text: `Xcode DerivedData ${formatBytes(derived)}: safe to delete; the next build of each project is a full one` })
  const devices = big('/Library/Developer/CoreSimulator/Devices')
  if (devices !== null) {
    out.push({
      key: 'simulators',
      action: { kind: 'delete-stale-simulators' },
      text: `iOS simulator devices ${formatBytes(devices)}: delete the simulators you no longer test on (Apply removes the unavailable ones, xcrun simctl delete unavailable)`,
    })
  }
  const runtimes = report.volumes.filter(v => v.name.startsWith('Simulator runtime '))
  if (runtimes.length > 1) {
    const total = runtimes.reduce((sum, v) => sum + v.usedBytes, 0)
    out.push({ key: 'runtimes', text: `${runtimes.length} iOS simulator runtimes ${formatBytes(total)}: keep the one you test on; remove the rest in Xcode > Settings > Components` })
  }
  const trash = big('/.Trash')
  if (trash !== null) out.push({ key: 'trash', action: { kind: 'empty-trash' }, text: `Trash ${formatBytes(trash)}: empty it` })
  const history = big('/.claude/file-history')
  if (history !== null) {
    out.push({
      key: 'file-history',
      action: { kind: 'prune-file-history' },
      text: `Claude file history ${formatBytes(history)}: file snapshots for rewinding edits; safe to prune once those sessions are closed (Apply removes entries older than 30 days)`,
    })
  }
  // The Claude transcripts (~/.claude/projects) are the session history: never a candidate, so never listed here.
  return out
}

/** The one command an Apply runs for a disk action, as argv (no shell): fixed paths under `home`, nothing from a file or a process. */
export function diskActionArgv(action: DiskAction, home: string): string[] {
  // No -H: a target folder that is itself a symlink is not followed (find lists nothing, rm removes nothing),
  // so a relocated Caches is left alone rather than a link to anywhere being emptied; entries that are links are removed as links.
  const clear = (dir: string) => ['find', dir, '-mindepth', '1', '-maxdepth', '1', '-exec', 'rm', '-rf', '{}', '+']
  switch (action.kind) {
    case 'clear-caches':
      return clear(`${home}/Library/Caches`)
    case 'clear-derived-data':
      return clear(`${home}/Library/Developer/Xcode/DerivedData`)
    case 'delete-stale-simulators':
      return ['xcrun', 'simctl', 'delete', 'unavailable']
    case 'empty-trash':
      return clear(`${home}/.Trash`)
    case 'prune-file-history':
      return ['find', `${home}/.claude/file-history`, '-mindepth', '1', '-maxdepth', '1', '-mtime', '+30', '-exec', 'rm', '-rf', '{}', '+']
  }
}

/** What the confirmation asks before a disk action runs; ends with what cannot be undone. */
export function diskActionQuestion(action: DiskAction): string {
  switch (action.kind) {
    case 'clear-caches':
      return 'Clear everything in ~/Library/Caches (apps rebuild their caches; this cannot be undone)?'
    case 'clear-derived-data':
      return 'Delete everything in Xcode DerivedData (the next build of each project is a full one; this cannot be undone)?'
    case 'delete-stale-simulators':
      return 'Delete the unavailable iOS simulators, those whose runtime is gone (the ones you still test on are kept)?'
    case 'empty-trash':
      return 'Empty the Trash (everything in it is deleted for good)?'
    case 'prune-file-history':
      return 'Delete Claude file-history entries older than 30 days (rewinding edits in those sessions will no longer be possible)?'
  }
}

/** A short name for a disk action, for toasts. */
export function diskActionLabel(action: DiskAction): string {
  switch (action.kind) {
    case 'clear-caches':
      return 'clear Library caches'
    case 'clear-derived-data':
      return 'delete Xcode DerivedData'
    case 'delete-stale-simulators':
      return 'delete unavailable simulators'
    case 'empty-trash':
      return 'empty the Trash'
    case 'prune-file-history':
      return 'prune old Claude file history'
  }
}

/**
 * A graceful quit of one app by name through osascript, the name handed as an
 * argument (never spliced into the script): the app may still ask to save.
 * Null for a name osascript could read as an option or that is not one line.
 */
export function quitAppArgv(app: string): string[] | null {
  if (!app || app.startsWith('-') || /[\u0000-\u001f\u007f]/.test(app) || app.length > 120) return null
  return ['osascript', '-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', app]
}

/**
 * A HOME an Apply may build paths under: absolute, no `.` or `..` segment
 * (so it cannot spell the disk root as `/.` or `/Users/..`), at least one
 * segment, no control characters. Null otherwise: the Apply says so and stops.
 */
export function applyHome(home: string | null): string | null {
  if (!home || !home.startsWith('/') || /[\u0000-\u001f\u007f]/.test(home)) return null
  const segments = home.split('/').filter(part => part !== '')
  if (segments.length === 0 || segments.some(part => part === '.' || part === '..')) return null
  return `/${segments.join('/')}`
}
