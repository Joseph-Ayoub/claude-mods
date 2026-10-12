import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

type Canned = { code: number; out?: string; err?: string }

const pr = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 7,
    state: 'MERGED',
    headRefOid: A,
    baseRefName: 'main',
    mergedAt: '2026-10-09T00:00:00Z',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    url: 'https://example.invalid/pr/7',
    ...over,
  })

const CWD = '/w/feat'
const wtList = `worktree /w/main\nHEAD ${B}\nbranch refs/heads/main\n\nworktree ${CWD}\nHEAD ${A}\nbranch refs/heads/feat\n`

/** A repo whose PR is merged and whose tree is clean: every row passes. */
const world = (over: Record<string, Canned | 'deny'> = {}): Record<string, Canned | 'deny'> => ({
  'git rev-parse HEAD': { code: 0, out: A + '\n' },
  'git status --porcelain': { code: 0, out: '' },
  'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'feat\n' },
  'git symbolic-ref --short refs/remotes/origin/HEAD': { code: 0, out: 'origin/main\n' },
  'git remote': { code: 0, out: 'origin\n' },
  'git rev-parse --show-toplevel': { code: 0, out: CWD + '\n' },
  'git worktree list --porcelain': { code: 0, out: wtList },
  'gh pr view --json number,state,headRefOid,baseRefName,mergedAt,mergeStateStatus,statusCheckRollup,url': {
    code: 0,
    out: pr(),
  },
  'git rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, out: 'origin/feat\n' },
  'git fetch origin main': { code: 0 },
  'git rev-list --count origin/main..HEAD': { code: 0, out: '2\n' },
  'git merge-base --is-ancestor origin/main HEAD': { code: 0 },
  'git merge-base --is-ancestor HEAD origin/main': { code: 1 },
  'git rev-list --count @{u}..HEAD': { code: 0, out: '0\n' },
  ...over,
})
const PR_KEY = 'gh pr view --json number,state,headRefOid,baseRefName,mergedAt,mergeStateStatus,statusCheckRollup,url'
/** The per-branch merged-PR query /wrap makes for a sibling worktree. */
const mergedKey = (branch: string) => `gh pr list --state merged --head ${branch} --limit 30 --json headRefName,headRefOid`
const ARCHIVE = 'mcp__ccd_session_mgmt__archive_session'
const open = (sha: string) => pr({ state: 'OPEN', mergedAt: null, headRefOid: sha, statusCheckRollup: [] })

type Setup = { tools?: string[]; surfaces?: string[]; submit?: 'enter' | 'drop' }

