import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptFillInput, PromptOrigin, PromptSubmitInput } from 'claude-code'

import { nextRefillStep } from './register'
import { CANDIDATE_RE, KINDS, hasCredential, redact } from './scan'
import type { KindId } from './scan'

// Fixtures are generated from a seeded generator, so no credential-shaped
// literal sits in this file (secret scanners and push protection would rightly
// flag one); prefixes are split for the same reason.

const HEX = '0123456789abcdef'
const DIGITS = '0123456789'
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const URLSAFE = `${ALNUM}_-`
const BASE64 = `${ALNUM}+/`

let seed = 0x5eed
function chars(alphabet: string, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    out += alphabet[seed % alphabet.length]
  }
  return out
}

const KEY_HEADER = ['-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----'].join('')
const KEY_FOOTER = ['-----END ', 'OPENSSH PRIVATE', ' KEY-----'].join('')
const KEY_BODY = [chars(BASE64, 70), chars(BASE64, 70), chars(BASE64, 70), `${chars(BASE64, 30)}==`].join('\n')

type Positive = { readonly name: string; readonly kind: KindId; readonly secrets: readonly string[]; readonly text: string }

const SHOPIFY = `shp${'at_'}${chars(HEX, 32)}`
const ANTHROPIC = `sk-${'ant-api03-'}${chars(URLSAFE, 93)}AA`
const OPENAI_PROJECT = `sk-${'proj-'}${chars(URLSAFE, 120)}`
const OPENAI_BARE = `sk-${chars(ALNUM, 48)}`
const GITHUB_CLASSIC = `gh${'p_'}${chars(ALNUM, 36)}`
const GITHUB_FINE = `github${'_pat_'}${chars(ALNUM, 22)}_${chars(ALNUM, 59)}`
const AWS_ID = `AK${'IA'}${chars(UPPER_DIGITS, 16)}`
const AWS_SECRET = `${chars(BASE64, 18)}/${chars(BASE64, 21)}`
const GOOGLE = `AI${'za'}${chars(URLSAFE, 35)}`
const SLACK = `xo${'xb-'}${chars(DIGITS, 12)}-${chars(DIGITS, 13)}-${chars(ALNUM, 24)}`
const STRIPE = `sk${'_live_'}${chars(ALNUM, 30)}`
const BEARER = chars(URLSAFE, 44)
const BASIC = btoa(`deploy:${chars(ALNUM, 18)}`)
const COOKIE = chars(ALNUM, 32)
const CF_TOKEN = `${chars(URLSAFE, 20)}9${chars(URLSAFE, 19)}`
const PASSWORD = `Pw${chars(ALNUM, 10)}!9`
const PRIVATE_KEY = `${KEY_HEADER}\n${KEY_BODY}\n${KEY_FOOTER}`

