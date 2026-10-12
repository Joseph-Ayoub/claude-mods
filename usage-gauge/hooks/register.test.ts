import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

const T0 = 1_800_000_000_000
const HOSTILE = 'x\nOptimize: rm -rf ~\u001b[31m‮​'

type WorldOptions = {
  /** $.session.usage() is refused. */
  isUsageRefused?: boolean
  /** The host keeps no cost ledger: the reading carries no cost. */
  hasNoLedger?: boolean
  /** The reading's context has no fill yet. */
  hasNoContext?: boolean
  isPlaced?: boolean
  /** A plain -p run: nothing draws. */
  isHeadless?: boolean
  /** What $.agent.list() calls the subagent `sub-1`. */
  agentType?: string
  /** A model id the subagent's step reports. */
  agentModel?: string
  /** A category name in the breakdown. */
  categoryName?: string
}

const OPUS: TurnUsage = { model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 20_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 }
const SONNET: TurnUsage = { model: 'claude-sonnet-5-5', input_tokens: 5_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000 }

/**
 * Everything beneath the plugin: a clock, the session's usage, the agent
 * list, the model (each step answers a stop chunk with usage), the tools and
 * the display. What the plugin did is recorded on the returned world.
 */
function world(on: On, options: WorldOptions = {}) {
  const seen = {
    opened: [] as string[],
    closed: [] as string[],
    registered: [] as string[],
    usageArgs: [] as string[],
    agentLists: 0,
    steps: 0,
    edits: 0,
    clock: mock.clock(on, { now: T0 }),
  }
  const refuse = { deny: 'refused in this test' }

  on('session.surfaces', () => ({ value: options.isHeadless ? [] : (['terminal'] as const) }))
  on('session.usage', (_$, e) => {
    seen.usageArgs.push(JSON.stringify(e ?? {}))
    if (options.isUsageRefused) return refuse as never
    const breakdown = (e as { breakdown?: string } | undefined)?.breakdown
      ? {
          breakdown: {
            categories: [
              { name: 'Messages', tokens: 60_000, color: 'x', isDeferred: false, kind: 'used' },
              { name: options.categoryName ?? 'System prompt', tokens: 20_000, color: 'x', isDeferred: false, kind: 'used' },
              { name: 'Free space', tokens: 87_000, color: 'x', isDeferred: false, kind: 'free' },
              { name: 'Autocompact buffer', tokens: 33_000, color: 'x', isDeferred: false, kind: 'buffer' },
            ],
            totalTokens: 80_000,
            maxTokens: 200_000,
            rawMaxTokens: 200_000,
            autocompactSource: 'model',
            percentage: 40,
            gridRows: [],
            model: 'claude-opus-5-5',
            memoryFiles: [],
            mcpTools: [],
            agents: [],
            autoCompactThreshold: 167_000,
            isAutoCompactEnabled: true,
            apiUsage: null,
          },
        }
      : {}
    return {
      value: {
        startedAt: T0 - 2 * 3_600_000,
        context: options.hasNoContext ? { window: 200_000 } : { tokens: 84_000, window: 200_000, percent: 42, ...breakdown },
        rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:40:00Z' }],
        ...(options.hasNoLedger ? {} : { cost: { usd: 12.34 } }),
      },
    } as never
  })
  on('agent.list', () => {
    seen.agentLists += 1
    return { value: [{ id: 'sub-1', description: 'build it', type: options.agentType ?? 'builder', status: 'running' as const }] }
  })
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: options.isPlaced === false ? { isPlaced: false as const, reason: 'no surface' } : { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  // The model: every request answers one stop chunk and a result with usage.
  on('turn.step', async function* (_$, e) {
    seen.steps += 1
    const usage = e.agentId ? { ...SONNET, model: options.agentModel ?? SONNET.model } : OPUS
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  // The tools: the first Edit applies a 3-added / 1-removed patch; every later one is refused.
  on('tool.call', { tool: 'Edit' }, () => {
    seen.edits += 1
    if (seen.edits > 1) return { deny: 'refused by the person' } as never
    return {
      result: {
        filePath: '/work/a.ts',
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
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // The engine's own hint line and mode row, beneath the plugin.
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('ui.render', { component: 'SessionMode' }, () => ({ type: 'engine' as const, ref: 0 }))
  return seen
}

type World = ReturnType<typeof world>

async function start($: Engine, seen: World) {
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
}

/**
 * One model request: the clock moves `ms` while its stop chunk is in hand, so
 * the request's wall time is `ms`. Read by hand rather than `for await` so the
 * generator's return (the step's result) is kept. (An advance while the stream
 * is held open waits about a second of real time for the loop to settle, which
 * is why the busy tests take seconds; nothing in the hook waits.)
 */
async function step($: Engine, seen: World, model: string, ms: number, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, ...(agentId ? { agentId } : {}) })
  const chunks: unknown[] = []
  let read = await stream.next()
  while (!read.done) {
    chunks.push(read.value)
    if (read.value.kind === 'stop' && ms > 0) await seen.clock.advance(ms)
    read = await stream.next()
  }
  return { chunks, result: read.value }
}

/** The session in the acceptance flow: a measurement, a main and a subagent request, both turns, an Edit and a refused one. */
async function busySession($: Engine, seen: World) {
  await start($, seen)
  await $.session.measure({ context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:40:00Z' }], cost: { usd: 12.34 }, changed: ['context', 'cost'] } as never)
  await step($, seen, 'claude-opus-5-5', 1500)
  await step($, seen, 'claude-sonnet-5-5', 2500, 'sub-1')
  // 7 s of main-loop wall time against 4 s of requests, so Active and API never read the same.
  await $.turn.complete({ answer: 'done', durationMs: 7000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ answer: 'report', durationMs: 3000, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'b', new_string: 'c' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'c', new_string: 'd' } as never)
  await seen.clock.settle()
}

const runSpend = ($: Engine, origin: { kind: string; name?: string } = { kind: 'composer' }) =>
  $.command.run({ command: 'spend', args: '', origin: origin as never, presentation: { isFullscreen: true, columns: 160 } })

const PANE = {
  component: 'Pane' as const,
  requestId: 'usage-gauge',
  props: {
    title: 'Usage',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
}
const HINT = { component: 'PromptHint' as const, props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }
const MODE = { component: 'SessionMode' as const, props: { modes: ['focus'] } }

describe('the chip', () => {
  test('on the desktop the mode row carries one Button, cost and context, before the engine row; a press opens the pane', async ($, on) => {
    const seen = world(on)
    await start($, seen)
    const mode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...MODE })
    const buttons = await mode.findAll({ type: 'Button' })
    // Cost alone by default: the desktop strip cuts the whole row to `…` once its chips overflow.
    expect(buttons.map(b => [b.key, b.props['label']])).toEqual([['usage-gauge', '$12.34']])
    expect(await mode.find({ type: 'Svg' })).toBeUndefined()
    expect(JSON.stringify(await mode.drawn())).toContain('"type":"engine"')
    await mode.press({ key: 'usage-gauge' })
    await mode.unmount()
    expect(seen.opened).toEqual(['usage-gauge'])
    // The terminal's mode row and the desktop's hint line are the engine's alone.
    const terminalMode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'terminal', ...MODE })
    expect(await terminalMode.find({ key: 'usage-gauge' })).toBeUndefined()
    await terminalMode.unmount()
  })

  test('before the first cost reading the chip reads $ --', async ($, on) => {
    const seen = world(on, { isUsageRefused: true })
    await start($, seen)
    await $.session.measure({ context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [], changed: ['context'] } as never)
    const mode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...MODE })
    expect((await mode.find({ key: 'usage-gauge' }))?.props['label']).toBe('$ --')
    await mode.unmount()
  })

  test('with no cost ledger and chipContext on the chip reads the context alone', { options: { chipContext: true } }, async ($, on) => {
    const seen = world(on, { hasNoLedger: true })
    await start($, seen)
    const mode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...MODE })
    expect((await mode.find({ key: 'usage-gauge' }))?.props['label']).toBe('ctx 42%')
    await mode.unmount()
  })

  test('with no cost ledger and the default options the engine row is drawn untouched', async ($, on) => {
    const seen = world(on, { hasNoLedger: true })
    await start($, seen)
    const mode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...MODE })
    expect(await mode.find({ key: 'usage-gauge' })).toBeUndefined()
    expect(await mode.drawn()).toEqual({ type: 'engine', ref: 0 } as never)
    await mode.unmount()
  })

  test('with neither figure the engine row is drawn untouched', async ($, on) => {
    const seen = world(on, { hasNoLedger: true, hasNoContext: true })
    await start($, seen)
    const mode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...MODE })
    expect(await mode.find({ key: 'usage-gauge' })).toBeUndefined()
    expect(await mode.drawn()).toEqual({ type: 'engine', ref: 0 } as never)
    await mode.unmount()
  })

  test('footerButton off: the figure is dim text, not a Button', { options: { footerButton: false } }, async ($, on) => {
    const seen = world(on)
    await start($, seen)
    const mode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...MODE })
    expect(await mode.findAll({ type: 'Button' })).toHaveLength(0)
    const text = await mode.find({ type: 'Text', text: /^\$12\.34$/ })
    expect(text?.props['dimColor']).toBe(true)
    await mode.unmount()
  })

  test('chipContext on: the chip adds the context fill', { options: { chipContext: true } }, async ($, on) => {
    const seen = world(on)
    await start($, seen)
    const mode = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...MODE })
    expect((await mode.find({ key: 'usage-gauge' }))?.props['label']).toBe('$12.34 · ctx 42%')
    await mode.unmount()
  })

  test('on the terminal the chip follows the engine hint and opens the pane', async ($, on) => {
    const seen = world(on)
    await start($, seen)
    const hint = await $.ui.mount({ plugin: 'usage-gauge', surface: 'terminal', ...HINT })
    const chip = await hint.find({ key: 'usage-gauge' })
    expect(chip?.type).toBe('Button')
    expect(chip?.props['label']).toBe('$12.34')
    expect(JSON.stringify(await hint.drawn())).toContain('"type":"engine"')
    await hint.press({ key: 'usage-gauge' })
    await hint.unmount()
    expect(seen.opened).toEqual(['usage-gauge'])
    const desktopHint = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...HINT })
    expect(await desktopHint.find({ key: 'usage-gauge' })).toBeUndefined()
    await desktopHint.unmount()
  })
})

