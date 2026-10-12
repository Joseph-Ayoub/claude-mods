// Pure close-out logic for /wrap: no `$`, no I/O. collect.ts gathers Facts
// through an injected runner and register.tsx wires the command; keeping the
// judgement here lets the tests feed it mocked process results.
//
// One rule runs through every row: anything that could not be established
// (non-zero exit, missing binary, timeout, unparseable output) is `unknown`,
// and `unknown` is never a pass. No raw stderr or stdout is ever copied into a
// reason: git/gh can echo remote URLs with embedded credentials, so reasons are
// built only from parsed fields (counts, SHAs, PR numbers, branch names).

export type Status = 'pass' | 'fail' | 'unknown'

export type Row = { id: RowId; check: string; status: Status; reason: string }

export type RowId =
  | 'tree'
  | 'fetch'
  | 'pushed'
  | 'pr'
  | 'ci'
  | 'base'
  | 'merged'
  | 'worktrees'
  | 'background'

/** The result of one argv run: it exited (any code) or it could not complete. */
export type Proc =
  | { kind: 'exit'; code: number; out: string; err: string }
  | { kind: 'failed' }

export type Run = (argv: readonly string[], timeoutMs: number) => Promise<Proc>

export type PrFact =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | {
      kind: 'pr'
      number: number
      state: string
      headRefOid: string
      baseRefName: string
      mergedAt: string | null
      mergeStateStatus: string
      rollup: unknown[] | undefined
    }

/** `prunable`: git says the worktree's folder is gone (only `git worktree prune` clears the entry). */
export type Worktree = { path: string; head: string; branch?: string; prunable?: boolean }

export type Facts = {
  cwd: string
  head?: string
  branch?: string
  dirtyCount?: number
  defaultBranch: string
  /** undefined: could not tell; false: no `origin` remote. */
  hasOrigin?: boolean
  /** undefined: not attempted (no origin) or unknown. */
  fetchOk?: boolean
  ahead?: number
  /** origin/<default> is an ancestor of HEAD (base is fresh). */
  baseContained?: boolean
  /** HEAD is an ancestor of origin/<default> (already merged). */
  headInBase?: boolean
  upstream?: { exists: false } | { exists: true; ahead: number | undefined }
  pr: PrFact
  worktrees?: Worktree[]
  selfRoot?: string
  /** Merged PRs gh listed for the sibling branches it was asked about; undefined when gh answered none. */
  ghMerged?: { name: string; oid: string }[]
  /**
   * Sibling worktrees gh gave no complete answer for (query failed, a full page, an unsafe
   * branch name, or past the query cap). Not knowing is never "not merged", so any reads unknown.
   */
  ghUnanswered?: number
  /** Uncommitted-path count per sibling worktree path, read only for PR-merged ones; absent: unknown. */
  siblingDirty?: Record<string, number>
  background: unknown
}

export type Options = { acceptSkippedChecks: boolean }

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const SHA_RE = /^[0-9a-f]{40}$/

/** Branch names go into argv and into text drawn in a terminal: allow-list them. */
export function safeBranch(name: string | undefined, fallback: string): string {
  const n = (name ?? '').trim()
  return n.length > 0 && n.length <= 100 && BRANCH_RE.test(n) && !n.includes('..') ? n : fallback
}

/** A name read from git, made safe to draw (no control or escape characters). */
export function show(text: string, max = 60): string {
  const clean = text.replace(/[^\x20-\x7e]/g, '?')
  return clean.length > max ? clean.slice(0, max - 1) + '~' : clean
}

const short = (sha: string | undefined) => (sha ? sha.slice(0, 7) : '?')

export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = []
  let cur: Worktree | undefined
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur)
      cur = { path: line.slice('worktree '.length), head: '' }
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim()
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (cur && (line === 'prunable' || line.startsWith('prunable '))) {
      cur.prunable = true
    }
  }
  if (cur) list.push(cur)
  return list
}

/** gh's own words for "this branch has no PR": a known fact, not an outage. */
export function isNoPr(err: string): boolean {
  return /no pull requests found/i.test(err)
}