const POSITIVES: readonly Positive[] = [
  { name: 'private key block', kind: 'private-key', secrets: [KEY_BODY], text: `deploy key below\n${PRIVATE_KEY}\nthanks` },
  { name: 'Shopify admin token', kind: 'shopify', secrets: [SHOPIFY], text: `use ${SHOPIFY} for the admin api` },
  { name: 'Anthropic key', kind: 'anthropic', secrets: [ANTHROPIC], text: `export ANTHROPIC_API_KEY=${ANTHROPIC}` },
  { name: 'OpenAI project key', kind: 'openai', secrets: [OPENAI_PROJECT], text: `key is "${OPENAI_PROJECT}"` },
  { name: 'bare sk- key', kind: 'openai', secrets: [OPENAI_BARE], text: `OPENAI_API_KEY=${OPENAI_BARE} please` },
  { name: 'GitHub classic token', kind: 'github', secrets: [GITHUB_CLASSIC], text: `push with ${GITHUB_CLASSIC}` },
  { name: 'GitHub fine-grained token', kind: 'github', secrets: [GITHUB_FINE], text: `GITHUB_TOKEN=${GITHUB_FINE}` },
  { name: 'AWS access key id', kind: 'aws', secrets: [AWS_ID], text: `aws_access_key_id = ${AWS_ID}` },
  { name: 'AWS secret access key', kind: 'aws', secrets: [AWS_SECRET], text: `aws_secret_access_key = ${AWS_SECRET}` },
  { name: 'Google API key', kind: 'google', secrets: [GOOGLE], text: `maps key ${GOOGLE} works` },
  { name: 'Slack bot token', kind: 'slack', secrets: [SLACK], text: `SLACK_BOT_TOKEN=${SLACK}` },
  { name: 'Stripe live key', kind: 'stripe', secrets: [STRIPE], text: `charge with ${STRIPE}` },
  { name: 'Bearer header', kind: 'authorization', secrets: [BEARER], text: `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com/v1` },
  { name: 'Basic header', kind: 'authorization', secrets: [BASIC], text: `Authorization: Basic ${BASIC}` },
  { name: 'Cookie header', kind: 'cookie', secrets: [COOKIE], text: `Cookie: _session_id=${COOKIE}; theme=dark` },
  { name: 'labelled 40-char token', kind: 'api-token', secrets: [CF_TOKEN], text: `CLOUDFLARE_API_TOKEN=${CF_TOKEN}` },
  { name: 'password assignment', kind: 'password', secrets: [PASSWORD], text: `DB_PASSWORD=${PASSWORD}` },
  { name: 'bare pass key', kind: 'password', secrets: [PASSWORD], text: `export SMTP_PASS=${PASSWORD}\npass: ${PASSWORD}` },
  { name: 'quoted password value', kind: 'password', secrets: [`${PASSWORD} two`], text: `"password": "${PASSWORD} two",` },
]

const NEGATIVES: readonly { readonly name: string; readonly text: string }[] = [
  { name: '40-hex git SHA', text: 'commit 9fceb02d0ae598e95dc970b74767f19372d61af8 fixed the band' },
  { name: 'UUID', text: 'request id 123e4567-e89b-12d3-a456-426614174000 failed' },
  { name: 'sha256 digest', text: `image sha256:${'4b3c'.repeat(16)} pulled` },
  { name: 'task-runner', text: 'the task-runner-for-nightly-builds-and-deploys crashed' },
  { name: 'desk-', text: 'the desk-booking-service-integration-test-run-2026 is red' },
  { name: 'risk-', text: 'see risk-assessment-for-q3-roadmap-2026-final' },
  { name: 'sk-learn slug', text: 'read https://example.com/blog/sk-learn-pipelines-for-beginners-2026 and the sk-learn-compatible-estimator-api' },
  { name: '32-hex bundle path', text: 'read /private/tmp/claude-501/bundled-skills/2.1.293/0141573418fa79e2d00e1ce65a7ae6eb/plugin-authoring/SKILL.md' },
  { name: 'Bearer in prose', text: 'Send the access token as a Bearer token in the Authorization header; a missing Bearer prefix is rejected.' },
  { name: 'Bearer placeholders', text: 'curl -H "Authorization: Bearer <token>" or -H "Authorization: Bearer $API_TOKEN"' },
  { name: 'template fence with PASSWORD=<placeholder>', text: 'set these:\n```env\nDATABASE_URL=<your database url>\nPASSWORD=<placeholder>\nADMIN_PASSWORD=example-pass-123\n```' },
  { name: 'password type and references', text: 'type User = { password: string; }\npassword=os.environ["DB_PASSWORD"]\npassword: config.db.password' },
  { name: 'test tallies', text: 'pass: 1234/1234, fail: 0, tokens: 120000 in, 3400 out' },
  { name: 'pass in prose and test output', text: 'Your lens this pass: architecture\n--- PASS: TestRedactAll (0.00s)\nIf tests pass: continue' },
  { name: 'password set from a variable', text: 'connect(password=db_password)\nconfig = { "pass": didPass }' },
  { name: 'password on a long line', text: `${'x'.repeat(220)} password=Hunter2Hunter2` },
  { name: 'Cookie in prose', text: 'The Cookie: header carries session=<id> and nothing else.' },
  { name: 'prefix mentions', text: 'GitHub tokens start with ghp_ and AWS ids with AKIA; Shopify uses shpat_.' },
]

