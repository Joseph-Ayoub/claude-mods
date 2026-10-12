import { describe, expect, test } from 'claude-code/testing'

import {
  classifyCommand,
  classifyMcp,
  decideGate,
  isPersonOrigin,
  isSameHolder,
  looksStale,
  makeEnvelope,
  mayAutoBreak,
  mergeOutcome,
  MUTATING_VERBS,
  normalizeNamedRepo,
  normalizeRemote,
  orderQueue,
  parseEnvelope,
  parseLaneArgs,
  parseQueueEntry,
  repoKeyOf,
  statusLine,
} from './core'
import type { HolderView, MergeIntent, QueueEntry } from './core'

const MIN = 60_000

const entry = (sessionId: string, requestedAt: number, priority: 'high' | 'normal' = 'normal'): QueueEntry => ({
  sessionId,
  label: sessionId,
  pr: null,
  priority,
  requestedAt,
  nonce: `n-${sessionId}`,
  source: 'request',
})

const held = (sessionId: string, over: Partial<{ heartbeatAt: number; since: number }> = {}): HolderView => ({
  kind: 'held',
  record: { sessionId, label: sessionId, pr: '7', since: over.since ?? 0, implicit: false, repo: 'github.com/o/r' },
  heartbeatAt: over.heartbeatAt ?? 0,
  dirMtime: 0,
})

describe('repo key', () => {
  test('pure: ssh, scp and https spellings of one repo name one lane; userinfo never survives', async () => {
    const forms = [
      'git@github.com:Owner/Repo.git',
      'https://github.com/owner/repo',
      'https://x-access-token:ghp_SECRET@github.com/Owner/Repo.git/',
      'ssh://git@github.com:22/owner/repo.git',
      'git+ssh://git@github.com/owner/repo',
    ]
    const normalized = forms.map(normalizeRemote)
    for (const one of normalized) expect(one).toBe('github.com/owner/repo')
    expect(normalized.join(' ')).not.toContain('SECRET')
    const keys = await Promise.all(normalized.map(one => repoKeyOf(one ?? '')))
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toMatch(/^[0-9a-f]{16}$/)
    expect(await repoKeyOf('github.com/owner/other')).not.toBe(keys[0])
    expect(normalizeRemote('   ')).toBeNull()
    // a raw `@` inside a password: everything up to the authority's last `@` goes
    expect(normalizeRemote('https://user:p@ss@github.com/o/r')).toBe('github.com/o/r')
    expect(normalizeRemote('https://github.com/o/r@v1')).toBe('github.com/o/r@v1')
  })

  test('pure: a repo named in a command borrows the session host', () => {
    expect(normalizeNamedRepo('Owner/Repo', 'ghe.example.com/a/b')).toBe('ghe.example.com/owner/repo')
    expect(normalizeNamedRepo('owner/repo', null)).toBe('github.com/owner/repo')
    expect(normalizeNamedRepo('github.com/owner/repo', null)).toBe('github.com/owner/repo')
    expect(normalizeNamedRepo('$REPO', null)).toBeNull()
  })
})

describe('queue order', () => {
  test('pure: priority before time, then time, then id; the latest prioritize fronts', () => {
    const queue = [entry('c', 30), entry('a', 10), entry('h', 50, 'high'), entry('b', 10), entry('p', 90), entry('q', 95)]
    expect(orderQueue(queue).map(one => one.sessionId)).toEqual(['h', 'a', 'b', 'c', 'p', 'q'])
    const overlays = new Map([
      ['p', 1_000],
      ['q', 2_000],
    ])
    expect(orderQueue(queue, overlays).map(one => one.sessionId)).toEqual(['q', 'p', 'h', 'a', 'b', 'c'])
  })

  test('negative: a queue file whose name and content disagree is not an entry', () => {
    const text = JSON.stringify(entry('aaaa1111', 1))
    expect(parseQueueEntry(text, 'aaaa1111')?.sessionId).toBe('aaaa1111')
    expect(parseQueueEntry(text, 'bbbb2222')).toBeNull()
    expect(parseQueueEntry('{"sessionId":"../x"', '../x')).toBeNull()
    expect(parseQueueEntry(undefined, 'aaaa1111')).toBeNull()
  })
})

