// Gathers the facts /wrap judges, through an injected runner so tests can feed
// canned process results. Every call is argv-only (no shell) with an explicit
// timeout; network calls (fetch, gh) get 60 s, local git 15 s. A call that
// cannot complete becomes `undefined`/'unknown' in Facts, never a pass.

import { candidates, isNoPr, mergedAtHead, parsePr, parseWorktrees, prMergedAtHead, safeBranch } from './checks'
import type { Facts, Proc, Run } from './checks'

const LOCAL_MS = 15000
const NET_MS = 60000
const MAX_SIBLING_READS = 20
/** Per-branch merged-PR queries per /wrap; siblings past it read unknown. */
const MAX_GH_QUERIES = 20
/** Page size per branch: a full page may have cut off the matching PR, so only a match settles it. */
const MERGED_PAGE = 30

const ok = (p: Proc): p is Extract<Proc, { kind: 'exit' }> => p.kind === 'exit' && p.code === 0
const text = (p: Proc) => (p.kind === 'exit' ? p.out.trim() : '')

const PR_FIELDS = 'number,state,headRefOid,baseRefName,mergedAt,mergeStateStatus,statusCheckRollup,url'

export async function collect(run: Run, cwd: string, background: unknown): Promise<Facts> {
  // Stage 1: independent reads, in parallel.
  const [head, status, branch, symref, remotes, top, wtList, prView, upstreamName] = await Promise.all([
    run(['git', 'rev-parse', 'HEAD'], LOCAL_MS),
    run(['git', 'status', '--porcelain'], LOCAL_MS),
    run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], LOCAL_MS),
    run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], LOCAL_MS),
    run(['git', 'remote'], LOCAL_MS),
    run(['git', 'rev-parse', '--show-toplevel'], LOCAL_MS),
    run(['git', 'worktree', 'list', '--porcelain'], LOCAL_MS),
    run(['gh', 'pr', 'view', '--json', PR_FIELDS], NET_MS),
    run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], LOCAL_MS),
  ])

  const defaultBranch = safeBranch(
    ok(symref) ? text(symref).replace(/^origin\//, '') : undefined,
    'main',
  )
  const base = `origin/${defaultBranch}`
  const hasOrigin = remotes.kind === 'exit' && remotes.code === 0
    ? remotes.out.split('\n').some(l => l.trim() === 'origin')
    : undefined

  const headSha = ok(head) && /^[0-9a-f]{40}$/.test(text(head)) ? text(head) : undefined

  // The kind is tested first: after an `ok()` miss its type guard would also rule out
  // a non-zero exit, which is exactly where gh says "no pull requests found".
  let pr: Facts['pr']
  if (prView.kind !== 'exit') pr = { kind: 'unknown' }
  else if (prView.code === 0) pr = parsePr(prView.out)
  else if (isNoPr(prView.err)) pr = { kind: 'none' }
  else pr = { kind: 'unknown' }

  // Stage 2: the one fetch (only when there is an origin to fetch from).
  let fetchOk: boolean | undefined
  if (hasOrigin === true) fetchOk = ok(await run(['git', 'fetch', 'origin', defaultBranch], NET_MS))

  // Stage 3: ancestry reads against the (now fresher) origin ref.
  const upstreamRef = ok(upstreamName) ? text(upstreamName) : ''
  const [aheadP, baseInHead, headInBaseP, upAhead] = await Promise.all([
    run(['git', 'rev-list', '--count', `${base}..HEAD`], LOCAL_MS),
    run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'], LOCAL_MS),
    run(['git', 'merge-base', '--is-ancestor', 'HEAD', base], LOCAL_MS),
    upstreamRef
      ? run(['git', 'rev-list', '--count', '@{u}..HEAD'], LOCAL_MS)
      : Promise.resolve<Proc>({ kind: 'failed' }),
  ])

  // is-ancestor: 0 yes, 1 no, anything else (128: bad ref) could not be told.
  const ancestor = (p: Proc): boolean | undefined =>
    p.kind === 'exit' && (p.code === 0 || p.code === 1) ? p.code === 0 : undefined
  const count = (p: Proc): number | undefined =>
    ok(p) && /^\d+$/.test(text(p)) ? Number(text(p)) : undefined

  // "no upstream configured" is a known fact (exit 128, empty result) as long as the
  // tree answered the other git calls; a failed run stays unknown.
  let upstream: Facts['upstream']
  if (upstreamRef) upstream = { exists: true, ahead: count(upAhead) }
  else if (upstreamName.kind === 'exit' && headSha !== undefined) upstream = { exists: false }

  const facts: Facts = {
    cwd,
    head: headSha,
    branch: ok(branch) ? text(branch) : undefined,
    dirtyCount: ok(status) ? status.out.split('\n').filter(l => l.length > 0).length : undefined,
    defaultBranch,
    hasOrigin,
    fetchOk,
    ahead: count(aheadP),
    baseContained: ancestor(baseInHead),
    headInBase: ancestor(headInBaseP),
    upstream,
    pr,
    worktrees: ok(wtList) ? parseWorktrees(wtList.out) : undefined,
    selfRoot: ok(top) ? text(top) : undefined,
    background,
  }

  // Stage 4: which sibling worktrees sit at a merged PR's head, asked per head branch: one
  // repo-wide list would silently miss PRs merged before its last page. Only asked when there
  // are siblings. `git branch --merged` is deliberately not used: it also lists a live
  // session's fresh branch at the base tip (see prMergedAtHead).
  const others = candidates(facts)
  if (others.length === 0) return facts
  const asked = others.slice(0, MAX_GH_QUERIES)
  const answers = await Promise.all(
    asked.map(w =>
      // The name goes into argv: only an allow-listed name that is exactly the branch is asked.
      w.branch !== undefined && safeBranch(w.branch, '') === w.branch
        ? run(
            ['gh', 'pr', 'list', '--state', 'merged', '--head', w.branch, '--limit', String(MERGED_PAGE), '--json', 'headRefName,headRefOid'],
            NET_MS,
          )
        : Promise.resolve<Proc>({ kind: 'failed' }),
    ),
  )
  let unanswered = others.length - asked.length
  let mergedPrs: { name: string; oid: string }[] | undefined
  asked.forEach((w, i) => {
    const p = answers[i]
    const list = p !== undefined && ok(p) ? parseMerged(p.out) : undefined
    if (list === undefined) {
      unanswered++
      return
    }
    mergedPrs = [...(mergedPrs ?? []), ...list]
    if (list.length >= MERGED_PAGE && !mergedAtHead(list, w)) unanswered++
  })
  facts.ghMerged = mergedPrs
  facts.ghUnanswered = unanswered

  // Stage 5: a PR-merged sibling still holding uncommitted work is live, never stale, so
  // read its tree. Capped: past the cap a sibling stays unread, which reads unknown.
  // A prunable entry's folder is gone: `git -C` there could climb into an enclosing repo and
  // read its tree instead, so it is never read and stays unknown (the row names the fix).
  const merged = others.filter(w => prMergedAtHead(facts, w) && w.prunable !== true).slice(0, MAX_SIBLING_READS)
  const trees = await Promise.all(
    merged.map(w => run(['git', '-C', w.path, 'status', '--porcelain'], LOCAL_MS)),
  )
  const dirty: Record<string, number> = {}
  merged.forEach((w, i) => {
    const t = trees[i]
    if (t !== undefined && ok(t)) dirty[w.path] = t.out.split('\n').filter(l => l.length > 0).length
  })
  facts.siblingDirty = dirty
  return facts
}

function parseMerged(out: string): { name: string; oid: string }[] | undefined {
  try {
    const j: unknown = JSON.parse(out)
    if (!Array.isArray(j)) return undefined
    const res: { name: string; oid: string }[] = []
    for (const x of j) {
      const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>
      if (typeof o.headRefName === 'string' && typeof o.headRefOid === 'string') {
        res.push({ name: o.headRefName, oid: o.headRefOid })
      }
    }
    return res
  } catch {
    return undefined
  }
}
