// Pure helpers for stall-watch: classification and text formatting. Kept free
// of `$` so the decisions that gate an auto-submit can be tested directly.

import type { StallWatchWindow } from '../types'

/** Error kinds that may clear on their own (ModelApiError's own doc says so). */
export const TRANSIENT_KINDS: readonly string[] = ['rate_limit', 'overloaded', 'server_error', 'unknown']

/** Seconds to wait before auto-retry 1, 2 and 3. */
export const BACKOFF_SECONDS: readonly number[] = [30, 120, 480]

export const MAX_ATTEMPTS = 3

/**
 * The prompt origins that are the person's own words: their Enter at the
 * terminal (`composer`), the Remote Control bridge, and the SDK, through which
 * the desktop app hosts its sessions. Only these reset the runaway cap,
 * supersede what is armed, mark a running turn as typed over, are excerpted
 * for the note, or turn resume on. Every other kind (a peer, a task
 * notification, a schedule, another plugin, unclassified) is not the person.
 */
export const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

export function isPerson(kind: string | undefined): boolean {
  return kind !== undefined && PERSON_ORIGINS.includes(kind)
}

/**
 * The longest single wait handed to $.clock.after. A spend-limit reset can be
 * weeks away, past what a 32-bit timer holds (about 24.8 days), and a wait the
 * host cannot hold may fire at once; a longer one is waited out in steps.
 */
export const MAX_WAIT_MS = 24 * 3_600_000

/** The next timer step toward `dueAt`: never negative, never past MAX_WAIT_MS. */
export function waitMs(dueAt: number, now: number): number {
  return Math.min(Math.max(0, dueAt - now), MAX_WAIT_MS)
}

/** A StopFailure older than this is not paired with a turn.complete. */
export const PAIR_WINDOW_MS = 30_000

/** Status line shows windows at or above this percentage. */
export const STATUS_THRESHOLD = 85

/** The resume note is written once a window reaches this percentage. */
export const NOTE_THRESHOLD = 90

/**
 * A window at least this full counts as exhausted for a rate_limit failure: a
 * retry before its reset cannot succeed, so rate_limit there means "wait for
 * the reset", not "back off". Readings lag and round to one decimal, so a
 * window that refuses requests often reads 95-99.9 %, not 100.
 */
export const EXHAUSTED_THRESHOLD = 95

/** A window this full is certainly refusing requests. */
export const FULL_THRESHOLD = 100

/**
 * The engine reports a context overflow as a plain API error; its details
 * carry the API's own wording. Matched only to refuse a retry, never shown.
 */
const CONTEXT_OVERFLOW = /prompt is too long|context (window|length|limit)|too many tokens|maximum context/i

export function isContextOverflow(details: string | undefined): boolean {
  return typeof details === 'string' && CONTEXT_OVERFLOW.test(details)
}

/** Whether a recorded failure is one an auto-retry may answer. */
export function isRetryable(kind: string, contextOverflow: boolean): boolean {
  return !contextOverflow && TRANSIENT_KINDS.includes(kind)
}

export function backoffSeconds(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1
  return BACKOFF_SECONDS[index] ?? 480
}

/** Parses `date +%z` output (`-0700`, `+0530`) into minutes east of UTC. */
export function parseOffset(text: string): number | null {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(text.trim())
  if (!match) return null
  const minutes = Number(match[2]) * 60 + Number(match[3])
  if (minutes > 14 * 60) return null
  return match[1] === '-' ? -minutes : minutes
}

/** Epoch ms of an ISO timestamp, or null for anything that does not parse. */
export function parseTime(iso: string | undefined): number | null {
  if (typeof iso !== 'string' || iso === '') return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function kindLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'weekly'
  if (kind === 'spend_limit') return 'spend'
  // Unknown windows are shown by their own name rather than hidden.
  return kind.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'limit'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Wall-clock time in the person's zone, from a fixed UTC offset (the hooks
 * environment has no reliable local zone of its own): `11:00pm`, or
 * `Tue 11:00pm` when the moment is more than 20 hours from now.
 */
export function clockText(ms: number, nowMs: number, offsetMin: number): string {
  const local = new Date(ms + offsetMin * 60_000)
  const hours24 = local.getUTCHours()
  const minutes = String(local.getUTCMinutes()).padStart(2, '0')
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  const time = `${hours12}:${minutes}${hours24 < 12 ? 'am' : 'pm'}`
  return Math.abs(ms - nowMs) > 20 * 3_600_000 ? `${DAYS[local.getUTCDay()]} ${time}` : time
}

