// rd-ledger: text discipline. Every string that comes from outside the mod (a
// branch name, a repo basename, a model id, a name in components.json, rdt's
// stdout, an environment variable) passes through cleanField before it is
// stored, drawn, exported or placed in an argv: the leak scan runs over the
// uncapped value first (a hit stores `[redacted:<kind>]`, rd-tracker's field()
// rule), then oneLine with the field's cap. The scan and the CSV cell rule port
// rd-tracker's rdt/sanitize.py plus the panel's additions, so the two records
// refuse the same things. Pure: no `$`, no I/O.

/**
 * One printable line of at most `max` code points, NFKC-normalized: control
 * characters and line separators become spaces, format characters (bidi
 * overrides, zero-width, Unicode tags), surrogates and private-use characters
 * are dropped, whitespace runs collapse. A crafted branch name cannot add a row
 * to a table or a line to a toast, and cannot hide one with a bidi override.
 */
/**
 * Invisible or blank characters outside Unicode's format class that still split
 * a token or an address without being seen (verifier N3, V13): the combining
 * grapheme joiner, every variation selector (U+FE00-FE0F, U+180B-180F,
 * U+E0100-E01EF), the Hangul fillers, the braille blank, Khmer vowel inherent
 * marks. oneLine is NFKC-normalized, so a full-width letter or sign becomes the
 * plain one before any scan.
 */
const INVISIBLE = /[\u034F\uFE00-\uFE0F\u115F\u1160\u3164\uFFA0\u2800\u180B-\u180F\u17B4\u17B5\u{E0100}-\u{E01EF}]/gu

export const oneLine = (text: string, max: number): string =>
  [
    ...String(text)
      // NFKC: a full-width @ or digit becomes the plain one, so a scan cannot be dodged by width.
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/[\p{Cf}\p{Cs}\p{Co}]/gu, '')
      .replace(INVISIBLE, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
    .trim()

/** A session id as the engine mints them: a UUID (any version), either case. */
export const isSessionId = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/** An entity, component or activity id: kebab-case, 1 to 64 characters, no leading dash. */
export const isId = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)

/** A segment id as store.ts mints it: base-36 digits. */
export const isSeg = (s: string): boolean => /^[0-9a-z]{1,16}$/.test(s)

/** A calendar date `YYYY-MM-DD` (shape only; the calendar is tz.ts's business). */
export const isDate = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)

/** A month `YYYY-MM`. */
export const isMonth = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

/** An ISO week `YYYY-Www`. */
export const isWeek = (s: string): boolean => /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(s)

