import type { On, ProcessRunResult, RenderSurface } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  archiveReason,
  ciRollup,
  completion,
  STALE_MS,
  fillOutcome,
  findRuleSentence,
  hasRule,
  insertCapturedRule,
  labelMarksRecommended,
  normalizePrompt,
  parseDecisions,
  parseWaiting,
  promptPreview,
  standingLine,
  personText,
  visibleText,
} from './parse'

const PLUGIN = 'cockpit'
const SURFACES = ['terminal', 'desktop'] as const
const START = 1_000_000

type FillAnswer = { isFilled: boolean; refusal?: 'no_composer' | 'dialog' }

type World = {
  submits: { text: string; origin: unknown }[]
  fills: string[]
  toasts: string[]
  runs: string[][]
  writes: { path: string; text: string }[]
  files: Map<string, string>
  fillAnswer: FillAnswer
  submitDelayMs: number
  /** Every stat sees a newer mtime, as if another session kept writing the file. */
  isFileChurning: boolean
  /** What `$.session.surfaces()` answers: the band surfaces attached right now. */
  surfaces: RenderSurface[]
  /** The tools `$.tool.list()` names (the app's archive and get_session among them when listed). */
  tools: string[]
  /** This session's parent (lead) session id in the app's record, or null. */
  lead: string | null
  mcpCalls: { tool: string; args: unknown }[]
  /** What `$.agent.list()` answers: the session's subagents and their statuses. */
  agents: { id: string; description: string; type: string; status: string }[]
  /** The app's get_session answers a tool error. */
  isGetSessionFailing: boolean
  /** `gh pr view` answers only after this long on the mocked clock: a refresh held in flight. */
  prDelayMs: number
  /** How long the roster call takes; it answers with the roster as it was when called. */
  surfacesDelayMs: number
  /** What `$.session.root()` answers. */
  root: string
  /** A hook beneath the plugin drops every prompt (a settings UserPromptSubmit block). */
  isDroppingBeneath: boolean
  /** gh hangs until the 10 s timeout, then the run rejects. */
  isGhHanging: boolean
  respond: (argv: readonly string[]) => ProcessRunResult | null
  /** The plugin's `$.store`, in memory, and every key it was asked to read. */
  store: Map<string, unknown>
  storeReads: string[]
  clock: ReturnType<typeof mock.clock>
}

const ran = (exitCode: number, stdout: string, stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const OPEN_PR = JSON.stringify({
  number: 12,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  mergedAt: null,
  url: 'https://github.com/o/r/pull/12',
})

const MERGED_PR = JSON.stringify({
  number: 12,
  state: 'MERGED',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  mergedAt: new Date(START).toISOString(),
  headRefOid: 'abc1234abc1234abc1234abc1234abc1234abc12',
  url: 'https://github.com/o/r/pull/12',
})
const HEAD_SHA = 'abc1234abc1234abc1234abc1234abc1234abc12'

/** git as the band asks it: the branch, a clean tree, HEAD, nothing ahead of the upstream. */
const gitAnswer = (argv: readonly string[], over: { dirty?: boolean; head?: string; ahead?: string | null; inDefault?: boolean; noRemote?: boolean } = {}): ProcessRunResult =>
  argv[1] === 'remote'
    ? ran(0, over.noRemote ? '' : 'origin\n')
    : argv[1] === 'status'
    ? ran(0, over.dirty ? ' M a.ts\n' : '')
    : argv[1] === 'rev-parse' && argv[2] === 'HEAD'
      ? ran(0, `${over.head ?? HEAD_SHA}\n`)
      : argv[1] === 'rev-list'
        ? over.ahead === null
          ? ran(128, '', 'fatal: no upstream configured')
          : ran(0, `${over.ahead ?? '0'}\n`)
        : argv[1] === 'symbolic-ref'
          ? ran(0, 'origin/main\n')
          : argv[1] === 'merge-base'
            ? ran(over.inDefault === false ? 1 : 0, '')
            : ran(0, 'feat/cockpit\n')
const ARCHIVE_TOOL = 'mcp__ccd_session_mgmt__archive_session'
const GET_SESSION_TOOL = 'mcp__ccd_session_mgmt__get_session'

const defaultRespond = (argv: readonly string[]): ProcessRunResult | null =>
  argv[0] === 'git' ? gitAnswer(argv) : argv[1] === 'pr' ? ran(0, OPEN_PR) : null

/** The engine beneath the plugin, in memory: answers every noun the cockpit calls and records what it asked for. */
function world(on: On, files: Readonly<Record<string, string>> = {}): World {
  const clock = mock.clock(on, { now: START })
  let tick = 1

  const w: World = {
    submits: [],
    fills: [],
    toasts: [],
    runs: [],
    writes: [],
    files: new Map(Object.entries(files)),
    fillAnswer: { isFilled: true },
    submitDelayMs: 0,
    isFileChurning: false,
    surfaces: ['terminal'],
    tools: [],
    lead: null,
    mcpCalls: [],
    agents: [],
    isGetSessionFailing: false,
    prDelayMs: 0,
    surfacesDelayMs: 0,
    root: '/work/wt',
    isDroppingBeneath: false,
    isGhHanging: false,
    respond: defaultRespond,
    store: new Map(),
    storeReads: [],
    clock,
  }

  // As mock.store, but open to the test: what was written, and what was read back.
  on('store.get', ($, e) => {
    w.storeReads.push(e.key)

    return { value: w.store.get(e.key) }
  })
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  mock.env(on, { HOME: '/home/j' })
  on('session.cwd', () => ({ value: '/work/wt' }))
  on('session.root', () => ({ value: w.root }))
  on('session.surfaces', async () => {
    const snapshot = [...w.surfaces]

    if (w.surfacesDelayMs > 0) {
      await clock.sleep(w.surfacesDelayMs)
    }

    return { value: snapshot }
  })
  on('tool.list', () => ({ value: w.tools.map(name => ({ name, description: 'test', mcp: true })) }) as never)
  on('agent.list', () => ({ value: w.agents }) as never)
  on('mcp.call', ($, e) => {
    w.mcpCalls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'get_session' && w.isGetSessionFailing) return { value: { content: [{ type: 'text', text: 'session not found' }], isError: true } } as never
    const text = e.tool === 'get_session' ? JSON.stringify({ sessionId: 'me', ...(w.lead === null ? {} : { parentSessionId: w.lead }) }) : ''
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({ result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Archive' } } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}) as never)
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('process.run', async ($, e) => {
    w.runs.push([...e.argv])

    if (w.isGhHanging && e.argv[1] === 'pr') {
      await clock.sleep(10_000)

      return { deny: 'still running after 10000 ms' }
    }

    if (w.prDelayMs > 0 && e.argv[1] === 'pr') {
      await clock.sleep(w.prDelayMs)
    }

    const result = w.respond(e.argv)

    return result === null ? { deny: 'ENOENT: no such file' } : { value: result }
  })
  on('prompt.submit', async ($, e) => {
    if (w.isDroppingBeneath) {
      return { drop: 'blocked beneath' }
    }

    if (w.submitDelayMs > 0) {
      await clock.sleep(w.submitDelayMs)
    }

    w.submits.push({ text: e.text, origin: e.origin })

    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)

    return w.fillAnswer
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: [''] }))
  on('fs.stat', ($, e) => {
    const text = w.files.get(e.path)

    if (text === undefined) {
      return { deny: `ENOENT: ${e.path}` }
    }

    tick += w.isFileChurning ? 1 : 0

    return { value: { kind: 'file' as const, size: text.length, mtimeMs: tick, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    w.files.set(e.path, e.text)

    return { value: undefined }
  })

  return w
}

const band = <S extends (typeof SURFACES)[number]>(
  surface: S,
  props: { hasSurvey?: boolean; isWorking?: boolean; bodyColumns?: number; view?: { agentId?: string } } = {},
) => ({
  plugin: PLUGIN,
  surface,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
    ...props,
  },
})

const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: '/work/wt' }

const composer = (text: string, extra: { turnId?: string; wait?: boolean } = {}) => ({
  text,
  wait: extra.wait ?? false,
  origin: { kind: 'composer' as const },
  ...(extra.turnId !== undefined && { turnId: extra.turnId }),
})

const answer = (text: string, extra: { agentId?: string; turnId?: string } = {}) => ({
  answer: text,
  durationMs: 10,
  isAborted: false,
  turnId: extra.turnId ?? 'turn-1',
  reason: 'answer' as const,
  ...(extra.agentId !== undefined && { agentId: extra.agentId }),
})

// The replies that set work in motion: no typed letter may ever send one.
const REPLY_TEXTS_OUTWARD = [
  'Go ahead.',
  'Resume from where you left off; do not restart from scratch.',
  'Is everything done, completed and merged on green CI in this session, and communicated back to the lead session if there is one? If so, archive this session to wrap up; or is that already done?',
]

const DECISIONS = [
  'Two calls before I go on.',
  '',
  '**Q1: Which store should the ledger use?**',
  'a) Postgres',
  'b) SQLite (recommended)',
  '',
  'Q2. Ship behind a flag?',
  '(a) Yes',
  '(b) No',
  'Recommended: a',
].join('\n')

// Band ----------------------------------------------------------------------------

describe('band', () => {
  test('mounts on terminal and desktop with the six replies, letter hotkeys on the harmless two only, and the standing line', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await w.clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))
      const buttons = await ui.findAll({ type: 'Button' })
      const hotkeys = buttons.map(button => button.props.hotkey).filter(hotkey => hotkey !== undefined)

      expect(hotkeys).toEqual(['t', 's'])
      expect(buttons.filter(button => button.key?.startsWith('reply-') === true).map(button => button.props.label)).toEqual([
        'Go',
        'Resume',
        'Try again',
        'Status',
        'Session completion',
      ])
      expect(hotkeys.every(hotkey => /^[a-z]$/.test(String(hotkey)))).toBe(true)

      const line = await ui.find({ type: 'Text', text: /feat\/cockpit/ })

      expect(line?.text).toContain('PR #12 open/mergeable')
      expect(line?.text).toContain('CI green')
      expect(line?.text).toContain('not merged')
      await ui.unmount()
    }

    // git ran in the session's own directory, never the main checkout.
    expect(w.runs[0]).toEqual(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  })

  test('yields the band to a survey and to a subagent transcript', async ($, on) => {
    world(on)
    await $.session.start(SESSION)

    for (const surface of SURFACES) {
      for (const props of [{ hasSurvey: true }, { view: { agentId: 'agent-7' } }]) {
        const ui = await $.ui.mount(band(surface, props))

        expect(await ui.find({ key: 'reply-g' })).toBeUndefined()
        await ui.unmount()
      }
    }
  })

  test('a section folds to its toggle and unfolds again', async ($, on) => {
    world(on)
    await $.session.start(SESSION)

    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'fold-replies' })
    expect(await ui.find({ key: 'reply-g' })).toBeUndefined()
    await ui.press({ key: 'fold-replies' })
    expect(await ui.find({ key: 'reply-g' })).toBeDefined()
  })

  test('the drawing is never wider than the band', async ($, on) => {
    world(on)
    await $.session.start(SESSION)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface, { bodyColumns: 10 }))

      expect((await ui.find({ type: 'Box' }))?.props.width).toBe(10)
      await ui.unmount()
    }
  })
})