/** `in 2h 13m`, `in 45m`, `in <1m`. */
export function relativeText(ms: number, nowMs: number): string {
  const totalMin = Math.floor((ms - nowMs) / 60_000)
  if (totalMin < 1) return 'in <1m'
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  if (days > 0) return `in ${days}d ${hours}h`
  return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`
}

/** Keeps only well-formed readings, so nothing downstream ever sees NaN. */
export function cleanWindows(raw: readonly unknown[] | undefined): StallWatchWindow[] {
  if (!Array.isArray(raw)) return []
  const out: StallWatchWindow[] = []
  for (const one of raw) {
    if (typeof one !== 'object' || one === null) continue
    const { kind, percentUsed, resetsAt } = one as Record<string, unknown>
    if (typeof kind !== 'string' || typeof percentUsed !== 'number' || !Number.isFinite(percentUsed)) continue
    out.push(
      typeof resetsAt === 'string' && parseTime(resetsAt) !== null
        ? { kind, percentUsed, resetsAt }
        : { kind, percentUsed },
    )
  }
  return out
}

/** The one-window text: `weekly 92% · resets 11:00pm (in 2h 13m)`. */
export function windowText(w: StallWatchWindow, nowMs: number, offsetMin: number | null): string {
  const head = `${kindLabel(w.kind)} ${Math.floor(w.percentUsed)}%`
  const resetMs = parseTime(w.resetsAt)
  if (resetMs === null) return head
  const relative = relativeText(resetMs, nowMs)
  return offsetMin === null
    ? `${head} · resets ${relative}`
    : `${head} · resets ${clockText(resetMs, nowMs, offsetMin)} (${relative})`
}

/**
 * The status line for every window at or above the threshold, fullest first,
 * or undefined when none is (or a window's reset has already passed, which
 * makes its reading stale).
 */
export function statusText(
  windows: readonly StallWatchWindow[],
  nowMs: number,
  offsetMin: number | null,
  threshold: number = STATUS_THRESHOLD,
): string | undefined {
  const shown = windows
    .filter(w => w.percentUsed >= threshold)
    .filter(w => {
      const resetMs = parseTime(w.resetsAt)
      return resetMs === null || resetMs > nowMs
    })
    .sort((a, b) => b.percentUsed - a.percentUsed)
  if (shown.length === 0) return undefined
  return shown.map(w => windowText(w, nowMs, offsetMin)).join('  |  ')
}

/**
 * The window a rate_limit failure is waiting on, among the exhausted windows
 * whose reset is still ahead. A full window wins, the one that resets last
 * among several (work cannot continue until every full window has reset), so
 * a nearly-full window with a days-away reset never outranks the full one the
 * 429 is about. With none full, the fullest (on a tie, the sooner reset).
 * Undefined when no exhausted window has a reset ahead (none is that full, the
 * reset is unknown, or the reading is stale), which leaves the failure to the
 * ordinary backoff retry.
 */
export function exhaustedWindow(windows: readonly StallWatchWindow[], nowMs: number): StallWatchWindow | undefined {
  const ahead = windows
    .filter(w => w.percentUsed >= EXHAUSTED_THRESHOLD)
    .map(w => ({ w, ms: parseTime(w.resetsAt) }))
    .filter((x): x is { w: StallWatchWindow; ms: number } => x.ms !== null && x.ms > nowMs)
  const full = ahead.filter(x => x.w.percentUsed >= FULL_THRESHOLD).sort((a, b) => b.ms - a.ms)[0]
  if (full !== undefined) return full.w
  return ahead.sort((a, b) => b.w.percentUsed - a.w.percentUsed || a.ms - b.ms)[0]?.w
}

/**
 * Words that mark what follows a name as a secret, wherever they sit inside
 * it. `pass` and `key` count only as a whole part of a name (DB_PASS, SMTP_PASS,
 * "pass", ENCRYPTION_KEY, JWT_SIGNING_KEY), so `bypass`, `passenger` and
 * `monkey` are not names of secrets.
 */
const SECRET_WORDS = String.raw`password|passwd|passphrase|pwd|secret|token|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|credentials?|(?<![a-z])pass(?![a-z])|(?<=[_.-])key(?![a-z0-9])`

/** A name holding a secret word; it starts at a token boundary (`\b` sits after `_`, so it is not used). */
const SECRET_NAME = String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?(?:${SECRET_WORDS})[A-Za-z0-9_.-]{0,64})`

/** A secret value: a quoted string (to its closing quote) or the next run of non-space. */
const SECRET_VALUE = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\S+`

/**
 * `name=value`, `name: value`, `"name": "value"`, `name := value`, `name => value`
 * whose name holds a secret word anywhere: DB_PASSWORD, SHOPIFY_API_SECRET,
 * KLAVIYO_TOKEN, DB_PASS, ENCRYPTION_KEY, dbPassword, aws_secret_access_key,
 * X-Api-Key. Every part is bounded, so a long pasted blob costs linear time.
 */
const SECRET_ASSIGNMENT = new RegExp(String.raw`${SECRET_NAME}(["']?)(\s*(?::=|=>|[:=])\s*)(${SECRET_VALUE})`, 'gi')

/** A command-line flag naming a secret, its value after a space: `--password hunter2`, `--db-pass x`. */
const SECRET_FLAG = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(--?[A-Za-z0-9-]{0,32}?(?:password|passwd|passphrase|secret|token|api-?key|(?<![a-z])pass(?![a-z]))[A-Za-z0-9-]{0,32})(\s+)(?!-)(${SECRET_VALUE})`,
  'gi',
)

/** Prose: `my password is hunter2`, `the token is: abc`, `DB_PASSWORD is x`. */
const SECRET_PROSE = new RegExp(String.raw`${SECRET_NAME}(\s+is\b:?\s*)(${SECRET_VALUE})`, 'gi')

/**
 * Prose with no `is`: `login with password hunter2`. Only a value holding a
 * digit, a symbol or quotes, so `the password reset page` reads as written.
 */
const SECRET_NEXT_WORD = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?(?:password|passwd|passphrase)[A-Za-z0-9_.-]{0,64})(\s+)(?!is\b)(?![=:[])(?=["']|\S*[^A-Za-z\s])(${SECRET_VALUE})`,
  'gi',
)

/** mysql's attached password flag: `mysql -uroot -phunter2`. */
const MYSQL_PASSWORD = /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,200}?\s-p)(?=\S)(\S+)/gi

