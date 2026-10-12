// usage-gauge: what this session has cost and used, live, without /usage
// dropping a card into the transcript. A chip in the prompt footer (beside the
// desktop's context-window icon, which is the app's own and no mod can draw
// inside) reads `$123.45 · ctx 12%` and opens a Usage pane: the engine's cost,
// session and API time, the context window by category, rate limits, tokens
// and cache hit per model with list-price estimates, the subagents' share, and
// the lines the session's edits changed.
//
// Every accounting hook only observes: it passes the event on unchanged, keeps
// its bookkeeping inside try/catch, and writes $.state, which a hot reload
// keeps. Drawings read $.state only. Nothing is written to disk, run, fetched
// or sent; no prompt, answer, path or tool argument is stored.
//
// The engine requires `$` to be handed only to functions declared at the top of
// this file, so every function that touches `$` lives here; the formatting and
// the arithmetic are pure and live in format.ts and prices.ts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsageArgs, TurnStepResult } from 'claude-code'

import type { View } from './format'
import {
  CAP,
  PRICE_NOTE,
  addRequest,
  BAR_CELLS,
  BAR_HEIGHT_PX,
  BAR_WIDTH_PX,
  barParts,
  boundedKey,
  breakdownFrom,
  categoryRows,
  changesLine,
  chipLabel,
  compactReport,
  contextLine,
  contributionLines,
  countPatch,
  emptyCounts,
  emptyTotals,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  keepLatest,
  modelLines,
  oneLine,
  ownGet,
  rateLine,
  pillSvg,
  sessionMs,
  summaryLine,
  unknownUsage,
  untilCompaction,
  usageFrom,
  viewNow,
} from './format'
import type { ModelLine } from './format'
import { estimateUsd } from './prices'

type Dollar = EngineInterface

// $.state values, one literal plugin/key reference each, so `claude plugin
// validate` holds them to types/index.d.ts. Written only from hooks and
// handlers, never while drawing.
const usageRef = atom({ plugin: 'usage-gauge', key: 'usage' } as const, null)
const breakdownRef = atom({ plugin: 'usage-gauge', key: 'breakdown' } as const, null)
const totalsRef = atom({ plugin: 'usage-gauge', key: 'totals' } as const, emptyTotals())
const modelsRef = atom({ plugin: 'usage-gauge', key: 'models' } as const, {})
const loopsRef = atom({ plugin: 'usage-gauge', key: 'loops' } as const, { main: emptyCounts(), agents: {} })
const agentTypesRef = atom({ plugin: 'usage-gauge', key: 'agentTypes' } as const, {})
const refreshingRef = atom({ plugin: 'usage-gauge', key: 'refreshing' } as const, false)

const PANE = 'usage-gauge'
/** The agent ids whose type is remembered; older ones are looked up again if they ever step. */
const MAX_AGENT_IDS = 500
/** Distinct models and agent types kept apart; any more fold into `other`. */
const MAX_MODELS = 50
const MAX_AGENT_TYPES = 50
/** Category rows the pane lists. */
const MAX_CATEGORIES = 8
/**
 * The origins that count as the person: their own Enter, the Remote Control
 * bridge, and the SDK host (the desktop Code tab drives the engine through
 * it). Only these open (and focus) the pane. Any other origin, and any kind
 * this list does not know, gets one summary line, so no peer session, plugin
 * or schedule can pop a pane in front of the person.
 */
const PANE_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

// Per-load options, not state: register() sets them and a reload re-reads them.
let config = { footerButton: true, chipContext: false }
// The context percent the bar last drew, so the next drawing animates from it (a load starts from empty).
let lastBarPercent: number | null = null

/** An error's kind only: a message could carry a path or a value. */
const kindOf = (err: unknown): string => (err instanceof Error && err.name ? err.name : 'error')

/**
 * Reads the status line's figures (and, with `breakdown`, the window by
 * category) into $.state. A refused read leaves every figure unknown rather
 * than absent, so the pane draws `--` instead of waiting forever.
 */
async function readUsage($: Dollar, args?: SessionUsageArgs): Promise<void> {
  const now = await $.clock.now()
  let reading
  try {
    reading = await $.session.usage(args)
  } catch {
    await update($, usageRef, prev => prev ?? unknownUsage(now))
    return
  }
  await update($, usageRef, prev => usageFrom(reading, prev, now, true))
  if (args?.breakdown) await update($, breakdownRef, () => breakdownFrom(reading.context.breakdown))
}

