// Kit-level tests: register.tsx loaded by the engine and driven through `$`
// (session.start, command.run, tool.call, session.receive, session.end,
// turn.start, the mocked clock), with the filesystem, git, gh, the session and
// the UI answered beneath it by world.ts's host. Other sessions are played by
// writing their files into the same in-memory filesystem through lane.ts.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { makeEnvelope, parseHolderRecord, parseQueueEntry, repoKeyOf } from './core'
import type { QueueEntry } from './core'
import { acquire, lanePaths, touchAlive, writeQueueEntry } from './lane'
import type { LanePaths } from './lane'
import { installHost, MemFs, memIO, newHost } from './world'
import type { Host } from './world'

const MIN = 60_000
const HOME = '/home/t'
const ROOT = `${HOME}/.claude/merge-lane`
const REMOTE = 'git@github.com:Owner/Repo.git'
const REPO = 'github.com/owner/repo'
const SELF = 'self-0001'
const OTHER = 'other-0001'
const NEXT = 'next-0001'
const PRESENTATION = { isFullscreen: false, columns: 120 }

type Ran = { isRefused: boolean; text: string }

type World = {
  host: Host
  fs: MemFs
  p: LanePaths
  key: string
  clock: ReturnType<typeof mock.clock>
  /** Another session takes the lane, as its own copy of the mod would. */
  otherHolds: (sessionId?: string, pr?: string | null) => Promise<void>
  /** Another session waits in the queue, alive and reachable. */
  otherQueues: (sessionId: string, requestedAt: number, isLive?: boolean) => Promise<QueueEntry>
  holderId: () => string | null
}

async function world(on: On, options: { env?: Record<string, string>; remote?: string | null } = {}): Promise<World> {
  const clock = mock.clock(on, { now: 100 * MIN })
  mock.env(on, options.env ?? { HOME })
  const fs = new MemFs(() => clock.now())
  const host = newHost(fs, SELF, options.remote === undefined ? REMOTE : options.remote)
  installHost(on, host)
  const key = await repoKeyOf(REPO)
  const p = lanePaths(ROOT, key)
  const others = memIO(fs, id => (host.live.has(id) ? 'delivered' : 'absent'))
  return {
    host,
    fs,
    p,
    key,
    clock,
    async otherHolds(sessionId = OTHER, pr = '7') {
      await acquire(others, p, { sessionId, label: 'other-branch', pr, since: clock.now(), implicit: false, repo: REPO })
      await touchAlive(others, p, sessionId, clock.now())
      host.live.add(sessionId)
    },
    async otherQueues(sessionId, requestedAt, isLive = true) {
      const entry: QueueEntry = {
        sessionId,
        label: `${sessionId}-branch`,
        pr: null,
        priority: 'normal',
        requestedAt,
        nonce: `n-${sessionId}`,
        source: 'request',
      }
      await writeQueueEntry(others, p, entry)
      if (isLive) {
        await touchAlive(others, p, sessionId, clock.now())
        host.live.add(sessionId)
      }
      return entry
    },
    holderId: () => parseHolderRecord(fs.read(p.holderFile))?.sessionId ?? (fs.has(p.holder) ? 'unlabeled' : null),
  }
}

const start = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.session.start({ cwd: '/work/repo', surface, isInteractive: true })

async function lane($: Engine, args: string, kind = 'composer'): Promise<string> {
  const answer = await $.command.run({ command: 'lane', args, origin: { kind } as never, presentation: PRESENTATION })
  return answer.text ?? ''
}

/** Runs a Bash command through every plugin; a refusal is the call's { deny }, or the errored result a session sees. */
async function bash($: Engine, command: string, agentId?: string): Promise<Ran> {
  const input = agentId === undefined ? { tool: 'Bash', command } : { tool: 'Bash', command, agentId }
  const answer = (await $.tool.call(input as never)) as { deny?: string; isError?: boolean; text?: string }
  return { isRefused: answer.deny !== undefined || answer.isError === true, text: answer.deny ?? answer.text ?? '' }
}

