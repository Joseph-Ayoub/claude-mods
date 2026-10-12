// merge-lane's pure core: every decision the mod makes, with no I/O.
//
// The lane protocol (lane.ts) and the hooks (register.tsx) gather facts from
// disk and the session, then ask these functions what to do. Keeping the
// decisions here means the rules the feasibility review pinned down (queue
// order, the gate's verdict, the envelope check, the liveness rule, the
// tombstone check after a lock break) are tested as plain functions.

import type { LaneQueueEntry } from '../types'

/** Every cross-session message this mod sends starts with this; nothing else does. */
export const ENVELOPE_PREFIX = 'merge-lane/v1 '

/** An alive file touched more recently than this proves its session is ticking. */
export const ALIVE_FRESH_MS = 2 * 60_000

/** The queue head breaks a stale holder by itself only this long after it turned stale. */
export const AUTO_BREAK_EXTRA_MS = 5 * 60_000

/** Session ids become file names: anything else is refused before a path is built. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

export type QueueEntry = LaneQueueEntry

/** What holder/holder.json says about the session that holds the lane. */
export type HolderRecord = {
  sessionId: string
  label: string
  pr: string | null
  since: number
  /** True when the gate took the lane for one merge, not a /lane request. */
  implicit: boolean
  repo: string
  takenFrom?: string
  /** When the holder last ran a merge command through the gate. */
  attemptAt?: number
}

/**
 * The holder as read from disk. A lock directory whose holder.json is missing
 * or unreadable is still held (it was just made, or its writer died between
 * mkdir and the write): `record` is null and its age comes from the directory.
 */
export type HolderView =
  | { kind: 'free' }
  | { kind: 'held'; record: HolderRecord | null; heartbeatAt: number; dirMtime: number }

/* ------------------------------------------------------------------------ */
/* Repo key                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Normalizes a git remote so every clone of one repository names one lane:
 * `git@github.com:Owner/Repo.git`, `ssh://git@github.com:22/owner/repo` and
 * `https://user:token@github.com/owner/repo/` all become
 * `github.com/owner/repo`. Userinfo (which can carry a token) is always
 * dropped, so the result is safe to show. Null for an empty remote.
 */
export function normalizeRemote(remote: string): string | null {
  let s = remote.trim()
  if (s === '') return null
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)
  if (scheme) {
    s = s.slice(scheme[0].length)
  } else if (!/^[a-z]:[\\/]/i.test(s)) {
    // scp-like `[user@]host:path` (a Windows drive letter is not a host)
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.*)$/.exec(s)
    if (scp) s = `${scp[1]}/${scp[2]}`
  }
  // userinfo runs to the authority's last `@`: a raw `@` inside a password must not leave a fragment behind
  const slash = s.indexOf('/')
  const at = s.lastIndexOf('@', slash === -1 ? s.length : slash)
  if (at !== -1) s = s.slice(at + 1)
  s = s.replace(/^([^/:]+):\d+(?=\/|$)/, '$1') // port
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  s = s.replace(/\/{2,}/g, '/').toLowerCase()
  return s === '' ? null : s
}

/**
 * Turns a repository named in a command (`-R owner/repo`, `HOST/OWNER/REPO`,
 * a URL) into the normalized form, borrowing the host from the session's own
 * remote (else github.com) when the name has none.
 */