/** Pane open and Refresh: the figures and the breakdown (`summary`: estimated locally, nothing is sent). */
async function refresh($: Dollar, columns?: number): Promise<void> {
  if (await read($, refreshingRef)) return
  await update($, refreshingRef, () => true)
  try {
    await readUsage($, columns === undefined ? { breakdown: 'summary' } : { breakdown: 'summary', columns })
  } finally {
    await update($, refreshingRef, () => false).catch(() => undefined)
  }
}

/** Opens the Usage pane (from the chip or /spend) and reads the breakdown behind it. */
async function openPane($: Dollar) {
  const opened = await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true })
  if (opened.isPlaced) void refresh($).catch(() => undefined)
  return opened
}

/** The type an agent id was spawned as, looked up once and remembered; `agent` when it is not listed. */
async function agentTypeOf($: Dollar, agentId: string): Promise<string> {
  const id = agentId.slice(0, 128)
  const known = ownGet(await read($, agentTypesRef), id)
  if (known !== undefined) return known
  let type = 'agent'
  try {
    const hit = (await $.agent.list()).find(a => a.id === agentId)
    if (hit && typeof hit.type === 'string') type = oneLine(hit.type, CAP.agentType) || 'agent'
  } catch {
    // Unknown stays `agent`; it is remembered so the list is not asked again for it.
  }
  await update($, agentTypesRef, m => keepLatest({ ...m, [id]: type }, MAX_AGENT_IDS))
  return type
}

/** One model request, counted under its model and its loop. */
async function recordStep($: Dollar, agentId: string | undefined, model: string, r: TurnStepResult | undefined, t0: number | null): Promise<void> {
  const now = await $.clock.now()
  const apiMs = t0 === null ? 0 : Math.max(0, now - t0)
  const usage = r?.usage ?? null
  const rawModel = typeof usage?.model === 'string' && usage.model ? usage.model : model
  const counts = usage
    ? { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }
    : null
  // A request with no usage (failed, interrupted) has no tokens to price.
  const est = counts ? estimateUsd(rawModel, counts) : 0
  const modelKey = oneLine(rawModel, CAP.model) || 'unknown'
  const type = agentId === undefined ? null : await agentTypeOf($, agentId)

  await update($, modelsRef, m => {
    const key = boundedKey(m, modelKey, MAX_MODELS)
    return { ...m, [key]: addRequest(ownGet(m, key), counts, apiMs, est) }
  })
  await update($, loopsRef, l => {
    if (type === null) return { ...l, main: addRequest(l.main, counts, apiMs, est) }
    const key = boundedKey(l.agents, type, MAX_AGENT_TYPES)
    return { ...l, agents: { ...l.agents, [key]: addRequest(ownGet(l.agents, key), counts, apiMs, est) } }
  })
  await update($, totalsRef, t => ({ ...t, loadedAt: t.loadedAt || now, updatedAt: now, requests: t.requests + 1, apiMs: t.apiMs + apiMs }))
}

/** A turn's end: the main loop's count and wall time, or a subagent's count. */
async function recordTurn($: Dollar, agentId: string | undefined, durationMs: number): Promise<void> {
  const now = await $.clock.now()
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  await update($, totalsRef, t =>
    agentId === undefined
      ? { ...t, loadedAt: t.loadedAt || now, updatedAt: now, turns: t.turns + 1, activeMs: t.activeMs + ms }
      : { ...t, loadedAt: t.loadedAt || now, updatedAt: now, agentTurns: t.agentTurns + 1 },
  )
}

/** An Edit / Write / NotebookEdit result's lines; a denied or failed call counts nothing. */
async function recordEdit($: Dollar, ran: unknown): Promise<void> {
  const counted = countPatch(ran)
  if (!counted) return
  const now = await $.clock.now()
  await update($, totalsRef, t => ({
    ...t,
    loadedAt: t.loadedAt || now,
    updatedAt: now,
    linesAdded: t.linesAdded + counted.added,
    linesRemoved: t.linesRemoved + counted.removed,
    edits: t.edits + 1,
  }))
}

/** Everything the pane and /spend draw. */
async function readView($: Dollar): Promise<View> {
  return {
    usage: await read($, usageRef),
    breakdown: await read($, breakdownRef),
    totals: await read($, totalsRef),
    models: await read($, modelsRef),
    loops: await read($, loopsRef),
  }
}