/** Lets work a hook left running unawaited (the tick, a session.start look) reach the host. */
async function until($: Engine, check: () => boolean): Promise<void> {
  // a send to nobody is a round trip through the engine that no lane code reads
  for (let i = 0; i < 400 && !check(); i++) await $.session.send({ to: 'flush-0000', text: 'flush' } as never)
}

const merged = (pr: number) => () => ({
  result: { stdout: '', stderr: '', interrupted: false, gitOperation: { pr: { number: pr, action: 'merged' } } },
  text: `Merged pull request #${pr}`,
})

describe('/lane commands and who may run them', () => {
  test('session.start registers /lane as an immediate command and, on a lane already, picks it up', async ($, on) => {
    const w = await world(on)
    await w.otherQueues(SELF, w.clock.now())
    await start($)
    expect(w.host.commands).toEqual([{ name: 'lane', immediate: true }])
    await w.clock.advance(1_000)
    await until($, () => w.holderId() === SELF)
    expect(w.holderId()).toBe(SELF)
  })

  test('origin gating: only the person (composer, bridge, the desktop app over sdk) may change the lane; anyone may read it', async ($, on) => {
    const w = await world(on)
    await start($)
    expect(await lane($, 'request 12')).toContain('the merge lane is yours (PR #12)')
    expect(w.holderId()).toBe(SELF)
    for (const [kind, args] of [
      ['peer', 'release'],
      ['task-notification', 'release'],
      ['plugin', 'take --yes'],
      ['scheduled-trigger', 'prioritize self'],
      ['peer', 'off'],
      ['peer', 'auto off'],
    ] as const) {
      expect(await lane($, args, kind)).toContain('type it yourself')
    }
    expect(w.holderId()).toBe(SELF)
    const status = await lane($, '', 'peer')
    expect(status).toContain(`Merge lane for ${REPO}`)
    expect(status).toContain('(this session) (PR #12)')
    expect(await lane($, 'release', 'bridge')).toContain('released the merge lane')
    expect(w.holderId()).toBeNull()
    // the desktop app hosts its sessions over the SDK: its /lane is the person's
    expect(await lane($, 'request 12', 'sdk')).toContain('the merge lane is yours (PR #12)')
    expect(w.holderId()).toBe(SELF)
    expect(await lane($, 'off', 'sdk')).not.toContain('type it yourself')
  })

  test('request behind a holder queues with the real position; prioritize writes an overlay, never the other queue file', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await w.otherQueues('third-0001', w.clock.now() - 5 * MIN)
    await start($)
    expect(await lane($, 'request 12')).toContain('queued #2 of 2 behind other-branch (PR #7)')
    expect(w.host.statuses.at(-1)).toBe('lane: queued #2 of 2 behind other-branch (PR #7)')
    const thirdFile = `${w.p.queue}/third-0001.json`
    const before = w.fs.read(thirdFile)
    expect(await lane($, 'prioritize self')).toContain('it is now #1 of 2')
    expect(w.fs.has(`${w.p.priority}/${SELF}.json`)).toBe(true)
    expect(w.fs.read(thirdFile)).toBe(before)
    expect(w.host.statuses.at(-1)).toBe('lane: queued #1 of 2 behind other-branch (PR #7)')
    expect(await lane($, 'prioritize zzzz')).toContain('no queued session matches')
  })

  test('take: refused while a turn runs, unless --yes', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    await $.turn.start({ text: 'work', turnId: 't1' })
    expect(await lane($, 'take')).toContain('a turn is running')
    // --yes never breaks a live holder without the dialog
    expect(await lane($, 'take --yes')).toContain('the holder looks live')
    expect(w.host.asks).toBe(0)
    expect(w.holderId()).toBe(OTHER)
  })

  test('take: a subagent turn starting after the main turn ended does not count as a running turn', async ($, on) => {
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    const w = await world(on)
    await w.otherHolds()
    await start($)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1, isAborted: false })
    await $.turn.start({ text: '', turnId: 't-sub', agentId: 'agent-1' } as never)
    expect(await lane($, 'take')).toContain('kept; nothing changed')
    expect(w.host.asks).toBe(1)
    expect(w.holderId()).toBe(OTHER)
  })

  test('take: a dismissed dialog keeps the holder; --yes asks for a live one and breaks a stale one, recording who it was taken from', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    expect(await lane($, 'take')).toContain('kept; nothing changed')
    expect(w.host.asks).toBe(1)
    expect(w.holderId()).toBe(OTHER)
    // a live holder may be mid-merge: --yes still shows the dialog
    expect(await lane($, 'take --yes')).toContain('kept; nothing changed')
    expect(w.host.asks).toBe(2)
    expect(w.holderId()).toBe(OTHER)
    // heartbeat and alive file both old: the lock looks stale, so --yes skips the dialog
    await w.clock.advance(11 * MIN)
    expect(await lane($, 'take --yes')).toContain('took the merge lane from other-branch')
    expect(w.host.asks).toBe(2)
    const record = parseHolderRecord(w.fs.read(w.p.holderFile))
    expect(record?.sessionId).toBe(SELF)
    expect(record?.takenFrom).toContain('other-branch')
    expect(w.host.sent.some(one => one.to === OTHER && one.text.includes('"kind":"lane.changed"'))).toBe(true)
  })
})

