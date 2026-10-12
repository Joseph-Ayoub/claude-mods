// Test support only (imported by the *.test.ts files, never by register.tsx):
// an in-memory filesystem with the POSIX semantics the lane protocol relies
// on (mkdir without -p fails on an existing path, mv is a rename that fails
// when the source is gone and moves INTO an existing directory, rm -rf,
// touch never creates a parent), and a LaneIO over it. `installHost` stands
// the same filesystem, plus git, gh, the session and the UI, beneath a kit
// test's plugin through the test's own `on`, so register.tsx runs end to end
// against it.

import type { On } from 'claude-code'

import type { Delivery, LaneIO, ListedEntry, MkdirResult } from './lane'

type Entry = { kind: 'dir'; mtime: number } | { kind: 'file'; text: string; mtime: number }

export class MemFs {
  readonly entries = new Map<string, Entry>()

  constructor(readonly now: () => number) {
    this.entries.set('/', { kind: 'dir', mtime: now() })
  }

  private parentOf(path: string): string {
    const cut = path.lastIndexOf('/')
    return cut <= 0 ? '/' : path.slice(0, cut)
  }

  private bump(path: string): void {
    const parent = this.entries.get(this.parentOf(path))
    if (parent?.kind === 'dir') parent.mtime = this.now()
  }

  isDir(path: string): boolean {
    return this.entries.get(path)?.kind === 'dir'
  }

  has(path: string): boolean {
    return this.entries.has(path)
  }

  /** `mkdir <path>`: exit 0, or 1 with the message mkdir prints. */
  mkdir(path: string): { code: number; stderr: string } {
    if (this.entries.has(path)) return { code: 1, stderr: `mkdir: ${path}: File exists` }
    if (!this.isDir(this.parentOf(path))) return { code: 1, stderr: `mkdir: ${path}: No such file or directory` }
    this.entries.set(path, { kind: 'dir', mtime: this.now() })
    this.bump(path)
    return { code: 0, stderr: '' }
  }

  mkdirp(path: string): void {
    const parts = path.split('/').filter(part => part !== '')
    let at = ''
    for (const part of parts) {
      at = `${at}/${part}`
      if (!this.entries.has(at)) {
        this.entries.set(at, { kind: 'dir', mtime: this.now() })
        this.bump(at)
      }
    }
  }

  /** `mv <from> <to>`: rename(2), or into `to` when it is an existing directory. */
  mv(from: string, to: string): boolean {
    if (!this.entries.has(from)) return false
    let dest = to
    if (this.isDir(to)) dest = `${to}/${from.slice(from.lastIndexOf('/') + 1)}`
    if (!this.isDir(this.parentOf(dest))) return false
    if (this.isDir(dest)) return false
    const moved = [...this.entries].filter(([path]) => path === from || path.startsWith(`${from}/`))
    for (const [path] of moved) this.entries.delete(path)
    for (const [path, entry] of moved) this.entries.set(dest + path.slice(from.length), entry)
    this.bump(from)
    this.bump(dest)
    return true
  }

  rmrf(path: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key)
    }
    this.bump(path)
  }

  touch(path: string): boolean {
    if (!this.isDir(this.parentOf(path))) return false
    const entry = this.entries.get(path)
    if (entry === undefined) {
      this.entries.set(path, { kind: 'file', text: '', mtime: this.now() })
      this.bump(path)
    } else {
      entry.mtime = this.now()
    }
    return true
  }

  read(path: string): string | undefined {
    const entry = this.entries.get(path)
    return entry?.kind === 'file' ? entry.text : undefined
  }

  /** `$.fs.write`: creates the directories, overwrites in place. */
  write(path: string, text: string): void {
    this.mkdirp(this.parentOf(path))
    const isNew = !this.entries.has(path)
    this.entries.set(path, { kind: 'file', text, mtime: this.now() })
    if (isNew) this.bump(path)
  }

  /** Sets a path's time, to age a file or directory in a test. */
  age(path: string, mtime: number): void {
    const entry = this.entries.get(path)
    if (entry !== undefined) entry.mtime = mtime
  }

  list(dir: string): ListedEntry[] | undefined {
    if (!this.isDir(dir)) return undefined
    const out: ListedEntry[] = []
    for (const [path, entry] of this.entries) {
      if (path !== dir && this.parentOf(path) === dir) {
        out.push({ name: path.slice(dir.length + 1), kind: entry.kind, mtimeMs: entry.kind === 'file' ? entry.mtime : 0 })
      }
    }
    return out
  }

  stat(path: string): { kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean } | undefined {
    const entry = this.entries.get(path)
    if (entry === undefined) return undefined
    return { kind: entry.kind, size: entry.kind === 'file' ? entry.text.length : 0, mtimeMs: entry.mtime, isLink: false }
  }
}