export const basename = (path: string): string => {
  const trimmed = String(path).replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/**
 * The branch from `git rev-parse --abbrev-ref HEAD`: its first line, printable
 * ASCII, at most 200 characters; null for a detached HEAD, an empty answer or
 * anything else (a branch is drawn and exported, so only a safe one is kept).
 */
export const cleanBranch = (out: string): string | null => {
  const line = (String(out).trim().split('\n')[0] ?? '').trim()
  if (line === '' || line === 'HEAD') return null
  return /^[\x21-\x7e]{1,200}$/.test(line) ? line : null
}

/**
 * The repository root's basename as the mapping key: one line, printable, at
 * most 100 characters, never empty. `#` is reserved for the `key#hash` form and
 * `|` for row keys, so both are replaced. The person's HOME reads `~` and `/`
 * reads `root` (CYB-10: a session started in HOME must not store the user name).
 */
export const repoKeyOf = (root: string, home: string | null): string => {
  const trimmed = String(root).replace(/\/+$/, '')
  if (home !== null && trimmed === home.replace(/\/+$/, '')) return '~'
  if (trimmed === '' || trimmed === '/') return 'root'
  const key = oneLine(basename(trimmed), 100).replace(/[#|]/g, '_')
  return key === '' ? 'unknown' : key
}

/** `repoKey#hash12`, or the bare key when the hash is unknown. */
export const repoRef = (repoKey: string, rootHash: string | null): string => (rootHash ? `${repoKey}#${rootHash}` : repoKey)

/** A pre-tag glob: a literal, or a prefix ending in one `*`; matched linearly, never a regex (CYB-9). */
export const globMatch = (pattern: string, text: string): boolean => {
  if (pattern.length === 0 || pattern.length > 100) return false
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    return !prefix.includes('*') && text.startsWith(prefix)
  }
  return !pattern.includes('*') && text === pattern
}

const CSV_TRIGGER = /^[=+\-@\t\r]/

/**
 * One CSV cell: line breaks become spaces, a leading `= + - @ TAB CR` gets a
 * `'` prefix so Excel reads text, then the cell is quoted when it holds a
 * quote, a comma or a space-only edge (rd-tracker's csv_cell plus csv.writer).
 */
export const csvCell = (value: string | number | boolean | null | undefined): string => {
  let text = value === null || value === undefined ? '' : String(value)
  text = text.replace(/\r/g, ' ').replace(/\n/g, ' ')
  if (CSV_TRIGGER.test(text)) text = `'${text}`
  return /[",]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

/** One CSV line from its cells. */
export const csvLine = (cells: readonly (string | number | boolean | null | undefined)[]): string => cells.map(csvCell).join(',')

// --- the leak scan (rdt/sanitize.py, ported; panel CYB-11 additions marked) -------

const SCAN_LIMIT = 64 * 1024

const CREDENTIAL_PATTERNS: readonly [string, RegExp][] = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{12,}/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/], // CYB-11
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{16,}/], // CYB-11
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}/], // CYB-11
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}/], // CYB-11
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['shopify-token', /\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['pem-block', /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/],
  ['client-secret', /\bclient[_-]?secret\b/i],
  ['bearer-token', /\bbearer\s+[A-Za-z0-9._-]{12,}/i],
  ['ein', /\b\d{2}-\d{7}\b/],
]

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const NOREPLY_DOMAIN = 'users.noreply.github.com'
const EXEMPT_EXACT = new Set(['noreply@anthropic.com'])
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org']
const RESERVED_TLDS = new Set(['invalid', 'test', 'localhost', 'example'])

const isEmailExempt = (address: string): boolean => {
  if (EXEMPT_EXACT.has(address.toLowerCase())) return true
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase().replace(/\.+$/, '')
  if (domain === NOREPLY_DOMAIN || domain.endsWith(`.${NOREPLY_DOMAIN}`)) return true
  if (RESERVED_DOMAINS.includes(domain) || RESERVED_DOMAINS.some(r => domain.endsWith(`.${r}`))) return true
  return RESERVED_TLDS.has(domain.slice(domain.lastIndexOf('.') + 1))
}

/** Every non-exempt email address in `value`, in order. */
export const findEmails = (value: string): string[] => {
  const out: string[] = []
  for (const m of String(value).slice(0, SCAN_LIMIT).matchAll(EMAIL_RE)) if (!isEmailExempt(m[0])) out.push(m[0])
  return out
}

const TOKEN_RE = /[A-Za-z0-9+=_-]{32,}/g
const HEX_DIGEST_RE = /^(?:[0-9a-f]{32,64}|[0-9A-F]{32,64})$/
const ENTROPY_THRESHOLD = 4.0

/** Bits of Shannon entropy per character; 0 for the empty string. */
export const shannonEntropy = (value: string): number => {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  const n = [...value].length
  let sum = 0
  for (const c of counts.values()) sum -= (c / n) * Math.log2(c / n)
  return sum
}

const looksLikeOpaqueSecret = (token: string): boolean => {
  if (HEX_DIGEST_RE.test(token)) return false
  if (!(/\d/.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token))) return false
  const segments = token.split('-')
  if (segments.length >= 4 && segments.every(s => s.length <= 12)) {
    const alpha = segments.filter(s => /^[a-z]+$/.test(s)).length
    if (alpha * 2 >= segments.length) return false
  }
  return shannonEntropy(token) >= ENTROPY_THRESHOLD
}

/**
 * Every deny-list reason `value` matches, in rule order: the named credential
 * shapes, then `email-address`, then `high-entropy` (skipped with `isEngineId`,
 * for ids that already passed a shape check). Empty when clean.
 */