// Quick replies -----------------------------------------------------------------

describe('quick replies', () => {
  test('a press sends the canonical phrase once, as the person', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))

      await ui.press({ key: 'reply-s' })
      await ui.unmount()
    }

    expect(w.submits.map(submit => submit.text)).toEqual([
      'Status update: what ran and passed, what is merged, what is pending, and the link where it can be seen.',
      'Status update: what ran and passed, what is merged, what is pending, and the link where it can be seen.',
    ])
    expect(w.submits[0]?.origin).toMatchObject({ kind: 'plugin', name: PLUGIN, asUser: true })
  })

  test('Go, Resume and Session completion carry no hotkey; an explicit press sends each once as the person', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    const ui = await $.ui.mount(band('terminal'))

    for (const [id, text] of [
      ['g', 'Go ahead.'],
      ['r', 'Resume from where you left off; do not restart from scratch.'],
      ['c', 'Is everything done, completed and merged on green CI in this session, and communicated back to the lead session if there is one? If so, archive this session to wrap up; or is that already done?'],
    ] as const) {
      w.submits.length = 0
      expect((await ui.find({ key: `reply-${id}` }))?.props.hotkey).toBeUndefined()
      await ui.press({ key: `reply-${id}` })
      await w.clock.advance(1_000)
      expect(w.submits.map(submit => submit.text)).toEqual([text])
      expect(w.submits[0]?.origin).toMatchObject({ kind: 'plugin', name: PLUGIN, asUser: true })
    }
  })

  test('typing "make sure" or "wait" into a band that holds the keys sends no Go, Resume or Session completion', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    const outward = new Set(REPLY_TEXTS_OUTWARD)

    // The kit cannot type into a band (ui.key reaches a Client only), so this models the engine's
    // dispatch: each typed character presses the Button whose hotkey it is. Every printable one is tried.
    const everyKey = Array.from({ length: 0x7f - 0x20 }, (_, at) => String.fromCharCode(0x20 + at).toLowerCase()).join('')

    for (const typed of ['make sure', 'wait', 'go resume session completion', everyKey]) {
      const ui = await $.ui.mount(band('terminal'))
      const buttons = await ui.findAll({ type: 'Button' })

      // A focused band turns each typed letter into a press of the Button with that hotkey.
      for (const letter of typed) {
        const hit = buttons.find(button => button.props.hotkey === letter)

        if (hit?.key !== undefined) {
          await ui.press({ key: hit.key })
          await w.clock.advance(1_000)
        }
      }

      await ui.unmount()
    }

    expect(w.submits.filter(submit => outward.has(submit.text))).toEqual([])
  })

  test('a second press while the first is pending is not sent again', async ($, on) => {
    const w = world(on)

    w.submitDelayMs = 1_000
    await $.session.start(SESSION)

    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'reply-g' })
    await ui.press({ key: 'reply-g' })
    await w.clock.advance(1_000)

    expect(w.submits.map(submit => submit.text)).toEqual(['Go ahead.'])
    expect(w.toasts).toContain('already queued')

    // Once the first has started its turn the pending mark is gone and the button works again.
    await ui.press({ key: 'reply-g' })
    await w.clock.advance(1_000)
    expect(w.submits).toHaveLength(2)
  })

  test('a press while Claude is working sends nothing', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    const ui = await $.ui.mount(band('desktop', { isWorking: true }))

    await ui.press({ key: 'reply-t' })
    expect(w.submits).toHaveLength(0)
    expect(w.toasts.length).toBe(1)
  })

  test('one reply in flight at a time: a different letter pressed meanwhile is not sent', async ($, on) => {
    const w = world(on)

    w.submitDelayMs = 1_000
    await $.session.start(SESSION)

    const ui = await $.ui.mount(band('terminal'))

    // As "gs" typed into a band that kept the focus after a click would press them.
    await ui.press({ key: 'reply-g' })
    await ui.press({ key: 'reply-s' })
    await w.clock.advance(1_000)

    expect(w.submits.map(submit => submit.text)).toEqual(['Go ahead.'])
    expect(w.toasts).toContain('already queued')
  })

  test('a phrase set in userConfig replaces the default and is shown, since it is sent as the person', { options: { replyGo: 'Ship\u202E it.\u200B', replyCompletion: 'Wrap \u201Cnow\u201D' } }, async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    const ui = await $.ui.mount(band('terminal'))

    // Shown exactly as it is sent: cleaned to printable ASCII. Default phrases are not repeated.
    expect((await ui.findAll({ type: 'Text', text: / sends: "/ })).map(text => text.text)).toEqual(['Go sends: "Ship it."', 'Session completion sends: "Wrap "now""'])

    await ui.press({ key: 'reply-g' })
    expect(w.submits.map(submit => submit.text)).toEqual(['Ship it.'])
  })
})

// Duplicate guard -------------------------------------------------------------

describe('duplicate prompt guard', () => {
  test('drops a repeat typed over a running turn and puts it back as a draft', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    expect((await $.prompt.submit(composer('Go ahead.'))).drop).toBeUndefined()

    const dropped = await $.prompt.submit(composer('  go ahead ', { turnId: 'turn-1' }))

    expect(dropped.drop).toContain('duplicate')
    expect(dropped.drop).toContain('"go ahead"')
    await w.clock.advance(300)
    expect(w.fills).toEqual(['  go ahead '])
  })

  test('a repeat from the desktop app (sdk origin) is the person too, and is dropped the same way', async ($, on) => {
    world(on)

    await $.session.start(SESSION)

    const sdk = (text: string, turnId?: string) => ({ text, wait: false, origin: { kind: 'sdk' as const }, ...(turnId !== undefined && { turnId }) })

    expect((await $.prompt.submit(sdk('Ship the fix.'))).drop).toBeUndefined()
    expect((await $.prompt.submit(sdk('ship the fix', 'turn-1'))).drop).toContain('duplicate')
  })

  test('lets repeats through when idle, queued on purpose, from a notification, different, or old', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.prompt.submit(composer('Go ahead.'))

    // Idle (no turnId): the person may say it twice.
    expect((await $.prompt.submit(composer('Go ahead.'))).drop).toBeUndefined()
    // ctrl+x enter: an explicit queue request always passes.
    expect((await $.prompt.submit(composer('Go ahead.', { turnId: 'turn-1', wait: true }))).drop).toBeUndefined()
    // Not the person: a duplicate notification is not a duplicate intent.
    expect(
      (await $.prompt.submit({ text: 'Go ahead.', wait: false, turnId: 'turn-1', origin: { kind: 'task-notification' } })).drop,
    ).toBeUndefined()
    // A real follow-up is not a duplicate.
    expect((await $.prompt.submit(composer('Go ahead but skip the tests.', { turnId: 'turn-1' }))).drop).toBeUndefined()
    // Outside the ten-minute window.
    await w.clock.advance(11 * 60_000)
    expect((await $.prompt.submit(composer('Go ahead.', { turnId: 'turn-2' }))).drop).toBeUndefined()
  })

  test('fails open: when the guard cannot run, the prompt goes through', async ($, on) => {
    // No clock beneath the plugin: $.clock.now throws inside the guard, and the .catch replays next.
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('ui.render', () => ({ type: 'Text', children: [''] }))

    const result = await $.prompt.submit(composer('Go ahead.', { turnId: 'turn-1' }))

    expect(result.drop).toBeUndefined()
    expect(result.text).toBe('Go ahead.')
  })

  test('a long or token-like prompt is never quoted back in a drop reason', () => {
    expect(promptPreview('Go ahead.')).toBe('"Go ahead."')
    expect(promptPreview('use key sk-abcdefghijklmnopqrstuvwxyz0123')).toBe('your earlier prompt')
    expect(promptPreview('x'.repeat(61))).toBe('your earlier prompt')
  })
})