/**
 * URL userinfo: `postgres://admin:S3cret@db`, `redis://:pw@cache` keep the user
 * and drop the password, up to the last `@` before a space (a password may
 * hold `/` or `@`).
 */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)([^\s:@/]{0,128}):(\S{1,256})@/g

/**
 * A credential pasted with no name in front of it: a run of 20 or more token
 * characters (base64, hex, URL-safe) that mixes letters and digits, or 32 or
 * more that mixes upper and lower case. That is an AWS secret access key (40
 * base64 characters), a hex API key, a session token. Words are letters only
 * and a path rarely mixes in digits, so prose and most file names pass; a
 * commit hash or a UUID does not, which a resume note can live with.
 */
const BARE_SECRET = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{20,}(?![A-Za-z0-9+/=_-])/g

function isSecretLike(run: string): boolean {
  const hasLetter = /[A-Za-z]/.test(run)
  return (hasLetter && /\d/.test(run)) || (run.length >= 32 && /[a-z]/.test(run) && /[A-Z]/.test(run))
}

/** A quoted value keeps its quotes, so JSON stays readable: `"password": "[redacted]"`. */
function masked(value: string): string {
  const quote = value[0]
  return (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)
    ? `${quote}[redacted]${quote}`
    : '[redacted]'
}

/**
 * Scrub of credential-shaped substrings before any prompt text is held or
 * written to the resume note on disk. Three layers: the common vendor token
 * shapes (and auth headers, cookies, webhook URLs, PEM keys, URL passwords);
 * any value after a name holding a secret word (`name=value`, `name: value`,
 * `"name": "value"`, `--name value`, `name is value`, `password value`),
 * env-var and camelCase names included; and last, any bare run that looks
 * random (BARE_SECRET), which catches a secret pasted with no name at all,
 * an AWS secret access key on its own included. It runs last, so the names
 * the earlier layers keep are not swallowed with their values.
 */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bshp(at|ca|pa|ss)_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9+/=]{16,}/g, '[redacted]')
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/\b(hooks\.slack\.com\/(?:services|workflows|triggers)\/|discord(?:app)?\.com\/api\/webhooks\/)\S+/gi, '$1[redacted]')
    .replace(URL_PASSWORD, '$1$2:[redacted]@')
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]')
    .replace(/\b((?:Set-)?Cookie)(\s*:\s*)[^\n]+/gi, '$1$2[redacted]')
    .replace(MYSQL_PASSWORD, '$1[redacted]')
    .replace(SECRET_ASSIGNMENT, (_m, name: string, quote: string, sep: string, value: string) => `${name}${quote}${sep}${masked(value)}`)
    .replace(SECRET_FLAG, (_m, flag: string, gap: string, value: string) => `${flag}${gap}${masked(value)}`)
    .replace(SECRET_PROSE, (_m, name: string, sep: string, value: string) => `${name}${sep}${masked(value)}`)
    .replace(SECRET_NEXT_WORD, (_m, name: string, gap: string, value: string) => `${name}${gap}${masked(value)}`)
    .replace(BARE_SECRET, run => (isSecretLike(run) ? '[redacted]' : run))
}

/** How much of the person's last prompt the resume note keeps. */
export const NOTE_PROMPT_CHARS = 80

/**
 * Redaction reads this much of a prompt. A secret that starts past it could
 * only reach the excerpt if the excerpt were this long, which it never is.
 */
const REDACT_SCAN_CHARS = 16_000

/**
 * The only form in which prompt text is kept or written (data minimisation):
 * redacted first, on the whole head of the prompt so a secret is never cut in
 * half before it is recognised, then cut to NOTE_PROMPT_CHARS on one line.
 */
export function promptExcerpt(text: string): string {
  const clean = redact(text.slice(0, REDACT_SCAN_CHARS)).replace(/\s+/g, ' ').trim()
  return clean.length > NOTE_PROMPT_CHARS || text.length > REDACT_SCAN_CHARS
    ? `${clean.slice(0, NOTE_PROMPT_CHARS).trimEnd()}...`
    : clean
}

/** A session id safe to use as a file name (no separators, no `..`). */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..')
}
