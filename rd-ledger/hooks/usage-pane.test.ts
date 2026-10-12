// rd-ledger: the Usage pane, the one footer chip, /rd usage and /spend, and
// the accounting hooks behind them (SPEC §6.5, §6.6), on the shared world.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { corpus, HINT, HOME, MODE, PANE, STEP_AGENT, STEP_MAIN, STORE, T0, world } from './testing/world'
import type { World, WorldOptions } from './testing/world'

const ZONE = 'America/New_York'
const SENTINEL = `SNTL-7f3a9c e@x.test ghp_${'A1b2C3d4E5'.repeat(4)}`
const files = (): Record<string, string> => ({ [`${STORE}/timezone`]: `${ZONE}\n`, [`${STORE}/salt`]: `${'a'.repeat(32)}\n` })

const make = (on: Parameters<typeof world>[0], options: WorldOptions = {}) => {
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  return world(on, Object.assign(options, { files: options.files ?? files() }))
}

async function start($: Engine, w: World, surface: 'terminal' | 'desktop' = 'desktop') {
  await $.session.start({ cwd: `${HOME}/shop`, surface, isInteractive: true } as never)
  await w.clock.settle()
}

/** One model request read by hand, so the generator's return (the step's result) is kept. */
async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}) } as never)
  const chunks: unknown[] = []
  let read = await stream.next()
  while (!read.done) {
    chunks.push(read.value)
    read = await stream.next()
  }
  return { chunks, result: read.value }
}

/** A measurement, a main and a subagent request, both turns, an Edit and a refused one. */
async function busy($: Engine, w: World) {
  await start($, w)
  await $.session.measure({ context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:40:00Z' }], cost: { usd: 12.34 }, changed: ['context', 'cost'] } as never)
  await step($)
  await step($, 'sub-1')
  await $.turn.complete({ answer: 'done', durationMs: 7000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ answer: 'report', durationMs: 3000, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${HOME}/shop/a.ts`, old_string: 'b', new_string: 'c' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${HOME}/shop/a.ts`, old_string: 'c', new_string: 'd' } as never)
  await w.clock.settle()
}

const USAGE_PANE = { ...PANE, requestId: 'rd-usage', props: { ...PANE.props, title: 'Usage' } }
const usagePane = ($: Engine, cols = 100, surface: 'terminal' | 'desktop' | 'mobile' = 'desktop') =>
  $.ui.mount({ plugin: 'rd-ledger', surface, ...USAGE_PANE, props: { ...USAGE_PANE.props, bodyColumns: cols } })
const run = ($: Engine, command: string, args = '', origin: Record<string, unknown> = { kind: 'composer' }) =>
  $.command.run({ command, args, origin: origin as never, presentation: { isFullscreen: true, columns: 160 } })

/** Every Text the tree drew, as its string. */
async function drawnTexts(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const out: string[] = []
  const strings = (n: unknown): string => (typeof n === 'string' ? n : typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(strings).join('') : n && typeof n === 'object' ? strings((n as { children?: unknown }).children ?? (n as { props?: { children?: unknown } }).props?.children) : '')
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit)
    if (!n || typeof n !== 'object') return
    const node = n as { type?: unknown; children?: unknown; props?: { children?: unknown } }
    if (node.type === 'Text') {
      out.push(strings(node.children ?? node.props?.children))
      return
    }
    visit(node.children)
    visit(node.props?.children)
  }
  visit(await ui.drawn())
  return out
}

function clean(w: World) {
  expect(w.disallowed).toEqual([])
  expect(w.statuses).toEqual([])
}