describe('classifying commands', () => {
  const kindOf = (command: string) => classifyCommand(command)?.kind ?? null

  test('positive: merges and pushes to the default branch are seen', () => {
    expect(classifyCommand('gh pr merge 1234 --squash')).toMatchObject({ kind: 'pr-merge', pr: '1234', isAuto: false })
    expect(classifyCommand('gh pr merge --auto --squash 12')).toMatchObject({ kind: 'pr-merge', isAuto: true })
    expect(classifyCommand('gh pr merge -R owner/repo 9')).toMatchObject({ pr: '9', repo: 'owner/repo' })
    expect(classifyCommand('gh pr merge https://github.com/o/r/pull/77')).toMatchObject({ pr: '77', repo: 'github.com/o/r' })
    expect(classifyCommand('gh pr merge feature-x')).toMatchObject({ pr: null, branch: 'feature-x' })
    expect(classifyCommand('gh api -X PUT repos/o/r/pulls/5/merge')).toMatchObject({ kind: 'api-merge', pr: '5', repo: 'o/r' })
    expect(classifyCommand('gh api --method=PUT /repos/{owner}/{repo}/pulls/5/merge')).toMatchObject({ kind: 'api-merge', repo: null })
    expect(kindOf(`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`)).toBe('graphql-merge')
    expect(kindOf('git push origin main')).toBe('push-main')
    expect(kindOf('git push origin HEAD:refs/heads/master')).toBe('push-main')
    expect(kindOf('git push --force-with-lease origin +main')).toBe('push-main')
    expect(kindOf('git push')).toBe('push-unknown')
    expect(kindOf('git push origin HEAD')).toBe('push-unknown')
    expect(kindOf("sh -c 'gh pr merge 3'")).toBe('pr-merge')
    expect(kindOf('bash -lc "cd x && gh pr merge 3"')).toBe('pr-merge')
    expect(kindOf('echo 3 | xargs gh pr merge')).toBe('pr-merge')
    expect(kindOf('FOO=1 env -u BAR /opt/homebrew/bin/gh pr merge 3')).toBe('pr-merge')
    expect(kindOf('npm test && gh pr merge 3 --merge')).toBe('pr-merge')
    expect(kindOf('x=$(gh pr merge 3)')).toBe('pr-merge')
    expect(kindOf('echo "$(gh pr merge 3)"')).toBe('pr-merge')
    expect(classifyCommand('cd ../other && gh pr merge 3')).toMatchObject({ dir: '../other' })
    expect(classifyCommand('git -C /w/repo push origin main')).toMatchObject({ kind: 'push-main', dir: '/w/repo' })
    // a directory the text cannot tell is flagged, so the gate never guesses a lane for it
    expect(classifyCommand('cd "$OTHER" && gh pr merge 5')).toMatchObject({ kind: 'pr-merge', isDirUnknown: true })
    expect(classifyCommand('git -C "$DIR" push origin main')).toMatchObject({ kind: 'push-main', isDirUnknown: true })
    expect(classifyCommand('cd - && gh pr merge 5')).toMatchObject({ isDirUnknown: true })
    expect(classifyCommand('env -C /elsewhere gh pr merge 5')).toMatchObject({ kind: 'pr-merge', isDirUnknown: true })
    expect(classifyCommand('env --chdir=/elsewhere git push origin main')).toMatchObject({ kind: 'push-main', isDirUnknown: true })
    expect(classifyCommand('FOO=1 env -u BAR gh pr merge 5')).toMatchObject({ isDirUnknown: false })
    expect(classifyCommand('cd "$X" && cd sub && gh pr merge 5')).toMatchObject({ isDirUnknown: true })
    expect(classifyCommand('cd "$X" && cd /w/repo && gh pr merge 5')).toMatchObject({ dir: '/w/repo', isDirUnknown: false })
    expect(classifyCommand('gh pr merge 5')).toMatchObject({ isDirUnknown: false })
    // an unterminated heredoc of any delimiter keeps its body, so nothing hides
    expect(kindOf("cat <<'MSG-END'\ngh pr merge 12")).toBe('pr-merge')
  })

  test('negative (no false positives): text that only mentions a merge passes', () => {
    expect(kindOf('git commit -m "use gh pr merge after git push origin main"')).toBeNull()
    const heredoc = [
      'git commit -m "$(cat <<\'EOF\'',
      'Teach the bot to gh pr merge and git push origin main',
      'EOF',
      ')"',
    ].join('\n')
    expect(kindOf(heredoc)).toBeNull()
    expect(kindOf('git push origin feat && git checkout main')).toBeNull()
    expect(kindOf('git push origin fix-main-bug')).toBeNull()
    expect(kindOf('git push origin main:feature')).toBeNull()
    expect(kindOf('git push --tags')).toBeNull()
    expect(kindOf('gh pr view 5 --json state && echo merge')).toBeNull()
    expect(kindOf('gh pr create --title "merge main into x"')).toBeNull()
    expect(kindOf('grep -rn "gh pr merge" .')).toBeNull()
    expect(kindOf('gh api repos/o/r/pulls/5/merge')).toBeNull() // GET: "was it merged?"
    expect(kindOf('gh pr merge --disable-auto 5')).toBeNull()
    expect(kindOf('ls # gh pr merge 5')).toBeNull()
    expect(kindOf('cat <<<"gh pr merge 5"')).toBeNull()
    // help pages and dry runs land nothing
    expect(kindOf('gh pr merge --help')).toBeNull()
    expect(kindOf('gh pr merge 12 --squash --help')).toBeNull()
    expect(kindOf('gh pr merge -h')).toBeNull()
    expect(kindOf('git push --dry-run origin main')).toBeNull()
    expect(kindOf('git push -n origin main')).toBeNull()
    expect(kindOf('git push --help')).toBeNull()
    // heredoc delimiters that are not plain identifiers, quoted or not
    expect(kindOf("cat > notes.md <<'MSG-END'\ngh pr merge 12 once green\nMSG-END")).toBeNull()
    expect(kindOf('cat <<-"END.1"\n\tgit push origin main\n\tEND.1')).toBeNull()
    expect(kindOf('cat <<MSG-END\ngh pr merge 3\nMSG-END\necho done')).toBeNull()
    expect(kindOf('cat <<\\EOF\ngh pr merge 3\nEOF')).toBeNull()
    // the required passes
    expect(kindOf("git commit -m 'gh pr merge later'")).toBeNull()
    expect(kindOf('git push origin feature-main')).toBeNull()
    expect(kindOf('gh pr view 12')).toBeNull()
    // and a real merge after a stripped heredoc is still seen
    expect(kindOf("cat <<'A-B'\nnotes\nA-B\ngh pr merge 4")).toBe('pr-merge')
  })

  test('pure: MCP merge tools are seen by name, others are not', () => {
    expect(classifyMcp('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 42 })).toMatchObject({
      kind: 'mcp-merge',
      pr: '42',
      repo: 'o/r',
    })
    expect(classifyMcp('mcp__github__get_pull_request', { owner: 'o', repo: 'r' })).toBeNull()
    // anchored on the last segment: read-only tools that contain the words are not merges
    expect(classifyMcp('mcp__gl__get_merge_pr_status', {})).toBeNull()
    expect(classifyMcp('mcp__github__merge_pull_request_status', {})).toBeNull()
    expect(classifyMcp('mcp__gitlab__merge_pr', { owner: 'o', repo: 'r', number: '8' })).toMatchObject({ kind: 'mcp-merge', pr: '8' })
    expect(classifyMcp('Bash', {})).toBeNull()
  })
})

