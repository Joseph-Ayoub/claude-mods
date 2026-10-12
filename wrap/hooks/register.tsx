// /wrap: the close-out checklist as a slash command. It answers deterministically
// from git/gh facts (see checks.ts), says "unknown" rather than guess, and hands
// the model-only steps (raise PR, merge on green, report to lead) to ONE canonical
// prompt per head SHA. Nothing here re-triggers itself (there is no turn.complete
// hook), and only a /wrap the person typed (composer, Remote Control's bridge, or the
// desktop app, which hosts sessions over the SDK so its typing arrives as `sdk`) may
// queue that prompt or offer the archive: a plugin, peer, task notification or schedule
// can also run /wrap, and its run must never turn into a user-voiced instruction to push
// and merge.

import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { closeoutPrompt, evaluate, isReady, needsModel, parseArgs, render, show } from './checks'
import type { Run } from './checks'
import { collect } from './collect'

type Dollar = EngineInterface

const ARCHIVE_SERVER = 'ccd_session_mgmt'
const ARCHIVE_TOOL_NAME = 'archive_session'
const ARCHIVE_TOOL = `mcp__${ARCHIVE_SERVER}__${ARCHIVE_TOOL_NAME}`

// Literal refs: `claude plugin validate` holds each key to types/index.d.ts.
const submittedRef = { plugin: 'wrap', key: 'submittedFor' } as const
const backgroundRef = { plugin: 'wrap', key: 'backgroundTasks' } as const

/** An error's kind only: messages from git, gh or MCP can carry URLs or tokens. */
const kindOf = (err: unknown): string => (err instanceof Error && err.name ? err.name : 'error')

const makeRun =
  ($: Dollar, cwd: string): Run =>
  async (argv, timeoutMs) => {
    try {
      // cwd is the session's (a worktree), never repo().root, which is the main checkout.
      const r = await $.process.run(argv, { cwd, timeoutMs })
      return { kind: 'exit', code: r.exitCode, out: r.stdout, err: r.stderr }
    } catch {
      // Missing binary, spawn failure or timeout: all "could not establish".
      return { kind: 'failed' }
    }
  }

/**
 * The origins that are the person's own typing (a binding lead decision); everything else
 * (plugin, peer, task-notification, scheduled-trigger, channel, coordinator, observer,
 * auto-continuation, unclassified, an unstamped origin) only gets the table. `sdk` is in
 * because the desktop app hosts sessions over the SDK: a /wrap typed there arrives as `sdk`,
 * and the desktop app is the one surface the archive exists for.
 */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

/** The archive needs the app's tool AND a desktop surface; either missing means "use the app". */
async function archiveAvailable($: Dollar): Promise<boolean> {
  try {
    const [tools, surfaces] = await Promise.all([$.tool.list(), $.session.surfaces()])
    return surfaces.includes('desktop') && tools.some(t => t.name === ARCHIVE_TOOL)
  } catch {
    return false
  }
}

/**
 * Gives the SHA back so a later /wrap may send again, unless another write has moved it on.
 * Compare-and-set on the claim's own version, never a fresh get: every get of one dispatch
 * reads one moment, so a get after the claim in this same timer could miss the claim.
 */
async function release($: Dollar, claimedVersion: number): Promise<void> {
  try {
    await $.state.set(submittedRef, null, { ifVersion: claimedVersion })
  } catch {
    // nothing more to do
  }
}

/**
 * Runs from a one-shot timer after the command hook returned: the engine refuses
 * $.prompt.submit inside command.run. The SHA is claimed here, not in the hook, so a
 * timer lost to a hot reload leaves nothing claimed and the next /wrap retries; the
 * compare-and-set on the version read in the hook keeps two quick /wraps to one send.
 */
async function sendCloseout($: Dollar, sha: string, version: number, text: string): Promise<void> {
  let claimed: number | undefined
  try {
    const res = await $.state.set(submittedRef, sha, { ifVersion: version })
    if (!res.isSet) return
    claimed = res.version
    const sent = await $.prompt.submit({ text, asUser: true })
    // A hook's refusal or a settings block resolves as { drop }, not a rejection.
    if (sent.drop !== undefined) await release($, claimed)
  } catch {
    if (claimed !== undefined) await release($, claimed)
  }
}

/** Runs after the text row is drawn (scheduled with clock.after), since archiving ends this session. */
async function archive($: Dollar): Promise<void> {
  try {
    const choice = await $.ui.ask('Archive this session?', ['Archive', 'Not yet'])
    if (choice !== 'Archive') return
    // The app's archive tool takes the literal "self" for this session and a reason it shows in its approval prompt.
    const res = await $.mcp.call(ARCHIVE_SERVER, ARCHIVE_TOOL_NAME, { session_id: 'self', reason: '/wrap: every check passed' })
    if (res.isError) $.ui.toast('/wrap: the app refused the archive request (tool error)')
  } catch (err) {
    $.ui.toast(`/wrap: archive not done (${kindOf(err)})`)
  }
}