export function parsePr(out: string): PrFact {
  try {
    const j: unknown = JSON.parse(out)
    if (typeof j !== 'object' || j === null) return { kind: 'unknown' }
    const o = j as Record<string, unknown>
    if (typeof o.number !== 'number' || typeof o.state !== 'string') return { kind: 'unknown' }
    if (typeof o.headRefOid !== 'string' || !SHA_RE.test(o.headRefOid)) return { kind: 'unknown' }
    return {
      kind: 'pr',
      number: o.number,
      state: o.state,
      headRefOid: o.headRefOid,
      baseRefName: typeof o.baseRefName === 'string' ? o.baseRefName : '',
      mergedAt: typeof o.mergedAt === 'string' && o.mergedAt !== '' ? o.mergedAt : null,
      mergeStateStatus: typeof o.mergeStateStatus === 'string' ? o.mergeStateStatus : '',
      rollup: Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : undefined,
    }
  } catch {
    return { kind: 'unknown' }
  }
}

/** Every worktree other than the main checkout and the session's own. */
export function siblings(f: Facts): Worktree[] {
  const wts = f.worktrees ?? []
  return wts.slice(1).filter(w => {
    if (f.selfRoot && w.path === f.selfRoot) return false
    if (f.cwd === w.path || f.cwd.startsWith(w.path + '/')) return false
    return true
  })
}

/**
 * The siblings that can be checked: on a named branch (stale needs a merged PR at the
 * branch's head) at an absolute path. A detached sibling is never flagged, so the row
 * names how many it skipped rather than claiming there are none.
 */
export function candidates(f: Facts): Worktree[] {
  // Paths go into `git -C <path>` argv: absolute only, so nothing reads as an option.
  return siblings(f).filter(w => w.branch !== undefined && w.branch !== '' && w.path.startsWith('/'))
}

export function classifyCi(
  rollup: unknown[] | undefined,
  acceptSkipped: boolean,
): { status: Status; reason: string } {
  if (!rollup) return { status: 'unknown', reason: 'check rollup missing from gh output' }
  if (rollup.length === 0) return { status: 'fail', reason: 'pending: no checks reported yet' }
  let ok = 0
  let skipped = 0
  let pending = 0
  let failed = 0
  let odd = 0
  for (const entry of rollup) {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    if (typeof e.status === 'string') {
      // CheckRun
      if (e.status !== 'COMPLETED') pending++
      else if (e.conclusion === 'SUCCESS') ok++
      else if (e.conclusion === 'NEUTRAL' || e.conclusion === 'SKIPPED') skipped++
      else if (typeof e.conclusion === 'string' && e.conclusion !== '') failed++
      else odd++
    } else if (typeof e.state === 'string') {
      // StatusContext
      if (e.state === 'SUCCESS') ok++
      else if (e.state === 'PENDING' || e.state === 'EXPECTED') pending++
      else if (e.state === 'FAILURE' || e.state === 'ERROR') failed++
      else odd++
    } else odd++
  }
  const n = rollup.length
  if (failed > 0) return { status: 'fail', reason: `${failed} of ${n} checks failing` }
  if (pending > 0) return { status: 'fail', reason: `pending: ${pending} of ${n} checks not finished` }
  if (odd > 0) return { status: 'unknown', reason: `${odd} of ${n} checks in an unrecognised shape` }
  if (skipped > 0 && !acceptSkipped) {
    return { status: 'fail', reason: `${skipped} of ${n} checks skipped or neutral, not success` }
  }
  return { status: 'pass', reason: `all ${n} checks green` }
}

/**
 * The last Stop's in-flight work: background tasks and session crons (CronCreate,
 * ScheduleWakeup, /loop) that will wake this session later. `crons` undefined: that
 * Stop did not list them, which is not the same as "none scheduled".
 */
export function readBackground(value: unknown): { tasks: number; crons: number | undefined; source: 'stop' | 'agents' } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.tasks)) return undefined
  return { tasks: v.tasks.length, crons: Array.isArray(v.crons) ? v.crons.length : undefined, source: v.source === 'agents' ? 'agents' : 'stop' }
}