export function normalizeNamedRepo(named: string, sessionRepo: string | null): string | null {
  const value = named.trim()
  if (value === '' || /[\s$`{}]/.test(value)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('@')) return normalizeRemote(value)
  const parts = value.replace(/\.git$/i, '').split('/').filter(part => part !== '')
  const sessionHost = sessionRepo?.split('/')[0]
  const host = sessionHost !== undefined && sessionHost.includes('.') ? sessionHost : 'github.com'
  if (parts.length === 2) return normalizeRemote(`${host}/${parts[0]}/${parts[1]}`)
  if (parts.length === 3) return normalizeRemote(parts.join('/'))
  return null
}

/** The lane's directory name: the first 16 hex characters of the SHA-256 of the normalized remote. */
export async function repoKeyOf(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

/* ------------------------------------------------------------------------ */
/* Queue order                                                               */
/* ------------------------------------------------------------------------ */

/**
 * The queue in lane order. A session someone prioritized (an overlay file,
 * written by whoever ran /lane prioritize, never the entry's own file) comes
 * first, the most recently prioritized foremost; then `--high` requests; then
 * the rest. Within a tier, first requested goes first; the session id breaks
 * ties so every session computes the same order.
 */
export function orderQueue(
  entries: readonly QueueEntry[],
  overlays: ReadonlyMap<string, number> = new Map(),
): QueueEntry[] {
  const tier = (entry: QueueEntry) =>
    overlays.has(entry.sessionId) ? 0 : entry.priority === 'high' ? 1 : 2
  return [...entries].sort((a, b) => {
    const byTier = tier(a) - tier(b)
    if (byTier !== 0) return byTier
    if (tier(a) === 0) {
      const byOverlay = (overlays.get(b.sessionId) ?? 0) - (overlays.get(a.sessionId) ?? 0)
      if (byOverlay !== 0) return byOverlay
    }
    const byTime = a.requestedAt - b.requestedAt
    if (byTime !== 0) return byTime
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
  })
}

/** Reads a queue file's text into an entry, or null when it is not one (a torn write, a stranger). */
export function parseQueueEntry(text: string | undefined, fileStem: string): QueueEntry | null {
  const value = parseJsonObject(text)
  if (value === null) return null
  const { sessionId, label, pr, priority, requestedAt, nonce, source } = value
  if (typeof sessionId !== 'string' || sessionId !== fileStem || !SESSION_ID.test(sessionId)) return null
  if (typeof nonce !== 'string' || nonce === '' || nonce.length > 100) return null
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return null
  return {
    sessionId,
    label: typeof label === 'string' ? cleanText(label, 80) : sessionId.slice(0, 8),
    pr: typeof pr === 'string' && /^\d{1,9}$/.test(pr) ? pr : null,
    priority: priority === 'high' ? 'high' : 'normal',
    requestedAt,
    nonce,
    source: source === 'gate' ? 'gate' : 'request',
  }
}

/** Reads holder.json, or null when it is missing, torn or not a holder record. */
export function parseHolderRecord(text: string | undefined): HolderRecord | null {
  const value = parseJsonObject(text)
  if (value === null) return null
  const { sessionId, label, pr, since, implicit, repo, takenFrom, attemptAt } = value
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null
  if (typeof since !== 'number' || !Number.isFinite(since)) return null
  const record: HolderRecord = {
    sessionId,
    label: typeof label === 'string' ? cleanText(label, 80) : sessionId.slice(0, 8),
    pr: typeof pr === 'string' && /^\d{1,9}$/.test(pr) ? pr : null,
    since,
    implicit: implicit === true,
    repo: typeof repo === 'string' ? cleanText(repo, 200) : '',
  }
  if (typeof takenFrom === 'string') record.takenFrom = cleanText(takenFrom, 80)
  if (typeof attemptAt === 'number' && Number.isFinite(attemptAt)) record.attemptAt = attemptAt
  return record
}

/* ------------------------------------------------------------------------ */
/* Liveness                                                                  */
/* ------------------------------------------------------------------------ */

export type Liveness = {
  now: number
  /** The holder's last heartbeat (or, for a lock with no record, its directory's time). */
  heartbeatAt: number
  /** When the holder's alive file was last touched; undefined when it has none. */
  aliveAt: number | undefined
  staleMinutes: number
}

/**
 * Whether the timestamps alone make the holder suspect. This is never enough
 * to break a lock (after a laptop sleep every timestamp is old while every
 * session is alive): the caller must also see a positive liveness failure,
 * an undelivered ping. Both the heartbeat and the alive file must be old.
 */
export function looksStale({ now, heartbeatAt, aliveAt, staleMinutes }: Liveness): boolean {
  const isBeatOld = now - heartbeatAt > staleMinutes * 60_000
  const isAliveOld = aliveAt === undefined || now - aliveAt > ALIVE_FRESH_MS
  return isBeatOld && isAliveOld
}

/**
 * Whether the queue head may break the holder by itself: stale by time, a
 * ping the engine says was not delivered (the session is not running), and
 * five more minutes past the stale mark so an operator's /lane take comes first.
 */
export function mayAutoBreak(liveness: Liveness & { isDelivered: boolean }): boolean {
  return (
    looksStale(liveness) &&
    !liveness.isDelivered &&
    liveness.now - liveness.heartbeatAt > liveness.staleMinutes * 60_000 + AUTO_BREAK_EXTRA_MS
  )
}

/** Whether a queue entry's owner is suspect enough to ping before pruning it. */
export function isEntrySuspect(now: number, aliveAt: number | undefined): boolean {
  return aliveAt === undefined || now - aliveAt > ALIVE_FRESH_MS
}

/** What a breaker judged stale: the identity it must find again in the tomb. */
export type Judged = { sessionId: string | null; since: number | null }

export function judgedOf(view: HolderView): Judged {
  if (view.kind === 'free') return { sessionId: null, since: null }
  return view.record === null
    ? { sessionId: null, since: null }
    : { sessionId: view.record.sessionId, since: view.record.since }
}

/**
 * After renaming holder/ to a tomb, the breaker keeps the tomb only when it
 * holds the very lock it judged. Anything else means a fresh holder took the
 * lane between the judgement and the rename, and the tomb goes back.
 */
export function isSameHolder(tomb: HolderRecord | null, judged: Judged): boolean {
  if (judged.sessionId === null) return tomb === null
  return tomb !== null && tomb.sessionId === judged.sessionId && tomb.since === judged.since
}

/* ------------------------------------------------------------------------ */
/* Gate                                                                      */
/* ------------------------------------------------------------------------ */

export type MergeKind = 'pr-merge' | 'api-merge' | 'graphql-merge' | 'push-main' | 'push-unknown' | 'mcp-merge'

/** A command that merges (or may push to the default branch), as the gate reads it. */
export type MergeIntent = {
  kind: MergeKind
  /** The PR number the command names, when it names one. */
  pr: string | null
  /** The repository the command names (`-R`, a URL, an API path), unnormalized. */
  repo: string | null
  /** `gh pr merge <branch>`: the branch named instead of a number. */
  branch: string | null
  /** A `cd` before it in the same command, or `git -C`: unresolved, relative or `~`. */
  dir: string | null
  /** `gh pr merge --auto`, or the GraphQL auto-merge mutation. */
  isAuto: boolean
  /** A `cd` or `git -C` target the text cannot tell (`"$DIR"`, `cd -`): any lane picked for it would be a guess. */
  isDirUnknown?: boolean
}

export type GateDecision =
  | { kind: 'pass' }
  | { kind: 'allow-holder' }
  | { kind: 'acquire' }
  | { kind: 'deny'; position: number; total: number; isFree: boolean }

/**
 * The gate's verdict over what it read. No merge intent: pass untouched. This
 * session holds the lane: allow. The lane is free and nobody waits ahead:
 * acquire, then allow. Otherwise deny, naming this session's place, counting
 * it in the queue as the gate is about to enqueue it.
 */
export function decideGate(input: {
  intent: MergeIntent | null
  selfId: string
  holder: HolderView
  queue: readonly QueueEntry[]
}): GateDecision {
  const { intent, selfId, holder, queue } = input
  if (intent === null) return { kind: 'pass' }
  if (holder.kind === 'held' && holder.record?.sessionId === selfId) return { kind: 'allow-holder' }
  const head = queue[0]
  const isFree = holder.kind === 'free'
  if (isFree && (head === undefined || head.sessionId === selfId)) return { kind: 'acquire' }
  const index = queue.findIndex(entry => entry.sessionId === selfId)
  return index === -1
    ? { kind: 'deny', position: queue.length + 1, total: queue.length + 1, isFree }
    : { kind: 'deny', position: index + 1, total: queue.length, isFree }
}

/** What happened to a merge the gate let through. */
export type MergeOutcome = 'merged' | 'failed' | 'pending' | 'unknown'

/** The parts of a tool.call result the outcome reads; every field optional. */
export type RanLike = {
  deny?: string
  isError?: boolean
  text?: string
  result?: unknown
}

type GitOperation = {
  push?: { branch?: unknown }
  pr?: { number?: unknown; action?: unknown }
}

/**
 * Reads whether the merge landed. The Bash result has no exit code, so this
 * trusts the engine's own `gitOperation` classification, never the word
 * "Merged" in the output: `merged` for the PR the lane is held for, and
 * `auto-merge-enabled` or a backgrounded command is still pending. A push that
 * did not error has landed unless git printed a rejection.
 */
export function mergeOutcome(intent: MergeIntent, ran: RanLike, holderPr: string | null): MergeOutcome {
  if (ran.deny !== undefined || ran.isError === true) return 'failed'
  const result = isObject(ran.result) ? ran.result : {}
  if (typeof result.backgroundTaskId === 'string' && result.backgroundTaskId !== '') return 'pending'
  if (result.interrupted === true) return 'unknown'
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const stdout = typeof result.stdout === 'string' ? result.stdout : (ran.text ?? '')
  if (intent.kind === 'push-main' || intent.kind === 'push-unknown') {
    return /!\s*\[(?:remote )?rejected\]|error: failed to push|^fatal:/m.test(stderr) ? 'failed' : 'merged'
  }
  const op = (isObject(result.gitOperation) ? result.gitOperation : {}) as GitOperation
  if (isObject(op.pr)) {
    if (op.pr.action === 'merged') {
      const wanted = intent.pr ?? holderPr
      return wanted === null || String(op.pr.number) === wanted ? 'merged' : 'pending'
    }
    if (op.pr.action === 'auto-merge-enabled') return 'pending'
  }
  if (intent.kind === 'api-merge' && /"merged"\s*:\s*true/.test(stdout)) return 'merged'
  return 'unknown'
}

/* ------------------------------------------------------------------------ */
/* Command classification                                                    */
/* ------------------------------------------------------------------------ */

const GH_VALUE_FLAGS = new Set([
  '-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email',
  '--match-head-commit', '-X', '--method', '-f', '--raw-field', '--field', '-H', '--header', '--input',
  '-q', '--jq', '--template', '--hostname', '--cache', '-p', '--preview',
])
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path',
])
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', '{', '!', 'then', 'do', 'else', 'if', 'elif', 'while', 'until'])
const SHELLS = /^(?:ba|z|da|k|fi)?sh$/
const DEFAULT_BRANCH = /^(?:main|master)$/
const MAX_DEPTH = 3

/**
 * Reads a Bash command for a merge: `gh pr merge`, a `gh api` call that
 * merges (PUT on `pulls/<n>/merge`, POST on `merges`, the GraphQL merge
 * mutations), or a `git push` that lands on main/master. Quoted text, heredoc
 * bodies and comments are words, never commands, so a commit message that
 * mentions `gh pr merge` passes; `sh -c`, `eval`, `xargs`, `env` and the like
 * are looked through. Null when nothing in it merges. Pure and cheap: the
 * gate runs it before anything else and runs no process for a null.
 */
export function classifyCommand(command: string): MergeIntent | null {
  return classifyIn(stripHeredocs(command), 0)
}

function classifyIn(source: string, depth: number): MergeIntent | null {
  let dir: string | null = null
  let isDirUnknown = false
  for (const segment of splitCommands(source)) {
    const tokens = stripPrefix(segment)
    const first = tokens[0]
    if (first === undefined) continue
    // a prefix that changes directory (`env -C dir`, `sudo -D dir`) lands the command in a repo the text does not pin
    const isPrefixDir = segment.slice(0, segment.length - tokens.length).some(token => /^(?:-C|-D|--chdir(?:=.*)?)$/.test(token))
    const base = basename(first)
    if (base === 'cd' || base === 'pushd') {
      const target = tokens[1] ?? '~'
      if (target === '-' || /[$`]/.test(target)) {
        dir = null
        isDirUnknown = true
      } else {
        // only an absolute target forgets an unknown one; a relative one still hangs off it
        if (target.startsWith('/') || target.startsWith('~')) isDirUnknown = false
        dir = joinDir(dir, target)
      }
      continue
    }
    let intent: MergeIntent | null = null
    if (SHELLS.test(base)) {
      const script = shellScript(tokens)
      if (script !== undefined && depth < MAX_DEPTH) intent = classifyIn(stripHeredocs(script), depth + 1)
    } else if (base === 'eval') {
      if (depth < MAX_DEPTH) intent = classifyIn(tokens.slice(1).join(' '), depth + 1)
    } else if (base === 'gh') {
      intent = classifyGh(tokens.slice(1))
    } else if (base === 'git') {
      intent = classifyGitPush(tokens.slice(1))
    }
    if (intent !== null) {
      return {
        ...intent,
        dir: intent.dir === null ? dir : joinDir(dir, intent.dir),
        isDirUnknown: isDirUnknown || isPrefixDir || intent.isDirUnknown === true,
      }
    }
  }
  return null
}

