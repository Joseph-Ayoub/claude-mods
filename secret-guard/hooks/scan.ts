/**
 * secret-guard's detector: finds credential-shaped values in a prompt and
 * builds the redacted text. Pure functions: no `$`, no state, no I/O.
 *
 * Why this shape: every pattern is anchored on a vendor prefix or a nearby
 * label and bounded in length, and bare hex or base64 is never a match on its
 * own, so the commit SHAs, UUIDs, digests and 32-hex bundle paths pasted every
 * day never raise the dialog (a guard that cries wolf gets switched off).
 * Each hit covers the value itself, never its label, and overlapping hits are
 * merged before redaction so no part of a value survives.
 *
 * Security invariant: nothing this module returns or throws carries a matched
 * value. Only kinds, counts and placeholders leave it; values exist solely as
 * local strings while the redacted text is built.
 */

export type KindId =
  | 'private-key'
  | 'shopify'
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'aws'
  | 'google'
  | 'slack'
  | 'stripe'
  | 'authorization'
  | 'cookie'
  | 'api-token'
  | 'password'

export type Kind = {
  readonly id: KindId
  /** What the person and the model are told it is ("a possible <label> credential"). */
  readonly label: string
  /** userConfig suffix: `scan<option>` (boolean) and `hint<option>` (string). */
  readonly option: string
  /** Where the value should be read from instead, unless the person configures another. */
  readonly hint: string
}

/**
 * Every kind, in merge priority order: when two hits cover the same span the
 * earlier kind names the placeholder (a vendor shape beats a generic one).
 * plugin.json's userConfig carries one `scan*` and one `hint*` field per row,
 * with these hints as its defaults.
 */
export const KINDS: readonly Kind[] = [
  { id: 'private-key', label: 'private key', option: 'PrivateKey', hint: 'the key file on disk (for example ~/.ssh/id_ed25519), referenced by path' },
  { id: 'shopify', label: 'Shopify', option: 'Shopify', hint: 'wrangler secret SHOPIFY_ADMIN_TOKEN' },
  { id: 'anthropic', label: 'Anthropic', option: 'Anthropic', hint: 'the ANTHROPIC_API_KEY environment variable' },
  { id: 'openai', label: 'OpenAI-style', option: 'Openai', hint: 'the OPENAI_API_KEY environment variable' },
  { id: 'github', label: 'GitHub', option: 'Github', hint: 'gh auth token' },
  { id: 'aws', label: 'AWS', option: 'Aws', hint: 'the AWS profile in ~/.aws/credentials (aws configure)' },
  { id: 'google', label: 'Google API', option: 'Google', hint: 'the GOOGLE_API_KEY environment variable' },
  { id: 'slack', label: 'Slack', option: 'Slack', hint: 'the SLACK_BOT_TOKEN environment variable' },
  { id: 'stripe', label: 'Stripe', option: 'Stripe', hint: 'wrangler secret STRIPE_SECRET_KEY' },
  { id: 'authorization', label: 'Authorization header', option: 'Authorization', hint: 'the API_TOKEN environment variable' },
  { id: 'cookie', label: 'session cookie', option: 'Cookie', hint: 'a fresh login in the browser (cookies are never pasted)' },
  { id: 'api-token', label: 'API token', option: 'ApiToken', hint: 'wrangler secret CLOUDFLARE_API_TOKEN' },
  { id: 'password', label: 'password', option: 'Password', hint: 'op read "op://Private/<item>/password"' },
]

const PRIORITY: ReadonlyMap<KindId, number> = new Map(KINDS.map((kind, index) => [kind.id, index]))

/**
 * The prefilter the registrations match `e.text` against, so the hook only
 * runs on prompts that could hold a hit. It MUST be a superset of every
 * detector below: each alternative is a literal that every match of some
 * detector contains (the tests hold every positive fixture to it). No `g`
 * flag: the engine tests it repeatedly and a global regex carries `lastIndex`.
 */
export const CANDIDATE_RE =
  /shp(?:at|ss|ca|pa)_|sk-|[sr]k_live_|gh[pousr]_|github_pat_|AKIA|ASIA|AIza|xox[abprs]-|PRIVATE KEY|authorization|cookie|pass|token|api[ _.-]?key|access[ _.-]?key|auth[ _.-]?key/i