export function evaluate(f: Facts, opts: Options): Row[] {
  const rows: Row[] = []
  const add = (id: RowId, check: string, status: Status, reason: string) =>
    rows.push({ id, check, status, reason })
  const base = `origin/${f.defaultBranch}`
  const pr = f.pr
  const prMerged =
    pr.kind === 'pr' && pr.mergedAt !== null && pr.state === 'MERGED' && pr.headRefOid === f.head
  const nothingToShip = f.ahead === 0 && pr.kind === 'none'

  // 1. tree
  if (f.dirtyCount === undefined) add('tree', 'Working tree clean', 'unknown', 'git status did not complete')
  else if (f.dirtyCount === 0) add('tree', 'Working tree clean', 'pass', 'no uncommitted changes')
  else add('tree', 'Working tree clean', 'fail', `${f.dirtyCount} changed or untracked path(s)`)

  // 2. fetch
  if (f.hasOrigin === false) add('fetch', `Fetched ${base}`, 'unknown', 'unknown (no origin)')
  else if (f.fetchOk === true) add('fetch', `Fetched ${base}`, 'pass', 'fetched just now')
  else add('fetch', `Fetched ${base}`, 'unknown', 'fetch did not complete, so origin refs may be stale')

  // 3. pushed
  if (f.head === undefined) {
    add('pushed', 'Commits pushed', 'unknown', 'could not read HEAD')
  } else if (pr.kind === 'pr') {
    if (pr.headRefOid === f.head) add('pushed', 'Commits pushed', 'pass', `PR head matches local HEAD ${short(f.head)}`)
    else
      add(
        'pushed',
        'Commits pushed',
        'fail',
        `local HEAD ${short(f.head)} differs from PR head ${short(pr.headRefOid)}`,
      )
  } else if (f.upstream?.exists === true && f.upstream.ahead !== undefined) {
    if (f.upstream.ahead === 0) add('pushed', 'Commits pushed', 'pass', 'in sync with upstream (no PR yet)')
    else add('pushed', 'Commits pushed', 'fail', `${f.upstream.ahead} commit(s) not on upstream`)
  } else if (f.upstream?.exists === false) {
    if (nothingToShip) add('pushed', 'Commits pushed', 'pass', `nothing beyond ${base}`)
    else add('pushed', 'Commits pushed', 'fail', 'no upstream branch set')
  } else {
    add('pushed', 'Commits pushed', 'unknown', 'could not compare with upstream or PR')
  }

  // 4. PR
  if (pr.kind === 'pr') {
    const conflict = pr.mergeStateStatus === 'DIRTY'
    if (pr.state === 'MERGED') add('pr', 'PR', 'pass', `#${pr.number} merged`)
    else if (pr.state === 'CLOSED') add('pr', 'PR', 'fail', `#${pr.number} closed without merging`)
    else if (conflict) add('pr', 'PR', 'fail', `#${pr.number} open but has merge conflicts`)
    else add('pr', 'PR', 'pass', `#${pr.number} open${pr.baseRefName ? ` into ${show(pr.baseRefName)}` : ''}`)
  } else if (pr.kind === 'none') {
    if (f.ahead === 0) add('pr', 'PR', 'pass', `no commits beyond ${base}, nothing to raise`)
    else if (f.ahead === undefined) add('pr', 'PR', 'unknown', 'no PR found and commits ahead of base not known')
    else add('pr', 'PR', 'fail', `no PR for this branch (${f.ahead} commit(s) ahead of ${base})`)
  } else {
    add('pr', 'PR', 'unknown', 'gh pr view did not complete (missing, signed out, offline or timed out)')
  }

  // 5. CI on the current head
  if (pr.kind === 'pr') {
    if (f.head !== undefined && pr.headRefOid !== f.head) {
      add('ci', 'CI green on current head', 'fail', `checks belong to ${short(pr.headRefOid)}, local HEAD is ${short(f.head)}`)
    } else if (f.head === undefined) {
      add('ci', 'CI green on current head', 'unknown', 'could not read HEAD to compare with the PR head')
    } else if (prMerged) {
      add('ci', 'CI green on current head', 'pass', 'PR merged; CI no longer gating')
    } else {
      const c = classifyCi(pr.rollup, opts.acceptSkippedChecks)
      add('ci', 'CI green on current head', c.status, c.reason)
    }
  } else if (pr.kind === 'none') {
    if (nothingToShip) add('ci', 'CI green on current head', 'pass', 'n/a: nothing to ship')
    else add('ci', 'CI green on current head', 'fail', 'no PR, so no CI result for this head')
  } else {
    add('ci', 'CI green on current head', 'unknown', 'PR state unknown')
  }

  // 7 first (base depends on it): merged into the default branch
  let mergedStatus: Status
  let mergedReason: string
  if (prMerged) {
    mergedStatus = 'pass'
    mergedReason = `PR #${(pr as { number: number }).number} merged at this head`
  } else if (f.headInBase === true) {
    mergedStatus = 'pass'
    mergedReason = `HEAD is contained in ${base}`
  } else if (pr.kind === 'pr' && pr.state === 'MERGED') {
    mergedStatus = 'fail'
    mergedReason = `PR #${pr.number} merged, but local HEAD ${short(f.head)} is not the merged head`
  } else if (pr.kind === 'pr') {
    mergedStatus = 'fail'
    mergedReason = `PR #${pr.number} is ${pr.state.toLowerCase()}, not merged`
  } else if (f.headInBase === false && pr.kind === 'none') {
    mergedStatus = 'fail'
    mergedReason = `HEAD is not in ${base} and no PR was found`
  } else {
    // headInBase false/undefined with PR unknown: a squash merge would look unmerged here.
    mergedStatus = 'unknown'
    mergedReason = 'could not establish (PR state unknown, or merge ancestry check did not complete)'
  }

  // 6. base freshness
  if (mergedStatus === 'pass') {
    add('base', `Base fresh vs ${base}`, 'pass', 'n/a: already merged')
  } else if (f.hasOrigin === false) {
    add('base', `Base fresh vs ${base}`, 'unknown', 'unknown (no origin)')
  } else if (f.fetchOk !== true) {
    add('base', `Base fresh vs ${base}`, 'unknown', 'fetch did not complete, so the local base ref may be stale')
  } else if (f.baseContained === true) {
    add('base', `Base fresh vs ${base}`, 'pass', `${base} is already in this branch`)
  } else if (f.baseContained === false) {
    add('base', `Base fresh vs ${base}`, 'fail', `${base} has commits this branch lacks (rebase or merge needed)`)
  } else {
    add('base', `Base fresh vs ${base}`, 'unknown', 'ancestry check did not complete')
  }
  rows.push({ id: 'merged', check: `Merged into ${base}`, status: mergedStatus, reason: mergedReason })

  // 8. other stale worktrees: flagged only with a merged PR at the worktree's head and a
  // clean tree; anything else may be a live session's and is never counted.
  if (f.worktrees === undefined) {
    add('worktrees', 'No stale worktrees', 'unknown', 'git worktree list did not complete')
  } else {
    const others = candidates(f)
    const skipped = siblings(f).filter(w => !w.branch).length
    const skippedNote = skipped > 0 ? `; ${skipped} detached worktree(s) not checked (no branch, so no PR to match)` : ''
    if (others.length === 0) {
      add(
        'worktrees',
        'No stale worktrees',
        'pass',
        skipped > 0
          ? `no other worktree on a branch${skippedNote}`
          : 'no other worktrees (this session\'s own is excluded)',
      )
    } else if (f.ghMerged === undefined) {
      add('worktrees', 'No stale worktrees', 'unknown', `could not ask gh whether ${others.length} other worktree branch(es) are merged`)
    } else {
      const stale: string[] = []
      const unanswered = f.ghUnanswered ?? 0
      let undecided = 0
      let gone = 0
      for (const w of others) {
        if (!prMergedAtHead(f, w)) continue
        const dirty = f.siblingDirty?.[w.path]
        if (dirty === undefined) {
          undecided++
          if (w.prunable === true) gone++
        }
        else if (dirty === 0) stale.push(show(w.branch as string))
        // dirty > 0: uncommitted work lives there, so it is never stale.
      }
      if (stale.length > 0) {
        const more = stale.length > 3 ? ` (+${stale.length - 3} more)` : ''
        add('worktrees', 'No stale worktrees', 'fail', `PR merged, tree clean, still checked out: ${stale.slice(0, 3).join(', ')}${more}`)
      } else if (undecided > 0) {
        // A prunable entry stays unknown (its tree cannot be read), but the person is told the fix.
        const hint = gone > 0 ? ` (${gone} of them marked prunable by git, its folder gone: \`git worktree prune\` clears it)` : ''
        add('worktrees', 'No stale worktrees', 'unknown', `could not read the tree of ${undecided} other worktree(s) whose PR merged${hint}`)
      } else if (unanswered > 0) {
        add('worktrees', 'No stale worktrees', 'unknown', `gh gave no complete answer for ${unanswered} of ${others.length} other worktree branch(es)`)
      } else {
        add('worktrees', 'No stale worktrees', 'pass', `${others.length} other worktree(s), none with a merged PR at its head${skippedNote}`)
      }
    }
  }

  // 9. background tasks and scheduled wakeups: archiving would drop either silently.
  const BG = 'No background tasks or wakeups'
  const bg = readBackground(f.background)
  if (bg === undefined) {
    add('background', BG, 'unknown', 'unknown (no turn end with a task list observed this session)')
  } else if (bg.source === 'agents') {
    // A host that raises no classic.Stop (the desktop): running subagents are what can be seen;
    // background shell tasks and wakeups are the app's to guard (its archive refuses live work).
    if (bg.tasks > 0) add('background', BG, 'fail', `${bg.tasks} subagent(s) still running as of the last turn end`)
    else add('background', BG, 'pass', 'no subagent running as of the last turn end (shell tasks and wakeups are not listed on this host; the app refuses to archive live work)')
  } else if (bg.tasks > 0 || (bg.crons ?? 0) > 0) {
    const parts: string[] = []
    if (bg.tasks > 0) parts.push(`${bg.tasks} task(s) still running`)
    if ((bg.crons ?? 0) > 0) parts.push(`${bg.crons} scheduled wakeup(s) pending (cron, ScheduleWakeup or /loop)`)
    add('background', BG, 'fail', `${parts.join(', ')} as of the last turn end`)
  } else if (bg.crons === undefined) {
    add('background', BG, 'unknown', 'no tasks running, but the last Stop did not list scheduled wakeups')
  } else {
    add('background', BG, 'pass', 'none running or scheduled as of the last turn end')
  }

  return rows
}