async function wrap($: Dollar, rawArgs: string, origin: PromptOrigin | undefined, acceptSkippedChecks: boolean) {
  const args = parseArgs(rawArgs)
  const cwd = await $.session.cwd()
  const bg = await $.state.get(backgroundRef)
  const facts = await collect(makeRun($, cwd), cwd, bg.value ?? null)
  const rows = evaluate(facts, { acceptSkippedChecks })
  const ready = isReady(rows)
  const notes: string[] = []
  // Fails closed: an origin the engine did not stamp is not the person's.
  const byPerson = origin !== undefined && PERSON_ORIGINS.has(origin.kind)
  const notPerson = `/wrap ran from ${show(origin?.kind ?? 'an unstamped origin', 30)}, not typed by you`

  if (args.unknown.length > 0) notes.push(`Ignored unknown argument(s): ${args.unknown.join(' ')}`)

  // Model-only work: once per head SHA, person-issued only, suppressed by --dry.
  if (needsModel(rows)) {
    if (args.dry) {
      notes.push('--dry: close-out prompt not sent.')
    } else if (!byPerson) {
      notes.push(`Close-out prompt not sent: ${notPerson}. Type /wrap to queue it.`)
    } else if (facts.head === undefined) {
      notes.push('Close-out prompt not sent: HEAD unknown.')
    } else {
      const held = await $.state.get(submittedRef)
      // --resend is the person's way out when a claimed send never arrived (a hooks worker
      // lost between the claim and the submit leaves the SHA claimed with nothing sent, and
      // no engine primitive makes the two atomic). It is explicit and person-only, so it
      // cannot loop; the claim stays a compare-and-set, so two quick /wraps still send once.
      if (held.value === facts.head && !args.resend) {
        notes.push(
          `Close-out prompt already sent for ${facts.head.slice(0, 7)}; not sending again until HEAD changes. If it never arrived, type /wrap --resend.`,
        )
      } else {
        const sha = facts.head
        const text = closeoutPrompt(facts.defaultBranch)
        $.clock.after(0, () => {
          void sendCloseout($, sha, held.version, text)
        })
        notes.push(
          `${held.value === facts.head ? '--resend: queued the close-out prompt again' : 'Queued the close-out prompt for the model (once per commit)'}; it starts when the session is idle. If a hook refuses it, the next /wrap tries again.`,
        )
      }
    }
  } else if (args.resend) {
    notes.push('--resend: nothing for the model to do, so no prompt was sent.')
  }

  // Archive: person-issued, capability-probed, explicit, confirmed, and only on a fully green table.
  if (ready) {
    if (args.archive && args.dry) {
      notes.push('--dry: archive not requested; ready to archive (use the app).')
    } else if (args.archive && !byPerson) {
      notes.push(`Archive not offered: ${notPerson}. Ready to archive (use the app).`)
    } else if (args.archive) {
      if (await archiveAvailable($)) {
        notes.push('Archive requested: a confirmation follows.')
        $.clock.after(0, () => {
          void archive($)
        })
      } else {
        notes.push('Archive tool not available here: ready to archive (use the app).')
      }
    } else {
      notes.push('ready to archive (use the app)')
    }
  } else if (args.archive) {
    notes.push('Archive skipped: not every check passed.')
  }

  // `text` is already the row the model reads, so no `context` copy of the table.
  return { text: render(facts, rows, notes) }
}

export const register: Register = (on, options) => {
  const acceptSkippedChecks = options.acceptSkippedChecks === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wrap',
      description:
        'Close-out checklist: tree, push, PR, CI on head, base freshness, merged, worktrees, background tasks',
      argumentHint: '[--archive] [--dry] [--resend]',
    })
    return next(e)
  })

  // Observer, fails open: caches what is still running or scheduled at each Stop, because no
  // `$` call lists either. Ids, types, statuses and the recurring flag only: descriptions,
  // commands and cron prompts may hold secrets or the person's own words.
  on('classic.Stop', async ($, e, next) => {
    try {
      if (e.agent_id === undefined) {
        // The field is optional: a Stop without it says nothing about tasks, so the row
        // goes back to unknown rather than reading as "none running".
        const listed = Array.isArray(e.background_tasks) ? e.background_tasks : undefined
        const tasks = listed?.map(t => ({
          id: String(t.id).slice(0, 64),
          type: String(t.type).slice(0, 32),
          status: String(t.status).slice(0, 32),
        }))
        // Crons (CronCreate, ScheduleWakeup, /loop) wake this session later: archiving drops them.
        // Absent stays absent, so the row reads unknown rather than "none scheduled".
        const crons = Array.isArray(e.session_crons)
          ? e.session_crons.map(c => ({ id: String(c.id).slice(0, 64), recurring: c.recurring === true }))
          : undefined
        await $.state.set(backgroundRef, tasks ? (crons ? { tasks, crons } : { tasks }) : null)
      }
    } catch {
      // never let bookkeeping disturb the stop
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fails open: bookkeeping must never disturb a stop

  // The desktop host raises no classic.Stop to mods (verified 2026-10-12): after a main-loop turn,
  // the running subagents stand in for the task list. A Stop that does arrive overwrites this.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        const agents = await $.agent.list()
        const tasks = agents
          .filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
          .map(a => ({ id: String(a.id).slice(0, 64), type: 'agent', status: String(a.status).slice(0, 32) }))
        await $.state.set(backgroundRef, { tasks, source: 'agents' })
      } catch {
        // a list that fails leaves what was known
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // Answers its own command (never calls next); a failure becomes the row, with the error kind only.
  on('command.run', { command: 'wrap' }, async ($, e) => {
    try {
      return await wrap($, e.args, e.origin, acceptSkippedChecks)
    } catch (err) {
      return { text: `/wrap could not run (${kindOf(err)}). Nothing was checked, so nothing passed.\n\nReady to archive: no` }
    }
  })
}