const ALL_KINDS: ReadonlySet<KindId> = new Set(KINDS.map(kind => kind.id))
const HOLD = 'secret-guard: prompt held, possible credential detected'

type Answer = string | 'dismiss' | 'no-dialog'

type Harness = {
  readonly asks: string[]
  readonly toasts: string[]
  readonly reached: PromptSubmitInput[]
  readonly fills: PromptFillInput[]
}

/** The engine beneath the plugin: answers the dialog, records toasts, fills, and what reached the session. */
function harness(on: On, answer: Answer, fill: { isFilled: boolean; refusal?: 'dialog' | 'no_composer' }[] = []): Harness {
  const h: Harness = { asks: [], toasts: [], reached: [], fills: [] }
  on('prompt.submit', ($, e) => {
    h.reached.push(e)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  if (answer !== 'no-dialog') {
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const question = e.questions[0]?.question ?? ''
      h.asks.push(question)
      if (answer === 'dismiss') return { deny: 'dismissed' }
      return { result: { questions: e.questions, answers: { [question]: answer } } }
    })
  }
  on('ui.toast', ($, e) => {
    h.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    h.fills.push(e)
    return fill.shift() ?? { isFilled: true }
  })
  return h
}

const submit = ($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.prompt.submit({ text, wait: false, origin })

/** Nothing the person or a log could see carries a value. */
function expectNoLeak(h: Harness, secrets: readonly string[]): void {
  for (const secret of secrets) {
    for (const ask of h.asks) expect(ask.includes(secret), 'ask text leaked a value').toBe(false)
    for (const toast of h.toasts) expect(toast.includes(secret), 'toast leaked a value').toBe(false)
    for (const fill of h.fills) expect(fill.text.includes(secret), 'refill leaked a value').toBe(false)
  }
}

describe('detector', () => {
  test('finds every kind, and nothing of the value survives redaction', () => {
    for (const fixture of POSITIVES) {
      expect(CANDIDATE_RE.test(fixture.text), `prefilter misses ${fixture.name}`).toBe(true)
      const found = redact(fixture.text, ALL_KINDS)
      expect(found.kinds, fixture.name).toEqual([fixture.kind])
      expect(found.redacted, fixture.name).toContain(`<REDACTED:${fixture.kind}#1>`)
      for (const secret of fixture.secrets) expect(found.redacted.includes(secret), `${fixture.name} survived`).toBe(false)
      expect(hasCredential(found.redacted, ALL_KINDS), `${fixture.name} still matches after redaction`).toBe(false)
    }
  })

  test('leaves SHAs, UUIDs, digests, slugs, bundle paths, prose and templates alone', () => {
    for (const fixture of NEGATIVES) {
      const found = redact(fixture.text, ALL_KINDS)
      expect(found.findings, fixture.name).toEqual([])
      expect(found.redacted, fixture.name).toBe(fixture.text)
    }
  })

  test('every kind in one prompt: all redacted, nothing left to match', () => {
    const text = POSITIVES.map(fixture => fixture.text).join('\n\n')
    const found = redact(text, ALL_KINDS)
    expect(new Set(found.kinds)).toEqual(new Set(POSITIVES.map(fixture => fixture.kind)))
    for (const fixture of POSITIVES) {
      for (const secret of fixture.secrets) expect(found.redacted.includes(secret), fixture.name).toBe(false)
    }
    expect(hasCredential(found.redacted, ALL_KINDS)).toBe(false)
  })

  test('the same value shares a placeholder; distinct values are numbered', () => {
    const other = `gh${'p_'}${chars(ALNUM, 36)}`
    const found = redact(`${GITHUB_CLASSIC} then ${other} then ${GITHUB_CLASSIC}`, ALL_KINDS)
    expect(found.redacted).toBe('<REDACTED:github#1> then <REDACTED:github#2> then <REDACTED:github#1>')
    expect(found.findings).toHaveLength(2)
  })

  test('a private key goes whole: with its footer, and when truncated without one', () => {
    const whole = redact(`a\n${PRIVATE_KEY}\nb`, ALL_KINDS)
    expect(whole.redacted).toBe('a\n<REDACTED:private-key#1>\nb')
    const truncated = redact(`${KEY_HEADER}\n${KEY_BODY}\n\nwhy does ssh reject it?`, ALL_KINDS)
    expect(truncated.redacted).toBe('<REDACTED:private-key#1>\n\nwhy does ssh reject it?')
  })

  test('overlapping hits merge: a Bearer value that is also a vendor key leaves nothing behind', () => {
    const found = redact(`Authorization: Bearer ${ANTHROPIC}`, ALL_KINDS)
    expect(found.redacted).toBe('Authorization: Bearer <REDACTED:anthropic#1>')
    expect(found.kinds).toEqual(['anthropic'])
  })

  test('an AWS key pair loses both halves', () => {
    const found = redact(`aws_access_key_id=${AWS_ID}\naws_secret_access_key=${AWS_SECRET}`, ALL_KINDS)
    expect(found.redacted).toBe('aws_access_key_id=<REDACTED:aws#1>\naws_secret_access_key=<REDACTED:aws#2>')
  })

  test('a disabled kind is not scanned', () => {
    const found = redact(`${SHOPIFY} ${GITHUB_CLASSIC}`, new Set<KindId>(['github']))
    expect(found.redacted).toBe(`${SHOPIFY} <REDACTED:github#1>`)
  })

  test('a 1 MB adversarial paste scans in well under the hook budget', () => {
    const unit = `token: ${'a1'.repeat(19)}b password=${'x'.repeat(7)} sk-${'ab-'.repeat(8)} Authorization: Bearer ${'q'.repeat(30)}\n`
    const text = unit.repeat(Math.ceil(1_000_000 / unit.length))
    const started = Date.now()
    redact(text, ALL_KINDS)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  test('a non-string prompt throws, naming no value', () => {
    expect(() => redact(['x'] as unknown as string, ALL_KINDS)).toThrow('secret-guard: the prompt text is not a string')
  })
})

describe('the person\'s own prompt', () => {
  for (const fixture of POSITIVES) {
    test(`Redact and reference: ${fixture.name}`, async ($, on) => {
      const h = harness(on, 'Redact and reference')
      const result = await submit($, fixture.text)
      expect(h.asks).toHaveLength(1)
      const label = KINDS.find(kind => kind.id === fixture.kind)?.label ?? ''
      expect(h.asks[0]).toBe(`secret-guard: a possible ${label} credential is in your prompt. How should it go?`)
      expect(h.reached).toHaveLength(1)
      const reached = h.reached[0]!
      expect(reached.text).toContain(`<REDACTED:${fixture.kind}#1>`)
      for (const secret of fixture.secrets) expect(reached.text.includes(secret), 'value reached the session').toBe(false)
      expect(hasCredential(reached.text, ALL_KINDS)).toBe(false)
      const note = reached.context?.[0] ?? ''
      expect(note).toContain(`<REDACTED:${fixture.kind}#1>`)
      expect(note).toContain(KINDS.find(kind => kind.id === fixture.kind)?.hint ?? '?')
      expect(note).toContain('Never ask the person to paste a credential into the chat again')
      for (const secret of fixture.secrets) expect(note.includes(secret), 'value reached the note').toBe(false)
      expect(result.text).toBe(reached.text)
      expectNoLeak(h, fixture.secrets)
    })
  }

  test('false positives pass untouched, with no dialog and no note', async ($, on) => {
    const h = harness(on, 'Cancel')
    for (const fixture of NEGATIVES) {
      const result = await submit($, fixture.text)
      expect(result.drop, fixture.name).toBeUndefined()
      expect(h.reached[h.reached.length - 1]?.text, fixture.name).toBe(fixture.text)
      expect(h.reached[h.reached.length - 1]?.context, fixture.name).toBeUndefined()
    }
    expect(h.asks).toEqual([])
    expect(h.toasts).toEqual([])
  })

  test('a dismissed dialog falls back to redaction, never to the raw text', async ($, on) => {
    const h = harness(on, 'dismiss')
    const result = await submit($, `token ${SHOPIFY} please`)
    expect(h.asks).toHaveLength(1)
    expect(result.drop).toBeUndefined()
    expect(h.reached[0]?.text).toBe('token <REDACTED:shopify#1> please')
    expect(h.reached[0]?.context?.[0]).toContain('wrangler secret SHOPIFY_ADMIN_TOKEN')
    expect(h.toasts.some(toast => toast.includes('no answer'))).toBe(true)
    expectNoLeak(h, [SHOPIFY])
  })

  test('with nobody to ask (headless), the prompt is sent redacted', async ($, on) => {
    const h = harness(on, 'no-dialog')
    await submit($, `push with ${GITHUB_CLASSIC}`, { kind: 'sdk' })
    expect(h.reached[0]?.text).toBe('push with <REDACTED:github#1>')
    expectNoLeak(h, [GITHUB_CLASSIC])
  })

  test('Remote Control and SDK prompts get the dialog too', async ($, on) => {
    const h = harness(on, 'Redact and reference')
    await submit($, `push with ${GITHUB_CLASSIC}`, { kind: 'bridge' })
    await submit($, `push with ${GITHUB_CLASSIC}`, { kind: 'sdk' })
    expect(h.asks).toHaveLength(2)
    expect(h.reached.map(e => e.text)).toEqual(['push with <REDACTED:github#1>', 'push with <REDACTED:github#1>'])
  })

  test('Send anyway sends it unchanged and warns that it is in the transcript', async ($, on) => {
    const h = harness(on, 'Send anyway')
    const text = `use ${STRIPE} in staging`
    await submit($, text)
    expect(h.reached[0]?.text).toBe(text)
    expect(h.reached[0]?.context).toBeUndefined()
    expect(h.toasts.some(toast => toast.includes('transcript'))).toBe(true)
    expectNoLeak(h, [STRIPE])
  })

  test('Cancel holds the prompt and puts the draft back, redacted', async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on, 'Cancel')
    const result = await submit($, `ship it with ${SHOPIFY} and ${GITHUB_CLASSIC}`)
    expect(result.drop).toBe('Held: possible Shopify and GitHub credential in prompt. The draft goes back in the prompt box with the value redacted.')
    expect(h.reached).toEqual([])
    await clock.advance(1000)
    expect(h.fills).toHaveLength(1)
    expect(h.fills[0]?.text).toBe('ship it with <REDACTED:shopify#1> and <REDACTED:github#1>')
    expect(h.fills[0]?.mode).toBe('replace')
    expectNoLeak(h, [SHOPIFY, GITHUB_CLASSIC])
  })

  test('words typed under Other count as Cancel', async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on, 'hmm, not sure')
    const result = await submit($, `DB_PASSWORD=${PASSWORD}`)
    expect(result.drop).toContain('Held: possible password credential in prompt')
    expect(h.reached).toEqual([])
    await clock.advance(1000)
    expect(h.fills[0]?.text).toBe('DB_PASSWORD=<REDACTED:password#1>')
  })

  test('a refill the prompt box refuses tells the person, naming no value', async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on, 'Cancel', [{ isFilled: false }])
    await submit($, `key ${GOOGLE}`)
    await clock.advance(1000)
    expect(h.fills.map(fill => fill.text)).toEqual(['key <REDACTED:google#1>'])
    expect(h.toasts).toContain('secret-guard: the held draft could not be put back in the prompt box.')
    expectNoLeak(h, [GOOGLE])
  })

  test('refill steps: retry under a dialog (capped), clipboard with no prompt box, give up when unknown', () => {
    expect(nextRefillStep({ isFilled: true }, 0)).toBe('done')
    expect(nextRefillStep({ isFilled: false, refusal: 'dialog' }, 0)).toBe('retry')
    expect(nextRefillStep({ isFilled: false, refusal: 'dialog' }, 2)).toBe('retry')
    expect(nextRefillStep({ isFilled: false, refusal: 'dialog' }, 3)).toBe('give-up')
    expect(nextRefillStep({ isFilled: false, refusal: 'no_composer' }, 0)).toBe('clipboard')
    expect(nextRefillStep({ isFilled: false }, 0)).toBe('give-up')
  })

  test('a hook that fails before deciding holds the prompt (fails closed)', async ($, on) => {
    const h = harness(on, 'Send anyway')
    const malformed = [`key ${SHOPIFY}`] as unknown as string
    for (const origin of [{ kind: 'composer' }, { kind: 'peer' }] as const) {
      const result = await submit($, malformed, origin)
      expect(result.drop, origin.kind).toBe(HOLD)
    }
    expect(h.reached).toEqual([])
    expect(h.asks).toEqual([])
  })
})