describe('the merge gate through tool.call', () => {
  test('a command that only mentions a merge passes untouched and runs no process', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    await lane($, '', 'composer')
    const runsBefore = w.host.runs.length
    const commands = [
      'git commit -m "docs: run gh pr merge 5 later"',
      'git push origin fix-main-bug && git checkout main',
      'cat <<EOF\ngh pr merge 9\nEOF',
    ]
    for (const command of commands) expect((await bash($, command)).isRefused).toBe(false)
    expect(w.host.ran).toEqual(commands)
    expect(w.host.runs.length).toBe(runsBefore)
  })

  test('held by another: help pages, dry runs, quoted or heredoc text and read-only gh are never refused or queued', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    const commands = [
      'gh pr merge --help',
      'gh pr merge 12 -h',
      'git push --dry-run origin main',
      'git push -n origin main',
      "cat > notes.md <<'MSG-END'\ngh pr merge 12 once green\nMSG-END",
      "git commit -m 'gh pr merge later'",
      'echo "gh pr merge 12"',
      'git push origin feature-main',
      'gh pr view 12',
    ]
    for (const command of commands) expect((await bash($, command)).isRefused).toBe(false)
    expect(w.host.ran).toEqual(commands)
    expect(w.fs.has(`${w.p.queue}/${SELF}.json`)).toBe(false)
    expect(w.holderId()).toBe(OTHER)
    // on a free lane a help page takes nothing
    w.fs.rmrf(w.p.holder)
    expect((await bash($, 'gh pr merge --help')).isRefused).toBe(false)
    expect(w.holderId()).toBeNull()
  })

  test('a repo or directory the text cannot tell is let through and logged, never judged against this lane', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    const commands = ['cd "$OTHER_REPO" && gh pr merge 5', 'git -C "$DIR" push origin main', 'gh pr merge -R "$REPO" 5']
    for (const command of commands) expect((await bash($, command)).isRefused).toBe(false)
    expect(w.host.ran).toEqual(commands)
    expect(w.fs.has(`${w.p.queue}/${SELF}.json`)).toBe(false)
    const ungated = w.host.logs.filter(line => line.includes('through ungated'))
    expect(ungated).toHaveLength(3)
    // the reason only, never the command text
    for (const line of ungated) for (const part of ['OTHER_REPO', 'DIR', 'REPO', 'gh pr', 'push origin']) expect(line).not.toContain(part)
    // a plain merge here is still refused
    expect((await bash($, 'gh pr merge 5')).isRefused).toBe(true)
  })

  test('held by another: denied with the real position, queued by the gate, never run', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    const ran = await bash($, 'gh pr merge 12 --squash')
    expect(ran.isRefused).toBe(true)
    expect(ran.text).toContain(`the merge lane for ${REPO} is held by other-branch`)
    expect(ran.text).toContain('(PR #7) since just now; you are #1 of 1 in the queue')
    expect(w.host.ran).toEqual([])
    const own = parseQueueEntry(w.fs.read(`${w.p.queue}/${SELF}.json`), SELF)
    expect(own?.source).toBe('gate')
    expect(own?.pr).toBe('12')
    expect(w.host.statuses.at(-1)).toBe('lane: queued #1 of 1 behind other-branch (PR #7)')
    // a subagent's merge is gated the same
    expect((await bash($, 'gh pr merge 12', 'a1')).isRefused).toBe(true)
    expect(w.host.ran).toEqual([])
  })

  test('free lane: taken for the merge, released when the engine reports it merged, and the next session woken', async ($, on) => {
    const w = await world(on)
    await start($)
    expect(await lane($, 'request 12')).toContain('is yours')
    await w.otherQueues(NEXT, w.clock.now())
    w.host.bash = merged(12)
    const ran = await bash($, 'gh pr merge 12 --squash --delete-branch')
    expect(ran.isRefused).toBe(false)
    expect(w.host.ran).toEqual(['gh pr merge 12 --squash --delete-branch'])
    expect(w.holderId()).toBeNull()
    const wake = makeEnvelope({ kind: 'lane.available', repoKey: w.key, nonce: `n-${NEXT}` })
    expect(w.host.sent).toContainEqual({ to: NEXT, text: wake })
    expect(w.host.toasts.at(-1)).toContain('merge lane released: PR #12 landed')
  })

  test('auto-merge-enabled, a backgrounded merge and an unreadable result all keep the lane', async ($, on) => {
    const w = await world(on)
    await start($)
    await lane($, 'request 12')
    const results = [
      { result: { stdout: '', stderr: '', interrupted: false, gitOperation: { pr: { number: 12, action: 'auto-merge-enabled' } } }, text: '' },
      { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: '' },
      { result: { stdout: '', stderr: '', interrupted: true }, text: '' },
      { result: { stdout: '', stderr: '', interrupted: false, gitOperation: { pr: { number: 99, action: 'merged' } } }, text: '' },
    ]
    for (const result of results) {
      w.host.bash = () => result
      await bash($, 'gh pr merge 12 --squash')
      expect(w.holderId()).toBe(SELF)
    }
  })

  test('a lane the gate took just for one merge is handed back when that merge fails', async ($, on) => {
    const w = await world(on)
    await start($)
    w.host.bash = () => ({ result: { stdout: '', stderr: 'not mergeable', interrupted: false }, isError: true, text: 'not mergeable' })
    await bash($, 'gh pr merge 12 --squash')
    expect(w.host.ran).toEqual(['gh pr merge 12 --squash'])
    expect(w.holderId()).toBeNull()
    expect(w.host.toasts.at(-1)).toContain('the merge did not go through')
  })

  test('gh pr merge --auto is refused by default', async ($, on) => {
    const w = await world(on)
    await start($)
    const ran = await bash($, 'gh pr merge 12 --auto --squash')
    expect(ran.isRefused).toBe(true)
    expect(ran.text).toContain('--auto is refused')
    expect(w.host.ran).toEqual([])
  })

  test('enforce off: the gate refuses nothing', { options: { enforce: false } }, async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    expect((await bash($, 'gh pr merge 12 --squash')).isRefused).toBe(false)
    expect(w.host.ran).toEqual(['gh pr merge 12 --squash'])
    expect(w.holderId()).toBe(OTHER)
  })

  test('/lane off lets this session merge without the lane; /lane on gates it again', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    expect(await lane($, 'off')).toContain('gate is off for this session')
    expect(w.host.statuses.at(-1)).toBe('lane: gate off')
    expect((await bash($, 'gh pr merge 12')).isRefused).toBe(false)
    expect(await lane($, 'on')).toContain('gate is on again')
    expect((await bash($, 'gh pr merge 12')).isRefused).toBe(true)
    expect(w.host.ran).toEqual(['gh pr merge 12'])
  })
})