export function isReady(rows: readonly Row[]): boolean {
  return rows.length > 0 && rows.every(r => r.status === 'pass')
}

/**
 * A sibling worktree is stale only on positive evidence: a merged PR whose head branch AND
 * head SHA equal the worktree's. `git branch --merged` is not evidence, because it also lists a
 * live session's brand-new branch that sits at the base tip with no commits of its own.
 */
export function prMergedAtHead(f: Facts, w: Worktree): boolean {
  return mergedAtHead(f.ghMerged ?? [], w)
}

/** The one matching rule: head branch AND head SHA. A name alone may be an older PR's reused branch. */
export function mergedAtHead(list: readonly { name: string; oid: string }[], w: Worktree): boolean {
  return list.some(m => m.name === w.branch && m.oid === w.head)
}

/** Rows whose fix is model work: raise the PR, push, fix CI, merge on green, rebase. */
const MODEL_ROWS: readonly RowId[] = ['pushed', 'pr', 'ci', 'base', 'merged']

export function needsModel(rows: readonly Row[]): boolean {
  return rows.some(r => r.status === 'fail' && MODEL_ROWS.includes(r.id))
}

export function render(f: Facts, rows: readonly Row[], notes: readonly string[]): string {
  const width = Math.max(...rows.map(r => r.check.length))
  const lines = [
    `/wrap close-out: ${show(f.branch ?? 'detached HEAD')} @ ${short(f.head)}`,
    ...rows.map(r => `${r.status.padEnd(8)}${r.check.padEnd(width + 2)}${r.reason}`),
  ]
  if (notes.length > 0) lines.push('', ...notes)
  lines.push('', `Ready to archive: ${isReady(rows) ? 'yes' : 'no'}`)
  return lines.join('\n')
}