// Standing ------------------------------------------------------------------------

describe('standing', () => {
  test('no PR is "no PR", an empty rollup is pending and never green, and old data says stale', () => {
    expect(ciRollup([])).toBe('pending')
    expect(ciRollup(undefined)).toBe('pending')
    expect(ciRollup([{ status: 'IN_PROGRESS', conclusion: null }])).toBe('pending')
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('green')
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing')
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'SOMETHING_NEW' }])).toBe('pending')

    const line = standingLine({ branch: 'main', pr: null, prStatus: 'none', refreshedAt: 0 , isClean: null, dirtyFiles: null, headSha: null, aheadOfUpstream: null, hasRemote: null, defaultBranch: null, inDefault: null, mergedSeenAt: null, stopSeq: 0, stopToken: '', inDefaultSeenAt: null }, 5 * 60_000, 60_000, false)

    expect(line).toBe('main · no PR · idle 4m (stale 5m)')
    expect(standingLine({ branch: null, pr: null, prStatus: 'unavailable', refreshedAt: 0 , isClean: null, dirtyFiles: null, headSha: null, aheadOfUpstream: null, hasRemote: null, defaultBranch: null, inDefault: null, mergedSeenAt: null, stopSeq: 0, stopToken: '', inDefaultSeenAt: null }, 0, 0, true)).toBe('git unavailable · working')
    expect(standingLine({ branch: null, pr: null, prStatus: 'skipped', refreshedAt: 0 , isClean: null, dirtyFiles: null, headSha: null, aheadOfUpstream: null, hasRemote: null, defaultBranch: null, inDefault: null, mergedSeenAt: null, stopSeq: 0, stopToken: '', inDefaultSeenAt: null }, 0, 0, false)).toBe('no git · no tool calls yet')
  })

  test('exit 1 "no pull requests found" or "no git remotes found" reads as no PR, and a missing CLI as unavailable, never an error', async ($, on) => {
    const w = world(on)

    w.respond = argv => (argv[0] === 'git' ? ran(0, 'topic\n') : ran(1, '', 'no pull requests found for branch "topic"'))
    await $.session.start(SESSION)
    await w.clock.settle()

    const ui = await $.ui.mount(band('terminal'))

    expect((await ui.find({ type: 'Text', text: /topic/ }))?.text).toContain('no PR')
    await ui.unmount()

    // A repository with no remote at all: gh says so on stderr; that is "no PR" too.
    w.respond = argv => (argv[0] === 'git' ? ran(0, 'topic\n') : ran(1, '', 'no git remotes found'))
    await w.clock.advance(60_000)
    await w.clock.settle()
    const noRemote = await $.ui.mount(band('terminal'))
    expect((await noRemote.find({ type: 'Text', text: /topic/ }))?.text).toContain('no PR')
    await noRemote.unmount()

    w.respond = argv => (argv[0] === 'git' ? ran(0, 'topic\n') : null)
    await w.clock.advance(60_000)

    const again = await $.ui.mount(band('terminal'))

    expect((await again.find({ type: 'Text', text: /topic/ }))?.text).toContain('PR lookup unavailable')
  })

  test('a gh that hangs until its timeout reads as PR unknown, and the other paths are not tried', async ($, on) => {
    const w = world(on)

    w.isGhHanging = true
    await $.session.start(SESSION)
    await w.clock.advance(10_000)
    await w.clock.settle()

    const ui = await $.ui.mount(band('terminal'))

    expect((await ui.find({ type: 'Text', text: /feat\/cockpit/ }))?.text).toContain('PR unknown')
    expect(w.runs.filter(argv => argv[1] === 'pr')).toHaveLength(1)
  })

  test('a session with no band surface never polls, even after events; a desktop that attaches starts it', async ($, on) => {
    const w = world(on)

    w.surfaces = []
    await $.session.start({ surface: null, isInteractive: false, cwd: '/work/wt' })
    await $.prompt.submit({ text: 'run the job', wait: false, origin: { kind: 'sdk' } })
    await $.turn.complete(answer('Done.'))
    await w.clock.advance(5 * 60_000)
    expect(w.runs).toHaveLength(0)

    w.surfaces = ['desktop']
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await w.clock.settle()

    const ui = await $.ui.mount(band('desktop'))

    expect((await ui.find({ type: 'Text', text: /feat\/cockpit/ }))?.text).toContain('PR #12')
  })

  test('an SDK-hosted session whose roster already has the desktop polls from the start', async ($, on) => {
    const w = world(on)

    w.surfaces = ['desktop']
    await $.session.start({ surface: null, isInteractive: false, cwd: '/work/wt' })
    await w.clock.settle()
    expect(w.runs[0]).toEqual(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])

    const before = w.runs.length

    await w.clock.advance(60_000)
    expect(w.runs.length).toBeGreaterThan(before)
  })

  test('a desktop that attaches while the roster is still being read still starts the refresh', async ($, on) => {
    const w = world(on)

    w.surfaces = []
    w.surfacesDelayMs = 50
    await $.session.start({ surface: null, isInteractive: false, cwd: '/work/wt' })
    await w.clock.advance(10)

    // The roster asked at start predates this attach, and answers "no band surface" 40 ms later.
    w.surfaces = ['desktop']
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await w.clock.advance(5 * 60_000)

    expect(w.runs.filter(run => run[0] === 'git').length).toBeGreaterThan(1)
  })

  for (const event of ['tool call', 'prompt', 'finished turn'] as const) {
    test(`after a hot reload drops the timer, the next ${event} re-arms the refresh`, async ($, on) => {
      const w = world(on)

      on('tool.call', () => ({ result: 'ok' }) as never)
      // A reloaded module gets no new session.start: the start ran in the old copy, whose timer died with it.
      await w.clock.advance(5 * 60_000)
      expect(w.runs).toHaveLength(0)

      if (event === 'tool call') {
        await $.tool.call({ tool: 'Read', file_path: '/work/wt/a.txt' } as never)
      } else if (event === 'prompt') {
        await $.prompt.submit(composer('carry on'))
      } else {
        await $.turn.complete(answer('Done.'))
      }

      await w.clock.settle()

      const armed = w.runs.length

      expect(armed).toBeGreaterThan(0)
      await w.clock.advance(60_000)
      expect(w.runs.length).toBeGreaterThan(armed)
    })
  }

  test('a tool call stamps activity and still runs the tool', async ($, on) => {
    const w = world(on)

    on('tool.call', () => ({ result: 'read ok' }) as never)
    await $.session.start(SESSION)
    await w.clock.settle()
    await w.clock.advance(2 * 60_000)

    const result = await $.tool.call({ tool: 'Read', file_path: '/work/wt/a.txt' } as never)

    expect((result as { result?: unknown }).result).toBe('read ok')
    await w.clock.settle()

    const ui = await $.ui.mount(band('terminal'))

    expect((await ui.find({ type: 'Text', text: /feat\/cockpit/ }))?.text).toContain('idle 0m')
  })
})

// Decision cards ------------------------------------------------------------------