describe('lane messages', () => {
  test('text without the prefix passes; anything with it is consumed, and a stale nonce takes nothing', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    await lane($, 'request 12')
    const nonce = parseQueueEntry(w.fs.read(`${w.p.queue}/${SELF}.json`), SELF)?.nonce ?? ''
    expect(nonce).not.toBe('')

    const plain = await $.session.receive({ origin: { kind: 'peer' }, text: 'hello from a peer' } as never)
    expect(plain.text).toBe('hello from a peer')
    for (const text of ['merge-lane/v1 {not json', makeEnvelope({ kind: 'ping' })]) {
      expect((await $.session.receive({ origin: { kind: 'peer-send-message' }, text } as never)).consumed).toBeDefined()
    }

    // the holder leaves without a word reaching us; then a stale wake arrives
    w.fs.rmrf(w.p.holder)
    const stale = makeEnvelope({ kind: 'lane.available', repoKey: w.key, nonce: 'stale-nonce' })
    expect((await $.session.receive({ origin: { kind: 'peer' }, text: stale } as never)).consumed).toBeDefined()
    expect(w.holderId()).toBeNull()
    expect(w.host.prompts).toEqual([])
    expect(w.host.received).toEqual(['hello from a peer'])

    // the real wake: taken by mkdir, toasted, one proceed prompt for this nonce only
    const wake = makeEnvelope({ kind: 'lane.available', repoKey: w.key, nonce })
    expect((await $.session.receive({ origin: { kind: 'peer' }, text: wake } as never)).consumed).toBeDefined()
    expect(w.holderId()).toBe(SELF)
    expect(w.host.toasts).toContain('merge lane is yours (PR #12)')
    expect(w.host.prompts).toHaveLength(1)
    expect(w.host.prompts[0]).toContain('The merge lane is yours for PR #12. Proceed with the merge')
    // the mod's own words: framed as the plugin's message, never as the person's
    expect(w.host.promptsAsUser).toEqual([false])
    expect(w.host.statuses.at(-1)).toBe('lane: yours (PR #12)')
    await $.session.receive({ origin: { kind: 'peer' }, text: wake } as never)
    expect(w.host.prompts).toHaveLength(1)
    expect(w.host.received).toEqual(['hello from a peer'])
  })

  test('auto off: the wake toasts and takes the lane but submits no prompt', { options: { auto: false } }, async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    await lane($, 'request 12')
    const nonce = parseQueueEntry(w.fs.read(`${w.p.queue}/${SELF}.json`), SELF)?.nonce ?? ''
    w.fs.rmrf(w.p.holder)
    await $.session.receive({ origin: { kind: 'peer' }, text: makeEnvelope({ kind: 'lane.available', repoKey: w.key, nonce }) } as never)
    expect(w.holderId()).toBe(SELF)
    expect(w.host.prompts).toEqual([])
  })
})