describe('options', () => {
  test('scan<Kind>: false turns that kind off and leaves the rest on', { options: { scanShopify: false } }, async ($, on) => {
    const h = harness(on, 'Redact and reference')
    await submit($, `use ${SHOPIFY}`)
    expect(h.reached[0]?.text).toBe(`use ${SHOPIFY}`)
    expect(h.asks).toEqual([])
    await submit($, `push with ${GITHUB_CLASSIC}`)
    expect(h.reached[1]?.text).toBe('push with <REDACTED:github#1>')
  })

  test('hint<Kind> names where the value lives', { options: { hintGithub: 'op read op://dev/github/token' } }, async ($, on) => {
    const h = harness(on, 'Redact and reference')
    await submit($, `push with ${GITHUB_CLASSIC}`)
    expect(h.reached[0]?.context?.[0]).toContain('Where it lives: op read op://dev/github/token')
  })

  test('a credential-shaped hint is ignored for the default', { options: { hintGithub: `use ${GITHUB_FINE}` } }, async ($, on) => {
    const h = harness(on, 'Redact and reference')
    await submit($, `push with ${GITHUB_CLASSIC}`)
    const note = h.reached[0]?.context?.[0] ?? ''
    expect(note.includes(GITHUB_FINE)).toBe(false)
    expect(note).toContain(`Where it lives: ${KINDS.find(kind => kind.id === 'github')?.hint}`)
  })
})