type Span = { readonly kind: KindId; readonly start: number; readonly end: number }

type Detector = { readonly kind: KindId; readonly find: (text: string, fences: Fences) => Span[] }

/** Whole-match spans of a global regex, kept where `accept` (if given) agrees. */
function wholeMatches(kind: KindId, pattern: RegExp, accept?: (value: string) => boolean) {
  return (text: string): Span[] => {
    const spans: Span[] = []
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
      if (accept && !accept(value)) continue
      spans.push({ kind, start: match.index, end: match.index + value.length })
    }
    return spans
  }
}

/** Spans of one capture group (the value after a label), from the `d` flag's indices. */
function groupMatches(
  kind: KindId,
  pattern: RegExp,
  group: number,
  accept?: (value: string, match: RegExpMatchArray) => boolean,
) {
  return (text: string): Span[] => {
    const spans: Span[] = []
    for (const match of text.matchAll(pattern)) {
      const value = match[group]
      const at = match.indices?.[group]
      if (value === undefined || at === undefined) continue
      if (accept && !accept(value, match)) continue
      spans.push({ kind, start: at[0], end: at[1] })
    }
    return spans
  }
}

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

const hasDigit = (value: string) => /[0-9]/.test(value)
const hasLetter = (value: string) => /[A-Za-z]/.test(value)
const isHexOnly = (value: string) => /^[0-9a-f]+$/i.test(value)

/** Longest run of letters and digits: a real key body has one; a hyphenated slug does not. */
function longestAlnumRun(value: string): number {
  let longest = 0
  for (const run of value.split(/[^A-Za-z0-9]+/)) longest = Math.max(longest, run.length)
  return longest
}

/** Basic credentials decode to `user:password`; anything else is not one. */
function isBasicCredential(value: string): boolean {
  if (typeof atob !== 'function') return true // cannot check: treat it as a credential
  try {
    return atob(value).includes(':')
  } catch {
    return false
  }
}

// Fenced code blocks, for the password rule's "config template" exemption.

type Fence = { readonly start: number; readonly end: number; readonly isTemplate: boolean }
type Fences = { readonly at: (offset: number) => Fence | undefined }

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/

/**
 * A value that stands for a secret rather than being one: `<placeholder>`,
 * `${VAR}`, `$VAR`, `{{var}}`, `%VAR%`, `xxxxxxxx`, `********`, `changeme`, a
 * type name, a code reference (`os.environ[...]`, `getpass()`), or one of this
 * mod's own `<REDACTED:...>` placeholders.
 */