describe('the tick', () => {
  test('the 30 s tick takes a free lane for the queue head with no message, and prompts once', async ($, on) => {
    const w = await world(on)
    await w.otherHolds()
    await start($)
    await lane($, 'request 12')
    w.fs.rmrf(w.p.holder)
    await w.clock.advance(30_000)
    await until($, () => w.holderId() === SELF)
    expect(w.holderId()).toBe(SELF)
    await until($, () => w.host.prompts.length > 0)
    expect(w.host.prompts).toHaveLength(1)
    expect(w.host.promptsAsUser).toEqual([false])
  })

  test('after a hot reload (no session.start) the first turn picks the lane back up', async ($, on) => {
    const w = await world(on)
    await w.otherQueues(SELF, w.clock.now())
    await $.turn.start({ text: 'work', turnId: 't1' })
    await w.clock.advance(1_000)
    await until($, () => w.holderId() === SELF)
    expect(w.holderId()).toBe(SELF)
    expect(w.host.statuses.at(-1)).toBe('lane: yours')
    // and the 30 s tick is armed again: the heartbeat moves on the next one
    const beat = w.fs.stat(w.p.heartbeat)?.mtimeMs ?? 0
    await w.clock.advance(30_000)
    await until($, () => (w.fs.stat(w.p.heartbeat)?.mtimeMs ?? 0) > beat)
    expect(w.fs.stat(w.p.heartbeat)?.mtimeMs ?? 0).toBeGreaterThan(beat)
  })

  test('release wakes the first live session, pruning a dead head', async ($, on) => {
    const w = await world(on)
    await start($)
    await lane($, 'request 12')
    await w.otherQueues('dead-0001', w.clock.now() - 10 * MIN, false)
    await w.otherQueues(NEXT, w.clock.now())
    expect(await lane($, 'release')).toContain(`woke ${NEXT}-branch`)
    expect(w.fs.has(`${w.p.queue}/dead-0001.json`)).toBe(false)
    expect(w.fs.has(`${w.p.queue}/${NEXT}.json`)).toBe(true)
  })
})

