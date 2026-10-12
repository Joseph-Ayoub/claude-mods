// Pure parsers and arithmetic for mem-gauge: every macOS command's text goes in,
// plain numbers come out. Nothing here touches `$`, so each function is tested
// from fixtures alone (hooks/parse.test.ts) and a parse failure is a null field,
// never a thrown tick.

import type { AppUsage, MachineStats, Pressure, SessionRow, SessionStatus, Snapshot, VolumeRow, WrapRequest } from '../types'

const MB = 1024 * 1024
const GB = 1024 * MB

/** A heartbeat older than this is stale and left out of totals. */
export const STALE_MS = 120_000
/** A gone or stale entry older than this is garbage-collected (a crash never fires session.end). */
export const GC_MS = 10 * 60_000
/** Any entry this old is collected whatever its pid says. */
export const MAX_AGE_MS = 24 * 60 * 60_000

/** `sysctl a b c` (no -n) into name -> value; keyed so a missing name cannot shift the others. */
export function parseSysctl(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    // sysctl names are dotted (hw.memsize); this also skips a stray "sysctl: unknown oid" line.
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(name)) continue
    out[name] = line.slice(at + 1).trim()
  }
  return out
}

const toInt = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d+$/.test(text.trim())) return null
  const n = Number(text.trim())
  return Number.isSafeInteger(n) ? n : null
}

export type VmStat = { pageSize: number; pages: Record<string, number> }

/**
 * `vm_stat`: the page size from its header and every "<label>: <n>." row, keyed
 * by the label lower-cased with a leading "Pages " dropped ("free", "wired down",
 * "occupied by compressor"). Null when the header is missing.
 */
export function parseVmStat(stdout: string): VmStat | null {
  const header = /page size of (\d+) bytes/.exec(stdout)
  const pageSize = header ? Number(header[1]) : NaN
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null
  const pages: Record<string, number> = {}
  for (const line of stdout.split('\n')) {
    const row = /^\s*"?([^:"]+)"?:\s+(\d+)\.?\s*$/.exec(line)
    if (!row) continue
    const label = row[1]!.trim().toLowerCase().replace(/^pages\s+/, '')
    pages[label] = Number(row[2])
  }
  return { pageSize, pages }
}

const UNIT: Record<string, number> = { K: 1024, M: MB, G: GB, T: GB * 1024 }

