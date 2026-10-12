import { expect, test } from 'claude-code/testing'

import { classifyCi, evaluate, isNoPr, mergedAtHead, parsePr, prMergedAtHead, readBackground, render, safeBranch, show } from './checks'
import type { Facts } from './checks'

const A = 'a'.repeat(40)
const facts = (over: Partial<Facts> = {}): Facts => ({
  cwd: '/w/feat',
  head: A,
  branch: 'feat',
  dirtyCount: 0,
  defaultBranch: 'main',
  hasOrigin: true,
  fetchOk: true,
  ahead: 1,
  baseContained: true,
  headInBase: false,
  upstream: { exists: true, ahead: 0 },
  pr: { kind: 'none' },
  worktrees: [],
  background: { tasks: [] },
  ...over,
})
const OPTS = { acceptSkippedChecks: false }

test('table rows carry pass, fail and unknown with a reason, and the last line is the verdict', () => {
  const rows = evaluate(facts({ dirtyCount: 3, hasOrigin: false, fetchOk: undefined, background: null }), OPTS)
  const text = render(facts(), rows, ['a note'])
  expect(text).toMatch(/fail\s+Working tree clean\s+3 changed/)
  expect(text).toMatch(/unknown\s+Fetched origin\/main\s+unknown \(no origin\)/)
  expect(text).toMatch(/unknown\s+No background tasks/)
  expect(text.split('\n').at(-1)).toBe('Ready to archive: no')
  expect(text).toContain('a note')
})

test('CI classification: success, pending, failure, empty, skipped and odd shapes', () => {
  const ok = { status: 'COMPLETED', conclusion: 'SUCCESS' }
  expect(classifyCi([ok, { state: 'SUCCESS' }], false).status).toBe('pass')
  expect(classifyCi([ok, { status: 'IN_PROGRESS', conclusion: '' }], false).status).toBe('fail')
  expect(classifyCi([ok, { status: 'COMPLETED', conclusion: 'CANCELLED' }], false).status).toBe('fail')
  expect(classifyCi([], false).reason).toContain('pending')
  expect(classifyCi(undefined, false).status).toBe('unknown')
  expect(classifyCi([ok, { weird: true }], false).status).toBe('unknown')
  expect(classifyCi([ok, { status: 'COMPLETED', conclusion: 'SKIPPED' }], false).status).toBe('fail')
  expect(classifyCi([ok, { status: 'COMPLETED', conclusion: 'SKIPPED' }], true).status).toBe('pass')
})

test('PR parsing refuses anything that is not a full SHA-bearing record', () => {
  expect(parsePr('{}').kind).toBe('unknown')
  expect(parsePr('not json').kind).toBe('unknown')
  expect(parsePr(JSON.stringify({ number: 1, state: 'OPEN', headRefOid: 'abc' })).kind).toBe('unknown')
  expect(parsePr(JSON.stringify({ number: 1, state: 'OPEN', headRefOid: A, statusCheckRollup: [] })).kind).toBe('pr')
})

test('names read from git are made safe before they reach argv or the terminal', () => {
  expect(safeBranch('-rf', 'main')).toBe('main')
  expect(safeBranch('a..b', 'main')).toBe('main')
  expect(safeBranch('release/1.2', 'main')).toBe('release/1.2')
  expect(show('feat\u001b[31mred')).toBe('feat?[31mred')
})

test('"no pull requests found" is the only stderr read as "no PR"', () => {
  expect(isNoPr('no pull requests found for branch "feat"')).toBe(true)
  expect(isNoPr('No Pull Requests Found')).toBe(true)
  expect(isNoPr('')).toBe(false)
  expect(isNoPr('HTTP 502: bad gateway')).toBe(false)
  expect(isNoPr('could not resolve to a PullRequest')).toBe(false)
})

test('a sibling is PR-merged only when branch AND head SHA both match', () => {
  const B = 'b'.repeat(40)
  const C = 'c'.repeat(40)
  const w = { path: '/w/old', head: B, branch: 'old' }
  expect(mergedAtHead([{ name: 'old', oid: B }], w)).toBe(true)
  // A reused branch name whose PR merged at another head is not this worktree.
  expect(mergedAtHead([{ name: 'old', oid: C }], w)).toBe(false)
  expect(mergedAtHead([{ name: 'other', oid: B }], w)).toBe(false)
  expect(prMergedAtHead(facts({ ghMerged: [{ name: 'old', oid: C }] }), w)).toBe(false)
  // End to end through evaluate: a clean sibling with a name-only match is not stale.
  const rows = evaluate(
    facts({
      worktrees: [{ path: '/w/main', head: A, branch: 'main' }, w],
      ghMerged: [{ name: 'old', oid: C }],
      ghUnanswered: 0,
      siblingDirty: { '/w/old': 0 },
    }),
    OPTS,
  )
  expect(rows.find(r => r.id === 'worktrees')?.status).toBe('pass')
})

test('background row: tasks and crons both count; an unlisted cron field is unknown, never pass', () => {
  expect(readBackground(null)).toBe(undefined)
  expect(readBackground({ tasks: [] })).toEqual({ tasks: 0, crons: undefined, source: 'stop' })
  expect(readBackground({ tasks: [], crons: [{ id: 'c1' }] })).toEqual({ tasks: 0, crons: 1, source: 'stop' })
  const row = (background: unknown) => evaluate(facts({ background }), OPTS).find(r => r.id === 'background')
  expect(row({ tasks: [], crons: [] })?.status).toBe('pass')
  expect(row({ tasks: [], crons: [{ id: 'c1' }] })?.status).toBe('fail')
  expect(row({ tasks: [{ id: 't' }], crons: [{ id: 'c1' }] })?.reason).toBe(
    '1 task(s) still running, 1 scheduled wakeup(s) pending (cron, ScheduleWakeup or /loop) as of the last turn end',
  )
  expect(row({ tasks: [] })?.status).toBe('unknown')
})