/** A LaneIO over a MemFs for one session; `deliver` says whether a session id is running. */
export function memIO(fs: MemFs, deliver: (sessionId: string) => Delivery, sent: string[] = []): LaneIO {
  let counter = 0
  return {
    now: async () => fs.now(),
    uuid: () => `u${(counter += 1)}-${Math.random().toString(16).slice(2, 10)}`,
    async mkdir(path): Promise<MkdirResult> {
      const made = fs.mkdir(path)
      if (made.code === 0) return 'created'
      return /File exists/.test(made.stderr) ? 'exists' : 'error'
    },
    async mkdirp(paths) {
      for (const path of paths) fs.mkdirp(path)
      return true
    },
    rename: async (from, to) => fs.mv(from, to),
    async remove(paths) {
      for (const path of paths) fs.rmrf(path)
    },
    touch: async path => fs.touch(path),
    read: async path => fs.read(path),
    async write(path, text) {
      fs.write(path, text)
    },
    list: async dir => fs.list(dir) ?? [],
    mtime: async path => fs.stat(path)?.mtimeMs,
    async send(sessionId, text) {
      sent.push(`${sessionId} ${text}`)
      return deliver(sessionId)
    },
  }
}

/** What the fake host answers beneath the plugin in a kit test; every field may change mid-test. */
export type Host = {
  fs: MemFs
  /** What `$.session.id()` answers: change it to play a /clear. */
  sessionId: string
  /** The origin remote `$.session.repo()` answers; null for a repo without one. */
  remote: string | null
  /** `$.session.repo()` throws, to reach the gate's .catch. */
  isRepoBroken: boolean
  /** `mkdir -p` fails, as when ~/.claude is not writable. */
  isMkdirpBroken: boolean
  cwd: string
  branch: string
  /** Session ids a `$.session.send` reaches (the engine's isDelivered). */
  live: Set<string>
  sent: { to: string; text: string }[]
  /** Every argv the plugin ran, in order. */
  runs: string[][]
  statuses: (string | undefined)[]
  toasts: string[]
  /** `$.ui.log` lines (debug and transcript alike). */
  logs: string[]
  prompts: string[]
  /** Whether each prompt went in as the person's own words (its origin's asUser), index for index with prompts. */
  promptsAsUser: boolean[]
  commands: { name: string; immediate?: boolean }[]
  /** Bash commands that got past every plugin to the tool. */
  ran: string[]
  /** session.receive texts that got past every plugin (reached the model). */
  received: string[]
  asks: number
  gh: (args: readonly string[]) => { exitCode: number; stdout: string }
  /** The Bash tool's answer to a command that ran. */
  bash: (command: string) => unknown
}

export function newHost(fs: MemFs, sessionId: string, remote: string | null): Host {
  return {
    fs,
    sessionId,
    remote,
    isRepoBroken: false,
    isMkdirpBroken: false,
    cwd: '/work/repo',
    branch: 'feature-x',
    live: new Set(),
    sent: [],
    runs: [],
    statuses: [],
    toasts: [],
    logs: [],
    prompts: [],
    promptsAsUser: [],
    commands: [],
    ran: [],
    received: [],
    asks: 0,
    gh: () => ({ exitCode: 1, stdout: '' }),
    bash: () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }),
  }
}