/** The canonical close-out prompt. The merge rule is restated because nothing in the mod enforces it. */
export function closeoutPrompt(defaultBranch: string): string {
  const base = `origin/${defaultBranch}`
  return [
    `Close out this session's work (the /wrap checklist found items open). Only if this session's brief authorized shipping: a read-only session ends with a report, never a PR, branch or remote change.`,
    `1. Re-check git status. If the tree is dirty, report what is dirty; do not commit files you did not change.`,
    `2. If commits are unpushed, push the branch. If there is no PR, raise one against ${defaultBranch}.`,
    `3. Read CI for the PR's CURRENT head: confirm the PR headRefOid equals git rev-parse HEAD. Red or stale CI is fixed or reported, never merged over.`,
    `4. Merge only when CI is green on that head, and re-verify against current ${defaultBranch} right before merging: fetch ${defaultBranch}, confirm ${base} is already in the branch (rebase and re-run CI if not). Never rely on auto-merge to gate it.`,
    `5. After the merge: delete this session's merged remote branch and run git fetch --prune. Do not remove any other worktree or branch, since one may belong to a live session; name any the checklist flagged as stale in your report instead.`,
    `6. Report to the lead: what actually ran and passed, what is merged, what is still pending, and the PR link. Do not archive the session.`,
  ].join('\n')
}

export function parseArgs(args: string): { dry: boolean; archive: boolean; resend: boolean; unknown: string[] } {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const unknown: string[] = []
  let dry = false
  let archive = false
  let resend = false
  for (const t of tokens) {
    if (t === '--dry') dry = true
    else if (t === '--archive') archive = true
    else if (t === '--resend') resend = true
    else unknown.push(show(t, 30))
  }
  return { dry, archive, resend, unknown }
}
