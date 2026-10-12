// rd-ledger: the shared fake engine beneath the plugin for every kit test
// (SPEC §11, panel TES-7). Lead-owned. It stands in for the file system (a
// Map, with `mv` as a rename, `mkdir`/`rmdir` as a lock, `rm -f`, stat with
// links, the 4 MiB read cap), the processes (every argv recorded and held to
// the allowlist), the session, the display and the clock. Fault knobs let a
// test tear a write, fail an `mv`, refuse the file system, or hold an `mv`.
//
// Import it from a *.test.ts beside the modules:
//   import { world, type World } from './testing/world'

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const HOME = '/Users/tester'
export const STORE = `${HOME}/.claude/rd-ledger`
export const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
export const SID2 = '22222222-aaaa-4bbb-8ccc-000000000002'
export const SID3 = '33333333-aaaa-4bbb-8ccc-000000000003'
/** 2026-10-11T13:00:00Z: Sunday 09:00 in New York (the ground-truth fixture's first event). */
export const T0 = 1_791_723_600_000
export const RDT_REPO = '/Users/tester/rd-tracker'
export const PYTHON = `${RDT_REPO}/.venv/bin/python`
export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(['/bin/mv', '/bin/rm', '/bin/mkdir', '/bin/rmdir', '/usr/bin/git', PYTHON])
export const FOUR_MIB = 4 * 1024 * 1024

export type WorldOptions = {
  files?: Record<string, string>
  /** Directories that exist without files (a symlinked store is `links`). */
  dirs?: string[]
  /** mtimeMs for directories (default 0 = unknown age), e.g. a stale lock folder. */
  dirMtimes?: Record<string, number>
  /** Paths that stat as symbolic links (write and mv must refuse them). */
  links?: string[]
  /** Every fs call is refused, as a hostile guard plugin or a sandbox would. */
  fsRefused?: boolean
  /** `fs.write` stores only the first half of the text (a torn write). */
  tearWrite?: boolean
  /** `/bin/mv` exits with this code instead of renaming. */
  mvExit?: number
  /** Called before each `mv` is applied, so a test can land another writer between stat and rename. */
  injectBeforeMv?: (files: Map<string, Stored>) => void
  /** The next N process spawns reject (cannot start). */
  processRejects?: number
  /** `python -m rdt add` answers this stdout and exit code (or rejects when `rdtRejects`). */
  rdtAdd?: { stdout: string; exitCode: number }
  rdtRejects?: boolean
  /** `python -m rdt review --json` stdout. */
  rdtReview?: string
  /** `python -I -c <program>` stdout (the registry import). */
  rdtImport?: string
  /** `git rev-parse --abbrev-ref HEAD` stdout. */
  branch?: string
  isPlaced?: boolean
  /** The answer every `$.ui.ask` gets; absent → the first option. `dismissed` rejects. */
  answer?: string
  isDismissed?: boolean
  /** A plain -p run: nothing draws. */
  isHeadless?: boolean
  surfaces?: readonly ('terminal' | 'desktop' | 'mobile' | 'vscode')[]
  sessionId?: string
  cwd?: string
  /** `$.session.repo()`; null for a directory outside any repository. */
  repoRoot?: string | null
  model?: string
  entrypoint?: string | null
  tz?: string | null
  costUsd?: number | null
  usageRefused?: boolean
  /** What `$.agent.list()` answers (default: one `builder` agent `sub-1` whose description is a sentinel-free task line). */
  agents?: readonly { id: string; type: string; status: 'running' | 'completed'; description: string }[]
  /** `$.agent.list()` rejects. */
  agentListRefused?: boolean
}

/** The usage every kit model request reports: the main loop's, and a subagent's. */
export const STEP_MAIN = { model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 20_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 }
export const STEP_AGENT = { model: 'claude-sonnet-5-5', input_tokens: 5_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000 }

export type Stored = { text: string; mtimeMs: number; size: number }