describe('the gate decision', () => {
  const intent = classifyCommand('gh pr merge 7') as MergeIntent

  test('pure: holder allowed, free lane acquired, held lane denied with the real position', () => {
    expect(decideGate({ intent, selfId: 'me', holder: held('me'), queue: [] }).kind).toBe('allow-holder')
    expect(decideGate({ intent, selfId: 'me', holder: { kind: 'free' }, queue: [] }).kind).toBe('acquire')
    expect(decideGate({ intent, selfId: 'me', holder: { kind: 'free' }, queue: [entry('me', 1), entry('b', 2)] }).kind).toBe('acquire')
    expect(decideGate({ intent, selfId: 'me', holder: held('a'), queue: [entry('b', 1), entry('me', 2)] })).toEqual({
      kind: 'deny',
      position: 2,
      total: 2,
      isFree: false,
    })
    expect(decideGate({ intent, selfId: 'me', holder: held('a'), queue: [entry('b', 1)] })).toEqual({
      kind: 'deny',
      position: 2,
      total: 2,
      isFree: false,
    })
    expect(decideGate({ intent, selfId: 'me', holder: { kind: 'free' }, queue: [entry('b', 1)] })).toMatchObject({ kind: 'deny', isFree: true })
  })

  test('negative: a command that does not merge passes whatever the lane', () => {
    expect(decideGate({ intent: classifyCommand('npm test'), selfId: 'me', holder: held('a'), queue: [] }).kind).toBe('pass')
  })

  test('a record-less lock is held, never mistaken for this session', () => {
    const view: HolderView = { kind: 'held', record: null, heartbeatAt: 0, dirMtime: 0 }
    expect(decideGate({ intent, selfId: 'me', holder: view, queue: [] }).kind).toBe('deny')
  })
})