describe('the one footer chip', () => {
  test('by default the desktop chip reads the session cost and today\'s hours; a press opens the ledger, then Usage focused', async ($, on) => {
    const w = make(on)
    await busy($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    const buttons = await mode.findAll({ type: 'Button' })
    expect(buttons).toHaveLength(1)
    const label = String(buttons[0]?.props['label'])
    expect(label).toMatch(/^\$12\.34 ⧗(--|\d+\.\dh)$/)
    expect([...label].length).toBeLessThanOrEqual(16)
    expect(/\p{Extended_Pictographic}/u.test(label)).toBe(false)
    await mode.press({ key: 'rd-ledger' })
    await w.clock.settle()
    await mode.unmount()
    // The ledger first without the keyboard, then Usage with it: Usage is shown, "R&D ledger" is its neighbouring tab.
    expect(w.openArgs).toEqual([
      { id: 'rd-ledger', title: 'R&D ledger', focus: false },
      { id: 'rd-usage', title: 'Usage', focus: true },
    ])
    expect(w.stateSets).toContain('overview')
    clean(w)
  })

  test('a second press while the ledger is open keeps its view: one ledger open, Usage opened again', async ($, on) => {
    const w = make(on)
    await busy($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    await mode.press({ key: 'rd-ledger' })
    await w.clock.settle()
    // The person moves the ledger to Review, then presses the chip again.
    const ledger = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...PANE })
    await ledger.press({ key: 'view-review' })
    await w.clock.settle()
    const sets = w.stateSets.length
    await mode.press({ key: 'rd-ledger' })
    await w.clock.settle()
    await mode.unmount()
    await ledger.unmount()
    expect(w.opened.filter(id => id === 'rd-ledger')).toHaveLength(1)
    expect(w.opened.filter(id => id === 'rd-usage')).toHaveLength(2)
    expect(w.stateSets.slice(sets)).not.toContain('overview')
    clean(w)
  })

  test('on the terminal the chip follows the engine hint and opens the same two panes', async ($, on) => {
    const w = make(on, { surfaces: ['terminal'] })
    await busy($, w)
    const hint = await $.ui.mount({ plugin: 'rd-ledger', surface: 'terminal', ...HINT })
    const chip = await hint.find({ key: 'rd-ledger' })
    expect(chip?.type).toBe('Button')
    expect(String(chip?.props['label'])).toMatch(/^\$12\.34 /)
    expect(JSON.stringify(await hint.drawn())).toContain('"type":"engine"')
    await hint.press({ key: 'rd-ledger' })
    await w.clock.settle()
    await hint.unmount()
    expect(w.openArgs.map(o => [o.id, o.focus])).toEqual([['rd-ledger', false], ['rd-usage', true]])
    clean(w)
  })

  test('footerChip cost draws the cost alone', { options: { footerChip: 'cost' } }, async ($, on) => {
    const w = make(on)
    await busy($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    expect((await mode.find({ key: 'rd-ledger' }))?.props['label']).toBe('$12.34')
    await mode.unmount()
    clean(w)
  })

  test('footerChip time draws today\'s hours alone', { options: { footerChip: 'time' } }, async ($, on) => {
    const w = make(on)
    await busy($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    expect(String((await mode.find({ key: 'rd-ledger' }))?.props['label'])).toMatch(/^⧗(--|\d+\.\dh)$/)
    await mode.unmount()
    clean(w)
  })

  test('chipContext appends the context fill within 16 characters', { options: { footerChip: 'cost', chipContext: true } }, async ($, on) => {
    const w = make(on)
    await busy($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    expect((await mode.find({ key: 'rd-ledger' }))?.props['label']).toBe('$12.34 · ctx 42%')
    await mode.unmount()
    clean(w)
  })

  test('an unknown footerChip value falls back to both', { options: { footerChip: 'nonsense' } }, async ($, on) => {
    const w = make(on)
    await busy($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    expect(String((await mode.find({ key: 'rd-ledger' }))?.props['label'])).toMatch(/^\$12\.34 ⧗/)
    await mode.unmount()
    clean(w)
  })

  test('footerButton off: the same label as dim Text on both surfaces, no Button', { options: { footerButton: false } }, async ($, on) => {
    const w = make(on)
    await busy($, w)
    for (const [surface, site] of [['desktop', MODE], ['terminal', HINT]] as const) {
      const ui = await $.ui.mount({ plugin: 'rd-ledger', surface, ...site })
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
      const text = await ui.find({ type: 'Text', text: /^\$12\.34 ⧗/ })
      expect(text?.props['dimColor']).toBe(true)
      await ui.unmount()
    }
    clean(w)
  })
})

describe('/rd usage and /spend', () => {
  test('both are registered; from the person each opens the ledger, then Usage focused', async ($, on) => {
    const w = make(on)
    await start($, w)
    expect(w.registered).toEqual(['rd', 'spend'])
    expect((await run($, 'rd', 'usage')).text).toBe('Usage pane opened.')
    expect((await run($, 'spend')).text).toBe('Usage pane opened.')
    // The second command finds the ledger open and leaves it (and its view) alone; only Usage opens again (verifier V2).
    expect(w.openArgs.map(o => [o.id, o.focus])).toEqual([['rd-ledger', false], ['rd-usage', true], ['rd-usage', true]])
    clean(w)
  })

  test('another origin gets the one summary line and opens nothing; extra words get the usage line', async ($, on) => {
    const w = make(on)
    await busy($, w)
    expect((await run($, 'spend', '', { kind: 'plugin', name: 'other-mod' })).text).toBe('Usage: $12.34 · ctx 42% · 2 requests')
    expect((await run($, 'rd', 'usage', { kind: 'peer' })).text).toBe('Usage: $12.34 · ctx 42% · 2 requests')
    expect((await run($, 'rd', 'usage now')).text).toMatch(/^Usage: \/rd \[usage \|/)
    expect(w.opened).toEqual([])
    clean(w)
  })

  test('headless, the person gets the one summary line too, counts only', async ($, on) => {
    const w = make(on, { isHeadless: true })
    await busy($, w)
    expect((await run($, 'rd', 'usage')).text).toBe('Usage: $12.34 · ctx 42% · 2 requests')
    expect((await run($, 'spend')).text).toBe('Usage: $12.34 · ctx 42% · 2 requests')
    expect(w.opened).toEqual([])
    clean(w)
  })

  test('where Usage cannot be placed the person gets the summary line', async ($, on) => {
    const w = make(on, { isPlaced: false })
    await start($, w)
    expect((await run($, 'spend')).text).toMatch(/^Usage: \$1\.25 · ctx 10% · 0 requests$/)
    expect(w.opened).toEqual(['rd-ledger', 'rd-usage'])
    clean(w)
  })
})

describe('the Usage pane', () => {
  test('after a busy session it draws every section, the TTL-aware estimates, and the actions row', async ($, on) => {
    const w = make(on)
    await busy($, w)
    const ui = await usagePane($)
    const texts = await drawnTexts(ui)
    for (const title of ['This session', 'Context', 'Rate limits', 'Models', "What's contributing", 'Code changes']) expect(texts).toContain(title)
    expect(texts.some(t => /^ {2}Cost +\$12\.34$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Turns +1$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Requests +2$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Agent turns +1$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Active +7s$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Window +84k of 200k \(42%\)$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}5-hour +23\.5% · resets /.test(t))).toBe(true)
    // Opus 5.5 main: $0.458; Sonnet 5.5 subagent: $0.0325 with its 5,000 cache-write tokens at 1.25 × input (5m).
    expect(texts.some(t => /^ {2}Opus 5\.5 .*\$0\.46 +93%$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Sonnet 5\.5 .*\$0\.03 +7%$/.test(t))).toBe(true)
    expect(texts).toContain('  main loop 93% · subagents 7%')
    expect(texts).toContain('  builder 7%')
    expect(texts).toContain('  +3 −1 lines · 1 edit')
    // The context bar is text cells on the desktop too: no Svg.
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Text', text: /^█+$/ })).map(t => [t.text.length, t.props['dimColor'] === true])).toEqual([[9, true]])
    const actions = (await ui.find({ key: 'actions' })) as unknown as { children: { props: { label: string; hotkey?: string } }[] }
    expect(actions.children.map(c => `${c.props.label} (${c.props.hotkey})`)).toEqual(['Refresh (r)', 'R&D ledger (d)', 'Close (c)'])
    await ui.press({ key: 'close' })
    await ui.unmount()
    expect(w.closed).toEqual(['rd-usage'])
    expect(w.agentLists).toBe(1)
    clean(w)
  })

  test('cacheTtl 1h prices the subagent\'s cache writes at 2 × input', { options: { cacheTtl: '1h' } }, async ($, on) => {
    const w = make(on)
    await busy($, w)
    const texts = await drawnTexts(await usagePane($))
    expect(texts.some(t => /^ {2}Sonnet 5\.5 .*\$0\.04 +8%$/.test(t))).toBe(true)
    expect(texts.join(' ').replace(/\s+/g, ' ')).toContain('else the 1h option')
    clean(w)
  })

  test('a 1h TTL change point applies to the requests after it, not before', async ($, on) => {
    const w = make(on)
    await start($, w)
    await step($, 'sub-1')
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', source: 'command', prompt_cache_warm: false, cache_ttl: '1h' } as never)
    await w.clock.advance(1000)
    await step($, 'sub-1')
    await w.clock.settle()
    const texts = await drawnTexts(await usagePane($))
    // 0.0325 (5m) + 0.04 (1h) = 0.0725.
    expect(texts.some(t => /^ {2}Sonnet 5\.5 .*\$0\.07 +100%$/.test(t))).toBe(true)
    clean(w)
  })

  test('R&D ledger (d) opens and focuses the ledger pane; Refresh reads the summary breakdown', async ($, on) => {
    const w = make(on)
    await busy($, w)
    const ui = await usagePane($)
    await ui.press({ key: 'ledger' })
    await ui.press({ key: 'refresh' })
    await w.clock.settle()
    expect(w.openArgs).toEqual([{ id: 'rd-ledger', title: 'R&D ledger', focus: true }])
    expect((await ui.find({ key: 'refresh' }))?.props['label']).toBe('Refresh')
    await ui.unmount()
    clean(w)
  })

  test('before any reading it says so, with the actions', async ($, on) => {
    make(on)
    const ui = await usagePane($)
    expect(await ui.find({ type: 'Text', text: 'Reading usage…' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ key: 'ledger' })).toBeDefined()
    await ui.unmount()
  })

  test('with usage refused the pane still draws, every figure --, none reported', async ($, on) => {
    const w = make(on, { usageRefused: true })
    await start($, w)
    const texts = await drawnTexts(await usagePane($))
    expect(texts.some(t => /^ {2}Cost +\$ --$/.test(t))).toBe(true)
    expect(texts).toContain('  none reported')
    clean(w)
  })

  test('with no cost ledger the Cost row reads no ledger here', async ($, on) => {
    const w = make(on, { costUsd: null })
    await start($, w)
    const texts = await drawnTexts(await usagePane($))
    expect(texts.some(t => /^ {2}Cost +no ledger here$/.test(t))).toBe(true)
    clean(w)
  })

  test('at 24, 40, 60, 84 and 120 columns no drawn Text is longer than the pane and no figure is cut, on every surface', async ($, on) => {
    const w = make(on)
    await busy($, w)
    for (const surface of ['desktop', 'terminal', 'mobile'] as const) {
      for (const cols of [24, 40, 60, 84, 120]) {
        const ui = await usagePane($, cols, surface)
        const texts = await drawnTexts(ui)
        expect(texts.length).toBeGreaterThan(20)
        for (const t of texts) if ([...t].length > cols) throw new Error(`${surface} at ${cols}: ${JSON.stringify(t)} is ${[...t].length} columns`)
        for (const t of texts) if (/[0-9$%,.kM]…$/.test(t)) throw new Error(`${surface} at ${cols}: a figure is cut in ${JSON.stringify(t)}`)
        // The actions row wraps rather than runs past a narrow pane.
        expect((await ui.find({ key: 'actions' }))?.props['flexWrap']).toBe('wrap')
        // Narrow drops Input and the cache columns; wide keeps them.
        expect(texts.some(t => /Cache wr/.test(t))).toBe(cols >= 84)
        await ui.unmount()
      }
    }
    clean(w)
  })
})

describe('the accounting hooks', () => {
  test('a step passes its chunks and result through untouched and asks the model once', async ($, on) => {
    const w = make(on)
    await start($, w)
    const { chunks, result } = await step($)
    expect(chunks).toEqual([{ kind: 'stop', stopReason: 'end_turn', usage: STEP_MAIN }])
    expect(result).toEqual({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_MAIN })
    const agent = await step($, 'sub-1')
    expect(agent.chunks).toEqual([{ kind: 'stop', stopReason: 'end_turn', usage: STEP_AGENT }])
    expect(w.steps).toBe(2)
    clean(w)
  })

  test('an Edit runs once, its result returned as the tool gave it; counts are kept, never the path or the lines', async ($, on) => {
    const w = make(on)
    await start($, w)
    const ran = (await $.tool.call({ tool: 'Edit', file_path: `${HOME}/shop/secret-path-a.ts`, old_string: 'b', new_string: 'c' } as never)) as { result?: { filePath?: string; structuredPatch?: unknown[] } }
    expect(ran.result?.filePath).toBe(`${HOME}/shop/secret-path-a.ts`)
    expect(ran.result?.structuredPatch).toHaveLength(1)
    const refused = (await $.tool.call({ tool: 'Write', file_path: `${HOME}/shop/b.ts`, content: 'x' } as never)) as { deny?: string }
    expect(refused.deny).toBe('refused by the person')
    expect(w.edits).toBe(2)
    await w.clock.settle()
    const all = corpus(w)
    expect(all).not.toContain('secret-path-a')
    expect(all).not.toContain('"+c"')
    const totals = w.stateSets.map(v => (typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v)).filter(v => typeof v === 'object' && v !== null && 'linesAdded' in v)
    expect(totals.at(-1)).toMatchObject({ linesAdded: 3, linesRemoved: 1, edits: 1 })
    clean(w)
  })

  test('$.agent.list is read for id and type only: a sentinel description never reaches state, a file, the pane or an answer', async ($, on) => {
    const w = make(on, { agents: [{ id: 'sub-1', type: 'verifier', status: 'running', description: SENTINEL }] })
    await busy($, w)
    const texts = await drawnTexts(await usagePane($))
    expect(texts).toContain('  verifier 7%')
    const answer = (await run($, 'spend', '', { kind: 'peer' })).text ?? ''
    const everything = [corpus(w), texts.join('\n'), answer].join('\n')
    for (const part of ['SNTL-7f3a9c', 'e@x.test', 'ghp_']) expect(everything).not.toContain(part)
    // The type is remembered: the list is asked once for the one agent id.
    expect(w.agentLists).toBe(1)
    clean(w)
  })

  test('an agent the list does not know, or a refused list, counts under agent', async ($, on) => {
    const w = make(on, { agentListRefused: true })
    await busy($, w)
    expect(await drawnTexts(await usagePane($))).toContain('  agent 7%')
    clean(w)
  })

  test('a hot reload (a second start) keeps the accumulators', async ($, on) => {
    const w = make(on)
    await busy($, w)
    await start($, w)
    await step($)
    // The step's bookkeeping now runs after the step is handed back (verifier V4), so let it land before reading.
    await w.clock.settle()
    // The cost is the engine's figure as the new load read it; the request count carried over.
    expect((await run($, 'spend', '', { kind: 'peer' })).text).toBe('Usage: $1.25 · ctx 10% · 3 requests')
    clean(w)
  })

  test('nothing new is written to disk: the session files hold no usage atom', async ($, on) => {
    const w = make(on)
    await busy($, w)
    const written = [...w.files.keys()].filter(p => !p.startsWith(`${STORE}/sessions/`) && p !== `${STORE}/timezone` && p !== `${STORE}/salt`)
    expect(written.filter(p => /usage|models|loops|agentTypes/.test(p))).toEqual([])
    for (const [path, f] of w.files) if (path.startsWith(`${STORE}/sessions/`)) expect(f.text).not.toContain('linesAdded')
    expect(T0).toBeGreaterThan(0)
    clean(w)
  })
})
