// /handoff's pure half: the prompt the fork answers, the note's cleaning and
// redaction, and where the note lands. register.ts does the calls
// ($.model.fork, $.fs.write, /clear, the prompt fill); everything here is
// testable without an engine. Moved unchanged from mem-gauge 0.2.1, so the
// note's format and path are the same as before.

/**
 * What the one model call is asked: a note a fresh session can start from
 * with none of this conversation. The fork answers over this session's own
 * transcript (served from its prompt cache) with every tool denied, so it can
 * only write text; the rules keep credentials and transcript quotes out of a
 * file that outlives the session.
 */
export const HANDOFF_PROMPT = [
  'Write a handoff note for a fresh Claude Code session that has none of this conversation.',
  'It continues this work from the note alone, so make it complete and exact.',
  '',
  'Plain language, at most 700 words, Markdown with exactly these sections, in this order:',
  '## Goal',
  '## Where things stand (what is done, verified, committed, shipped: files, commits, branches, PRs, versions)',
  '## Decisions and why',
  '## Next steps (in order, exact enough to act on: paths, commands, who owns each)',
  '## Waiting on / open questions',
  '## Gotchas (what failed and why, what not to retry)',
  '',
  'Rules:',
  '- Never include credentials, tokens, keys, passwords, account numbers or personal data. Name where a secret lives instead (for example "the key in the keychain"), never its value.',
  '- No quotes from the transcript, only its substance.',
  '- Output the note alone: no preamble, no closing remarks.',
].join('\n')

/** The note on disk is cut here (code points), so a runaway reply cannot fill the disk. */
export const NOTE_MAX = 20_000
export const CUT_MARKER = '… (cut)'

/**
 * The model's note as text safe to keep in a file a person opens in a
 * terminal or an editor: line structure kept (`\n`, `\t`), everything that
 * could repaint the screen or hide text removed. ANSI escape sequences go
 * whole (not just their ESC, which would leave `[31m` behind), the remaining
 * C0/C1 controls go, CRLF and lone CR become line ends, line and paragraph
 * separators become `\n`, and format characters (bidi overrides, zero-width,
 * Unicode tags), lone surrogates and private-use code points are dropped, the
 * same classes register.ts `oneLine` drops from one-line text.
 */
export function cleanNote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    // CSI (ESC [ ... final) and its 8-bit form, then OSC (ESC ] ... BEL or ST), then any other ESC pair.
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, '')
    .replace(/\u001b[@-_]?/g, '')
    .split('\n')
    .map(line => line.replace(/[\p{Cc}]/gu, ch => (ch === '\t' ? ch : '')).replace(/[\p{Cf}\p{Cs}\p{Co}]/gu, '').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Cuts `text` to `max` code points, marking the cut on its own line. */
export function capNote(text: string, max = NOTE_MAX): string {
  const points = [...text]
  return points.length <= max ? text : `${points.slice(0, max).join('').trimEnd()}\n${CUT_MARKER}`
}

const REDACTED = '[redacted]'

/**
 * Secret shapes, each replaced by `[redacted]`: a whole match for a shape that
 * is the secret itself (an API key, an access key id, a private key block),
 * the value alone where a label says what it is (`Bearer …`, `token: …`), so
 * the note still reads. Order matters: the multi-line key block and the
 * longer `sk-ant-` shape go before their shorter kin.
 */
const SECRET_SHAPES: readonly { pattern: RegExp; replace: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: REDACTED },
  // A key block the model cut short still goes, to the end of the text.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, replace: REDACTED },
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { pattern: /sk-[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { pattern: /sk_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /AKIA[0-9A-Z]{16}/g, replace: REDACTED },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  // A JSON web token: three base64url parts, the first a header starting `{"`.
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: REDACTED },
  // The password of a URL's user:password@host.
  { pattern: /(:\/\/[^\s/:@]+:)[^\s@/]+(@)/g, replace: `$1${REDACTED}$2` },
  { pattern: /(bearer|authorization:)(\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1$2${REDACTED}` },
  // A labelled value, the label quoted or not (`token: …`, `"api_key": "…"`), only when the value
  // looks like a credential: no spaces, 8+ characters, letters and digits both. A value with no
  // digit reads as prose ("Secret: lives-in-the-keychain") and stays.
  {
    pattern: /(api[_-]?key|secret|token|password)(["']?\s*[:=]\s*["']?)(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: `$1$2${REDACTED}`,
  },
]

/**
 * The note with every secret shape above replaced by `[redacted]`. A last
 * line of defence under the prompt's own rule against credentials: a model
 * that quotes an env file or a curl line anyway leaves no usable key on disk.
 * Pure and idempotent; a short value after a label ("token: abc"), or one with
 * no digit in it, is left, so ordinary prose about tokens is not mangled. A
 * fixed list: a shape not on it relies on the prompt's own rule.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const { pattern, replace } of SECRET_SHAPES) out = out.replace(pattern, replace)
  return out
}

/** The repo part of a "repo · branch" label as a file-name piece: [A-Za-z0-9._-], at most 40, never dot-led; else `session`. */
export function repoKey(label: string): string {
  const repo = label.split(' · ')[0] ?? ''
  const key = repo
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 40)
    .replace(/[-.]+$/, '')
  return key || 'session'
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/**
 * `<home>/.claude/handoffs/<yyyy-mm-dd-HHmmss>-<repoKey>-<id8>.md`, the time in
 * UTC to the second (the same clock as the header's ISO stamp, the same name on
 * any machine, and a second hand-off a moment later never overwrites the first).
 * `home` is the checked HOME (register.ts `applyHome`); the id is the engine's
 * session id, cut to its first 8 safe characters.
 */
export function handoffPath(home: string, label: string, sessionId: string, now: number): string {
  const d = new Date(now)
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  const id = sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8) || 'session'
  return `${home}/.claude/handoffs/${stamp}-${repoKey(label)}-${id}.md`
}

/**
 * The file's whole text: the mod's own header (label, time, the old session's
 * id and how to resume it), a blank line, then the note cleaned, redacted and
 * capped. Redaction runs before the cap so a key straddling the cut cannot
 * leave a usable prefix; the cap only removes text, so nothing it leaves can
 * form a new match. Empty when the note has no text once cleaned.
 */
export function handoffFile(note: string, label: string, sessionId: string, now: number): string {
  const body = capNote(redactSecrets(cleanNote(note)))
  if (body === '') return ''
  const header = [
    `# Handoff — ${label} — ${new Date(now).toISOString()}`,
    `From session ${sessionId}; the old conversation stays resumable: claude --resume ${sessionId}`,
  ]
  return `${header.join('\n')}\n\n${body}\n`
}