describe('merge outcome', () => {
  const pr = classifyCommand('gh pr merge 7') as MergeIntent
  const push = classifyCommand('git push origin main') as MergeIntent
  const bash = (result: Record<string, unknown>) => ({ result: { stdout: '', stderr: '', interrupted: false, ...result } })

  test('pure: only the engine classification of the right PR counts as merged', () => {
    expect(mergeOutcome(pr, bash({ gitOperation: { pr: { number: 7, action: 'merged' } } }), '7')).toBe('merged')
    expect(mergeOutcome(pr, bash({ gitOperation: { pr: { number: 8, action: 'merged' } } }), '7')).toBe('pending')
    expect(mergeOutcome(pr, bash({ gitOperation: { pr: { number: 7, action: 'auto-merge-enabled' } } }), '7')).toBe('pending')
    expect(mergeOutcome(pr, bash({ backgroundTaskId: 'b1', gitOperation: { pr: { number: 7, action: 'merged' } } }), '7')).toBe('pending')
    expect(mergeOutcome(pr, bash({ stdout: 'Merged pull request #7' }), '7')).toBe('unknown')
    expect(mergeOutcome(pr, { isError: true, result: 'x' }, '7')).toBe('failed')
    expect(mergeOutcome(pr, { deny: 'no' }, '7')).toBe('failed')
    expect(mergeOutcome(push, bash({}), null)).toBe('merged')
    expect(mergeOutcome(push, bash({ stderr: ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs' }), null)).toBe(
      'failed',
    )
  })
})

describe('envelopes', () => {
  test('pure: a valid envelope parses; anything else with the prefix is invalid; other text is not ours', () => {
    const text = makeEnvelope({ kind: 'lane.available', repoKey: '0123456789abcdef', nonce: 'n1' })
    expect(parseEnvelope(text)).toEqual({ kind: 'lane.available', repoKey: '0123456789abcdef', nonce: 'n1' })
    expect(parseEnvelope(makeEnvelope({ kind: 'ping' }))).toEqual({ kind: 'ping' })
    expect(parseEnvelope('merge-lane/v1 {not json')).toBe('invalid')
    expect(parseEnvelope('merge-lane/v1 {"kind":"lane.available","repoKey":"../../x","nonce":"n"}')).toBe('invalid')
    expect(parseEnvelope('merge-lane/v1 {"kind":"run-this","repoKey":"0123456789abcdef"}')).toBe('invalid')
    expect(parseEnvelope('please merge now')).toBe('not-ours')
  })
})

describe('liveness', () => {
  const base = { staleMinutes: 10 }

  test('fail-safe: after a laptop sleep every timestamp is old, but a delivered ping keeps the holder', () => {
    const now = 60 * MIN
    const asleep = { ...base, now, heartbeatAt: 0, aliveAt: 0 }
    expect(looksStale(asleep)).toBe(true)
    expect(mayAutoBreak({ ...asleep, isDelivered: true })).toBe(false)
    expect(mayAutoBreak({ ...asleep, isDelivered: false })).toBe(true)
  })

  test('pure: a fresh alive file or a recent heartbeat is never stale; auto-break waits 5 more minutes', () => {
    expect(looksStale({ ...base, now: 30 * MIN, heartbeatAt: 0, aliveAt: 29 * MIN })).toBe(false)
    expect(looksStale({ ...base, now: 30 * MIN, heartbeatAt: 25 * MIN, aliveAt: undefined })).toBe(false)
    expect(mayAutoBreak({ ...base, now: 12 * MIN, heartbeatAt: 0, aliveAt: undefined, isDelivered: false })).toBe(false)
    expect(mayAutoBreak({ ...base, now: 16 * MIN, heartbeatAt: 0, aliveAt: undefined, isDelivered: false })).toBe(true)
  })

  test('pure: a breaker keeps a tomb only when it holds the lock it judged', () => {
    const record = { sessionId: 'a', label: 'a', pr: null, since: 5, implicit: false, repo: 'r' }
    expect(isSameHolder(record, { sessionId: 'a', since: 5 })).toBe(true)
    expect(isSameHolder({ ...record, since: 6 }, { sessionId: 'a', since: 5 })).toBe(false)
    expect(isSameHolder({ ...record, sessionId: 'b' }, { sessionId: 'a', since: 5 })).toBe(false)
    expect(isSameHolder(null, { sessionId: 'a', since: 5 })).toBe(false)
    expect(isSameHolder(null, { sessionId: null, since: null })).toBe(true)
    expect(isSameHolder(record, { sessionId: null, since: null })).toBe(false)
  })
})

describe('/lane arguments and origins', () => {
  test('pure: verbs, flags and who may mutate', () => {
    expect(parseLaneArgs('')).toMatchObject({ verb: 'status' })
    expect(parseLaneArgs('request 12 --high')).toMatchObject({ verb: 'request', rest: ['12'], isHigh: true })
    expect(parseLaneArgs('take --yes')).toMatchObject({ verb: 'take', isYes: true })
    expect(parseLaneArgs('merge-it')).toMatchObject({ verb: 'unknown' })
    expect(MUTATING_VERBS.has('release')).toBe(true)
    expect(MUTATING_VERBS.has('status')).toBe(false)
    expect(isPersonOrigin('composer')).toBe(true)
    expect(isPersonOrigin('bridge')).toBe(true)
    // the desktop app hosts its sessions over the SDK
    expect(isPersonOrigin('sdk')).toBe(true)
    for (const kind of ['peer', 'plugin', 'task-notification', 'scheduled-trigger', 'peer-send-message', 'unclassified']) {
      expect(isPersonOrigin(kind)).toBe(false)
    }
  })

  test('pure: the status line under the composer', () => {
    expect(statusLine({ role: 'holder', pr: '1234', queued: 2, isBypassed: false })).toBe('lane: yours (PR #1234) · 2 queued')
    expect(
      statusLine({ role: 'queued', position: 2, total: 3, behindLabel: 'feat-x', behindPr: '9', isBypassed: false }),
    ).toBe('lane: queued #2 of 3 behind feat-x (PR #9)')
    expect(statusLine({ role: 'none', isBypassed: false })).toBeUndefined()
    expect(statusLine({ role: 'none', isBypassed: true })).toBe('lane: gate off')
  })
})