export function isPlaceholder(raw: string): boolean {
  const value = raw.trim().replace(/^["'`]|["'`,;]+$/g, '')
  if (value.length === 0) return true
  if (/^<[^<>]*>$/.test(value) || value.includes('<REDACTED:')) return true
  if (/^\$\{[^}]*\}$/.test(value) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true
  if (/^\{\{[^}]*\}\}$/.test(value) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(value)) return true
  if (/^(.)\1+$/.test(value)) return true
  if (/change[-_ ]?me|placeholder|^your[-_ ]|\[redacted\]|^redacted$|x{4,}|\*{3,}/i.test(value)) return true
  if (
    /^(?:secret|password|passwd|pass|null|nil|none|undefined|true|false|string|str|number|int|bool|boolean|required|optional|hidden|masked|empty|example|sample|dummy|todo|tbd)$/i.test(
      value,
    )
  )
    return true
  // A code reference (`os.environ["X"]`, `getpass()`, `config.db.password`) names where the value lives.
  if (/^[A-Za-z_$][\w$.]*\s*[[(]/.test(value)) return true
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return true
  // So does a bare snake_case or camelCase identifier (`password=db_password`, `"pass": didPass`).
  if (/^[A-Za-z]+(?:_[A-Za-z]+)+$/.test(value) || /^[a-z]+(?:[A-Z][a-z]+)+$/.test(value)) return true
  return false
}

/** Values documentation uses inside a template fence (`my-example-pass`); never skipped outside one. */
const DOC_DUMMY = /example|sample|dummy|demo|change.?me|placeholder|your[-_]|fixme|todo|test/i

// Greedy capture, trimmed by the caller: a lazy `(.+?)\s*$` is quadratic on a long run of spaces.
const ASSIGNED_VALUE = /^\s*[A-Za-z_][\w.-]*["']?\s*[:=]\s*(.*)$/

/**
 * The fenced blocks of `text`, each marked as a config template when one of
 * its `KEY=value` / `key: value` lines holds a placeholder value.
 */
function findFences(text: string): Fences {
  const fences: Fence[] = []
  let open: { start: number; marker: string; hasPlaceholder: boolean } | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length
    const marker = FENCE_LINE.exec(line)?.[1]
    if (open === undefined) {
      if (marker) open = { start: offset, marker, hasPlaceholder: false }
    } else if (marker && marker[0] === open.marker[0] && marker.length >= open.marker.length && line.trim() === marker) {
      fences.push({ start: open.start, end: lineEnd, isTemplate: open.hasPlaceholder })
      open = undefined
    } else if (!open.hasPlaceholder) {
      const value = ASSIGNED_VALUE.exec(line)?.[1]?.trim()
      if (value !== undefined && value !== '' && isPlaceholder(value)) open.hasPlaceholder = true
    }
    offset = lineEnd + 1
  }
  if (open) fences.push({ start: open.start, end: text.length, isTemplate: open.hasPlaceholder })
  // Fences are disjoint and in order, so a binary search finds the one holding an offset.
  const at = (offset: number): Fence | undefined => {
    let low = 0
    let high = fences.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const fence = fences[middle]!
      if (offset < fence.start) high = middle - 1
      else if (offset > fence.end) low = middle + 1
      else return fence
    }
    return undefined
  }
  return { at }
}

// Private keys: the whole block goes, header to footer, never the header alone.

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g
const KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g

/** A line of a key's body: base64 (long, or with a digit, `+`, `/` or `=`, so a lone word is not one) or a PEM header. */
function isKeyBodyLine(line: string): boolean {
  if (/^[A-Za-z-]+: /.test(line)) return true
  return /^[A-Za-z0-9+/=]+$/.test(line) && (line.length >= 16 || /[0-9+/=]/.test(line))
}

/**
 * Where a block with no footer (a truncated paste) ends: the rest of the
 * header's line, then every body line, blank lines between them allowed. A
 * line walk, not a regex, so a long line costs one pass.
 */
function truncatedKeyEnd(text: string, headerEnd: number): number {
  const lineEnd = (from: number) => {
    const newline = text.indexOf('\n', from)
    return newline === -1 ? text.length : newline
  }
  let end = lineEnd(headerEnd)
  let cursor = end
  while (cursor < text.length) {
    const next = lineEnd(cursor + 1)
    const line = text.slice(cursor + 1, next).trim()
    if (line !== '' && !isKeyBodyLine(line)) break
    if (line !== '') end = next
    cursor = next
  }
  return end
}

function privateKeys(text: string): Span[] {
  const ends = [...text.matchAll(KEY_END)].map(match => ({ start: match.index, end: match.index + match[0].length }))
  const spans: Span[] = []
  let nextEnd = 0
  for (const begin of text.matchAll(KEY_BEGIN)) {
    const headerEnd = begin.index + begin[0].length
    while (nextEnd < ends.length && ends[nextEnd]!.start < headerEnd) nextEnd += 1
    const footer = ends[nextEnd]
    if (footer) {
      spans.push({ kind: 'private-key', start: begin.index, end: footer.end })
      continue
    }
    spans.push({ kind: 'private-key', start: begin.index, end: truncatedKeyEnd(text, headerEnd) })
  }
  return spans
}

// Passwords: `password: <value>` / `PASSWORD=<value>` on a short line.

// A bare `pass` key counts only as part of a key (`DB_PASS=`, `"pass":`, `pass:` opening a
// line); after a word it is prose (`this pass:`, `tests pass:`, Go's `--- PASS: TestA`).
const PASSWORD =
  /(?:pass(?:word|wd)|(?:(?<=[_.\-"'`])|(?<=(?:^|\n)[ \t]*(?:export[ \t]+)?))pass(?![A-Za-z]))["'`]?[ \t]*[:=][ \t]*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|`([^`\r\n]{8,})`|([^\s"'`]{8,}))/gid
const MAX_PASSWORD_LINE = 200

function passwords(text: string, fences: Fences): Span[] {
  const spans: Span[] = []
  for (const match of text.matchAll(PASSWORD)) {
    const group = [1, 2, 3, 4].find(index => match[index] !== undefined)
    const at = group === undefined ? undefined : match.indices?.[group]
    if (group === undefined || at === undefined) continue
    const start = at[0]
    const trailing = group === 4 ? (/[,;)\]}]*$/.exec(match[4]!)?.[0].length ?? 0) : 0
    const end = at[1] - trailing
    const value = text.slice(start, end)
    if (value.length < 8 || isPlaceholder(value)) continue
    // A bare `pass` key also heads test tallies (`pass: 1234/1234`); there a value needs a letter.
    if (!/^pass(?:word|wd)/i.test(match[0]) && !hasLetter(value)) continue
    const lineStart = text.lastIndexOf('\n', match.index) + 1
    const newline = text.indexOf('\n', match.index)
    const lineEnd = newline === -1 ? text.length : newline
    if (lineEnd - lineStart >= MAX_PASSWORD_LINE) continue
    if (fences.at(match.index)?.isTemplate && DOC_DUMMY.test(value)) continue
    spans.push({ kind: 'password', start, end })
  }
  return spans
}

const DETECTORS: readonly Detector[] = [
  { kind: 'private-key', find: privateKeys },
  { kind: 'shopify', find: wholeMatches('shopify', /(?<![A-Za-z0-9_])shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}(?![A-Za-z0-9_])/g) },
  { kind: 'anthropic', find: wholeMatches('anthropic', /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g) },
  { kind: 'openai', find: wholeMatches('openai', /(?<![A-Za-z0-9])sk-proj-[A-Za-z0-9_-]{20,}/g) },
  {
    // The bare `sk-` form: only after the start, whitespace, a quote or an
    // assignment, so task-/desk-/risk- and URL slugs never qualify, and only
    // with a long letters-and-digits run, which a hyphenated slug lacks.
    kind: 'openai',
    find: wholeMatches(
      'openai',
      /(?<=^|[\s'"`=:,;(\[{<>|])sk-(?!ant-|proj-)[A-Za-z0-9_-]{20,}/g,
      value => longestAlnumRun(value.slice(3)) >= 16 && hasDigit(value) && hasLetter(value.slice(3)),
    ),
  },
  { kind: 'github', find: wholeMatches('github', /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g) },
  { kind: 'github', find: wholeMatches('github', /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_])/g) },
  { kind: 'aws', find: wholeMatches('aws', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g) },
  {
    // The access key's partner: a secret access key is 40 base64 characters
    // and recognisable only by its label, so it is caught beside one.
    kind: 'aws',
    find: groupMatches(
      'aws',
      /secret[ _.-]?access[ _.-]?key[^\r\n]{0,20}?(?<![A-Za-z0-9/+])([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gid,
      1,
      value => hasLetter(value) && /[0-9/+]/.test(value) && !isHexOnly(value),
    ),
  },
  { kind: 'google', find: wholeMatches('google', /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g) },
  { kind: 'slack', find: wholeMatches('slack', /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g, hasDigit) },
  { kind: 'stripe', find: wholeMatches('stripe', /(?<![A-Za-z0-9_])[sr]k_live_[A-Za-z0-9]{24,}/g) },
  {
    kind: 'authorization',
    find: groupMatches(
      'authorization',
      /authorization["'`]?[ \t]*[:=][ \t]*["'`]?[ \t]*(bearer|token|bot|basic)[ \t]+([A-Za-z0-9._~+/=-]{12,})/gid,
      2,
      (value, match) =>
        match[1]!.toLowerCase() === 'basic' ? isBasicCredential(value) : value.length >= 20 && entropy(value) > 3.5,
    ),
  },
  {
    kind: 'cookie',
    find: text =>
      groupMatches('cookie', /(?<![A-Za-z0-9_-])(?:set-)?cookie["'`]?[ \t]*:[ \t]*([^\r\n"'`]+)/gid, 1, value =>
        /(?:^|[;\s])[^=;\s]+=[^;\s]{20,}/.test(value),
      )(text).map(span => ({ ...span, end: span.start + text.slice(span.start, span.end).trimEnd().length })),
  },
  {
    // Cloudflare-style 40-character tokens have no prefix, so they count only
    // within 20 characters after a label; a 40-hex git SHA never does.
    kind: 'api-token',
    find: groupMatches(
      'api-token',
      /(?:token|api[ _.-]?key|access[ _.-]?key|auth[ _.-]?key)[^\r\n]{0,20}?(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{40})(?![A-Za-z0-9_-])/gid,
      1,
      value => hasDigit(value) && hasLetter(value) && !isHexOnly(value),
    ),
  },
  { kind: 'password', find: passwords },
]

/** Every enabled detector's hits, overlaps merged into one span named by its widest member. */
function findSpans(text: string, enabled: ReadonlySet<KindId>): Span[] {
  const fences = findFences(text)
  const hits = DETECTORS.filter(detector => enabled.has(detector.kind))
    .flatMap(detector => detector.find(text, fences))
    .filter(span => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)

  const merged: Span[] = []
  let current: { kind: KindId; start: number; end: number; width: number } | undefined
  for (const hit of hits) {
    const width = hit.end - hit.start
    if (current && hit.start < current.end) {
      current.end = Math.max(current.end, hit.end)
      const isWider = width > current.width
      const isTieWon = width === current.width && PRIORITY.get(hit.kind)! < PRIORITY.get(current.kind)!
      if (isWider || isTieWon) {
        current.kind = hit.kind
        current.width = width
      }
      continue
    }
    if (current) merged.push({ kind: current.kind, start: current.start, end: current.end })
    current = { kind: hit.kind, start: hit.start, end: hit.end, width }
  }
  if (current) merged.push({ kind: current.kind, start: current.start, end: current.end })
  return merged
}

export type Finding = { readonly kind: KindId; readonly placeholder: string }

export type Redaction = {
  /** The text with each value replaced by `<REDACTED:kind#n>`. */
  readonly redacted: string
  /** One per distinct value, in order of first appearance; the same value twice shares a placeholder. */
  readonly findings: readonly Finding[]
  /** The distinct kinds found, in priority order. */
  readonly kinds: readonly KindId[]
}

/** Scan-then-redact passes before giving up: a redaction can bring a label within reach of a later value. */
const MAX_PASSES = 4

/**
 * Finds every enabled credential shape in `text` and replaces each value with
 * a numbered placeholder, re-scanning the result until nothing matches.
 *
 * Throws (with no value in the message) when the text is not a string or the
 * redaction does not settle; the hooks' `.catch` turns either into a hold.
 */
export function redact(text: string, enabled: ReadonlySet<KindId>): Redaction {
  if (typeof text !== 'string') throw new TypeError('secret-guard: the prompt text is not a string')
  const numbers = new Map<string, string>()
  const counts = new Map<KindId, number>()
  const findings: Finding[] = []
  let current = text
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const spans = findSpans(current, enabled)
    if (spans.length === 0) {
      const kinds = KINDS.map(kind => kind.id).filter(id => findings.some(finding => finding.kind === id))
      return { redacted: current, findings, kinds }
    }
    let rebuilt = ''
    let cursor = 0
    for (const span of spans) {
      const key = `${span.kind}\u0000${current.slice(span.start, span.end)}`
      let placeholder = numbers.get(key)
      if (placeholder === undefined) {
        const n = (counts.get(span.kind) ?? 0) + 1
        counts.set(span.kind, n)
        placeholder = `<REDACTED:${span.kind}#${n}>`
        numbers.set(key, placeholder)
        findings.push({ kind: span.kind, placeholder })
      }
      rebuilt += current.slice(cursor, span.start) + placeholder
      cursor = span.end
    }
    current = rebuilt + current.slice(cursor)
  }
  throw new Error('secret-guard: the redaction did not settle')
}

/** Whether any enabled shape is still in `text` (the post-redaction check the tests make). */
export function hasCredential(text: string, enabled: ReadonlySet<KindId>): boolean {
  return findSpans(text, enabled).length > 0
}

/** "Shopify", "Shopify and GitHub", "Shopify, GitHub and AWS": labels only, never values. */
export function kindsPhrase(kinds: readonly KindId[]): string {
  const labels = kinds.map(id => KINDS.find(kind => kind.id === id)?.label ?? id)
  if (labels.length <= 1) return labels[0] ?? 'credential'
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