describe('session rotation and fail-safes', () => {
  test('/clear: the ending id gives the lane back and leaves the queue; the new id starts gated and clean', async ($, on) => {
    const w = await world(on)
    await start($)
    await lane($, 'request 12')
    await lane($, 'off')
    expect(w.holderId()).toBe(SELF)
    await $.session.end({ reason: 'clear', sessionId: SELF } as never)
    expect(w.holderId()).toBeNull()
    expect(w.fs.has(`${w.p.alive}/${SELF}`)).toBe(false)
    w.host.sessionId = 'new-0002'
    await w.otherHolds()
    const ran = await bash($, 'gh pr merge 12')
    expect(ran.isRefused).toBe(true)
    expect(ran.text).toContain('you are #1 of 1')
    expect(w.fs.has(`${w.p.queue}/new-0002.json`)).toBe(true)
    expect(await lane($, '')).toContain('gate on')
  })

  test('inert without a remote: merges pass and /lane says why', async ($, on) => {
    const w = await world(on, { remote: null })
    await start($)
    expect((await bash($, 'gh pr merge 12')).isRefused).toBe(false)
    expect(await lane($, 'request')).toContain('not in a git repository with an origin remote')
    expect(w.fs.has(ROOT)).toBe(false)
  })

  test('inert without HOME: merges pass', async ($, on) => {
    const w = await world(on, { env: {} })
    await start($)
    expect((await bash($, 'gh pr merge 12')).isRefused).toBe(false)
    expect(w.host.ran).toEqual(['gh pr merge 12'])
  })

  test('fail closed: a lane that cannot be created refuses the merge', async ($, on) => {
    const w = await world(on)
    await start($)
    w.host.isMkdirpBroken = true
    const ran = await bash($, 'gh pr merge 12')
    expect(ran.isRefused).toBe(true)
    expect(ran.text).toContain('could not check the merge lane')
    expect(w.host.ran).toEqual([])
  })

  test('fail closed: a gate that throws refuses merges but never other commands', async ($, on) => {
    const w = await world(on)
    await start($)
    w.host.isRepoBroken = true
    const ran = await bash($, 'gh pr merge 12')
    expect(ran.isRefused).toBe(true)
    expect(ran.text).toContain('refused rather than let through unchecked')
    expect((await bash($, 'ls -la')).isRefused).toBe(false)
    expect(w.host.ran).toEqual(['ls -la'])
  })
})

describe('status line on each surface', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: yours, then queued count, then cleared on release`, async ($, on) => {
      const w = await world(on)
      // the desktop app hosts its sessions over the SDK, so its /lane arrives with an sdk origin
      const origin = surface === 'desktop' ? 'sdk' : 'composer'
      await start($, surface)
      await lane($, 'request 12', origin)
      expect(w.host.statuses.at(-1)).toBe('lane: yours (PR #12)')
      await w.otherQueues(NEXT, w.clock.now())
      await lane($, '', origin)
      expect(w.host.statuses.at(-1)).toBe('lane: yours (PR #12) · 1 queued')
      await lane($, 'release', origin)
      expect(w.host.statuses.at(-1)).toBeUndefined()
    })
  }
})