describe('decision cards', () => {
  test('parses numbered and lettered option questions with their recommendations', () => {
    expect(parseDecisions(DECISIONS)).toEqual([
      {
        number: 1,
        text: 'Which store should the ledger use?',
        options: [
          { value: 'a', label: 'Postgres' },
          { value: 'b', label: 'SQLite (recommended)' },
        ],
        recommended: 'b',
        picked: null,
      },
      {
        number: 2,
        text: 'Ship behind a flag?',
        options: [
          { value: 'a', label: 'Yes' },
          { value: 'b', label: 'No' },
        ],
        recommended: 'a',
        picked: null,
      },
    ])

    const other = parseDecisions(
      ['Decision 3: rollout', 'Option A: all at once', 'Option B: staged', 'I recommend option B.', '', 'Which region? (a) us-east (b) eu-west'].join('\n'),
    )

    // Prose ("I recommend option B.") names no option: only a "Recommended:" line or the option's own mark does.
    expect(other.map(question => [question.number, question.options.length, question.recommended])).toEqual([
      [3, 2, null],
      [4, 2, null],
    ])
    expect(parseDecisions(['Decision 3: rollout', 'Option A: all at once', 'Option B: staged', 'Recommended: option B.'].join('\n'))[0]?.recommended).toBe('b')
  })

  test('skips step lists, code and look-alike recommendations', () => {
    const steps = ['1. Set up the database', '   a) create the table', '   b) add the index', '2. Deploy'].join('\n')
    const code = ['```', 'Q1: Which one?', 'a) foo', 'b) bar', '```'].join('\n')

    expect(parseDecisions(steps)).toEqual([])
    expect(parseDecisions(code)).toEqual([])
    expect(parseDecisions('All done. Tests pass and the PR is merged.')).toEqual([])
    expect(parseDecisions(['Q1: Which path?', 'a) Fast', 'b) Safe', 'Recommended: a fast approach overall.'].join('\n'))[0]?.recommended).toBeNull()
  })

  test('a negated or passing "recommend" never picks the option advised against', () => {
    const recommendedOf = (lines: string[]) => parseDecisions(lines.join('\n'))[0]?.recommended

    expect(recommendedOf(['Q1: Which approach?', 'a) Rewrite from scratch (not recommended)', 'b) Patch in place'])).toBeNull()
    expect(recommendedOf(['Q1: Which config?', 'a) Use the recommended defaults', 'b) Custom tuned', 'Recommended: b'])).toBe('b')
    expect(recommendedOf(['Q1: Which DB?', 'a) Mongo', 'b) Postgres', 'I would not recommend option A.'])).toBeNull()
    expect(recommendedOf(['Q1: Which rollout?', 'a) Big bang (not recommended: risky)', 'b) Staged (RECOMMENDED)', 'c) Skip'])).toBe('b')
    expect(recommendedOf(['Q1: Which rollout?', 'a) Big bang', "b) Staged, which I don't recommend", 'c) Skip — recommended'])).toBe('c')
    // Two marks that disagree are no default at all.
    expect(recommendedOf(['Q1: Which store?', 'a) PG (recommended)', 'b) SQLite', 'Recommended: b'])).toBeNull()

    expect(labelMarksRecommended('SQLite (recommended)')).toBe(true)
    expect(labelMarksRecommended('Recommended: SQLite')).toBe(true)
    expect(labelMarksRecommended('Use the recommended defaults')).toBe(false)
    expect(labelMarksRecommended('Rewrite (not recommended)')).toBe(false)
    expect(labelMarksRecommended('Not-recommended path')).toBe(false)
  })

  test('only a whole mark counts: a "recommend" turned around before or after it never presets that option', () => {
    const recommendedOf = (lines: string[]) => parseDecisions(lines.join('\n'))[0]?.recommended

    for (const mark of [
      '(recommended against)',
      '— recommended against',
      '(least recommended)',
      '(less recommended)',
      '(hardly recommended)',
      '(rarely recommended)',
      "(wouldn't really be recommended)",
      '(risky; the recommended one is b)',
      '— avoid, NOT RECOMMENDED',
      '(DO NOT USE — RECOMMENDED ONLY FOR TESTS)',
      ', not-recommended',
    ]) {
      expect(recommendedOf(['Q1 Which approach?', `a) Big bang ${mark}`, 'b) Staged'])).toBeNull()
    }

    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', 'Recommended against: Q1 a'])).toBeNull()
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', 'Least recommended: a'])).toBeNull()
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', 'I would recommend against option A.'])).toBeNull()
    expect(parseDecisions(['Q1 Which?', 'a) X', 'b) Y', 'Q2 Which?', 'a) X', 'b) Y', 'Not recommended: Q1 a, Q2 a'].join('\n')).map(q => q.recommended)).toEqual([null, null])

    // The whole marks still count, a negative option among them included.
    expect(recommendedOf(['Q1 Which approach?', 'a) Big bang (less recommended)', 'b) Staged (RECOMMENDED)'])).toBe('b')
    expect(recommendedOf(['Ship behind a flag?', 'a) Yes', 'b) No (recommended)'])).toBe('b')
    expect(recommendedOf(["Q1 Ship now?", "a) Don't ship yet [strongly recommended]", 'b) Ship'])).toBe('a')
    expect(recommendedOf(['Q1 Which?', 'a) X (my recommendation)', 'b) Y'])).toBe('a')
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y — highly recommended'])).toBe('b')
    // Only a line that opens with "Recommended:" names an option; prose never does, however it is worded.
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', 'If there is no rush, I recommend option B.'])).toBeNull()
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', 'I recommend (a), not (b).'])).toBeNull()
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', "I'd avoid a; Recommended: b"])).toBeNull()
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', '**Recommended:** (b)'])).toBe('b')
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', '- Recommendation: option B'])).toBe('b')
    expect(recommendedOf(['Q1 Which?', 'a) X', 'b) Y', 'Recommended: not a'])).toBeNull()
    expect(parseDecisions(['Q1 Which?', 'a) X', 'b) Y', 'Q2 Which?', 'a) X', 'b) Y', 'Recommended: Q1 b, Q2 a.'].join('\n')).map(q => q.recommended)).toEqual(['b', 'a'])
  })

  test('a "Recommended:" line counts only as a bare option list, and a label mark only with no negation beside it', () => {
    const recommendedOf = (lines: string[]) => parseDecisions(lines.join('\n'))[0]?.recommended
    const one = (line: string) => recommendedOf(['Q1 Which?', 'a) X', 'b) Y', line])

    // Verify-3 V1: every wording that argued against an option still preset it.
    for (const line of [
      'Recommended: not Q1 a',
      'Recommendation: avoid Q1 a; go with Q1 b',
      'Recommended: anything but Q1 a',
      'Recommended - against Q1 a',
      'Recommended: no Q1 a',
      'Recommended: (a) is NOT recommended',
      'Recommended: a - avoid at all costs',
      'Recommendation: option A is not the one',
      'Recommended: a would be wrong',
      "Recommendation - a, wouldn't do it",
      'Recommended: a. Not really, avoid it.',
      'Recommended: Q1 a, Q1 b',
    ]) {
      expect([line, one(line)]).toEqual([line, null])
    }

    for (const label of [
      'Recommended — against: Postgres',
      'Recommended: no, too risky',
      'Recommended - not really, avoid',
      'X - NOT: recommended',
      'avoid, recommended',
      'Big bang, not (recommended)',
      'Recommended: anything but this',
    ]) {
      expect([label, labelMarksRecommended(label)]).toEqual([label, false])
      expect([label, recommendedOf(['Q1 Which?', `a) ${label}`, 'b) Y'])]).toEqual([label, null])
    }

    // The bare forms still name their option.
    expect(one('Recommended: b')).toBe('b')
    expect(one('Recommended: b.')).toBe('b')
    expect(one('Recommended: b)')).toBe('b')
    expect(one('Recommended: Q1 b')).toBe('b')
    expect(one('**Recommendation:** Option B')).toBe('b')
    expect(parseDecisions(['Q1 Which?', 'a) X', 'b) Y', 'Q2 Which?', 'a) X', 'b) Y', 'Recommended: Q1: (b); Q2: a'].join('\n')).map(q => q.recommended)).toEqual(['b', 'a'])
    expect(labelMarksRecommended('Recommended: SQLite')).toBe(true)
    expect(labelMarksRecommended('Staged — recommended')).toBe(true)
    expect(recommendedOf(['Q1 Ship?', 'a) Yes', 'b) No (recommended)'])).toBe('b')
  })

  test('an explanation or a self-answered status list raises no cards', () => {
    expect(parseDecisions(['Why did CI fail? Two reasons:', 'a) the cache was stale', 'b) the token expired'].join('\n'))).toEqual([])
    expect(parseDecisions(['What changed:', '1. Did the parser regress? No.', '   a) unit tests pass', '   b) e2e pass', '2. Deploy done.'].join('\n'))).toEqual([])
    expect(parseDecisions(['How did CI fail?', 'a) flaky', 'b) timeout'].join('\n'))).toEqual([])
    expect(parseDecisions(['What caused the outage?', 'a) a bad deploy', 'b) a DNS change'].join('\n'))).toEqual([])
    expect(parseDecisions(['1. Did the parser regress?', 'a) unit tests pass', 'b) e2e pass'].join('\n'))).toEqual([])
    // A fact question that offers a choice, and one answered yes or no, still ask; so does a labelled one.
    expect(parseDecisions(['Is it OK to ship now?', 'a) Yes', 'b) No'].join('\n'))).toHaveLength(1)
    expect(parseDecisions(['Is Postgres or SQLite the better fit?', 'a) Postgres', 'b) SQLite'].join('\n'))).toHaveLength(1)
    expect(parseDecisions(['Q1: Did you want the cache kept?', 'a) keep it', 'b) drop it'].join('\n'))).toHaveLength(1)
    // A question followed only by a cue to choose still asks.
    expect(parseDecisions(['Which store? Pick one:', 'a) PG', 'b) SQLite'].join('\n'))).toHaveLength(1)
  })

  test('a main-loop answer raises cards; Send answers fills the prompt once and clears them', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    for (const surface of SURFACES) {
      await $.turn.complete(answer(DECISIONS, { turnId: `turn-${surface}` }))

      const ui = await $.ui.mount(band(surface))

      expect((await ui.find({ key: 'pick-1' }))?.props.value).toBe('b')
      expect(await ui.find({ key: 'cards-accept' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^Send answers sends/ }))?.text).toBe('Send answers sends: "Q1 b, Q2 a"')
      await ui.select({ key: 'pick-1', value: 'a' })
      // Shown before the press, both ways it can go out.
      expect((await ui.find({ type: 'Text', text: /^Send answers sends/ }))?.text).toBe('Send answers sends: "Q1 a, Q2 a"; Accept all sends: "Q1 b, Q2 a"')
      await ui.press({ key: 'cards-send' })
      expect(await ui.find({ key: 'cards-send' })).toBeUndefined()
      await ui.unmount()
    }

    expect(w.fills).toEqual(['Q1 a, Q2 a', 'Q1 a, Q2 a'])
    expect(w.submits).toHaveLength(0)
  })

  test('a subagent answer raises no cards; a fill refused for an unknown cause keeps the cards and sends nothing', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.turn.complete(answer(DECISIONS, { agentId: 'agent-1' }))

    const ui = await $.ui.mount(band('desktop'))

    expect(await ui.find({ key: 'cards-send' })).toBeUndefined()

    // A cause a hook writes is stripped by the engine, so this reaches the plugin as an unknown refusal.
    w.fillAnswer = { isFilled: false, refusal: 'no_composer' }
    await $.turn.complete(answer(DECISIONS))
    await ui.press({ key: 'cards-accept' })

    expect(w.fills).toEqual(['Q1 b, Q2 a'])
    expect(w.submits).toHaveLength(0)
    expect(await ui.find({ key: 'cards-accept' })).toBeDefined()
  })

  test('only the engine saying there is no prompt box falls back to submitting as the person', () => {
    expect(fillOutcome({ isFilled: true })).toBe('filled')
    expect(fillOutcome({ isFilled: false, refusal: 'no_composer' })).toBe('submit')
    expect(fillOutcome({ isFilled: false, refusal: 'dialog' })).toBe('keep')
    expect(fillOutcome({ isFilled: false })).toBe('keep')
  })

  test('while Claude works, Send answers, Accept all and Done do nothing but say so', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.turn.complete(answer(`${DECISIONS}\nWAITING ON YOU: approve the deploy`))

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface, { isWorking: true }))

      await ui.press({ key: 'cards-send' })
      await ui.press({ key: 'cards-accept' })
      await ui.press({ key: 'done-w1' })
      expect(await ui.find({ key: 'cards-send' })).toBeDefined()
      expect(await ui.find({ key: 'done-w1' })).toBeDefined()
      await ui.unmount()
    }

    expect(w.fills).toHaveLength(0)
    expect(w.submits).toHaveLength(0)
    expect(w.toasts.every(toast => toast.startsWith('Claude is working'))).toBe(true)
  })

  test('a notification or a peer between question and answer leaves the cards; a prompt dropped beneath leaves everything', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.turn.complete(answer(`${DECISIONS}\nWAITING ON YOU: approve the deploy`))

    const ui = await $.ui.mount(band('terminal'))

    await $.prompt.submit({ text: 'Agent finished.', wait: false, origin: { kind: 'task-notification' } })
    await $.prompt.submit({ text: 'From now on, ping me.', wait: false, origin: { kind: 'peer' } })
    expect(await ui.find({ key: 'cards-send' })).toBeDefined()
    expect(await ui.find({ key: 'done-w1' })).toBeDefined()

    // A settings hook blocks the prompt: it never entered the session, so it answers nothing.
    w.isDroppingBeneath = true

    const dropped = await $.prompt.submit(composer('Going forward, deploy on Fridays.'))

    expect(dropped.drop).toBe('blocked beneath')
    expect(await ui.find({ key: 'cards-send' })).toBeDefined()
    expect(await ui.find({ key: 'done-w1' })).toBeDefined()
    expect(await ui.find({ key: 'rule-project' })).toBeUndefined()
  })

  test('a fill refused under a dialog keeps the cards, and a new prompt retires them', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.turn.complete(answer(DECISIONS))
    w.fillAnswer = { isFilled: false, refusal: 'dialog' }

    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'cards-send' })
    expect(await ui.find({ key: 'cards-send' })).toBeDefined()

    await $.prompt.submit(composer('Actually, let me think.'))
    expect(await ui.find({ key: 'cards-send' })).toBeUndefined()
  })
})