/** `vm.swapusage`: "total = 1024.00M  used = 202.00M  free = 822.00M  (encrypted)". */
export function parseSwap(value: string | undefined): { totalBytes: number; usedBytes: number } | null {
  if (!value) return null
  const read = (name: string) => {
    const m = new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMGT])`).exec(value)
    return m ? Math.round(Number(m[1]) * UNIT[m[2]!]!) : null
  }
  const totalBytes = read('total')
  const usedBytes = read('used')
  return totalBytes === null || usedBytes === null ? null : { totalBytes, usedBytes }
}

/** `vm.loadavg`: "{ 1.52 1.80 1.95 }" -> the 1-minute figure. */
export function parseLoad(value: string | undefined): number | null {
  const m = value ? /^\{?\s*([\d.]+)/.exec(value) : null
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) ? n : null
}

/** `df -k /`: the data row's 1024-blocks and Available columns, in bytes. */
export function parseDf(stdout: string): { totalBytes: number; freeBytes: number } | null {
  for (const line of stdout.split('\n').slice(1)) {
    // The filesystem name may hold spaces, so anchor on the numeric run and the capacity's %.
    const m = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec(line)
    if (m) return { totalBytes: Number(m[2]) * 1024, freeBytes: Number(m[4]) * 1024 }
  }
  return null
}

/** Mounts `df -kP` lists that are no volume of the person's: the sealed-system helpers and the swap space. */
const HELPER_MOUNTS = new Set([
  '/dev',
  '/System/Volumes/VM',
  '/System/Volumes/Preboot',
  '/System/Volumes/Update',
  '/System/Volumes/xarts',
  '/System/Volumes/iSCPreboot',
  '/System/Volumes/Hardware',
])

/** A readable name for a mount point: the APFS system and data volumes, an external disk, a simulator runtime. */
export function volumeName(mount: string): string {
  if (mount === '/') return 'Macintosh HD (system)'
  if (mount === '/System/Volumes/Data') return 'Macintosh HD (data)'
  const sim = /^\/Library\/Developer\/CoreSimulator\/Volumes\/(.+)$/.exec(mount)
  if (sim) return `Simulator runtime ${sim[1]}`
  const vol = /^\/Volumes\/(.+)$/.exec(mount)
  if (vol) return vol[1]!
  return mount
}

/**
 * Every real volume in `df -kP` (POSIX columns: blocks, used, available,
 * capacity, mount), the pseudo filesystems (devfs, automounter maps) and the
 * helper mounts left out. The mount point may hold spaces.
 */
export function parseDfAll(stdout: string): VolumeRow[] {
  const rows: VolumeRow[] = []
  for (const line of stdout.split('\n').slice(1)) {
    const m = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\/.*?)\s*$/.exec(line)
    if (!m) continue
    const filesystem = m[1]!
    const mount = m[5]!
    if (filesystem === 'devfs' || filesystem.startsWith('map ') || HELPER_MOUNTS.has(mount) || mount.startsWith('/System/Volumes/Data/')) continue
    const totalBytes = Number(m[2]) * 1024
    if (!(totalBytes > 0)) continue
    // A mount point is another program's text (a disk named elsewhere, a network share): one line,
    // no control characters, like every ps name and heartbeat label, or the pane is refused whole.
    const cleanMount = oneLine(mount.slice(0, 1024), 256)
    if (!cleanMount) continue
    const name = oneLine(volumeName(mount).slice(0, 512), 120) || cleanMount
    rows.push({ mount: cleanMount, name, totalBytes, usedBytes: Number(m[3]) * 1024, freeBytes: Number(m[4]) * 1024 })
  }
  return mergeSystemVolume(rows)
}

/**
 * The APFS system volume (`/`) and data volume (`/System/Volumes/Data`) share
 * one container, so df lists the same size and free space twice: one
 * "Macintosh HD" row, its used space the two volumes' together.
 */
function mergeSystemVolume(rows: VolumeRow[]): VolumeRow[] {
  const system = rows.find(r => r.mount === '/')
  const data = rows.find(r => r.mount === '/System/Volumes/Data')
  const main = data ?? system
  if (!main) return rows
  const merged: VolumeRow = {
    mount: '/',
    name: 'Macintosh HD',
    totalBytes: main.totalBytes,
    usedBytes: (system?.usedBytes ?? 0) + (data?.usedBytes ?? 0),
    freeBytes: main.freeBytes,
  }
  return [merged, ...rows.filter(r => r !== system && r !== data)]
}

/** One line for /disk where no pane can be drawn: 'Disk 50% used · used 931 GB of 1858 GB · free 927 GB'. */
export function diskLine(snapshot: Snapshot): string {
  const m = snapshot.machine
  const usedBytes = m.diskTotalBytes !== null && m.diskFreeBytes !== null ? Math.max(0, m.diskTotalBytes - m.diskFreeBytes) : null
  const percent = usedBytes !== null && m.diskTotalBytes ? `${Math.round((usedBytes / m.diskTotalBytes) * 100)}%` : '--'
  return `Disk ${percent} used · used ${formatCompact(usedBytes)} of ${formatCompact(m.diskTotalBytes)} · free ${formatCompact(m.diskFreeBytes)}`
}

/** `du -sk <path>` as bytes; null when du said nothing readable. */
export function parseDu(stdout: string): number | null {
  const m = /^\s*(\d+)\s/.exec(stdout)
  return m ? Number(m[1]) * 1024 : null
}

/**
 * Pressure from kern.memorystatus_level (percent of memory free as the kernel
 * judges it): under 20 warn, under 10 critical. Falls back to the share of
 * reclaimable pages from vm_stat when the sysctl is missing.
 */
export function pressureOf(level: number | null, vm: VmStat | null, totalBytes: number | null): Pressure {
  let freePercent = level
  if (freePercent === null && vm && totalBytes) {
    const p = vm.pages
    const reclaimable = (p['free'] ?? 0) + (p['inactive'] ?? 0) + (p['speculative'] ?? 0)
    freePercent = ((reclaimable * vm.pageSize) / totalBytes) * 100
  }
  if (freePercent === null || !Number.isFinite(freePercent)) return 'unknown'
  if (freePercent < 10) return 'critical'
  if (freePercent < 20) return 'warn'
  return 'ok'
}

/** One machine reading from the raw command outputs (any of them null when its command failed). */
export function buildMachine(
  at: number,
  raw: { sysctl: string | null; vmStat: string | null; df: string | null },
): MachineStats {
  const ctl = raw.sysctl ? parseSysctl(raw.sysctl) : {}
  const vm = raw.vmStat ? parseVmStat(raw.vmStat) : null
  const disk = raw.df ? parseDf(raw.df) : null
  const swap = parseSwap(ctl['vm.swapusage'])
  const totalBytes = toInt(ctl['hw.memsize'])
  const pagesOf = (...names: string[]) => {
    if (!vm || names.some(n => vm.pages[n] === undefined)) return null
    return names.reduce((sum, n) => sum + vm.pages[n]!, 0) * vm.pageSize
  }
  const usedBytes = pagesOf('active', 'wired down', 'occupied by compressor')
  const usedPercent =
    usedBytes !== null && totalBytes ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : null
  return {
    at,
    totalBytes,
    cores: toInt(ctl['hw.ncpu']),
    usedBytes,
    freeBytes: pagesOf('free', 'speculative'),
    compressedBytes: pagesOf('occupied by compressor'),
    usedPercent,
    pressure: pressureOf(toInt(ctl['kern.memorystatus_level']), vm, totalBytes),
    swapUsedBytes: swap?.usedBytes ?? null,
    swapTotalBytes: swap?.totalBytes ?? null,
    load1: parseLoad(ctl['vm.loadavg']),
    diskFreeBytes: disk?.freeBytes ?? null,
    diskTotalBytes: disk?.totalBytes ?? null,
  }
}

/** One process: its executable's basename and the app it rolls up under. */
export type Proc = { pid: number; ppid: number; rssKB: number; name: string; app: string }

/**
 * The app a process belongs to: the outermost `<Name>.app` in its executable
 * path (so "Google Chrome Helper (Renderer)" rolls up under "Google Chrome"),
 * else the basename. macOS `ps -o comm=` prints the full path.
 */
export function appOf(path: string): string {
  const bundle = /(?:^|\/)([^/]+)\.app(?:\/|$)/.exec(path)
  return bundle ? bundle[1]! : basename(path)
}

/**
 * Text another process wrote (a heartbeat's label or model, a ps app name),
 * squashed to one printable line before it is drawn or written into the /mem
 * row the model reads: C0/C1 controls (ESC, newlines) and line separators
 * become spaces; format characters (bidi overrides, zero-width, Unicode tags)
 * are dropped; runs of whitespace collapse; the result is cut to `max` code
 * points. Without this a crafted label could forge extra lines (a fake
 * "Optimize:" section) in the table the model reads.
 */
export const oneLine = (text: string, max: number): string =>
  [
    ...text
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/[\p{Cf}\p{Cs}\p{Co}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
    .trim()

export const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** `ps -axo pid=,ppid=,rss=,comm=` rows (comm last, so it may hold spaces). */
export function parsePs(stdout: string): Proc[] {
  const out: Proc[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const path = m[4]!
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), name: oneLine(basename(path), 256), app: oneLine(appOf(path), 120) || '?' })
  }
  return out
}

/** Executable names a Claude Code engine runs under (native build, Homebrew's .exe, node or bun). */
export const isEngineName = (name: string): boolean => /^(claude|claude\.exe|node|bun)$/.test(name)

/** `root` and every descendant, by walking ppid links; cycles and a missing root are safe. */
export function descendants(procs: readonly Proc[], root: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const p of procs) {
    if (p.pid === p.ppid) continue
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const seen = new Set<number>()
  if (!procs.some(p => p.pid === root)) return seen
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return seen
}

/**
 * RSS of a process tree in MB: the engine plus its MCP servers, shells and test
 * engines. In-process agents are inside the engine's own RSS. Null when the
 * root is not in the table. Approximate: RSS undercounts compressed pages.
 */
export function treeMB(procs: readonly Proc[], root: number): number | null {
  const tree = descendants(procs, root)
  if (tree.size === 0) return null
  let kb = 0
  for (const p of procs) if (tree.has(p.pid)) kb += p.rssKB
  return Math.round(kb / 1024)
}

/** Claude Code engines that run without mem-gauge, summed so their memory is not hidden or blamed on an app. */
export type Unregistered = { count: number; rssMB: number }
/** The unregistered engines one by one (their process trees' memory), with the totals. */
export type UnregisteredRoots = Unregistered & { roots: { pid: number; rssMB: number }[] }

const isClaudeEngine = (name: string) => name === 'claude' || name === 'claude.exe'

/**
 * Finds Claude Code engines outside `covered` (the registered sessions' trees),
 * counts each outermost one with its descendants (a nested `claude -p` or test
 * engine counts inside its parent), and adds every pid it counted to `covered`.
 */
export function claimUnregistered(procs: readonly Proc[], covered: Set<number>): UnregisteredRoots {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const engines = procs.filter(p => isClaudeEngine(p.name) && !covered.has(p.pid))
  const enginePids = new Set(engines.map(p => p.pid))
  const isRoot = (p: Proc) => {
    let parent = byPid.get(p.ppid)
    for (let hops = 0; parent && hops < 64; hops += 1) {
      if (enginePids.has(parent.pid) || covered.has(parent.pid)) return false
      if (parent.pid === parent.ppid) break
      parent = byPid.get(parent.ppid)
    }
    return true
  }
  let count = 0
  let kb = 0
  const roots: { pid: number; rssMB: number }[] = []
  for (const root of engines.filter(isRoot)) {
    count += 1
    let rootKB = 0
    for (const pid of descendants(procs, root.pid)) {
      if (covered.has(pid)) continue
      covered.add(pid)
      rootKB += byPid.get(pid)?.rssKB ?? 0
    }
    kb += rootKB
    roots.push({ pid: root.pid, rssMB: rootKB / 1024 })
  }
  return { count, rssMB: Math.round(kb / 1024), roots }
}

/** The top `n` apps by RSS, leaving out every pid in `exclude` (the Claude session trees). */
export function topApps(procs: readonly Proc[], exclude: ReadonlySet<number>, n = 8): AppUsage[] {
  const byApp = new Map<string, { kb: number; count: number }>()
  for (const p of procs) {
    if (exclude.has(p.pid) || p.rssKB <= 0) continue
    const row = byApp.get(p.app) ?? { kb: 0, count: 0 }
    row.kb += p.rssKB
    row.count += 1
    byApp.set(p.app, row)
  }
  return [...byApp.entries()]
    .map(([name, row]) => ({ name, rssMB: Math.round(row.kb / 1024), processes: row.count }))
    .sort((a, b) => b.rssMB - a.rssMB || a.name.localeCompare(b.name))
    .slice(0, n)
}

/** The registry file one session's copy writes; no prompt text, no secrets. */
export type RegistryEntry = {
  v: 1
  sessionId: string
  pid: number | null
  label: string
  cwd: string
  model: string
  rssMB: number | null
  contextPercent: number | null
  rateLimitPercent: number | null
  agents: number
  lastActivityAt: number
  startedAt: number
  updatedAt: number
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null)
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
/** A field drawn or reported as text: one printable line (see oneLine). */
const line = (v: unknown, max: number): string => (typeof v === 'string' ? oneLine(v.slice(0, max * 4), max) : '')

/** Session ids become file names, so only a plain id shape is accepted. */
export const isSessionId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id)

/**
 * A registry file's text, validated field by field. Writes are not atomic, so a
 * half-written or foreign file is null (left out of the table until a later tick
 * reads it whole, or collected), never a thrown tick. Another session wrote
 * it, so every drawn text field is squashed to one printable line.
 */
export function parseEntry(text: string): RegistryEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const sessionId = str(o['sessionId'], 128)
  if (!isSessionId(sessionId) || !isNum(o['updatedAt'])) return null
  const pid = numOrNull(o['pid'])
  return {
    v: 1,
    sessionId,
    pid: pid !== null && Number.isSafeInteger(pid) && pid > 1 ? pid : null,
    label: line(o['label'], 120) || sessionId.slice(0, 8),
    cwd: str(o['cwd'], 1024),
    model: line(o['model'], 80),
    rssMB: numOrNull(o['rssMB']),
    contextPercent: numOrNull(o['contextPercent']),
    rateLimitPercent: numOrNull(o['rateLimitPercent']),
    agents: isNum(o['agents']) ? Math.max(0, Math.round(o['agents'])) : 0,
    lastActivityAt: isNum(o['lastActivityAt']) ? o['lastActivityAt'] : 0,
    startedAt: isNum(o['startedAt']) ? o['startedAt'] : 0,
    updatedAt: o['updatedAt'],
  }
}

/**
 * live, stale or gone. Gone needs proof: the ps table was taken after the
 * session started and its pid is missing, or now belongs to something that is
 * not an engine (pid reuse). Without a ps table or a pid, age alone decides.
 */
export function statusOf(
  entry: RegistryEntry,
  now: number,
  procs: { at: number; byPid: ReadonlyMap<number, Proc> } | null,
): SessionStatus {
  if (entry.pid !== null && procs && procs.at > entry.startedAt) {
    const proc = procs.byPid.get(entry.pid)
    if (!proc || !isEngineName(proc.name)) return 'gone'
  }
  return now - entry.updatedAt > STALE_MS ? 'stale' : 'live'
}

/** Whether a registry file should be removed by this tick's garbage collection. */
export function isCollectable(entry: RegistryEntry | null, status: SessionStatus | null, now: number, mtimeMs: number): boolean {
  if (entry === null) return now - mtimeMs > GC_MS
  if (now - entry.updatedAt > MAX_AGE_MS) return true
  return status === 'gone' && now - entry.updatedAt > GC_MS
}

/** A registry entry as a drawable row. */
export function rowOf(entry: RegistryEntry, status: SessionStatus, now: number, thisId: string): SessionRow {
  return {
    sessionId: entry.sessionId,
    label: entry.label,
    model: entry.model,
    rssMB: entry.rssMB,
    contextPercent: entry.contextPercent,
    rateLimitPercent: entry.rateLimitPercent,
    agents: entry.agents,
    idleMinutes: entry.lastActivityAt > 0 ? Math.max(0, Math.floor((now - entry.lastActivityAt) / 60_000)) : null,
    status,
    isThis: entry.sessionId === thisId,
    hasMod: true,
  }
}

/** What the engine's own session record (~/.claude/sessions/<pid>.json) says that the pane can use. */
export type EngineSession = { sessionId: string; label: string; idleMinutes: number | null }

/**
 * The engine's record of a running session, written by the CLI itself for
 * every session (mod or not): its id, its name (or the folder it runs in)
 * and when it last changed. Null for a torn or foreign file, or one that is
 * not about `pid`. Every text is cleaned to one line.
 */
export function decodeEngineSession(text: string, pid: number, now: number): EngineSession | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o['pid'] !== pid) return null
  const id = typeof o['sessionId'] === 'string' && isSessionId(o['sessionId']) ? o['sessionId'] : `engine-${pid}`
  const name = typeof o['name'] === 'string' ? oneLine(o['name'].slice(0, 1024), 100) : ''
  const cwd = typeof o['cwd'] === 'string' ? oneLine(basename(o['cwd'].slice(0, 4096)), 100) : ''
  const updatedAt = isNum(o['updatedAt']) ? o['updatedAt'] : null
  return {
    sessionId: id,
    label: name || cwd || `claude (pid ${pid})`,
    idleMinutes: updatedAt === null ? null : Math.max(0, Math.floor((now - updatedAt) / 60_000)),
  }
}

/** A row for a session that does not run mem-gauge, from the engine's record and its process tree. */
export function engineRow(pid: number, rssMB: number, session: EngineSession): SessionRow {
  return {
    sessionId: session.sessionId,
    label: session.label,
    model: '',
    rssMB,
    contextPercent: null,
    rateLimitPercent: null,
    agents: 0,
    idleMinutes: session.idleMinutes,
    status: 'live',
    isThis: false,
    hasMod: false,
  }
}

/** Live first by RSS (largest first), then stale, then gone. */
export function sortRows(rows: readonly SessionRow[]): SessionRow[] {
  const rank: Record<SessionStatus, number> = { live: 0, stale: 1, gone: 2 }
  return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || (b.rssMB ?? -1) - (a.rssMB ?? -1))
}

/** The used-memory quintile as a ring glyph: ○ ◔ ◑ ◕ ●. */
export function glyph(usedPercent: number | null): string {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return '?'
  const rings = ['○', '◔', '◑', '◕', '●']
  return rings[Math.min(4, Math.max(0, Math.floor(usedPercent / 20)))]!
}

/** "1.8 GB" from 1.0 GB up, "512 MB" below. */
export function formatMB(mb: number | null): string {
  if (mb === null || !Number.isFinite(mb)) return '?'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export const formatBytes = (bytes: number | null): string => formatMB(bytes === null ? null : bytes / MB)

const isAlarm = (p: Pressure) => p === 'warn' || p === 'critical'

/** "✓" when memory pressure is fine, "! warn" / "! critical" under pressure, "?" when unread. */
export function pressureText(p: Pressure): string {
  return p === 'ok' ? '✓' : p === 'unknown' ? '?' : `! ${p}`
}

/**
 * The gauge row's text in two parts: `main` ('Memory 60% · Pressure ✓ · 7 sessions',
 * "! " in front under pressure, '! Wrap requested (2.0 GB)' first when asked) and
 * `disk` ('41 GB free'), which the desktop draws behind a disk icon.
 */
export function summaryParts(snapshot: Snapshot, wrap: WrapRequest | null): { main: string; disk: string } {
  const m = snapshot.machine
  const live = snapshot.sessions.filter(s => s.status === 'live').length
  const parts = [
    `${isAlarm(m.pressure) ? '! ' : ''}Memory ${m.usedPercent === null ? '--' : `${Math.round(m.usedPercent)}%`}`,
    `Pressure ${pressureText(m.pressure)}`,
    `${live} session${live === 1 ? '' : 's'}`,
  ]
  if (wrap) parts.unshift(`! Wrap requested (${wrap.freesMB === null ? '?' : formatMB(wrap.freesMB)})`)
  return { main: parts.join(' · '), disk: `${formatBytes(m.diskFreeBytes)} free` }
}

/** The one-line form (terminal row and the optional status line): 'Memory 60% · Pressure ✓ · 7 sessions · Disk 41 GB free'. */
export function statusLine(snapshot: Snapshot, wrap: WrapRequest | null): string {
  const { main, disk } = summaryParts(snapshot, wrap)
  return `${main} · Disk ${disk}`
}

/** "901 GB" from 10 GB up, "9.5 GB" below, "512 MB" under 1 GB; "--" unread. The footer is narrow. */
export function formatCompact(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '--'
  const gb = bytes / (1024 * MB)
  if (gb >= 10) return `${Math.round(gb)} GB`
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / MB)} MB`
}