describe('the accounting hooks', () => {
  test('a step passes its chunks and result through untouched and asks the model once', async ($, on) => {
    const seen = world(on)
    await start($, seen)
    const { chunks, result } = await step($, seen, 'claude-opus-5-5', 0)
    expect(chunks).toEqual([{ kind: 'stop', stopReason: 'end_turn', usage: OPUS }])
    expect(result).toEqual({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: OPUS })
    expect(seen.steps).toBe(1)
  })

  test('an Edit runs once and its result is returned as the tool gave it; a refused one counts nothing', async ($, on) => {
    const seen = world(on)
    await start($, seen)
    const ran = (await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'b', new_string: 'c' } as never)) as { result?: { structuredPatch?: unknown[] } }
    expect(ran.result?.structuredPatch).toHaveLength(1)
    const refused = (await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'c', new_string: 'd' } as never)) as { deny?: string; isError?: boolean }
    expect(refused.deny ?? (refused.isError ? 'error' : undefined)).toBeDefined()
    expect(seen.edits).toBe(2)
    const pane = await $.ui.mount({ plugin: 'usage-gauge', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: /^\+3 −1 lines · 1 edit$/ })).toBeDefined()
    await pane.unmount()
  })
})

describe('the pane', () => {
  test('after a busy session it draws cost, time, models, shares and changes on terminal and desktop', async ($, on) => {
    const seen = world(on)
    await busySession($, seen)

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'usage-gauge', surface, ...PANE })
      if (surface === 'terminal') {
        // The bar: 16 cells at the right of the Context title, 7 filled then 9 dim track cells; no hatching.
        const cells = await pane.findAll({ type: 'Text', text: /^█+$/ })
        expect(cells.map(c => [c.text.length, c.props['dimColor'] === true])).toEqual([[7, false], [9, true]])
        expect(await pane.find({ type: 'Text', text: /░/ })).toBeUndefined()
        expect(await pane.find({ type: 'Svg' })).toBeUndefined()
      } else {
        // The pill: 120 x 2 px at the right of the Context title (the title row spreads title and bar apart).
        const pill = await pane.find({ type: 'Svg' })
        expect(pill?.props['alt']).toBe('Context 42% used')
        expect(pill?.props['width']).toBe(120)
        expect(pill?.props['height']).toBe(2)
        const source = String(pill?.props['source'])
        expect(source).toContain('rx="1"')
        expect(source).toContain('to{width:50.4px}')
        expect(JSON.stringify(await pane.drawn())).toContain('"justifyContent":"space-between"')
        expect(source).not.toContain('<circle')
        expect(source).not.toContain('#FF3B30')
      }
      // The headline: labels left, figures flush with the pane's right edge (the value box grows to the row's end).
      expect(await pane.find({ type: 'Text', text: /^\$12\.34$/ })).toBeDefined()
      // Session: 2 h before start, then 1.5 s + 2.5 s of requests.
      expect(await pane.find({ type: 'Text', text: /^2h 0m$/ })).toBeDefined()
      const drawnJson = JSON.stringify(await pane.drawn())
      expect(drawnJson).toContain('"justifyContent":"flex-end"')
      // Seven headline rows, the window row and the rate-limit row each grow to the right edge.
      expect((drawnJson.match(/"flexGrow":1/g) ?? []).length).toBeGreaterThanOrEqual(9)
      // Active: the main loop's turn alone (7 s), never the subagent's 3 s; API: both requests (1.5 s + 2.5 s = 4 s);
      // Turns 1 (main), Requests 2, Agent turns 1. The header's figures come before the model table's.
      const labels = (await pane.findAll({ type: 'Text', text: /^(Cost|Session|Active|API|Turns|Requests|Agent turns)$/ })).map(t => t.text)
      expect(labels).toEqual(['Cost', 'Session', 'Active', 'API', 'Turns', 'Requests', 'Agent turns'])
      const figures = (await pane.findAll({ type: 'Text', text: /^(\$12\.34|2h 0m|7s|4s|1|2)$/ })).map(t => t.text).slice(0, 7)
      expect(figures).toEqual(['$12.34', '2h 0m', '7s', '4s', '1', '2', '1'])
      expect(await pane.find({ type: 'Text', text: '84k of 200k (42%)' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '5-hour' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^23\.5% · resets / })).toBeDefined()
      // Models: short names, tokens, cache hit, est. $ and share.
      expect(await pane.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '90.0k' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '20.0k' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '90%' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '$0.46' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '$0.03' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '93%' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '7%' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'Total' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^Estimates at list price \(as of 2026-10-06, cache writes at 1\.25×\)/ })).toBeDefined()
      // What's contributing: by est. cost, the subagent named from the agent list.
      expect(await pane.find({ type: 'Text', text: 'main loop 93% · subagents 7%' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'builder 7%' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^\+3 −1 lines · 1 edit$/ })).toBeDefined()
      await pane.press({ key: 'close' })
      await pane.unmount()
    }
    expect(seen.closed).toEqual(['usage-gauge', 'usage-gauge'])
    // The agent list was asked once, for the one new agent id.
    expect(seen.agentLists).toBe(1)
  })

  test('Refresh re-reads the summary breakdown and draws the category rows', async ($, on) => {
    const seen = world(on)
    await start($, seen)
    const pane = await $.ui.mount({ plugin: 'usage-gauge', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'Messages' })).toBeUndefined()
    await pane.press({ key: 'refresh' })
    await seen.clock.settle()
    expect(seen.usageArgs[seen.usageArgs.length - 1]).toBe(JSON.stringify({ breakdown: 'summary', columns: 100 }))
    expect(await pane.find({ type: 'Text', text: 'Messages' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '60.0k · 30%' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Until compaction' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '87.0k' })).toBeDefined()
    const free = await pane.find({ type: 'Text', text: '87.0k · 44%' })
    expect(free?.props['dimColor']).toBe(true)
    expect((await pane.find({ key: 'refresh' }))?.props['label']).toBe('Refresh')
    await pane.unmount()
  })

  test('a narrow pane on every surface keeps the bar, drops the wide columns and still draws', async ($, on) => {
    const seen = world(on)
    await busySession($, seen)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const pane = await $.ui.mount({ plugin: 'usage-gauge', surface, ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
      if (surface === 'terminal') {
        expect((await pane.findAll({ type: 'Text', text: /^█+$/ })).map(c => c.text.length)).toEqual([7, 9])
      } else {
        expect((await pane.find({ type: 'Svg' }))?.props['alt']).toBe('Context 42% used')
      }
      expect(await pane.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '$0.46' })).toBeDefined()
      // Input and cache columns are gone.
      expect(await pane.find({ type: 'Text', text: '90.0k' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: 'Input' })).toBeUndefined()
      await pane.unmount()
    }
  })

  test('with usage refused the pane still draws, every figure --', async ($, on) => {
    const seen = world(on, { isUsageRefused: true })
    await start($, seen)
    const pane = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...PANE })
    expect(await pane.find({ type: 'Text', text: /Reading usage/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '$ --' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'none reported' })).toBeDefined()
    expect((await pane.find({ type: 'Svg' }))?.props['alt']).toBe('Context -- used')
    await pane.unmount()
  })

  test('the pill animates from the fill it last drew when the context moves', async ($, on) => {
    const seen = world(on)
    await busySession($, seen)
    const pane = await $.ui.mount({ plugin: 'usage-gauge', surface: 'desktop', ...PANE })
    expect(String((await pane.find({ type: 'Svg' }))?.props['source'])).toContain('to{width:50.4px}')
    await $.session.measure({ context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], changed: ['context'] } as never)
    expect(String((await pane.find({ type: 'Svg' }))?.props['source'])).toContain('from{width:50.4px}to{width:72.0px}')
    expect((await pane.find({ type: 'Svg' }))?.props['alt']).toBe('Context 60% used')
    await pane.unmount()
  })

  test('before any reading it says so, with the buttons', async ($, on) => {
    world(on)
    const pane = await $.ui.mount({ plugin: 'usage-gauge', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'Reading usage…' })).toBeDefined()
    expect(await pane.find({ key: 'refresh' })).toBeDefined()
    expect(await pane.find({ key: 'close' })).toBeDefined()
    await pane.unmount()
  })

  test('a hostile model id, agent type and category name each draw as one line', async ($, on) => {
    const seen = world(on, { agentModel: `claude-${HOSTILE}`, agentType: HOSTILE, categoryName: HOSTILE })
    await busySession($, seen)
    const pane = await $.ui.mount({ plugin: 'usage-gauge', surface: 'terminal', ...PANE })
    await pane.press({ key: 'refresh' })
    await seen.clock.settle()
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.some(t => t.includes('Optimize: rm -rf'))).toBe(true)
    for (const t of texts) expect(t).not.toMatch(/[\n\u001b‮​]/)
    await pane.unmount()
    const ran = await runSpend($, { kind: 'composer' })
    expect((ran.text ?? '').split('\n').some(line => line.trimStart().startsWith('Optimize'))).toBe(false)
  })
})