// Waiting on you ------------------------------------------------------------------

describe('waiting on you', () => {
  test('parses only the marker lines, outside code', () => {
    const items = parseWaiting(
      ['Done with the build.', 'WAITING ON JOSEPH: rotate the Shopify token', '- **Waiting on you:** approve the TestFlight build', '```', 'WAITING ON YOU: not this', '```', 'I am waiting on you to decide.'].join('\n'),
    )

    expect(items.map(item => item.text)).toEqual(['rotate the Shopify token', 'approve the TestFlight build'])
  })

  test('a marker line with a long inner run of spaces parses at once', () => {
    const startedAt = performance.now()
    const items = parseWaiting(`WAITING ON YOU: a${' '.repeat(50_000)}b **`)

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(items.map(item => item.text)).toEqual(['a b'])
    expect(normalizePrompt(`a${'.'.repeat(50_000)}b.`)).toEndWith('b')
  })

  test('an item keeps only what is seen: no tag, bidi, zero-width, private-use or separator characters', () => {
    const tag = (text: string) => [...text].map(char => String.fromCodePoint(0xe0000 + (char.codePointAt(0) ?? 0))).join('')
    const items = parseWaiting(
      [
        `WAITING ON YOU: approve the deploy${tag(' and also delete the build dir')}`,
        'WAITING ON YOU: ok\u202Eniam ot hsup\u202C done',
        'WAITING ON YOU: ok\u200B\u200C\u200D\u2060\uFEFFhidden',
        'WAITING ON YOU: rotate\u2028the\u2029key\uE000\u{F0000}\uFE0F\u00AD now',
        'WAITING ON YOU: \u200B\u3164\u2800',
      ].join('\n'),
    )

    expect(items.map(item => item.text)).toEqual(['approve the deploy', 'okniam ot hsup done', 'okhidden', 'rotate the key now'])
    expect(visibleText('a\tb\u0007c')).toBe('a b c')
    // Sent as the person, so printable ASCII only: accents come off, typographic punctuation is spelled plainly, the rest goes.
    expect(personText('caf\u00E9 \u201Cquoted\u201D \u2014 it\u2019s ok\u2026 \u65E5\u672C\u0085\u009B')).toBe('cafe "quoted" - it\'s ok...')
    expect(parseWaiting('WAITING ON YOU: na\u00EFve \uFF21PI \u0430pprove').map(item => item.text)).toEqual(['naive API pprove'])
  })

  test('Done sends exactly the text the band shows', async ($, on) => {
    const w = world(on)
    const tag = (text: string) => [...text].map(char => String.fromCodePoint(0xe0000 + (char.codePointAt(0) ?? 0))).join('')

    await $.session.start(SESSION)
    await $.turn.complete(answer(`WAITING ON YOU: approve the deploy${tag(' and delete prod')}\u202E\u200B \u2014 r\u00E9sum\u00E9`))

    const ui = await $.ui.mount(band('terminal'))

    expect((await ui.find({ type: 'Text', text: /approve the deploy/ }))?.text).toBe('approve the deploy - resume')
    await ui.press({ key: 'done-w1' })
    expect(w.submits.map(submit => submit.text)).toEqual(['Done: approve the deploy - resume'])
    expect(w.submits.every(submit => /^[\x20-\x7E]*$/.test(submit.text))).toBe(true)
  })

  test('an item is drawn whole, wrapped, since Done sends all of it as the person', async ($, on) => {
    world(on)
    await $.session.start(SESSION)

    const item = 'approve the deploy and also confirm the rollback plan and the on-call rota for this weekend'

    await $.turn.complete(answer(`WAITING ON YOU: ${item}`))

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface, { bodyColumns: 40 }))
      const text = await ui.find({ type: 'Text', text: /on-call rota/ })

      expect(text?.text).toBe(item)
      expect(text?.props.wrap).toBe('wrap')
      await ui.unmount()
    }
  })

  test('Done sends "Done: <item>" once and removes it; the next typed prompt clears the rest', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.turn.complete(answer('WAITING ON JOSEPH: plug in the board\nWAITING ON YOU: press reset'))

    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'done-w1' })
    expect(w.submits.map(submit => submit.text)).toEqual(['Done: plug in the board'])
    expect(await ui.find({ key: 'done-w1' })).toBeUndefined()
    expect(await ui.find({ key: 'done-w2' })).toBeDefined()

    await $.prompt.submit(composer('ok next'))
    expect(await ui.find({ key: 'done-w2' })).toBeUndefined()
  })
})