export const findCredentials = (value: string, options: { isEngineId?: boolean } = {}): string[] => {
  const scanned = String(value ?? '').slice(0, SCAN_LIMIT)
  if (scanned === '') return []
  const reasons: string[] = []
  for (const [reason, re] of CREDENTIAL_PATTERNS) if (re.test(scanned)) reasons.push(reason)
  if (findEmails(scanned).length > 0) reasons.push('email-address')
  if (!options.isEngineId) {
    for (const m of scanned.matchAll(TOKEN_RE)) {
      if (looksLikeOpaqueSecret(m[0])) {
        reasons.push('high-entropy')
        break
      }
    }
  }
  return reasons
}

/** The first reason `value` is refused, or null when it is clean. */
export const leakScan = (value: string): string | null => findCredentials(value)[0] ?? null

export const isRedacted = (value: string): boolean => /^\[redacted:[a-z-]+\]$/.test(value)

/**
 * rd-tracker's `field()` rule at the storage boundary: the uncapped value is
 * scanned first; a hit becomes `[redacted:<kind>]` (never the raw value, never a
 * partial); a clean value becomes one line of at most `cap` code points. An
 * empty result is null. `redacted` says whether the scan fired.
 */
export const cleanField = (value: string | null | undefined, cap: number, options: { isEngineId?: boolean } = {}): { value: string | null; redacted: boolean } => {
  if (value === null || value === undefined) return { value: null, redacted: false }
  // Normalize and drop invisible characters FIRST (verifier V2): a zero-width space or a soft
  // hyphen inside an address or a token would otherwise hide it from the scan and be
  // rejoined by oneLine afterwards. The scan then sees exactly what would be stored.
  const joined = oneLine(String(value), Number.MAX_SAFE_INTEGER)
  // Scanned twice: as stored, and with every space removed, so a no-break space or a plain
  // space pushed into an address or a token (verifier V13) cannot split it past the rules.
  const reason = findCredentials(joined, options)[0] ?? findCredentials(joined.replace(/\s+/g, ''), options)[0]
  if (reason !== undefined) return { value: `[redacted:${reason}]`, redacted: true }
  const line = [...joined].slice(0, cap).join('').trim()
  return { value: line === '' ? null : line, redacted: false }
}

/** The leak scan over text as it would be stored (normalized, invisible characters dropped): the form every scan of raw data must use. */
export const scanJoined = (value: string, options: { isEngineId?: boolean } = {}): string | null => {
  const joined = oneLine(String(value), Number.MAX_SAFE_INTEGER)
  return findCredentials(joined, options)[0] ?? findCredentials(joined.replace(/\s+/g, ''), options)[0] ?? null
}

/**
 * FNV-1a over the UTF-8 bytes, 64-bit, as 8 hex characters: a stable short
 * fingerprint for a subagent id (`agentKey`). Not a security hash; sha256 in
 * hash.ts is used for everything that must match another tool.
 */
export const sha8 = (text: string): string => {
  let h = 0xcbf29ce484222325n
  const bytes = new TextEncoder().encode(text)
  for (const b of bytes) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0').slice(0, 8)
}

/** `$12.50` style; a non-finite or null number reads `--`. */
export const money = (usd: number | null): string => (usd === null || !Number.isFinite(usd) ? '--' : `$${usd.toFixed(2)}`)

/** Seconds as `H.HH h`. */
export const hoursText = (seconds: number): string => `${(seconds / 3600).toFixed(2)} h`

/** `1234567` → `1.2M`, `12345` → `12.3k`. */
export const compactInt = (n: number): string => {
  if (!Number.isFinite(n)) return '--'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** A null-prototype copy of a plain object, so `__proto__` and `constructor` are ordinary keys (CYB-8). */
export const bareObject = <T>(source: Record<string, T> | null | undefined): Record<string, T> => {
  const out: Record<string, T> = Object.create(null) as Record<string, T>
  if (source && typeof source === 'object') for (const key of Object.keys(source)) out[key] = source[key] as T
  return out
}

export const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)