/** Answers the engine beneath the plugin: process.run from a table, cwd, surfaces, tools, submits and toasts. */
function setup(_$: Engine, on: On, table: Record<string, Canned | 'deny'>, extra: Setup = {}) {
  const calls: string[] = []
  const submits: string[] = []
  const toasts: string[] = []
  on('process.run', (_$, e) => {
    const key = e.argv.join(' ')
    calls.push(key)
    const hit = table[key]
    // An argv the table does not know is a failed command, like a missing binary would be.
    if (hit === undefined || hit === 'deny') return { deny: 'unavailable' } as never
    return {
      value: { exitCode: hit.code, stdout: hit.out ?? '', stderr: hit.err ?? '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_$, e) => {
    submits.push(e.text)
    // 'enter' stands for the prompt entering the session; 'drop' for a hook or settings block refusing it.
    return extra.submit === 'drop' ? { drop: 'test' } : { text: e.text }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('session.surfaces', () => ({ value: (extra.surfaces ?? ['desktop']) as never }))
  on('tool.list', () => ({
    value: (extra.tools ?? []).map(name => ({ name, description: 'test', mcp: true })),
  }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { calls, submits, toasts }
}

const PERSON: PromptOrigin = { kind: 'composer' }

/** Runs /wrap as the person typing it, unless another origin is given. */
const wrap = async ($: Engine, args = '', origin: PromptOrigin = PERSON) =>
  (await $.command.run({ command: 'wrap', args, origin } as never)).text ?? ''

const greenStop = ($: Engine) => $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })

test('positive: a merged, clean, in-sync repo passes every row and sends nothing', async ($, on) => {
  const { submits } = setup($, on, world())
  await greenStop($)
  const text = await wrap($)
  expect(text).toContain('Ready to archive: yes')
  expect(text).toContain('ready to archive (use the app)')
  expect(text).not.toMatch(/\b(fail|unknown)\b/)
  expect(submits.length).toBe(0)
})

test('negative: red CI on the current head fails, never passes, and is not mistaken for another head', async ($, on) => {
  const red = pr({ state: 'OPEN', mergedAt: null, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })
  setup($, on, world({ [PR_KEY]: { code: 0, out: red }, 'git merge-base --is-ancestor HEAD origin/main': { code: 1 } }))
  const text = await wrap($, '--dry')
  expect(text).toMatch(/fail\s+CI green on current head\s+1 of 1 checks failing/)
  expect(text).toContain('Ready to archive: no')
})

test('negative: green checks that belong to an older SHA do not count for HEAD', async ($, on) => {
  const stale = pr({ state: 'OPEN', mergedAt: null, headRefOid: B })
  setup($, on, world({ [PR_KEY]: { code: 0, out: stale } }))
  const text = await wrap($, '--dry')
  expect(text).toMatch(/fail\s+CI green on current head\s+checks belong to bbbbbbb/)
  expect(text).toMatch(/fail\s+Commits pushed/)
})

test('negative: an empty rollup is pending, not green', async ($, on) => {
  setup($, on, world({ [PR_KEY]: { code: 0, out: open(A) } }))
  expect(await wrap($, '--dry')).toMatch(/fail\s+CI green on current head\s+pending/)
})

test('fail-safe: missing gh, failed fetch and no Stop all read unknown and block readiness', async ($, on) => {
  setup($, on, world({ [PR_KEY]: 'deny', 'git fetch origin main': { code: 128 } }))
  const text = await wrap($, '--dry')
  expect(text).toMatch(/unknown\s+PR\s+gh pr view did not complete/)
  expect(text).toMatch(/unknown\s+CI green on current head/)
  expect(text).toMatch(/unknown\s+Fetched origin\/main/)
  expect(text).toMatch(/unknown\s+Base fresh/)
  expect(text).toMatch(/unknown\s+No background tasks or wakeups\s+unknown \(no turn end with a task list observed this session\)/)
  expect(text).toContain('Ready to archive: no')
})

test('fail-safe: unparseable PR output and a non-numeric count are unknown, and no raw output is echoed', async ($, on) => {
  setup($, on, world({
    [PR_KEY]: { code: 0, out: 'https://user:ghp_SECRET@example.invalid not json' },
    'git rev-list --count origin/main..HEAD': { code: 0, out: 'lots' },
  }))
  const text = await wrap($, '--dry')
  expect(text).toMatch(/unknown\s+PR\s/)
  expect(text).not.toContain('ghp_SECRET')
  expect(text).toContain('Ready to archive: no')
})

test('no origin remote marks fetch and base checks unknown (no origin)', async ($, on) => {
  setup(
    $,
    on,
    world({
      'git remote': { code: 0, out: '' },
      'git symbolic-ref --short refs/remotes/origin/HEAD': { code: 128 },
      [PR_KEY]: { code: 1 },
    }),
  )
  const text = await wrap($, '--dry')
  expect(text).toMatch(/unknown\s+Fetched origin\/main\s+unknown \(no origin\)/)
  expect(text).toMatch(/unknown\s+Base fresh vs origin\/main\s+unknown \(no origin\)/)
})

test('the close-out prompt is submitted once per head SHA, restates the merge rule, and --dry suppresses it', async ($, on) => {
  const table = world({ [PR_KEY]: { code: 0, out: open(A) } })
  const { submits } = setup($, on, table)
  const clock = mock.clock(on)
  const settle = () => clock.advance(1)

  await wrap($, '--dry')
  await settle()
  expect(submits.length).toBe(0)

  const first = await wrap($)
  expect(submits.length).toBe(0) // never from inside the command hook
  await settle()
  expect(first).toContain('Queued the close-out prompt')
  expect(submits.length).toBe(1)
  expect(submits[0]).toContain('re-verify against current main')
  expect(submits[0]).toContain('Report to the lead')
  expect(submits[0]).toContain('Do not remove any other worktree or branch')

  const second = await wrap($)
  await settle()
  expect(second).toContain('already sent for aaaaaaa')
  expect(submits.length).toBe(1)

  // A new head SHA may submit again.
  table['git rev-parse HEAD'] = { code: 0, out: B + '\n' }
  table[PR_KEY] = { code: 0, out: open(B) }
  await wrap($)
  await settle()
  expect(submits.length).toBe(2)
})

test('two quick /wraps before the timer fires still send one prompt', async ($, on) => {
  const { submits } = setup($, on, world({ [PR_KEY]: { code: 0, out: open(A) } }))
  const clock = mock.clock(on)
  const first = await $.command.run({ command: 'wrap', args: '', origin: PERSON } as never)
  // The row is already what the model reads: no second copy of the table as context.
  expect(first.text).toContain('Queued the close-out prompt')
  expect(first.context).toBeUndefined()
  await wrap($)
  await clock.advance(1)
  expect(submits.length).toBe(1)
})

test('a dropped submit releases the SHA, so the next /wrap tries again', async ($, on) => {
  const { submits } = setup($, on, world({ [PR_KEY]: { code: 0, out: open(A) } }), { submit: 'drop' })
  const clock = mock.clock(on)
  await wrap($)
  await clock.advance(1)
  expect(submits.length).toBe(1)
  const again = await wrap($)
  await clock.advance(1)
  expect(again).not.toContain('already sent')
  expect(submits.length).toBe(2)
})

test('origin gate: a /wrap run by a plugin, peer, task notification or unstamped origin shows the table but never submits', async ($, on) => {
  const { submits } = setup($, on, world({ [PR_KEY]: { code: 0, out: open(A) } }))
  const clock = mock.clock(on)
  const fromPlugin = await wrap($, '', { kind: 'plugin', name: 'other' } as PromptOrigin)
  await clock.advance(1)
  expect(fromPlugin).toMatch(/fail\s+CI green on current head/)
  expect(fromPlugin).toContain('Close-out prompt not sent: /wrap ran from plugin, not typed by you')
  const fromPeer = await wrap($, '', { kind: 'peer' })
  await clock.advance(1)
  expect(fromPeer).toContain('ran from peer')
  // The test kit leaves origin unset unless given: that must fail closed too.
  const unstamped = (await $.command.run({ command: 'wrap', args: '' } as never)).text ?? ''
  await clock.advance(1)
  expect(unstamped).toContain('ran from an unstamped origin')
  const fromTask = await wrap($, '', { kind: 'task-notification' } as PromptOrigin)
  await clock.advance(1)
  expect(fromTask).toContain('ran from task-notification')
  expect(submits.length).toBe(0)

  // The person's own /wrap still sends.
  await wrap($)
  await clock.advance(1)
  expect(submits.length).toBe(1)
})

test('origin gate: --archive from a scheduled run never asks or archives; from the desktop app (sdk) it asks, then archives', async ($, on) => {
  setup($, on, world(), { tools: [ARCHIVE] })
  const archived: string[] = []
  let asked = 0
  on('mcp.call', (_$, e) => {
    archived.push(e.tool)
    return { value: { content: [], isError: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked++
    return { result: { questions: e.questions, answers: { 'Archive this session?': 'Archive' } } } as never
  })
  const clock = mock.clock(on)
  await greenStop($)
  const text = await wrap($, '--archive', { kind: 'scheduled-trigger' })
  await clock.advance(1)
  expect(text).toContain('Archive not offered: /wrap ran from scheduled-trigger')
  expect(text).toContain('Ready to archive: yes')
  expect(asked).toBe(0)
  expect(archived.length).toBe(0)
  // The desktop app hosts sessions over the SDK, so the person's own /wrap there arrives as sdk.
  const fromSdk = await wrap($, '--archive', { kind: 'sdk' } as PromptOrigin)
  expect(fromSdk).toContain('Archive requested: a confirmation follows.')
  expect(archived.length).toBe(0) // only after the row, and only after 'Archive'
  await clock.advance(1)
  expect(asked).toBe(1)
  expect(archived).toEqual(['archive_session'])
})

test('origin gate: a /wrap typed in the desktop app (sdk) or over Remote Control (bridge) queues the prompt once', async ($, on) => {
  const table = world({ [PR_KEY]: { code: 0, out: open(A) } })
  const { submits } = setup($, on, table)
  const clock = mock.clock(on)
  const fromSdk = await wrap($, '', { kind: 'sdk' } as PromptOrigin)
  await clock.advance(1)
  expect(fromSdk).toContain('Queued the close-out prompt')
  expect(submits.length).toBe(1)
  // A new head, then the bridge: the person typing remotely sends too.
  table['git rev-parse HEAD'] = { code: 0, out: B + '\n' }
  table[PR_KEY] = { code: 0, out: open(B) }
  await wrap($, '', { kind: 'bridge' } as PromptOrigin)
  await clock.advance(1)
  expect(submits.length).toBe(2)
})

test('--resend: a claimed SHA whose prompt never arrived can be sent again by the person, once, never by others or --dry', async ($, on) => {
  const { submits } = setup($, on, world({ [PR_KEY]: { code: 0, out: open(A) } }))
  const clock = mock.clock(on)
  await wrap($)
  await clock.advance(1)
  expect(submits.length).toBe(1)
  // From here the claim holds A; a worker lost between the claim and the submit leaves exactly this state.
  const held = await wrap($)
  await clock.advance(1)
  expect(held).toContain('already sent for aaaaaaa')
  expect(held).toContain('type /wrap --resend')
  expect(submits.length).toBe(1)

  // Not from another origin, and not under --dry.
  const fromPlugin = await wrap($, '--resend', { kind: 'plugin', name: 'other' } as PromptOrigin)
  await wrap($, '--resend --dry')
  await clock.advance(1)
  expect(fromPlugin).toContain('Close-out prompt not sent')
  expect(submits.length).toBe(1)

  // The person's --resend sends again; two quick ones still send once (compare-and-set).
  const again = await wrap($, '--resend')
  await wrap($, '--resend')
  await clock.advance(1)
  expect(again).toContain('--resend: queued the close-out prompt again')
  expect(again).not.toContain('Ignored unknown argument')
  expect(submits.length).toBe(2)
})

test('--resend with nothing open says so and sends nothing', async ($, on) => {
  const { submits } = setup($, on, world())
  const clock = mock.clock(on)
  await greenStop($)
  const text = await wrap($, '--resend')
  await clock.advance(1)
  expect(text).toContain('--resend: nothing for the model to do')
  expect(submits.length).toBe(0)
})

test('Stop observer: a subagent\'s Stop never overwrites the main session\'s task cache', async ($, on) => {
  setup($, on, world())
  await greenStop($)
  await $.classic.Stop({
    stop_hook_active: false,
    agent_id: 'sub-1',
    agent_type: 'scout',
    background_tasks: [{ id: 't9', type: 'shell', status: 'running', description: 'x' }],
    session_crons: [{ id: 'c9', recurring: true }],
  } as never)
  const text = await wrap($, '--dry')
  expect(text).toMatch(/pass\s+No background tasks or wakeups\s+none running or scheduled/)
  expect(text).toContain('Ready to archive: yes')
})

test('background tasks come only from the Stop observer: unknown, then running, then clear, then unknown again', async ($, on) => {
  setup($, on, world())
  expect(await wrap($)).toMatch(/unknown\s+No background tasks/)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 't1', type: 'shell', status: 'running', description: 'x' }] })
  expect(await wrap($)).toMatch(/fail\s+No background tasks or wakeups\s+1 task\(s\) still running/)
  await greenStop($)
  const text = await wrap($)
  expect(text).toMatch(/pass\s+No background tasks/)
  expect(text).toContain('Ready to archive: yes')
  // A Stop that carries no task list says nothing about tasks: back to unknown, never "none".
  await $.classic.Stop({ stop_hook_active: false })
  const after = await wrap($)
  expect(after).toMatch(/unknown\s+No background tasks/)
  expect(after).toContain('Ready to archive: no')
})

test('archive gating: no listed tool means no archive call, even with --archive on a green table', async ($, on) => {
  setup($, on, world())
  const archived: string[] = []
  on('mcp.call', (_$, e) => {
    archived.push(`${e.server}/${e.tool}`)
    return { value: { content: [], isError: false } }
  })
  const clock = mock.clock(on)
  await greenStop($)
  const text = await wrap($, '--archive')
  await clock.advance(10)
  expect(text).toContain('Archive tool not available here: ready to archive (use the app)')
  expect(archived.length).toBe(0)
})

test('archive gating: a listed tool without a desktop surface means no archive call', async ($, on) => {
  setup($, on, world(), { tools: [ARCHIVE], surfaces: ['terminal'] })
  const archived: string[] = []
  on('mcp.call', (_$, e) => {
    archived.push(e.tool)
    return { value: { content: [], isError: false } }
  })
  const clock = mock.clock(on)
  await greenStop($)
  const text = await wrap($, '--archive')
  await clock.advance(10)
  expect(text).toContain('Archive tool not available here: ready to archive (use the app)')
  expect(archived.length).toBe(0)
})

test('archive gating: --archive is ignored while any check is not green', async ($, on) => {
  setup($, on, world({ 'git status --porcelain': { code: 0, out: ' M file\n' } }), { tools: [ARCHIVE] })
  const archived: string[] = []
  on('mcp.call', (_$, e) => {
    archived.push(e.tool)
    return { value: { content: [], isError: false } }
  })
  const text = await wrap($, '--archive')
  expect(text).toContain('Archive skipped: not every check passed')
  expect(archived.length).toBe(0)
})

test('archive: a listed tool, --archive, a green table and a confirmation call the tool once, after the row; "Not yet" does not', async ($, on) => {
  setup($, on, world(), { tools: [ARCHIVE] })
  const archived: { server: string; tool: string; args: unknown }[] = []
  let answer = 'Archive'
  on('mcp.call', (_$, e) => {
    archived.push({ server: e.server, tool: e.tool, args: e.args })
    return { value: { content: [], isError: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
    result: { questions: e.questions, answers: { 'Archive this session?': answer } },
  }) as never)
  const clock = mock.clock(on)
  await greenStop($)

  const text = await wrap($, '--archive')
  expect(text).toContain('Archive requested: a confirmation follows.')
  expect(text).toContain('Ready to archive: yes')
  expect(archived.length).toBe(0) // not before the row is returned
  await clock.advance(1)
  expect(archived).toEqual([{ server: 'ccd_session_mgmt', tool: 'archive_session', args: { session_id: 'self', reason: '/wrap: every check passed' } }])

  answer = 'Not yet'
  await wrap($, '--archive')
  await clock.advance(1)
  expect(archived.length).toBe(1)

  // Without --archive it only says so.
  const plain = await wrap($)
  await clock.advance(1)
  expect(plain).toContain('ready to archive (use the app)')
  expect(archived.length).toBe(1)
})

test('archive: a dismissed confirmation or a tool error ends in a toast, with no secret-bearing text', async ($, on) => {
  const { toasts } = setup($, on, world(), { tools: [ARCHIVE] })
  const archived: string[] = []
  let dismiss = true
  on('mcp.call', (_$, e) => {
    archived.push(e.tool)
    return { value: { content: [{ type: 'text', text: 'token=ghp_SECRET' }], isError: true } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) =>
    (dismiss ? { deny: 'dismissed' } : { result: { questions: e.questions, answers: { 'Archive this session?': 'Archive' } } }) as never,
  )
  const clock = mock.clock(on)
  await greenStop($)

  await wrap($, '--archive')
  await clock.advance(1)
  expect(archived.length).toBe(0)
  expect(toasts).toEqual(['/wrap: archive not done (HooksError)'])

  dismiss = false
  await wrap($, '--archive')
  await clock.advance(1)
  expect(archived.length).toBe(1)
  expect(toasts[1]).toBe('/wrap: the app refused the archive request (tool error)')
  expect(toasts.join(' ')).not.toContain('ghp_SECRET')
})

test('--dry also holds back the archive request, and unknown arguments are called out', async ($, on) => {
  setup($, on, world(), { tools: [ARCHIVE] })
  const archived: string[] = []
  on('mcp.call', (_$, e) => {
    archived.push(e.tool)
    return { value: { content: [], isError: false } }
  })
  const clock = mock.clock(on)
  await greenStop($)
  const text = await wrap($, '--archive --dry --frobnicate')
  await clock.advance(1)
  expect(text).toContain('--dry: archive not requested')
  expect(text).toContain('Ignored unknown argument(s): --frobnicate')
  expect(archived.length).toBe(0)
})

// Sibling worktrees: another session's worktree is never flagged on ancestry alone.
const withSibling = (path: string, sha: string, branch: string) =>
  `${wtList}\nworktree ${path}\nHEAD ${sha}\nbranch refs/heads/${branch}\n`
const mergedList = (...prs: [string, string][]) =>
  ({ code: 0, out: JSON.stringify(prs.map(([headRefName, headRefOid]) => ({ headRefName, headRefOid }))) })

test('worktrees: a live sibling session at the base tip with no PR is not stale, and the table can go green', async ($, on) => {
  const { calls } = setup($, on, world({
    'git worktree list --porcelain': { code: 0, out: withSibling('/w/live', B, 'live-session') },
    [mergedKey('live-session')]: mergedList(),
  }))
  await greenStop($)
  const text = await wrap($, '--dry')
  expect(text).toMatch(/pass\s+No stale worktrees\s+1 other worktree\(s\), none with a merged PR at its head/)
  expect(text).toContain('Ready to archive: yes')
  // Not merged, so its tree is never even read.
  expect(calls.some(c => c.startsWith('git -C'))).toBe(false)
  expect(calls.some(c => c.includes('branch --merged'))).toBe(false)
})

test('worktrees: a clean sibling at its merged PR head is stale; the session\'s own never is', async ($, on) => {
  setup($, on, world({
    'git worktree list --porcelain': { code: 0, out: withSibling('/w/old', B, 'old') },
    [mergedKey('old')]: mergedList(['old', B]),
    'git -C /w/old status --porcelain': { code: 0, out: '' },
  }))
  const text = await wrap($, '--dry')
  expect(text).toMatch(/fail\s+No stale worktrees\s+PR merged, tree clean, still checked out: old/)
  expect(text).not.toMatch(/checked out: .*feat/)
})

test('worktrees: a merged sibling with uncommitted work, or a name match at another SHA, is never stale', async ($, on) => {
  const table = world({
    'git worktree list --porcelain': { code: 0, out: withSibling('/w/old', B, 'old') },
    [mergedKey('old')]: mergedList(['old', B]),
    'git -C /w/old status --porcelain': { code: 0, out: '?? notes.txt\n' },
  })
  setup($, on, table)
  expect(await wrap($, '--dry')).toMatch(/pass\s+No stale worktrees/)
  // Same branch name, but the PR merged at a different head: a reused name, not this worktree.
  // The tree is clean here, so only the head-SHA half of the match keeps it from reading stale.
  table['git -C /w/old status --porcelain'] = { code: 0, out: '' }
  table[mergedKey('old')] = mergedList(['old', C])
  const reused = await wrap($, '--dry')
  expect(reused).toMatch(/pass\s+No stale worktrees\s+1 other worktree\(s\), none with a merged PR at its head/)
  expect(reused).not.toContain('still checked out')
})

test('worktrees: gh unavailable, or an unreadable merged sibling tree, reads unknown', async ($, on) => {
  const table = world({
    'git worktree list --porcelain': { code: 0, out: withSibling('/w/old', B, 'old') },
    [mergedKey('old')]: 'deny',
  })
  setup($, on, table)
  expect(await wrap($, '--dry')).toMatch(/unknown\s+No stale worktrees\s+could not ask gh/)
  table[mergedKey('old')] = mergedList(['old', B])
  // 'git -C /w/old status --porcelain' is not in the table: the read fails.
  expect(await wrap($, '--dry')).toMatch(/unknown\s+No stale worktrees\s+could not read the tree of 1/)
})

test('no PR yet: gh\'s "no pull requests found" is a known fact, so PR fails and the prompt is queued once', async ($, on) => {
  const table = world({
    [PR_KEY]: { code: 1, err: 'no pull requests found for branch "feat"\n' },
    'git merge-base --is-ancestor HEAD origin/main': { code: 1 },
  })
  const { submits } = setup($, on, table)
  const clock = mock.clock(on)
  await greenStop($)
  const text = await wrap($)
  await clock.advance(1)
  expect(text).toMatch(/fail\s+PR\s+no PR for this branch \(2 commit\(s\) ahead of origin\/main\)/)
  expect(text).toMatch(/fail\s+CI green on current head\s+no PR, so no CI result/)
  expect(text).toContain('Queued the close-out prompt')
  expect(submits.length).toBe(1)
  expect(submits[0]).toContain('If there is no PR, raise one against main')

  // Any other non-zero exit from gh is an outage, never "no PR".
  table[PR_KEY] = { code: 1, err: 'HTTP 502' }
  const outage = await wrap($, '--dry')
  expect(outage).toMatch(/unknown\s+PR\s+gh pr view did not complete/)
  expect(outage).not.toContain('HTTP 502')
})

test('scheduled wakeups: a pending cron fails the row and blocks the archive; its prompt is never cached', async ($, on) => {
  setup($, on, world(), { tools: [ARCHIVE] })
  const archived: string[] = []
  on('mcp.call', (_$, e) => {
    archived.push(e.tool)
    return { value: { content: [], isError: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) =>
    ({ result: { questions: e.questions, answers: { 'Archive this session?': 'Archive' } } }) as never,
  )
  const writes: string[] = []
  on('state.set', (_$, e, next) => {
    writes.push(JSON.stringify(e.value))
    return next(e)
  })
  const clock = mock.clock(on)
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [{ id: 'c1', schedule: '0 9 * * 1-5', recurring: true, prompt: 'PRIVATE_PROMPT_TEXT' }],
  } as never)
  const text = await wrap($, '--archive')
  await clock.advance(1)
  expect(text).toMatch(/fail\s+No background tasks or wakeups\s+1 scheduled wakeup\(s\) pending/)
  expect(text).toContain('Archive skipped: not every check passed')
  expect(text).toContain('Ready to archive: no')
  expect(archived.length).toBe(0)
  // The cached value keeps the id and recurring flag only, never the cron's prompt or schedule.
  expect(writes).toContain(JSON.stringify({ tasks: [], crons: [{ id: 'c1', recurring: true }] }))
  expect(writes.join(' ')).not.toContain('PRIVATE_PROMPT_TEXT')
  expect(writes.join(' ')).not.toContain('0 9 * * 1-5')

  // A Stop that lists tasks but not crons says nothing about wakeups: unknown, never pass.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  const unlisted = await wrap($, '--dry')
  expect(unlisted).toMatch(/unknown\s+No background tasks or wakeups\s+no tasks running, but the last Stop did not list scheduled wakeups/)
  expect(unlisted).toContain('Ready to archive: no')
})

test('worktrees: merged PRs are asked per sibling branch; a failed or full-page answer reads unknown, never pass', async ($, on) => {
  const two = `${withSibling('/w/old', B, 'old')}\nworktree /w/other\nHEAD ${C}\nbranch refs/heads/other\n`
  const full = { code: 0, out: JSON.stringify(Array.from({ length: 30 }, () => ({ headRefName: 'other', headRefOid: A }))) }
  const table = world({
    'git worktree list --porcelain': { code: 0, out: two },
    [mergedKey('old')]: mergedList(['old', C]),
    [mergedKey('other')]: 'deny',
  })
  const { calls } = setup($, on, table)
  await greenStop($)
  // One branch answered (not merged at its head), the other could not be asked.
  expect(await wrap($, '--dry')).toMatch(/unknown\s+No stale worktrees\s+gh gave no complete answer for 1 of 2/)
  expect(calls).toContain(mergedKey('old'))
  expect(calls.some(c => c.startsWith('gh pr list') && !c.includes('--head'))).toBe(false)

  // A full page with no match may have cut off the matching PR: still unknown.
  table[mergedKey('other')] = full
  expect(await wrap($, '--dry')).toMatch(/unknown\s+No stale worktrees\s+gh gave no complete answer for 1 of 2/)

  // Complete answers with no match at either head: pass, and the table can go green.
  table[mergedKey('other')] = mergedList(['other', A])
  const green = await wrap($, '--dry')
  expect(green).toMatch(/pass\s+No stale worktrees\s+2 other worktree\(s\), none with a merged PR at its head/)
  expect(green).toContain('Ready to archive: yes')
})

test('worktrees: a sibling branch name that is not allow-listed is never put in argv and reads unknown', async ($, on) => {
  const { calls } = setup($, on, world({
    'git worktree list --porcelain': { code: 0, out: withSibling('/w/odd', B, 'odd..name') },
  }))
  await greenStop($)
  expect(await wrap($, '--dry')).toMatch(/unknown\s+No stale worktrees\s+could not ask gh/)
  expect(calls.some(c => c.includes('odd..name'))).toBe(false)
})

test('worktrees: siblings past the 20-query cap are never asked and read unknown, never pass', async ($, on) => {
  const many = Array.from({ length: 21 }, (_, i) => `worktree /w/s${i}\nHEAD ${B}\nbranch refs/heads/s${i}\n`).join('\n')
  const answered = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [mergedKey(`s${i}`), mergedList()]))
  const { calls } = setup($, on, world({ 'git worktree list --porcelain': { code: 0, out: `${wtList}\n${many}` }, ...answered }))
  await greenStop($)
  const text = await wrap($, '--dry')
  // Twenty complete "not merged" answers; the 21st sibling was never asked, so it may be stale.
  expect(text).toMatch(/unknown\s+No stale worktrees\s+gh gave no complete answer for 1 of 21/)
  expect(text).toContain('Ready to archive: no')
  expect(calls.filter(c => c.startsWith('gh pr list')).length).toBe(20)
  expect(calls).not.toContain(mergedKey('s20'))
})

test('worktrees: a detached sibling is named as not checked, never reported as "no other worktrees"', async ($, on) => {
  const detached = `\nworktree /w/det\nHEAD ${C}\ndetached\n`
  const table = world({ 'git worktree list --porcelain': { code: 0, out: `${wtList}${detached}` } })
  setup($, on, table)
  await greenStop($)
  const alone = await wrap($, '--dry')
  expect(alone).toMatch(/pass\s+No stale worktrees\s+no other worktree on a branch; 1 detached worktree\(s\) not checked/)
  expect(alone).not.toContain('no other worktrees (this session')
  // Beside a checked sibling the count is still named.
  table['git worktree list --porcelain'] = { code: 0, out: `${withSibling('/w/live', B, 'live')}${detached}` }
  table[mergedKey('live')] = mergedList()
  expect(await wrap($, '--dry')).toMatch(
    /pass\s+No stale worktrees\s+1 other worktree\(s\), none with a merged PR at its head; 1 detached worktree\(s\) not checked/,
  )
})

test('worktrees: a prunable sibling whose PR merged is never read, stays unknown, and names the fix', async ($, on) => {
  const gone = `${withSibling('/w/gone', B, 'gone')}prunable gitdir file points to non-existent location\n`
  const { calls } = setup($, on, world({
    'git worktree list --porcelain': { code: 0, out: gone },
    [mergedKey('gone')]: mergedList(['gone', B]),
    // Were it read, a clean answer would flag it stale; it must not be read at all.
    'git -C /w/gone status --porcelain': { code: 0, out: '' },
  }))
  await greenStop($)
  const text = await wrap($, '--dry')
  expect(text).toMatch(/unknown\s+No stale worktrees\s+could not read the tree of 1 other worktree\(s\) whose PR merged \(1 of them marked prunable by git/)
  expect(text).toContain('`git worktree prune` clears it')
  expect(text).toContain('Ready to archive: no')
  expect(calls.some(c => c.startsWith('git -C /w/gone'))).toBe(false)
})

test('where no Stop arrives (the desktop), a main-loop turn end reads the running subagents: none passes with the caveat, one fails', async ($, on) => {
  const { } = setup($, on, world())
  let agents: { id: string; description: string; type: string; status: string }[] = []
  on('agent.list', () => ({ value: agents }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const text = await wrap($)
  expect(text).toMatch(/pass\s+No background tasks or wakeups\s+no subagent running as of the last turn end/)
  agents = [{ id: 'a1', description: 'scout', type: 'scout', status: 'running' }]
  await $.turn.complete({ answer: 'more', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(await wrap($)).toMatch(/fail\s+No background tasks or wakeups\s+1 subagent\(s\) still running/)
  // A subagent's own turn end changes nothing.
  agents = []
  await $.turn.complete({ answer: 'sub', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer', agentId: 'a1' } as never)
  expect(await wrap($)).toMatch(/fail\s+No background tasks or wakeups\s+1 subagent\(s\) still running/)
})