/**
 * The desktop footer row, kept short because the mode strip clips what does
 * not fit: the used percent, the free disk space, and whether something needs
 * attention (pressure, or a wrap request). Pressure itself is read in the pane.
 */
export function footerParts(snapshot: Snapshot, wrap: WrapRequest | null): { used: string; disk: string; diskPct: string; alarm: boolean } {
  const m = snapshot.machine
  const full = m.diskTotalBytes !== null && m.diskFreeBytes !== null && m.diskTotalBytes > 0
    ? `${Math.round((100 * (m.diskTotalBytes - m.diskFreeBytes)) / m.diskTotalBytes)}%`
    : '--'
  return {
    used: m.usedPercent === null ? '--' : `${Math.round(m.usedPercent)}%`,
    disk: formatCompact(m.diskFreeBytes),
    // The disk's fullness, for the one-chip footer: the same reading as the memory percent.
    diskPct: full,
    alarm: isAlarm(m.pressure) || wrap !== null,
  }
}

/** A monochrome disk-drive icon (no script, no external refs) for the gauge row. */
export function diskSvg(size = 14): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" role="img" aria-label="Disk">` +
    `<rect x="1.5" y="4" width="13" height="8" rx="2" fill="none" stroke="${RING_TRACK}" stroke-width="1.5"/>` +
    `<circle cx="11.5" cy="8" r="1.1" fill="${RING_TRACK}"/><line x1="4" y1="8" x2="8.5" y2="8" stroke="${RING_TRACK}" stroke-width="1.5" stroke-linecap="round"/></svg>`
  )
}