describe('/spend', () => {
  test('from the person it opens the focused pane', async ($, on) => {
    const seen = world(on)
    await start($, seen)
    expect(seen.registered).toEqual(['spend'])
    const ran = await runSpend($)
    // The pane is the answer: nothing lands in the transcript.
    expect(ran.text).toBeUndefined()
    expect(seen.opened).toEqual(['usage-gauge'])
    await seen.clock.settle()
    // Opening reads the breakdown behind the pane.
    expect(seen.usageArgs[seen.usageArgs.length - 1]).toBe(JSON.stringify({ breakdown: 'summary' }))
  })

  test('from a plugin it answers one line and opens nothing', async ($, on) => {
    const seen = world(on)
    await busySession($, seen)
    const ran = await runSpend($, { kind: 'plugin', name: 'other-mod' })
    expect(ran.text).toBe('Usage: $12.34 · ctx 42% · 2 requests')
    expect(seen.opened).toEqual([])
  })

  test('headless, and where the pane cannot be placed, it answers the plain table', async ($, on) => {
    const seen = world(on, { isHeadless: true })
    await busySession($, seen)
    const ran = await runSpend($)
    expect(seen.opened).toEqual([])
    expect(ran.text).toContain('Cost         $12.34')
    expect(ran.text).toContain('Opus 5.5: 1 req')
    expect(ran.text).toContain('main loop 93% · subagents 7%')
    expect(ran.text).toContain('+3 −1 lines · 1 edit')
    // Headless too, another origin gets the one line, never the table.
    const peer = await runSpend($, { kind: 'plugin', name: 'other-mod' })
    expect(peer.text).toBe('Usage: $12.34 · ctx 42% · 2 requests')
  })

  test('an unplaced pane answers the plain table', { options: {} }, async ($, on) => {
    const seen = world(on, { isPlaced: false })
    await start($, seen)
    const ran = await runSpend($)
    expect(seen.opened).toEqual(['usage-gauge'])
    expect(ran.text).toContain('Usage (usage-gauge)')
    expect(ran.text).toContain('5-hour 23.5%')
  })
})

describe('reload', () => {
  test('a second start (a hot reload) keeps the accumulators and when they began', async ($, on) => {
    const seen = world(on)
    await busySession($, seen)
    await seen.clock.advance(60_000)
    await start($, seen)
    await step($, seen, 'claude-opus-5-5', 1000)
    const ran = await runSpend($, { kind: 'plugin', name: 'other-mod' })
    expect(ran.text).toBe('Usage: $12.34 · ctx 42% · 3 requests')
    const pane = await $.ui.mount({ plugin: 'usage-gauge', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: /^\+3 −1 lines · 1 edit$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^5s$/ })).toBeDefined()
    await pane.unmount()
  })
})