export const register: Register = (on, options) => {
  config = {
    footerButton: options['footerButton'] !== false,
    chipContext: options['chipContext'] === true,
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'spend',
        description: 'Open the Usage pane: cost, context, rate limits, models, subagents, code changes',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`usage-gauge: /spend not registered (${kindOf(err)})`, { to: 'debug' })
    }
    const result = await next(e)
    try {
      const now = await $.clock.now()
      // A reload (or a second start) keeps the accumulators and when they began.
      await update($, totalsRef, t => (t.loadedAt > 0 ? t : { ...t, loadedAt: now, updatedAt: Math.max(t.updatedAt, now) }))
      // A load starts with no Refresh in flight: a reload mid-Refresh must not leave the button at Refreshing.
      await update($, refreshingRef, () => false)
      await readUsage($)
    } catch {
      // Observing only.
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, usageRef, prev => usageFrom(e, prev, now, false))
    } catch {
      // Observing only.
    }
    return next(e)
  })

  // One model request in any loop. Observing a stream: the chunks pass through
  // untouched (`yield* next(e)`), `next(e)` is called exactly once, and nothing
  // before it can throw (a hook that fails before calling it would be skipped,
  // but one that fails after would cut the stream). Its wall time counts the
  // request from send to its last chunk.
  on('turn.step', async function* ($, e, next) {
    let t0: number | null = null
    try {
      t0 = await $.clock.now()
    } catch {
      t0 = null
    }
    const result = yield* next(e)
    try {
      await recordStep($, e.agentId, e.model, result, t0)
    } catch {
      // Observing only.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    try {
      await recordTurn($, e.agentId, e.durationMs)
    } catch {
      // Observing only.
    }
    return next(e)
  })

  // The tool runs once, beneath, whatever this hook does: it counts after
  // `next(e)` settled and returns that result unchanged.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await recordEdit($, ran)
    } catch {
      // Observing only.
    }
    return ran
  }).catch(($, e, next) =>
    // Should the hook overrun anyway: inside a catch `next` is replay-safe, so
    // once called it answers what the tool already returned without running it
    // again, and uncalled it runs the tool once. Never a deny: an observer
    // must not refuse a tool.
    next(e),
  )

  // Read-only, so any origin may run it, but only the person's own origins open
  // the focused pane. Where none can be placed (`claude -p`), the person gets
  // the short table; any other origin gets one summary line.
  on('command.run', { command: 'spend' }, async ($, e) => {
    const surfaces = await $.session.surfaces().catch(() => [])
    const isPerson = PANE_ORIGINS.has(e.origin.kind)
    if (surfaces.length > 0 && isPerson) {
      let isPlaced = false
      try {
        isPlaced = (await openPane($)).isPlaced
      } catch {
        isPlaced = false
      }
      // The pane is the answer: no transcript row (CommandRunResult.text is a transcript line).
      if (isPlaced) return {}
    }
    const view = await readView($)
    return { text: isPerson ? compactReport(view) : summaryLine(view) }
  }).catch(async ($, e) => {
    // Past its budget or failed: answer from the state rather than leave a
    // registered command with no output.
    const view = await readView($).catch(() => null)
    if (!view) return { text: 'usage-gauge: no reading yet.' }
    return { text: PANE_ORIGINS.has(e.origin.kind) ? compactReport(view) : summaryLine(view) }
  })

  // The chip on the terminal: the hint line under the prompt, after the
  // engine's own line so its pills stay live. Only the terminal raises it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'terminal') return engine
    const label = chipLabel(await read($, usageRef), config.chipContext)
    if (!label) return engine
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = () => void openPane($).catch(() => undefined)
    return (
      <Box flexDirection="row">
        {engine}
        <Box marginLeft={2} flexDirection="row">
          {config.footerButton ? <Button key="usage-gauge" plain dimColor label={label} onPress={open} /> : <Text dimColor>{label}</Text>}
        </Box>
      </Box>
    )
  })

  // The chip on the desktop: the prompt footer's mode row, right beside the
  // context-window icon, the one site under the composer the desktop raises.
  // That strip draws text and native chips only (no vector element, no Box
  // hover or display) and lays every Button before every Text whatever the
  // tree's order, so nothing here relies on order.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'desktop') return engine
    const label = chipLabel(await read($, usageRef), config.chipContext)
    if (!label) return engine
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = () => void openPane($).catch(() => undefined)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {config.footerButton ? <Button key="usage-gauge" plain label={label} onPress={open} /> : <Text dimColor>{label}</Text>}
        {engine}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await readView($)
    const isRefreshing = await read($, refreshingRef)
    const cols = Math.max(24, Math.floor(e.props.bodyColumns))
    const isNarrow = cols < 60

    const controls = (
      <Box key="controls" flexDirection="row" gap={2} marginTop={1}>
        <Button
          key="refresh"
          label={isRefreshing ? 'Refreshing' : 'Refresh'}
          hotkey="r"
          dimColor={isRefreshing}
          onPress={() => void refresh($, cols).catch(() => undefined)}
        />
        <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => void $.ui.close({ id: PANE }).catch(() => undefined)} />
      </Box>
    )
    if (!v.usage && v.totals.requests === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Reading usage…</Text>
          {controls}
        </Box>
      )
    }

    const now = viewNow(v)
    const pct = v.usage?.context.percent ?? null
    const t = v.totals

    // Label left in a fixed column, figure flush with the pane's right edge: the
    // value box grows to the rest of the row, so the figures line up on the
    // right whatever the pane's width.
    type Pair = { key: string; label: string; value: string; isDim?: boolean }
    const headline: Pair[] = [
      { key: 'cost', label: 'Cost', value: formatUsd(v.usage?.costUsd ?? null) },
      { key: 'session', label: 'Session', value: formatDuration(sessionMs(v)) },
      { key: 'active', label: 'Active', value: formatDuration(t.activeMs) },
      { key: 'api', label: 'API', value: formatDuration(t.apiMs) },
      { key: 'turns', label: 'Turns', value: formatCount(t.turns) },
      { key: 'requests', label: 'Requests', value: formatCount(t.requests) },
    ]
    if (t.agentTurns > 0) headline.push({ key: 'agent-turns', label: 'Agent turns', value: formatCount(t.agentTurns) })
    if (v.usage && !v.usage.hasCost) headline[0] = { key: 'cost', label: 'Cost', value: 'no ledger here', isDim: true }

    const context: Pair[] = [{ key: 'window', label: 'Window', value: contextLine(v.usage) }]
    const left = untilCompaction(v.breakdown)
    if (left !== null) context.push({ key: 'until', label: 'Until compaction', value: formatTokens(left) })
    for (const c of categoryRows(v.breakdown, MAX_CATEGORIES)) {
      context.push({ key: `cat:${c.name}`, label: c.name, value: `${formatTokens(c.tokens)} · ${formatPercent(c.percent)}`, isDim: c.isDim })
    }

    const limits: Pair[] = (v.usage?.rateLimits ?? []).map((r, i) => {
      const line = rateLine(r, now)
      return { key: `rate:${i}`, label: line.label, value: line.value }
    })

    const labelWidth = isNarrow ? 14 : 20
    const pairRows = (pairs: readonly Pair[]) =>
      pairs.map(p => (
        <Box key={p.key} flexDirection="row">
          <Box width={labelWidth}>
            <Text wrap="truncate" dimColor>
              {p.label}
            </Text>
          </Box>
          <Box flexGrow={1} justifyContent="flex-end">
            <Text wrap="truncate" dimColor={p.isDim === true}>
              {p.value}
            </Text>
          </Box>
        </Box>
      ))

    const header = (
      <Box key="header" flexDirection="column">
        {pairRows(headline)}
      </Box>
    )

    // The context fill as a small thin bar at the right of the Context title,
    // flush with the pane's edge, so it sits just above the Window figure: on
    // the terminal two runs of cells (the track dim); elsewhere a 2 px pill
    // SVG that animates from the fill it last drew.
    let contextBar
    if (e.surface === 'terminal') {
      const b = barParts(pct, Math.min(BAR_CELLS, cols - 10))
      contextBar = (
        <Box key="context-bar" flexDirection="row">
          {b.filled !== '' && <Text>{b.filled}</Text>}
          {b.track !== '' && <Text dimColor>{b.track}</Text>}
        </Box>
      )
    } else {
      const { Svg } = $.ui.resolve(e)
      const shown = pct === null ? '--' : `${Math.round(pct)}%`
      contextBar = <Svg source={pillSvg(pct, lastBarPercent)} alt={`Context ${shown} used`} width={BAR_WIDTH_PX} height={BAR_HEIGHT_PX} />
      lastBarPercent = pct
    }

    // The model table: columns sized to the body; on a narrow pane only
    // output, est. $ and share stay, and on a middling one the least telling
    // columns drop until the model name has room.
    type Col = { key: string; title: string; width: number; value: (l: ModelLine) => string }
    const allCols: Col[] = [
      { key: 'req', title: 'Req', width: 7, value: l => formatCount(l.requests) },
      { key: 'in', title: 'Input', width: 9, value: l => formatTokens(l.input) },
      { key: 'out', title: 'Output', width: 9, value: l => formatTokens(l.output) },
      { key: 'cr', title: 'Cache rd', width: 10, value: l => formatTokens(l.cacheRead) },
      { key: 'cw', title: 'Cache wr', width: 10, value: l => formatTokens(l.cacheWrite) },
      { key: 'hit', title: 'Hit', width: 6, value: l => formatPercent(l.hit) },
      // A total with an unpriced model in it is a floor, marked `+`, never a complete figure.
      { key: 'est', title: 'Est. $', width: 11, value: l => (l.estUsd === null ? '--' : `${formatUsd(l.estUsd)}${l.isPartial ? '+' : ''}`) },
      { key: 'share', title: 'Share', width: 7, value: l => (l.share === null ? '--' : formatPercent(l.share)) },
    ]
    let cols2 = isNarrow ? allCols.filter(c => c.key === 'out' || c.key === 'est' || c.key === 'share') : allCols
    for (const drop of ['req', 'cw', 'in', 'cr']) {
      if (isNarrow || cols - cols2.reduce((s, c) => s + c.width, 0) >= 14) break
      cols2 = cols2.filter(c => c.key !== drop)
    }
    const nameWidth = Math.max(8, cols - cols2.reduce((s, c) => s + c.width, 0))
    const { rows: modelRows, total } = modelLines(v.models)
    const tableRow = (key: string, name: string, values: string[], isDim: boolean, isBold: boolean) => (
      <Box key={key} flexDirection="row">
        <Box width={nameWidth}>
          <Text wrap="truncate" dimColor={isDim} bold={isBold}>
            {name}
          </Text>
        </Box>
        {cols2.map((c, i) => (
          <Box key={`${key}:${c.key}`} width={c.width} justifyContent="flex-end">
            <Text wrap="truncate" dimColor={isDim} bold={isBold}>
              {values[i] ?? ''}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const contributing = contributionLines(v.loops)
    const section = (title: string) => <Text bold>{title}</Text>

    return (
      <Box flexDirection="column">
        {header}

        <Box key="context" flexDirection="column" marginTop={1}>
          <Box key="context-title" flexDirection="row" justifyContent="space-between" alignItems="center">
            {section('Context')}
            {contextBar}
          </Box>
          {pairRows(context)}
        </Box>

        <Box key="limits" flexDirection="column" marginTop={1}>
          {section('Rate limits')}
          {limits.length === 0 ? <Text dimColor>none reported</Text> : pairRows(limits)}
        </Box>

        <Box key="models" flexDirection="column" marginTop={1}>
          {section('Models')}
          {modelRows.length === 0 ? (
            <Text dimColor>No requests counted yet.</Text>
          ) : (
            <Box flexDirection="column">
              {tableRow('model-head', 'Model', cols2.map(c => c.title), true, false)}
              {modelRows.map(l => tableRow(`model:${l.model}`, l.name, cols2.map(c => c.value(l)), false, false))}
              {modelRows.length > 1 && tableRow('model-total', 'Total', cols2.map(c => c.value(total)), false, true)}
              <Text dimColor wrap="wrap">
                {PRICE_NOTE}
              </Text>
            </Box>
          )}
        </Box>

        <Box key="contributing" flexDirection="column" marginTop={1}>
          {section("What's contributing")}
          {contributing.length === 0 ? <Text dimColor>Nothing counted yet.</Text> : contributing.map((line, i) => <Text key={`contrib:${i}`}>{line}</Text>)}
        </Box>

        <Box key="changes" flexDirection="column" marginTop={1}>
          {section('Code changes')}
          <Text>{changesLine(t)}</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            Per-model, per-agent and code figures count from when usage-gauge loaded; the cost is the engine's own, from the session's start.
          </Text>
        </Box>
        {controls}
      </Box>
    )
  })
}