/** Registers the host's answers on a kit test's `on`, beneath every plugin. */
export function installHost(on: On, host: Host): void {
  // A call on `$` is answered `{ value }`, or refused `{ deny }` (the caller's promise rejects).
  const exited = (exitCode: number, stdout: string, stderr: string) => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })
  const ok = (stdout = '') => exited(0, stdout, '')
  const fail = (stderr = '') => exited(1, '', stderr)
  const missing = (path: string) => ({ deny: `ENOENT: ${path}` })

  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    host.runs.push(argv)
    const [command, ...args] = argv
    const fs = host.fs
    if (command === 'mkdir' && args[0] === '-p') {
      if (host.isMkdirpBroken) return fail('mkdir: Permission denied')
      for (const path of args.slice(1)) fs.mkdirp(path)
      return ok()
    }
    if (command === 'mkdir') {
      const made = fs.mkdir(args[0] ?? '')
      return made.code === 0 ? ok() : fail(made.stderr)
    }
    if (command === 'mv') return fs.mv(args[0] ?? '', args[1] ?? '') ? ok() : fail('mv: No such file or directory')
    if (command === 'rm') {
      for (const path of args.filter(arg => !arg.startsWith('-'))) fs.rmrf(path)
      return ok()
    }
    if (command === 'touch') return fs.touch(args[0] ?? '') ? ok() : fail('touch: No such file or directory')
    if (command === 'git' && args.includes('rev-parse')) return ok(`${host.branch}\n`)
    if (command === 'git' && args.includes('get-url')) return host.remote === null ? fail() : ok(`${host.remote}\n`)
    if (command === 'gh') {
      const answer = host.gh(args)
      return exited(answer.exitCode, answer.stdout, '')
    }
    return exited(127, '', `${command ?? ''}: not found`)
  })
  on('fs.read', async (_$, e) => {
    const text = host.fs.read(e.path)
    return text === undefined ? missing(e.path) : { value: text }
  })
  on('fs.write', async (_$, e) => {
    host.fs.write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    const listed = host.fs.list(e.path)
    if (listed === undefined) return missing(e.path)
    const value = listed.map(entry => ({
      name: entry.name,
      kind: entry.kind === 'dir' ? ('dir' as const) : ('file' as const),
      size: 0,
      mtimeMs: entry.mtimeMs,
      isLink: false,
    }))
    return { value }
  })
  on('fs.stat', async (_$, e) => {
    const stat = host.fs.stat(e.path)
    return stat === undefined ? missing(e.path) : { value: stat }
  })
  on('fs.exists', async (_$, e) => ({ value: host.fs.has(e.path) }))
  on('session.id', async () => ({ value: host.sessionId }))
  on('session.cwd', async () => ({ value: host.cwd }))
  on('session.repo', async () => {
    if (host.isRepoBroken) return { deny: 'repo lookup failed' }
    return { value: { root: '/work/repo', remote: host.remote, internal: false, name: 'repo' } }
  })
  on('session.send', async (_$, e) => {
    const to = String(e.to)
    host.sent.push({ to, text: e.text })
    return host.live.has(to) ? { isDelivered: true as const } : { isDelivered: false as const, reason: 'not running' }
  })
  on('command.register', async (_$, e) => {
    host.commands.push({ name: e.name, immediate: e.immediate })
    return { value: { command: e.name } }
  })
  on('ui.status', async (_$, e) => {
    host.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async (_$, e) => {
    host.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    host.prompts.push(e.text)
    host.promptsAsUser.push((e.origin as { asUser?: boolean } | undefined)?.asUser === true)
    return { text: e.text } as never
  })
  on('tool.call', async (_$, e) => {
    if (String(e.tool) === 'AskUserQuestion') {
      // the person dismisses the dialog
      host.asks += 1
      return { deny: 'dismissed' }
    }
    const command = String((e as { command?: unknown }).command ?? '')
    host.ran.push(command)
    return host.bash(command) as never
  })
  on('session.receive', async (_$, e) => {
    host.received.push(e.text)
    return { text: e.text }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
}