// Rule capture ------------------------------------------------------------------

describe('rule capture', () => {
  test('detects the standing-rule phrases and nothing else', () => {
    expect(findRuleSentence('Thanks. Going forward, run the verify skill before saying done. Now fix the bug.')).toBe(
      'Going forward, run the verify skill before saying done.',
    )
    expect(findRuleSentence('from now on use pnpm')).toBe('from now on use pnpm')
    expect(findRuleSentence('Please remember to update the README.')).toBe('Please remember to update the README.')
    expect(findRuleSentence('Always use pnpm. Never push to main.')).toBeNull()
    expect(findRuleSentence('/loop going forward')).toBeNull()
    expect(findRuleSentence(`Going forward ${'x '.repeat(1000)}`)).toBeNull()
    expect(findRuleSentence('From now on use the key sk-abcdefghijklmnopqrstuvwxyz012345.')).toBeNull()
    expect(findRuleSentence('```\nfrom now on\n```\nship it')).toBeNull()
  })

  test('a question is no rule unless it is a request', () => {
    expect(findRuleSentence('Is this going forward or not?')).toBeNull()
    expect(findRuleSentence('Did you add that to memory?')).toBeNull()
    expect(findRuleSentence('Could you use pnpm from now on?')).toBe('Could you use pnpm from now on?')
    expect(findRuleSentence('Is that done? Going forward, run lint first.')).toBe('Going forward, run lint first.')
  })

  test('"remember" counts only as a request, and a colon lead-in takes the lines under it', () => {
    expect(findRuleSentence('Do you remember that bug from yesterday?')).toBeNull()
    expect(findRuleSentence("I can't remember to be honest")).toBeNull()
    expect(findRuleSentence('Remember that we squash merge.')).toBe('Remember that we squash merge.')
    expect(findRuleSentence('Also, please remember to run the linter.')).toBe('Also, please remember to run the linter.')
    expect(findRuleSentence('Going forward:\n- use pnpm\n- no yarn\n\nThanks')).toBe('Going forward: use pnpm; no yarn')
    expect(findRuleSentence('Going forward:')).toBeNull()
  })

  test('inserts under the Captured rules heading, never at the blind end', () => {
    const file = '# Project\n\nIntro.\n\n## Captured rules\n\n- Old rule.\n\n## Generated\n\nDo not edit.\n'

    expect(insertCapturedRule(file, 'New rule.')).toBe('# Project\n\nIntro.\n\n## Captured rules\n\n- Old rule.\n- New rule.\n\n## Generated\n\nDo not edit.\n')
    expect(insertCapturedRule('# Project\n', 'New rule.')).toBe('# Project\n\n## Captured rules\n\n- New rule.\n')
  })

  test('a heading inside code is not the section, CRLF files stay CRLF, and code never counts as holding the rule', () => {
    expect(insertCapturedRule('# P\n\n```md\n## Captured rules\n```\n', 'New rule.')).toBe('# P\n\n```md\n## Captured rules\n```\n\n## Captured rules\n\n- New rule.\n')
    expect(insertCapturedRule('# P\r\n\r\n## Captured rules\r\n\r\n- Old.\r\n', 'New.')).toBe('# P\r\n\r\n## Captured rules\r\n\r\n- Old.\r\n- New.\r\n')
    expect(insertCapturedRule('# P\r\n', 'New.')).toBe('# P\r\n\r\n## Captured rules\r\n\r\n- New.\r\n')
    expect(hasRule('```\n- Use pnpm.\n```\n', 'Use pnpm.')).toBe(false)
    expect(hasRule('## Notes\n- Use pnpm.\n', 'use pnpm')).toBe(true)
  })

  test('a typed rule shows verbatim; Project rules writes it under the heading in the session root', async ($, on) => {
    const w = world(on, { '/work/wt/CLAUDE.md': '# Project\n\n## Captured rules\n\n- Old rule.\n\n## Other\n\nStuff.\n' })

    await $.session.start(SESSION)
    await $.prompt.submit(composer('Nice. Going forward, run the verify skill before saying done.'))

    const ui = await $.ui.mount(band('terminal'))

    expect((await ui.find({ type: 'Text', text: /verify skill/ }))?.text).toContain('"Going forward, run the verify skill before saying done."')
    expect(w.writes).toHaveLength(0)

    await ui.press({ key: 'rule-project' })

    expect(w.writes).toEqual([
      {
        path: '/work/wt/CLAUDE.md',
        text: '# Project\n\n## Captured rules\n\n- Old rule.\n- Going forward, run the verify skill before saying done.\n\n## Other\n\nStuff.\n',
      },
    ])
    expect(await ui.find({ key: 'rule-project' })).toBeUndefined()

    // Saved once: the same rule typed again is not offered again.
    await $.prompt.submit(composer('Going forward, run the verify skill before saying done.'))
    expect(await ui.find({ key: 'rule-project' })).toBeUndefined()
  })

  test('Global rules creates the captured-rules file under HOME; peers never raise a capture', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.prompt.submit({ text: 'From now on deploy on Fridays.', wait: false, origin: { kind: 'peer' } })

    const ui = await $.ui.mount(band('desktop'))

    expect(await ui.find({ key: 'rule-global' })).toBeUndefined()

    await $.prompt.submit(composer('From now on, keep PRs under 400 lines.'))
    await ui.press({ key: 'rule-global' })

    expect(w.writes.map(write => write.path)).toEqual(['/home/j/.claude/captured-rules.md'])
    expect(w.writes[0]?.text).toStartWith('# Captured rules\n')
    expect(w.writes[0]?.text).toEndWith('## Captured rules\n\n- From now on, keep PRs under 400 lines.\n')
    // Nothing imports the file yet, and the mod never edits ~/.claude/CLAUDE.md: it says so instead of seeming done.
    expect(w.toasts.at(-1)).toContain('not loaded yet')
    expect(w.toasts.at(-1)).toContain('/home/j/.claude/CLAUDE.md')
  })

  test('Global rules says plainly saved when ~/.claude/CLAUDE.md already imports the file', async ($, on) => {
    const w = world(on, { '/home/j/.claude/CLAUDE.md': '# Me\n\n@captured-rules.md\n' })

    await $.session.start(SESSION)
    await $.prompt.submit(composer('From now on, keep PRs small.'))

    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'rule-global' })
    expect(w.toasts.at(-1)).toBe('Saved to /home/j/.claude/captured-rules.md.')
  })

  test('a rule saved in one project is still offered in another, and one already in the file is not offered', async ($, on) => {
    const w = world(on, { '/work/other/CLAUDE.md': '# Other\n\n- Going forward, squash merge only.\n' })

    await $.session.start(SESSION)
    await $.prompt.submit(composer('Going forward, run the verify skill.'))

    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'rule-project' })
    expect(w.writes.map(write => write.path)).toEqual(['/work/wt/CLAUDE.md'])

    w.root = '/work/third'
    await $.prompt.submit(composer('Going forward, run the verify skill.'))
    expect(await ui.find({ key: 'rule-project' })).toBeDefined()
    await ui.press({ key: 'rule-dismiss' })

    w.root = '/work/other'
    await $.prompt.submit(composer('Going forward, squash merge only.'))
    expect(await ui.find({ key: 'rule-project' })).toBeUndefined()
  })

  test('a rule is offered and written only as it is seen: tag, bidi and zero-width characters never reach the file', async ($, on) => {
    expect(findRuleSentence('Going forward, always use pnpm\u{E0041}\u{E0042}\u{E0043} ok.')).toBe('Going forward, always use pnpm ok.')
    expect(findRuleSentence('Going forward, use ‮pnpm‬ and​⁠ yarn.')).toBe('Going forward, use pnpm and yarn.')

    const w = world(on, { '/work/wt/CLAUDE.md': '# Project\n' })

    await $.session.start(SESSION)
    await $.prompt.submit(composer('From now on, run tests\u{E0049}\u{E0047}\u{E004E} first.'))

    const ui = await $.ui.mount(band('terminal'))

    expect((await ui.find({ type: 'Text', text: /run tests/ }))?.text).toContain('"From now on, run tests first."')
    await ui.press({ key: 'rule-project' })
    expect(w.writes.map(write => write.text)).toEqual(['# Project\n\n## Captured rules\n\n- From now on, run tests first.\n'])
  })

  test('a rule typed in the desktop app (sdk origin) is offered, and each saved rule has a store key of its own', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.prompt.submit({ text: 'Going forward, squash merge only.', wait: false, origin: { kind: 'sdk' } })

    const ui = await $.ui.mount(band('desktop'))

    await ui.press({ key: 'rule-project' })
    await $.prompt.submit(composer('Going forward, run the verify skill.'))
    await ui.press({ key: 'rule-project' })

    expect(w.writes.map(write => write.path)).toEqual(['/work/wt/CLAUDE.md', '/work/wt/CLAUDE.md'])

    // No shared list is read and rewritten, so two sessions saving at once cannot drop each other's record.
    const keys = [...w.store.keys()]

    expect(keys.filter(key => key.startsWith('capturedRule:'))).toHaveLength(2)
    expect(keys.every(key => key.startsWith('capturedRule:') && w.store.get(key) === true)).toBe(true)
    expect(w.storeReads).not.toContain('capturedRuleHashes')
  })

  test('fails safe: a file that keeps changing is not written and the rule stays offered', async ($, on) => {
    const w = world(on, { '/work/wt/CLAUDE.md': '# Project\n' })

    w.isFileChurning = true
    await $.session.start(SESSION)
    await $.prompt.submit(composer('Going forward, squash merge only.'))

    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'rule-project' })

    expect(w.writes).toHaveLength(0)
    expect(await ui.find({ key: 'rule-project' })).toBeDefined()
    expect(w.toasts.some(toast => toast.includes('kept changing'))).toBe(true)
  })
})