function classifyGh(args: readonly string[]): MergeIntent | null {
  const { positionals, flags } = parseArgs(args, GH_VALUE_FLAGS)
  // a help page merges nothing, whatever else the line names
  if (flags.has('--help') || flags.has('-h')) return null
  const named = flagValue(flags, '-R') ?? flagValue(flags, '--repo')
  if (positionals[0] === 'pr' && positionals[1] === 'merge') {
    if (flags.has('--disable-auto')) return null
    const selector = positionals[2]
    let pr: string | null = null
    let repo = named
    let branch: string | null = null
    if (selector !== undefined) {
      const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(selector)
      if (url) {
        pr = url[4] ?? null
        repo = repo ?? `${url[1]}/${url[2]}/${url[3]}`
      } else if (/^#?\d{1,9}$/.test(selector)) {
        pr = selector.replace('#', '')
      } else {
        branch = selector
      }
    }
    return { kind: 'pr-merge', pr, repo, branch, dir: null, isAuto: flags.has('--auto') }
  }
  if (positionals[0] !== 'api') return null
  const endpoint = positionals[1] ?? ''
  if (endpoint === 'graphql') {
    const all = args.join(' ')
    const isAuto = /enablePullRequestAutoMerge/.test(all)
    if (!isAuto && !/mergePullRequest|mergeBranch/.test(all)) return null
    return { kind: 'graphql-merge', pr: null, repo: named, branch: null, dir: null, isAuto }
  }
  const method = flagValue(flags, '-X') ?? flagValue(flags, '--method')
  const hasFields = ['-f', '-F', '--field', '--raw-field', '--input'].some(name => flags.has(name))
  const isReadOnly = method !== null ? /^(?:GET|HEAD)$/i.test(method) : !hasFields
  if (isReadOnly) return null
  const path = endpoint.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '')
  const pull = /(?:^|\/)repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge\/?$/.exec(path)
  const branchMerge = /(?:^|\/)repos\/([^/]+)\/([^/]+)\/merges\/?$/.exec(path)
  const hit = pull ?? branchMerge
  if (hit === null) return null
  const owner = hit[1] ?? ''
  const name = hit[2] ?? ''
  const isPlaceholder = /[{}:]/.test(owner + name)
  return {
    kind: 'api-merge',
    pr: pull?.[3] ?? null,
    repo: isPlaceholder ? named : `${owner}/${name}`,
    branch: null,
    dir: null,
    isAuto: false,
  }
}