export function world(on: On, options: WorldOptions = {}) {
  const files = new Map<string, Stored>()
  const dirs = new Set<string>(options.dirs ?? [])
  const dirMtimes: Record<string, number> = options.dirMtimes ?? {}
  options.dirMtimes = dirMtimes
  const links = new Set<string>(options.links ?? [])
  const clock = mock.clock(on, { now: T0 })
  const seen = {
    files,
    dirs,
    /** mtimeMs per directory (0 or absent = unknown age); a test edits it to age or refresh a lock folder. */
    dirMtimes,
    argv: [] as string[][],
    stdin: [] as string[],
    toasts: [] as string[],
    logs: [] as string[],
    statuses: [] as (string | undefined)[],
    opened: [] as string[],
    /** Every `$.ui.open` in order, with whether it asked for the keyboard. */
    openArgs: [] as { id: string; title: string | undefined; focus: boolean }[],
    /** `$.agent.list()` calls, model requests answered, Edit/Write/NotebookEdit calls run beneath. */
    agentLists: 0,
    steps: 0,
    edits: 0,
    closed: [] as string[],
    asked: [] as string[],
    registered: [] as string[],
    stateSets: [] as unknown[],
    clock,
    sessionId: options.sessionId ?? SID,
    /** Order of the session.end steps beneath: core's end and the mv. */
    order: [] as string[],
    /** While set, every `mv` waits on it: a flush held in flight. */
    hold: null as Promise<void> | null,
    disallowed: [] as string[],
  }
  for (const [path, text] of Object.entries(options.files ?? {})) files.set(path, { text, mtimeMs: T0 - 1000, size: new TextEncoder().encode(text).length })
  const env: Record<string, string> = { HOME }
  if (options.entrypoint !== null) env['CLAUDE_CODE_ENTRYPOINT'] = options.entrypoint ?? 'claude-desktop'
  if (options.tz) env['TZ'] = options.tz
  mock.env(on, env)
  const refuse = { deny: 'refused in this test' }
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const dirExists = (p: string) => dirs.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)) || [...dirs].some(d => d.startsWith(`${p}/`))

  on('fs.read', (_$, e) => {
    if (options.fsRefused) return refuse
    const f = files.get(e.path)
    if (!f) return { deny: 'ENOENT' }
    if (f.size > FOUR_MIB) return { deny: 'file too large' }
    return { value: f.text }
  })
  on('fs.write', (_$, e) => {
    if (options.fsRefused) return refuse
    if (links.has(e.path)) return { deny: 'EISLINK' } // a write through a link is refused by the kit world so a test can prove the plugin never relies on it
    const text = options.tearWrite ? e.text.slice(0, Math.floor(e.text.length / 2)) : e.text
    files.set(e.path, { text, mtimeMs: clock.now(), size: new TextEncoder().encode(text).length })
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    if (options.fsRefused) return refuse
    const path = (e.path ?? '').replace(/\/$/, '')
    const prefix = `${path}/`
    const names = new Map<string, { name: string; kind: 'file' | 'directory' | 'other'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [p, f] of files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) names.set(rest, { name: rest, kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: links.has(p) })
      else names.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'directory', size: 0, mtimeMs: 0, isLink: links.has(`${prefix}${rest.slice(0, slash)}`) })
    }
    for (const d of dirs) {
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      const head = rest.split('/')[0] as string
      if (!names.has(head)) names.set(head, { name: head, kind: 'directory', size: 0, mtimeMs: 0, isLink: links.has(`${prefix}${head}`) })
    }
    if (names.size === 0 && !dirExists(path)) return { deny: 'ENOENT' }
    return { value: [...names.values()] }
  })
  on('fs.exists', (_$, e) => {
    if (options.fsRefused) return refuse
    return { value: files.has(e.path) || dirExists(e.path) || links.has(e.path) }
  })
  on('fs.stat', (_$, e) => {
    if (options.fsRefused) return refuse
    const f = files.get(e.path)
    const isLink = links.has(e.path)
    if (f) return { value: { kind: 'file' as const, size: f.size, mtimeMs: f.mtimeMs, isLink, ...(e.options?.resolve ? { realPath: e.path } : {}) } }
    if (dirExists(e.path) || isLink) return { value: { kind: isLink ? ('other' as const) : ('directory' as const), size: 0, mtimeMs: options.dirMtimes?.[e.path] ?? 0, isLink, ...(e.options?.resolve ? { realPath: e.path } : {}) } }
    return { deny: 'ENOENT' }
  })

  let rejectsLeft = options.processRejects ?? 0
  on('process.run', async (_$, e) => {
    seen.argv.push([...e.argv])
    if (e.init?.stdin) seen.stdin.push(String(e.init.stdin))
    const [cmd, ...args] = e.argv
    if (!cmd || !ALLOWED_EXECUTABLES.has(cmd)) seen.disallowed.push(cmd ?? '')
    if (rejectsLeft > 0) {
      rejectsLeft -= 1
      return { deny: 'cannot start' }
    }
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === '/bin/mv') {
      if (seen.hold) await seen.hold
      const from = args[args.length - 2] ?? ''
      const to = args[args.length - 1] ?? ''
      if (options.mvExit) return ok('', options.mvExit)
      options.injectBeforeMv?.(files)
      const f = files.get(from)
      if (!f) return ok('', 1)
      files.delete(from)
      files.set(to, { ...f, mtimeMs: clock.now() })
      seen.order.push('mv')
      return ok('')
    }
    if (cmd === '/bin/rm') {
      files.delete(args[args.length - 1] ?? '')
      return ok('')
    }
    if (cmd === '/bin/mkdir') {
      const d = args[args.length - 1] ?? ''
      if (dirs.has(d)) return ok('', 1)
      dirs.add(d)
      if (options.dirMtimes) delete options.dirMtimes[d]
      return ok('')
    }
    if (cmd === '/bin/rmdir') {
      dirs.delete(args[args.length - 1] ?? '')
      return ok('')
    }
    if (cmd === '/usr/bin/git') return ok(`${options.branch ?? 'claude/x'}\n`)
    if (cmd === PYTHON) {
      if (args.includes('add')) {
        if (options.rdtRejects) return { deny: 'timeout' }
        return ok(options.rdtAdd?.stdout ?? `rdt add: manual entry 12 — 1.5h on 2026-10-11 [contemporaneous, lag 0d]\n`, options.rdtAdd?.exitCode ?? 0)
      }
      if (args.includes('review')) return ok(options.rdtReview ?? '{}')
      if (args.includes('-c')) return ok(options.rdtImport ?? '{"entities":{},"components":{}}')
      return ok('', 2)
    }
    return ok('', 127)
  })

  on('session.id', () => ({ value: seen.sessionId }))
  on('session.surfaces', () => ({ value: options.isHeadless ? [] : (options.surfaces ?? (['desktop'] as const)) }))
  on('session.cwd', () => ({ value: options.cwd ?? `${HOME}/shop` }))
  on('session.repo', () => ({ value: options.repoRoot === null ? null : { root: options.repoRoot ?? `${HOME}/shop`, remote: null, internal: false, name: null } }))
  on('session.model', () => ({ value: options.model ?? 'claude-fable-5-1' }))
  on('session.usage', () => (options.usageRefused ? refuse : {
    value: { startedAt: T0 - 60_000, context: { window: 1_000_000, percent: 10 }, rateLimits: [], ...(options.costUsd === null ? {} : { cost: { usd: options.costUsd ?? 1.25 } }) },
  }) as never)
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  // The panes this plugin has open, as $.ui.panes() answers them.
  const openIds = new Set<string>()
  on('ui.panes', () => ({ value: [...openIds].map(id => ({ id, title: id, isShown: false, isFocused: false, isPlaced: true })) }) as never)
  on('ui.open', (_$, e) => {
    if (options.isPlaced !== false) openIds.add(e.id)
    seen.opened.push(e.id)
    seen.openArgs.push({ id: e.id, title: e.title, focus: e.focus === true })
    return { value: options.isPlaced === false ? { isPlaced: false as const, reason: 'no surface' } : { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    if (typeof e.id === 'string') openIds.delete(e.id)
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('state.set', (_$, e, next) => {
    seen.stateSets.push(e.value)
    return next(e)
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0]
    const question = q?.question ?? ''
    seen.asked.push(question)
    if (options.isDismissed) return { deny: 'dismissed' } as never
    const first = q?.options?.[0]?.label ?? ''
    return { result: { questions: e.questions, answers: { [question]: options.answer ?? first } } } as never
  })
  on('agent.list', () => {
    seen.agentLists += 1
    if (options.agentListRefused) return refuse as never
    return { value: options.agents ?? [{ id: 'sub-1', type: 'builder', status: 'running' as const, description: 'build the thing' }] } as never
  })
  // The model: every request answers one stop chunk and a result with usage.
  on('turn.step', async function* (_$, e) {
    seen.steps += 1
    const usage = e.agentId ? STEP_AGENT : STEP_MAIN
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  // The edit tools: the first call applies a 3-added / 1-removed patch; every later one is refused.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, () => {
    seen.edits += 1
    if (seen.edits > 1) return { deny: 'refused by the person' } as never
    return {
      result: {
        filePath: `${HOME}/shop/secret-path-a.ts`,
        oldString: 'b',
        newString: 'c',
        originalFile: 'a\nb\n',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, lines: [' a', '-b', '+c', '+d', '+e'] }],
        userModified: false,
        replaceAll: false,
      },
    } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => {
    seen.order.push('core-end')
    return { sessionId: e.sessionId }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('ui.render', { component: 'SessionMode' }, () => ({ type: 'engine' as const, ref: 0 }))
  return Object.assign(seen, { session: mock.session(on) })
}

export type World = ReturnType<typeof world>

/** Lets queued work run for `n` microtask turns (no host timers in the hook runtime). */
export async function yieldTurns(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}

/** Every text the plugin produced that a sentinel must be absent from: files, argv, stdin, toasts, logs, state. */
export const corpus = (w: World): string =>
  [
    ...[...w.files.entries()].map(([p, f]) => `${p}\n${f.text}`),
    ...w.argv.map(a => a.join(' ')),
    ...w.stdin,
    ...w.toasts,
    ...w.logs,
    ...w.statuses.map(s => s ?? ''),
    ...w.stateSets.map(v => JSON.stringify(v)),
  ].join('\n')

/** The kit's Pane props for the rd-ledger pane. */
export const PANE = {
  component: 'Pane' as const,
  requestId: 'rd-ledger',
  props: { title: 'R&D ledger', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}
export const HINT = { component: 'PromptHint' as const, props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }
export const MODE = { component: 'SessionMode' as const, props: { modes: ['focus'] } }