describe('messages nobody typed', () => {
  test('a peer message is redacted with no dialog', async ($, on) => {
    const h = harness(on, 'Send anyway')
    const result = await submit($, `here is the token ${SLACK}`, { kind: 'peer' })
    expect(h.asks).toEqual([])
    expect(result.text).toBe('here is the token <REDACTED:slack#1>')
    expect(h.reached[0]?.context?.[0]).toContain('a message from another Claude session')
    expect(h.toasts.some(toast => toast.includes('from a message from another Claude session'))).toBe(true)
    expectNoLeak(h, [SLACK])
  })

  test('every unattended origin is redacted, never asked', async ($, on) => {
    const h = harness(on, 'Send anyway')
    const origins: PromptOrigin[] = [
      { kind: 'peer-send-message' },
      { kind: 'task-notification' },
      { kind: 'scheduled-trigger' },
      { kind: 'projects-relay' },
      { kind: 'channel', server: 'slack' },
      { kind: 'coordinator' },
      { kind: 'observer' },
      { kind: 'observer-activity' },
      { kind: 'auto-continuation' },
      { kind: 'unclassified' },
      { kind: 'slack-ping' },
      { kind: 'plugin', name: 'other', asUser: true },
      // An origin kind a later build adds is unattended until proven otherwise.
      { kind: 'some-future-kind' } as unknown as PromptOrigin,
    ]
    for (const origin of origins) {
      const result = await submit($, `AWS key ${AWS_ID}`, origin)
      expect(result.text, origin.kind).toBe('AWS key <REDACTED:aws#1>')
    }
    expect(h.asks).toEqual([])
    expectNoLeak(h, [AWS_ID])
  })

  test('a clean peer message passes untouched', async ($, on) => {
    const h = harness(on, 'Send anyway')
    const result = await submit($, 'the token budget is fine', { kind: 'peer' })
    expect(result.text).toBe('the token budget is fine')
    expect(h.reached[0]?.context).toBeUndefined()
    expect(h.toasts).toEqual([])
  })
})