/** A text gauge for surfaces with no Svg: "███████░░░░░ 62%". */
export function bar(usedPercent: number | null, width: number): string {
  const cells = Math.max(4, Math.min(40, Math.floor(width)))
  if (usedPercent === null) return `${'░'.repeat(cells)} --`
  const filled = Math.round((Math.min(100, Math.max(0, usedPercent)) / 100) * cells)
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${Math.round(usedPercent)}%`
}

/** Apple system red: the arc that fills with used memory, the same on light and dark. */
const RING_RED = '#FF3B30'
const RING_TRACK = '#8E8E93'

/**
 * A gauge icon: a muted track, a red arc that fills clockwise from twelve with
 * used percent, and the percent centered inside, as an SVG document (no
 * script, no external refs). `size` is the drawn box in CSS pixels; the type
 * scales up for the small icon under the prompt so "60%" stays legible.
 */
export function ringSvg(usedPercent: number | null, pressure: Pressure, size = 88, withLabel = true, title?: string): string {
  const pct = usedPercent === null ? 0 : Math.min(100, Math.max(0, usedPercent))
  const r = 15.915 // circumference 100, so the dash array is the percent
  const label = usedPercent === null ? '--' : `${Math.round(usedPercent)}%`
  const small = size <= 40
  const stroke = small ? 4.2 : 3.4
  const font = small ? (label.length > 3 ? 9.5 : 10.5) : 8
  const y = small ? 21.7 : 20.8
  const label2 = title ?? `Memory ${label} used, pressure ${pressure}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="${size}" height="${size}" role="img" aria-label="${label2}">` +
    `<circle cx="18" cy="18" r="${r}" fill="none" stroke="${RING_TRACK}" stroke-opacity="0.28" stroke-width="${stroke}"/>` +
    `<circle cx="18" cy="18" r="${r}" fill="none" stroke="${RING_RED}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-dasharray="${pct.toFixed(1)} ${(100 - pct).toFixed(1)}" transform="rotate(-90 18 18)"/>` +
    (withLabel
      ? `<text x="18" y="${y}" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" ` +
        `font-size="${font}" font-weight="700" fill="${RING_TRACK}">${label}</text>`
      : '') +
    '</svg>'
  )
}