describe('archive session', () => {
  const merged = (w: World, over: { dirty?: boolean; head?: string; ahead?: string | null; inDefault?: boolean; noRemote?: boolean } = {}) => {
    w.respond = argv => (argv[0] === 'git' ? gitAnswer(argv, over) : argv[1] === 'pr' ? ran(0, MERGED_PR) : null)
  }
  const greenStop = ($: Engine) => $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] } as never)
  const settled = async (w: World) => {
    await w.clock.settle()
  }

  test('completion: every observable condition, each unmet one a blocker, unknown never a pass', () => {
    const pr = { number: 12, state: 'MERGED', mergeable: 'UNKNOWN', mergeState: 'UNKNOWN', ci: 'green' as const, isMerged: true, headSha: HEAD_SHA, mergedAt: 10 }
    const standing = { branch: 'feat/x', pr, prStatus: 'ok' as const, refreshedAt: 10, isClean: true, dirtyFiles: 0, headSha: HEAD_SHA, aheadOfUpstream: 0, hasRemote: true, defaultBranch: 'origin/main', inDefault: true, mergedSeenAt: 10, stopSeq: 1, stopToken: 'load-a', inDefaultSeenAt: 10 }
    const base = { standing, now: 10, isWorking: false, hasPending: false, waiting: 0, openDecisions: 0, background: { tasks: 0, crons: 0, at: 10, seq: 1, token: 'load-a', source: 'stop' as const }, lead: { state: 'none' as const, id: null }, lastReportAt: 0 }
    expect(completion(base)).toEqual({ isReady: true, blockers: [] })
    expect(completion({ ...base, standing: null }).blockers).toEqual(['standing unknown'])
    expect(completion({ ...base, now: 10 + STALE_MS + 1 }).blockers).toEqual(['standing stale'])
    expect(completion({ ...base, background: { tasks: 0, crons: 0, at: 11, seq: 2, token: 'load-a', source: 'stop' as const } }).blockers).toEqual(['standing older than the last turn'])
    expect(completion({ ...base, background: { tasks: 0, crons: 0, at: 10, seq: 1, token: 'load-b', source: 'stop' as const } }).blockers).toEqual(['standing older than the last turn'])
    expect(completion({ ...base, standing: { ...standing, pr: { ...pr, state: 'OPEN', isMerged: false } } }).blockers).toEqual(['PR #12 open'])
    expect(completion({ ...base, standing: { ...standing, headSha: 'def4567def4567def4567def4567def4567def45' } }).blockers).toEqual(['commits after the merged PR'])
    expect(completion({ ...base, standing: { ...standing, pr: { ...pr, headSha: null } } }).blockers).toEqual(['merged head unknown'])
    expect(completion({ ...base, standing: { ...standing, isClean: false, dirtyFiles: 3 } }).blockers).toEqual(['3 uncommitted changes'])
    expect(completion({ ...base, standing: { ...standing, isClean: false, dirtyFiles: 1 } }).blockers).toEqual(['1 uncommitted change'])
    expect(completion({ ...base, standing: { ...standing, isClean: null } }).blockers).toEqual(['working tree unknown'])
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'none' } }).isReady).toBe(true)
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'none', inDefault: false } }).blockers).toEqual(['not in origin/main'])
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'none', defaultBranch: null, inDefault: null } }).blockers).toEqual(['default branch unknown'])
    // No remote at all: nowhere to push or merge, so a clean tree is done; remotes unknown blocks.
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'none', hasRemote: false, aheadOfUpstream: null, defaultBranch: null, inDefault: null } }).isReady).toBe(true)
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'none', hasRemote: null, aheadOfUpstream: null, defaultBranch: null, inDefault: null } }).blockers).toEqual(['remotes unknown'])
    expect(archiveReason({ ...standing, pr: null, prStatus: 'none', hasRemote: false })).toBe('no remote, all committed, tree clean, nothing waiting')
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'none', aheadOfUpstream: 2 } }).blockers).toEqual(['2 unpushed commits'])
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'none', aheadOfUpstream: null } }).blockers).toEqual(['unpushed commits unknown (no upstream)'])
    expect(completion({ ...base, standing: { ...standing, pr: null, prStatus: 'error' } }).blockers).toEqual(['PR unknown'])
    expect(completion({ ...base, isWorking: true, hasPending: true, waiting: 2, openDecisions: 1 }).blockers).toEqual(['working', 'reply queued', '2 waiting on you', '1 decision open'])
    expect(completion({ ...base, background: null }).blockers).toEqual(['background work unknown'])
    expect(completion({ ...base, background: { tasks: 1, crons: 2, at: 10, seq: 1, token: 'load-a', source: 'stop' } }).blockers).toEqual(['1 background task', '2 wakeups scheduled'])
    expect(completion({ ...base, background: { tasks: 2, crons: 0, at: 10, seq: 1, token: 'load-a', source: 'agents' } }).blockers).toEqual(['2 running agents'])
    // The lead: unknown blocks; known must have been told after the merge was first seen.
    expect(completion({ ...base, lead: { state: 'unknown', id: null } }).blockers).toEqual(['lead session unknown'])
    expect(completion({ ...base, lead: { state: 'known', id: 'parent-1' } }).blockers).toEqual(['lead session not told'])
    expect(completion({ ...base, lead: { state: 'known', id: 'parent-1' }, lastReportAt: 9 }).blockers).toEqual(['lead session not told'])
    expect(completion({ ...base, lead: { state: 'known', id: 'parent-1' }, lastReportAt: 10 }).isReady).toBe(true)
    expect(completion({ ...base, lead: { state: 'known', id: 'parent-1' }, lastReportAt: 10, standing: { ...standing, mergedSeenAt: undefined as never } }).blockers).toEqual(['merge time unknown'])
    // No PR: the report must follow the refresh that first saw HEAD in the default branch.
    expect(completion({ ...base, lead: { state: 'known', id: 'parent-1' }, lastReportAt: 9, standing: { ...standing, pr: null, prStatus: 'none', inDefaultSeenAt: 10 } }).blockers).toEqual(['lead session not told'])
    expect(completion({ ...base, lead: { state: 'known', id: 'parent-1' }, lastReportAt: 10, standing: { ...standing, pr: null, prStatus: 'none', inDefaultSeenAt: 10 } }).isReady).toBe(true)
    expect(completion({ ...base, lead: { state: 'known', id: 'parent-1' }, lastReportAt: 10, standing: { ...standing, pr: null, prStatus: 'none', inDefaultSeenAt: null } }).blockers).toEqual(['merge time unknown (no PR)'])
    expect(archiveReason(standing)).toBe('PR #12 merged, tree clean, nothing waiting')
    expect(archiveReason(null)).toBe('no PR, tree clean, nothing waiting')
  })

  test('merged at HEAD, clean, nothing standing: the Standing row offers Archive session; a press confirms, then asks the app to archive this session', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    merged(w)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w) // the Stop asks for a refresh younger than itself
    const ui = await $.ui.mount(band('terminal'))
    const button = await ui.find({ key: 'archive' })
    expect(button?.type).toBe('Button')
    expect(button?.props['label']).toBe('Archive session')
    expect(await ui.find({ type: 'Text', text: /archive after/ })).toBeUndefined()
    await ui.press({ key: 'archive' })
    expect(w.mcpCalls.filter(c => c.tool === 'archive_session')).toEqual([{ tool: 'archive_session', args: { session_id: 'self', reason: 'cockpit: PR #12 merged, tree clean, nothing waiting' } }])
    await ui.unmount()
  })

  test('an open PR, a dirty tree, commits after the merge, unpushed commits or a waiting item: no button, and the idle session says what stands', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    const line = async () => (await (await $.ui.mount(band('terminal'))).find({ type: 'Text', text: /archive after/ }))?.text
    let ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: PR #12 open')
    await ui.unmount()

    merged(w, { dirty: true })
    await w.clock.advance(60_000)
    await settled(w)
    expect(await line()).toBe('archive after: 1 uncommitted change')

    merged(w, { head: 'def4567def4567def4567def4567def4567def45' })
    await w.clock.advance(60_000)
    await settled(w)
    expect(await line()).toBe('archive after: commits after the merged PR')

    w.respond = argv => (argv[0] === 'git' ? gitAnswer(argv, { ahead: '2', inDefault: false }) : ran(1, '', 'no pull requests found for branch "feat/cockpit"'))
    await w.clock.advance(60_000)
    await settled(w)
    expect(await line()).toBe('archive after: 2 unpushed commits, not in origin/main')

    merged(w)
    await w.clock.advance(60_000)
    await settled(w)
    await $.turn.complete(answer('Done.\nWAITING ON JOSEPH: paste the token'))
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: 1 waiting on you')
    await ui.unmount()
  })

  test('background work: only a Stop after the latest turn counts, so a new turn hides the button until its Stop', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    merged(w)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    let ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeDefined()
    await ui.unmount()
    // A turn starts (it may start background work): the old count no longer stands.
    await $.turn.start({ ...composer('one more thing'), turnId: 'turn-2' })
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: background work unknown')
    await ui.unmount()
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 't1', type: 'agent', status: 'running' }], session_crons: [] } as never)
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: 1 background task')
    await ui.unmount()
  })

  test('the lead: unknown until the app answers, kept across a failed read, told only by a delivered main-loop message after the merge', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    w.lead = 'parent-1'
    merged(w)
    let failSend = false
    on('tool.call', () => (failSend ? { result: 'no', isError: true, ref: 1 } : { result: 'ok', ref: 1, text: 'ok' }) as never)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    let ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: lead session not told')
    await ui.unmount()

    // A subagent's message, a message to some other session, and a failed send do not count.
    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'SendMessage', to: 'parent-1', message: 'x', agentId: 'agent-7' } as never)
    await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id: 'someone-else', message: 'x' } as never)
    failSend = true
    await $.tool.call({ tool: 'SendMessage', to: 'parent-1', message: 'x' } as never)
    failSend = false
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    await ui.unmount()

    // The app's record goes unreadable for a round: the lead is still known.
    w.isGetSessionFailing = true
    await w.clock.advance(60_000)
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: lead session not told')
    await ui.unmount()
    w.isGetSessionFailing = false

    // A delivered message to the lead from the main loop: told.
    await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id: 'parent-1', message: 'merged and done' } as never)
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ key: 'archive' }))?.props['label']).toBe('Archive session')
    await ui.unmount()
  })

  test('a host that raises no classic.Stop (the desktop): the turn-complete observation of running agents stands in', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    merged(w)
    await $.session.start(SESSION)
    await settled(w)
    // No Stop ever arrives; a completed main-loop turn with no running agent is enough.
    await $.turn.complete(answer('Merged and reported.'))
    await settled(w)
    let ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ key: 'archive' }))?.props['label']).toBe('Archive session')
    await ui.unmount()

    // A running subagent blocks, in those words; a subagent's own turn end changes nothing.
    w.agents = [{ id: 'a1', description: 'scout', type: 'scout', status: 'running' }]
    await $.turn.start({ ...composer('go on'), turnId: 'turn-3' })
    await $.turn.complete(answer('Working.', { agentId: 'a1', turnId: 'turn-3' }))
    await $.turn.complete(answer('Dispatched.', { turnId: 'turn-3' }))
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: 1 running agent')
    await ui.unmount()
  })

  test('a repository with no remote: all committed is done, so the button shows with its own reason', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    w.respond = argv => (argv[0] === 'git' ? gitAnswer(argv, { noRemote: true, ahead: null }) : ran(1, '', 'no git remotes found'))
    await $.session.start(SESSION)
    await settled(w)
    await $.turn.complete(answer('All committed.'))
    await settled(w)
    const ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ key: 'archive' }))?.props['label']).toBe('Archive session')
    await ui.press({ key: 'archive' })
    expect(w.mcpCalls.filter(c => c.tool === 'archive_session')).toEqual([{ tool: 'archive_session', args: { session_id: 'self', reason: 'cockpit: no remote, all committed, tree clean, nothing waiting' } }])
    await ui.unmount()
  })

  test('a refused send does not count as telling the lead', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    w.lead = 'parent-1'
    merged(w)
    let answerInPlace = false
    on('tool.call', () => (answerInPlace ? { result: 'sent, says a hook' } : { deny: 'a guard refused it' }) as never)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id: 'parent-1', message: 'merged and done' } as never).catch(() => undefined)
    // A hook answering in the tool's place (no engine ref) is not a delivery either.
    answerInPlace = true
    await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id: 'parent-1', message: 'merged and done' } as never).catch(() => undefined)
    await settled(w)
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: lead session not told')
    await ui.unmount()
  })

  test('a refresh in flight when the turn ends never passes on its old readings: the Stop queues a fresh one', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    merged(w)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    let ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeDefined()
    await ui.unmount()

    // The minute refresh starts (git read clean) and waits on gh; meanwhile the tree is edited and the turn ends.
    w.prDelayMs = 5_000
    await w.clock.advance(60_000)
    merged(w, { dirty: true })
    await greenStop($)
    // The in-flight refresh lands with readings older than the Stop: still no button.
    await w.clock.advance(5_000)
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    await ui.unmount()
    // The queued fresh refresh lands and sees the edit.
    await w.clock.advance(5_000)
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: 1 uncommitted change')
    await ui.unmount()
  })

  test('the press re-reads git after the dialog: an edit made meanwhile stops the archive with a toast', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    merged(w)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeDefined()
    merged(w, { dirty: true })
    await ui.press({ key: 'archive' })
    expect(w.mcpCalls.filter(c => c.tool === 'archive_session')).toHaveLength(0)
    expect(w.toasts[w.toasts.length - 1]).toBe('Cockpit: not archived, something came up: 1 uncommitted change.')
    await ui.unmount()
  })

  test('the merge is dated from GitHub: a report sent after the merge but before the band saw it counts; a later PR is a new merge', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL, GET_SESSION_TOOL]
    w.lead = 'parent-1'
    // PR #12 is still open when the session starts.
    w.respond = argv => (argv[0] === 'git' ? gitAnswer(argv) : argv[1] === 'pr' ? ran(0, OPEN_PR.replace('"headRefOid"', '"x"')) : null)
    on('tool.call', () => ({ result: 'ok', ref: 1, text: 'ok' }) as never)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    // GitHub merges it at START + 5 s; the report goes out at START + 10 s; the band only sees the merge at the minute refresh.
    await w.clock.advance(10_000)
    await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id: 'parent-1', message: 'merged' } as never)
    w.respond = argv => (argv[0] === 'git' ? gitAnswer(argv) : argv[1] === 'pr' ? ran(0, MERGED_PR.replace(/"mergedAt":"[^"]+"/, `"mergedAt":"${new Date(START + 5_000).toISOString()}"`)) : null)
    await w.clock.advance(50_000)
    await settled(w)
    await greenStop($)
    await settled(w)
    let ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ key: 'archive' }))?.props['label']).toBe('Archive session')
    await ui.unmount()

    // PR #13 merges on the same branch (GitHub gives no mergedAt here): dated from the refresh that sees it, after the report.
    w.respond = argv => (argv[0] === 'git' ? gitAnswer(argv) : argv[1] === 'pr' ? ran(0, MERGED_PR.replace('"number":12', '"number":13').replace(/"mergedAt":"[^"]+"/, '"mergedAt":null')) : null)
    await w.clock.advance(60_000)
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: lead session not told')
    await ui.unmount()
  })

  test('without the app\'s record the lead is unknown and blocks; without the archive tool a done session says use the app', async ($, on) => {
    const w = world(on)
    w.tools = [ARCHIVE_TOOL]
    merged(w)
    await $.session.start(SESSION)
    await settled(w)
    await greenStop($)
    await settled(w)
    let ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /archive after/ }))?.text).toBe('archive after: lead session unknown')
    await ui.unmount()

    w.tools = [GET_SESSION_TOOL]
    await w.clock.advance(60_000)
    await settled(w)
    ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'archive' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'done: ready to archive (use the app)' })).toBeDefined()
    await ui.unmount()
  })
})