function classifyGitPush(args: readonly string[]): MergeIntent | null {
  let index = 0
  let dir: string | null = null
  let isDirUnknown = false
  while (index < args.length) {
    const arg = args[index] ?? ''
    if (!arg.startsWith('-')) break
    if (arg === '-C') {
      const target = args[index + 1] ?? ''
      if (/[$`]/.test(target)) {
        dir = null
        isDirUnknown = true
      } else dir = joinDir(dir, target)
      index += 2
      continue
    }
    index += GIT_GLOBAL_VALUE_FLAGS.has(arg) ? 2 : 1
  }
  if (args[index] !== 'push') return null
  const { positionals, flags } = parseArgs(args.slice(index + 1), PUSH_VALUE_FLAGS)
  // a dry run or a help page lands nothing on any branch
  if (['--dry-run', '-n', '--help', '-h'].some(name => flags.has(name))) return null
  const intent = (kind: MergeKind): MergeIntent => ({ kind, pr: null, repo: null, branch: null, dir, isAuto: false, isDirUnknown })
  if (flags.has('--all') || flags.has('--mirror') || flags.has('--branches')) return intent('push-main')
  const refspecs = positionals.slice(1)
  if (refspecs.some(isDefaultBranchRef)) return intent('push-main')
  if (refspecs.length === 0) return flags.has('--tags') ? null : intent('push-unknown')
  if (refspecs.some(ref => /^\+?(?:HEAD|@)$/.test(ref))) return intent('push-unknown')
  return null
}

/** A refspec whose destination is main or master (`main`, `HEAD:main`, `+x:refs/heads/master`, `:main`). */
export function isDefaultBranchRef(refspec: string): boolean {
  const bare = refspec.replace(/^\+/, '')
  const destination = bare.includes(':') ? bare.slice(bare.lastIndexOf(':') + 1) : bare
  return DEFAULT_BRANCH.test(destination.replace(/^refs\/heads\//, ''))
}

export function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCH.test(branch.trim())
}

/**
 * Reads an MCP GitHub merge tool's call (`merge_pull_request`), or null for
 * any other tool. Anchored on the name's last segment, so a read-only tool
 * that merely contains the words (`get_merge_pr_status`) is never gated.
 */
export function classifyMcp(tool: string, input: Readonly<Record<string, unknown>>): MergeIntent | null {
  if (!/(?:^|__)(?:merge_pull_request|merge_pr)$/i.test(tool)) return null
  const owner = input.owner
  const repo = input.repo
  const number = input.pullNumber ?? input.pull_number ?? input.number
  return {
    kind: 'mcp-merge',
    pr: typeof number === 'number' || (typeof number === 'string' && /^\d{1,9}$/.test(number)) ? String(number) : null,
    repo: typeof owner === 'string' && typeof repo === 'string' ? `${owner}/${repo}` : null,
    branch: null,
    dir: null,
    isAuto: false,
  }
}

/**
 * Drops heredoc bodies (and their terminator lines); an unterminated one is
 * kept, so nothing hides. The delimiter is any shell word, quoted or not
 * (`<<EOF`, `<<-'MSG-END'`, `<<"END.1"`), its quotes removed as the shell
 * does, so a body line that only mentions a merge never reads as one.
 */
export function stripHeredocs(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    out.push(line)
    index += 1
    // `<<WORD`, `<<-WORD`, `<<'A-B'`, `<<"A"B`; never a `<<<` here-string (a word cannot start with `<`)
    const delimiters = [...line.matchAll(/(^|[^<])<<-?[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"\\])+)/g)].map(m =>
      (m[2] ?? '').replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_all, single, double, escaped) => single ?? double ?? escaped ?? ''),
    )
    for (const delimiter of delimiters) {
      let end = index
      while (end < lines.length && (lines[end] ?? '').trim() !== delimiter) end += 1
      if (end >= lines.length) break
      index = end + 1
    }
  }
  return out.join('\n')
}

/**
 * Splits a command into its simple commands' words: quotes join and are
 * removed, `;` `&` `|` `(` `)` and newlines end a command, a `#` at a word's
 * start comments the line out, and each `$(...)` or backtick body is split as
 * commands of its own (it runs, even inside double quotes).
 */
export function splitCommands(source: string, depth = 0): string[][] {
  const segments: string[][] = []
  let segment: string[] = []
  let word = ''
  let isInWord = false
  const endWord = () => {
    if (isInWord) segment.push(word)
    word = ''
    isInWord = false
  }
  const endSegment = () => {
    endWord()
    if (segment.length > 0) segments.push(segment)
    segment = []
  }
  const nested = (body: string) => {
    if (depth < MAX_DEPTH) segments.push(...splitCommands(body, depth + 1))
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? ''
    if (c === '\\') {
      if (source[i + 1] === '\n') {
        i += 1
        continue
      }
      if (i + 1 < source.length) {
        word += source[i + 1]
        isInWord = true
        i += 1
      }
      continue
    }
    if (c === "'") {
      const close = source.indexOf("'", i + 1)
      const stop = close === -1 ? source.length : close
      word += source.slice(i + 1, stop)
      isInWord = true
      i = stop
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== '"') {
        const d = source[j] ?? ''
        if (d === '\\' && j + 1 < source.length) {
          word += source[j + 1]
          j += 2
          continue
        }
        if (d === '$' && source[j + 1] === '(') {
          const close = matchParen(source, j + 1)
          nested(source.slice(j + 2, close))
          word += '$()'
          j = close + 1
          continue
        }
        if (d === '`') {
          const close = source.indexOf('`', j + 1)
          const stop = close === -1 ? source.length : close
          nested(source.slice(j + 1, stop))
          j = stop + 1
          continue
        }
        word += d
        j += 1
      }
      isInWord = true
      i = j
      continue
    }
    if (c === '`') {
      const close = source.indexOf('`', i + 1)
      const stop = close === -1 ? source.length : close
      endSegment()
      nested(source.slice(i + 1, stop))
      i = stop
      continue
    }
    if (c === '#' && !isInWord) {
      const newline = source.indexOf('\n', i)
      i = newline === -1 ? source.length : newline - 1
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      continue
    }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endSegment()
      continue
    }
    word += c
    isInWord = true
  }
  endSegment()
  return segments
}

/** The index of the `)` closing the `(` at `open`, skipping quoted text; the end when unclosed. */
function matchParen(source: string, open: number): number {
  let depth = 0
  for (let k = open; k < source.length; k++) {
    const d = source[k]
    if (d === '\\') {
      k += 1
      continue
    }
    if (d === "'") {
      const close = source.indexOf("'", k + 1)
      if (close === -1) return source.length
      k = close
      continue
    }
    if (d === '"') {
      let m = k + 1
      while (m < source.length && source[m] !== '"') m += source[m] === '\\' ? 2 : 1
      k = m
      continue
    }
    if (d === '(') depth += 1
    if (d === ')') {
      depth -= 1
      if (depth === 0) return k
    }
  }
  return source.length
}

/** Drops what runs a command rather than being it: assignments, `env`, `sudo`, `xargs`, `timeout`, `nice`, ... */
function stripPrefix(segment: readonly string[]): string[] {
  let tokens = [...segment]
  for (let guard = 0; guard < 12 && tokens.length > 0; guard++) {
    const first = tokens[0] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(first)) {
      tokens = tokens.slice(1)
      continue
    }
    const base = basename(first)
    if (base === 'env') {
      tokens = skipFlags(tokens.slice(1), new Set(['-u', '--unset', '-C', '--chdir']))
    } else if (base === 'sudo' || base === 'doas') {
      tokens = skipFlags(tokens.slice(1), new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-T']))
    } else if (base === 'nice') {
      tokens = skipFlags(tokens.slice(1), new Set(['-n']))
    } else if (base === 'timeout' || base === 'gtimeout') {
      tokens = skipFlags(tokens.slice(1), new Set(['-s', '--signal', '-k', '--kill-after'])).slice(1)
    } else if (base === 'xargs') {
      tokens = skipFlags(
        tokens.slice(1),
        new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace']),
      )
    } else {
      break
    }
  }
  return tokens
}

function skipFlags(tokens: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (token === '--') {
      i += 1
      break
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i += 1
      continue
    }
    if (!token.startsWith('-') || token === '-') break
    i += valueFlags.has(token) ? 2 : 1
  }
  return tokens.slice(i)
}

/** The script of `sh -c '<script>'` (any flag cluster holding `c`), or undefined. */
function shellScript(tokens: readonly string[]): string | undefined {
  const flag = tokens.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(token))
  return flag === -1 ? undefined : tokens[flag + 1]
}

type Parsed = { positionals: string[]; flags: Map<string, string | true> }

function parseArgs(args: readonly string[], valueFlags: ReadonlySet<string>): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 0) flags.set(arg.slice(0, eq), arg.slice(eq + 1))
      else if (valueFlags.has(arg)) {
        flags.set(arg, args[i + 1] ?? '')
        i += 1
      } else flags.set(arg, true)
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const name = arg.slice(0, 2)
      if (valueFlags.has(name)) {
        if (arg.length > 2) flags.set(name, arg.slice(2).replace(/^=/, ''))
        else {
          flags.set(name, args[i + 1] ?? '')
          i += 1
        }
      } else {
        for (const letter of arg.slice(1)) flags.set(`-${letter}`, true)
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

function flagValue(flags: ReadonlyMap<string, string | true>, name: string): string | null {
  const value = flags.get(name)
  return typeof value === 'string' && value !== '' ? value : null
}

function basename(path: string): string {
  return path.replace(/^.*\//, '')
}

/** Joins a `cd` target onto the directory before it; absolute and `~` targets restart. */
export function joinDir(base: string | null, next: string): string {
  if (next.startsWith('/') || next.startsWith('~') || base === null) return next
  return `${base.replace(/\/+$/, '')}/${next}`
}

/** Resolves a classified directory against HOME and the session's cwd; null when it cannot. */
export function resolveDir(dir: string, home: string | undefined, cwd: string): string | null {
  if (dir === '~' || dir.startsWith('~/')) return home === undefined ? null : `${home}${dir.slice(1)}`
  if (dir.startsWith('~')) return null
  if (dir.startsWith('/')) return dir
  return `${cwd.replace(/\/+$/, '')}/${dir}`
}

/* ------------------------------------------------------------------------ */
/* Envelope                                                                  */
/* ------------------------------------------------------------------------ */

export type Envelope =
  | { kind: 'lane.available'; repoKey: string; nonce: string }
  | { kind: 'lane.changed'; repoKey: string }
  | { kind: 'ping' }

export function makeEnvelope(envelope: Envelope): string {
  return ENVELOPE_PREFIX + JSON.stringify(envelope)
}

/**
 * Reads a delivery. `not-ours` for text without the prefix (it passes on
 * untouched); `invalid` for anything with the prefix that does not parse to a
 * known kind (it is still consumed, so it never reaches the model). A parsed
 * envelope is only a hint: the receiver re-reads the lane from disk.
 */
export function parseEnvelope(text: string): Envelope | 'not-ours' | 'invalid' {
  if (!text.startsWith(ENVELOPE_PREFIX)) return 'not-ours'
  const value = parseJsonObject(text.slice(ENVELOPE_PREFIX.length))
  if (value === null) return 'invalid'
  const isKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{16}$/.test(key)
  if (value.kind === 'ping') return { kind: 'ping' }
  if (value.kind === 'lane.changed' && isKey(value.repoKey)) return { kind: 'lane.changed', repoKey: value.repoKey }
  if (
    value.kind === 'lane.available' &&
    isKey(value.repoKey) &&
    typeof value.nonce === 'string' &&
    value.nonce !== '' &&
    value.nonce.length <= 100
  ) {
    return { kind: 'lane.available', repoKey: value.repoKey, nonce: value.nonce }
  }
  return 'invalid'
}

/* ------------------------------------------------------------------------ */
/* /lane arguments                                                           */
/* ------------------------------------------------------------------------ */

export type LaneVerb = 'status' | 'request' | 'release' | 'prioritize' | 'take' | 'auto' | 'off' | 'on' | 'help'

export type LaneCommand = {
  verb: LaneVerb | 'unknown'
  /** The words after the verb, flags removed. */
  rest: string[]
  isHigh: boolean
  isYes: boolean
}

/** Verbs that change the lane or this session's standing: only the person may run them. */
export const MUTATING_VERBS: ReadonlySet<string> = new Set(['request', 'release', 'prioritize', 'take', 'auto', 'off', 'on'])

export function parseLaneArgs(args: string): LaneCommand {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const verb = (words[0] ?? 'status').toLowerCase()
  const known: readonly string[] = ['status', 'request', 'release', 'prioritize', 'take', 'auto', 'off', 'on', 'help']
  const rest = words.slice(1)
  return {
    verb: known.includes(verb) ? (verb as LaneVerb) : 'unknown',
    rest: rest.filter(word => !word.startsWith('--')),
    isHigh: rest.includes('--high'),
    isYes: rest.includes('--yes'),
  }
}

/**
 * Origins whose /lane is the person's own: the prompt's Enter, the Remote
 * Control bridge, and `sdk`, since the desktop app hosts its sessions over
 * the SDK. Every other origin (peers, plugins, schedules) is not the person.
 */
export function isPersonOrigin(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

/** A PR named in `/lane request` or `/lane prioritize`: a number, `#n`, or a pull URL. */
export function prFromArg(arg: string): string | null {
  const url = /\/pull\/(\d{1,9})(?:\/|$|[?#])/.exec(arg)
  if (url) return url[1] ?? null
  return /^#?\d{1,9}$/.test(arg) ? arg.replace('#', '') : null
}

/* ------------------------------------------------------------------------ */
/* Text                                                                      */
/* ------------------------------------------------------------------------ */

/** Drops control characters (a label is another session's text drawn in this terminal) and caps the length. */
export function cleanText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

export function prText(pr: string | null): string {
  return pr === null ? '' : ` (PR #${pr})`
}

/** A duration as a person reads it: `just now`, `45 s`, `12 min`, `3 h`. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 90) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/** A past moment as a phrase: `just now`, or `12 min ago` (never "just now ago"). */
export function agoText(ms: number): string {
  const span = ago(ms)
  return span === 'just now' ? span : `${span} ago`
}

export type StatusView =
  | { role: 'none'; isBypassed: boolean }
  | { role: 'holder'; pr: string | null; queued: number; isBypassed: boolean }
  | {
      role: 'queued'
      position: number
      total: number
      behindLabel: string | null
      behindPr: string | null
      isBypassed: boolean
    }

/** The line under the composer; undefined clears it when this session is not involved. */
export function statusLine(view: StatusView): string | undefined {
  const gate = view.isBypassed ? ' · gate off' : ''
  if (view.role === 'holder') {
    return `lane: yours${prText(view.pr)}${view.queued > 0 ? ` · ${view.queued} queued` : ''}${gate}`
  }
  if (view.role === 'queued') {
    const behind = view.behindLabel === null ? '' : ` behind ${view.behindLabel}${prText(view.behindPr)}`
    return `lane: queued #${view.position} of ${view.total}${behind}${gate}`
  }
  return view.isBypassed ? 'lane: gate off' : undefined
}

/** The summary of a PR's checks from `gh pr view --json statusCheckRollup`. */
export function ciSummary(rollup: unknown): { passed: number; failing: number; pending: number } {
  const counts = { passed: 0, failing: 0, pending: 0 }
  if (!Array.isArray(rollup)) return counts
  for (const check of rollup) {
    if (!isObject(check)) continue
    const verdict = String(check.conclusion ?? check.state ?? '').toUpperCase()
    const status = String(check.status ?? '').toUpperCase()
    if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') counts.passed += 1
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(verdict)) {
      counts.failing += 1
    } else if (status === 'COMPLETED' && verdict === '') counts.passed += 1
    else counts.pending += 1
  }
  return counts
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined || text.length > 64_000) return null
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}