/** Pads or cuts `text` to exactly `width` columns (with an ellipsis when cut). */
export function fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return ''
  const chars = [...text]
  if (chars.length > width) return width === 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`
  const pad = ' '.repeat(width - chars.length)
  return align === 'left' ? text + pad : pad + text
}

/** machine.json: one collector's reading, shared so N sessions do not each run vm_stat, df and ps. */
export type MachineFile = { v: 1; at: number; stats: MachineStats; procs: Proc[] | null }

type ProcTuple = [number, number, number, string, string]

export function encodeMachine(file: MachineFile): string {
  const procs = file.procs?.map((p): ProcTuple => [p.pid, p.ppid, p.rssKB, p.name, p.app]) ?? null
  return JSON.stringify({ v: 1, at: file.at, stats: file.stats, procs })
}

const PRESSURES: readonly Pressure[] = ['ok', 'warn', 'critical', 'unknown']

/** machine.json back, every field checked; null for a half-written or foreign file. */
export function decodeMachine(text: string): MachineFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const s = o['stats'] as Record<string, unknown> | null
  if (o['v'] !== 1 || !isNum(o['at']) || !s || typeof s !== 'object') return null
  const pressure = PRESSURES.includes(s['pressure'] as Pressure) ? (s['pressure'] as Pressure) : 'unknown'
  const stats: MachineStats = {
    at: o['at'],
    totalBytes: numOrNull(s['totalBytes']),
    cores: numOrNull(s['cores']),
    usedBytes: numOrNull(s['usedBytes']),
    freeBytes: numOrNull(s['freeBytes']),
    compressedBytes: numOrNull(s['compressedBytes']),
    usedPercent: numOrNull(s['usedPercent']),
    pressure,
    swapUsedBytes: numOrNull(s['swapUsedBytes']),
    swapTotalBytes: numOrNull(s['swapTotalBytes']),
    load1: numOrNull(s['load1']),
    diskFreeBytes: numOrNull(s['diskFreeBytes']),
    diskTotalBytes: numOrNull(s['diskTotalBytes']),
  }
  let procs: Proc[] | null = null
  if (Array.isArray(o['procs'])) {
    procs = []
    for (const t of o['procs'] as unknown[]) {
      if (!Array.isArray(t) || t.length !== 5) return null
      const [pid, ppid, rssKB, name, app] = t as unknown[]
      if (!isNum(pid) || !isNum(ppid) || !isNum(rssKB) || typeof name !== 'string' || typeof app !== 'string') return null
      // Another session wrote this file: names are cleaned as if ps had just printed them.
      procs.push({ pid, ppid, rssKB, name: oneLine(name.slice(0, 1024), 256), app: oneLine(app.slice(0, 1024), 120) })
    }
  }
  return { v: 1, at: o['at'], stats, procs }
}

/** A wrap request file another session wrote for this one. */
export function decodeWrapRequest(text: string): WrapRequest | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (!o || typeof o !== 'object' || !isNum(o['at'])) return null
    // Another session wrote this file: a figure out of range is dropped, not drawn.
    const frees = numOrNull(o['freesMB'])
    return { at: o['at'], freesMB: frees !== null && frees >= 0 && frees < 16 * 1024 * 1024 ? frees : null }
  } catch {
    return null
  }
}

/** The model id without the vendor prefix, for narrow columns: "fable-5-1". */
export const shortModel = (model: string): string => model.replace(/^claude-/, '') || '?'

/** A git branch name safe to draw: printable, one line, bounded. */
export const cleanBranch = (text: string): string | null => {
  const line = text.trim().split('\n')[0] ?? ''
  return /^[\x21-\x7e]{1,100}$/.test(line) ? line : null
}
