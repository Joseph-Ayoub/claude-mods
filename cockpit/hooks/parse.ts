// Pure, deterministic text work for the cockpit band: no `$`, no model calls.
// Kept apart from register.tsx so the tests can hold every parser to its
// positive and false-positive cases without mounting anything.

import type { CockpitBackground, CockpitCi, CockpitContext, CockpitOption, CockpitPr, CockpitQuestion, CockpitStanding, CockpitWaiting } from '../types'

export const MAX_QUESTIONS = 6
export const MAX_OPTIONS = 8
export const MAX_WAITING = 8
export const MAX_RULE_CHARS = 300
export const MAX_RULE_PROMPT_CHARS = 2000
export const STALE_MS = 3 * 60_000

/**
 * Blanks every fenced code block (``` or ~~~, closed by the same fence or
 * longer) so option-looking lines and markers inside code never parse, while
 * the line count stays the same.
 */
export function stripFences(text: string): string {
  const out: string[] = []
  let fence: { char: string; length: number } | null = null

  for (const line of text.split(/\r?\n/)) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]

    if (fence === null) {
      if (mark !== undefined) {
        fence = { char: mark[0] ?? '`', length: mark.length }
        out.push('')
        continue
      }

      out.push(line)
      continue
    }

    if (mark !== undefined && mark[0] === fence.char && mark.length >= fence.length) {
      fence = null
    }

    out.push('')
  }

  return out.join('\n')
}

/**
 * Collapses a prompt to the form two sends of "the same thing" share: trimmed,
 * lowercased, whitespace collapsed, trailing punctuation dropped. Exact match
 * on this, never fuzzy: "go" and "go ahead but skip tests" stay different.
 */
export function normalizePrompt(text: string): string {
  return dropTrailing(text.trim().toLowerCase().replace(/\s+/g, ' '), ' .!?,;:')
}

/**
 * The text without its trailing run of `chars`, in one pass from the end. A
 * `[...]+$` regex rescans a long inner run of those characters once per start
 * position, which is quadratic, and these run inside prompt and turn hooks.
 */
export function dropTrailing(text: string, chars: string): string {
  let end = text.length

  while (end > 0 && chars.includes(text[end - 1] ?? '')) {
    end -= 1
  }

  return text.slice(0, end)
}

/** SHA-256 of a string as lowercase hex, so recent prompts are compared without keeping their text. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const SECRET_PREFIX =
  /(?:\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_|\bshpat_|\bAKIA[0-9A-Z]{16}|\bAIza[0-9A-Za-z_-]{20,}|\bxox[abprs]-|-----BEGIN [A-Z ]*PRIVATE KEY)/

/**
 * True when a text carries anything shaped like a credential: a known token
 * prefix, a private-key header, or any unbroken 32+ character token-ish run
 * (which also catches commit SHAs; erring that way only costs a preview).
 * Used to keep such text out of drop reasons and out of captured rules.
 */
export function looksSecret(text: string): boolean {
  return SECRET_PREFIX.test(text) || /[A-Za-z0-9_\-+/=]{32,}/.test(text)
}

/** A short quote of a prompt for a drop reason, or a neutral phrase when quoting it could leak something. */
export function promptPreview(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ')

  return flat.length <= 60 && !looksSecret(flat) ? `"${flat}"` : 'your earlier prompt'
}

// Decision cards ------------------------------------------------------------

/** Drops quote marks, a heading's hashes, a bullet and bold/underline markers: what is left is matched. */
const cleanLine = (line: string): string =>
  line
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+)?(?:[-*+•]\s+)?/, '')
    .trim()

const SEP = String.raw`(?:\s*[:.)\-–—]\s*|\s+|$)`
const Q_HEADER = new RegExp(String.raw`^(?:Q|Question\s*)(\d{1,2})${SEP}(.*)$`, 'i')
const DECISION_HEADER = new RegExp(String.raw`^Decision\s+(\d{1,2})${SEP}(.*)$`, 'i')
const NUMBERED_HEADER = /^(\d{1,2})[.)]\s+(.*)$/
const OPTION_LINE = /^(?:\(([a-h])\)|([a-h])\)|([a-h])\.(?=\s)|Option\s+([a-h])\b(?:\s*[:.)\-–—])?)\s*(.*)$/i
const INLINE_OPTION = /(?:^|[\s,;])\(?([a-h])\)\s+/gi
const RECOMMEND_WORD = /\brecommend(?:s|ed|ation)?\b/i
const RECOMMEND_EVERY = /\brecommend(?:s|ed|ation)?\b/gi
// The whole of a bracket that marks its option: an allowlist, so "(recommended against)", "(least
// recommended)" or "(risky; the recommended one is b)" never mark the option they sit on.
const MARK_ALONE = /^(?:(?:strongly|highly)\s+)?recommended$|^(?:my\s+|the\s+)?recommendation$/i
// The only prose that names a recommended option: a line that opens with "Recommended:" (or
// "Recommendation:") and holds nothing else but a bare option list. "I recommend option B",
// "Recommended against: a", "Recommended: not Q1 a" and "Recommended: (a) is NOT recommended"
// name none: any word beside the options, negation or not, voids the whole line.
const RECOMMEND_LINE = /^(?:my\s+)?recommend(?:ed|ation)\s*[:\-–—]\s*(.*)$/i
// The whole rest of a "Recommended:" line for one question: "b", "(b)", "b)", "option B".
const RECOMMEND_LETTER = /^(?:option\s+([a-h])|\(([a-h])\)|([a-h])\)?)$/i
const QUESTION_PAIR = String.raw`Q(\d{1,2})\s*[:=\-]?\s*\(?([a-h])\)?`
// The whole rest of a "Recommended:" line for several questions: "Q1 a, Q2 c", "Q1: (a); Q2: c".
const RECOMMEND_PAIRS = new RegExp(String.raw`^${QUESTION_PAIR}(?:\s*(?:[,;&]|and)\s*${QUESTION_PAIR})*$`, 'i')
const RECOMMEND_PER_QUESTION = new RegExp(QUESTION_PAIR, 'gi')
// Words that turn a label's leading or closing mark around ("Recommended: no, too risky", "avoid,
// recommended"); a label carrying any of them is not marked by those forms. A wrong miss only leaves
// the picker unset; a wrong hit presets the option argued against.
const NEGATION_CUE =
  /\b(?:not|no|never|none|nor|neither|nothing|avoid\w*|against|without|except|but|instead|rather|least|less|hardly|rarely|barely|seldom|reject\w*|discourag\w*|risky|unsafe|dangerous|wrong|bad|worse|worst|nope|nah|cannot|non|dont|wont|cant|isnt|arent|wasnt|wouldnt|shouldnt|couldnt|doesnt|didnt)\b|n['’]t\b/i

// A word that, straight before a whole bracket mark, turns it around: "Big bang, not (recommended)".
// "No" is left out, since "b) No (recommended)" is an option named No.
const NEGATED_TAIL = /(?:\b(?:not|never|hardly|rarely|barely|seldom|least|less)|n['’]t)[\s,:\-–—]*$/i

/**
 * The rest of a line that opens with "Recommended:", whole, with its closing
 * punctuation dropped; null for any other line. Callers accept it only when
 * all of it is a bare option list, so nothing said beside an option (a
 * negation, a second option, a reason) can ever be read past.
 */
function recommendLine(line: string): string | null {
  const match = RECOMMEND_LINE.exec(cleanLine(line))

  return match === null ? null : (match[1] ?? '').replace(/[\s.!]+$/, '').trim()
}

/**
 * Whether an option's own label marks it as the recommended one, by an
 * allowlist of whole marks: a bracket holding nothing but the mark
 * ("(recommended)", "[strongly recommended]", "(my recommendation)") and not
 * led by a negation ("not (recommended)"), the label opening with
 * "Recommended:" or closing with "— recommended". The opening and closing
 * forms count only when nothing else in the label is a negation cue
 * (NEGATION_CUE), so "Recommended: no, too risky" or "avoid, recommended"
 * never mark it. Anything else that merely contains the word ("Use the
 * recommended defaults", "(recommended against)", "(least recommended)",
 * "NOT RECOMMENDED") never marks it.
 */
export function labelMarksRecommended(label: string): boolean {
  for (const match of label.matchAll(RECOMMEND_EVERY)) {
    const at = match.index ?? 0
    const before = label.slice(0, at)
    const after = label.slice(at + match[0].length)
    const open = Math.max(before.lastIndexOf('('), before.lastIndexOf('['))
    const closeAt = after.search(/[)\]]/)
    const isInBracket = open !== -1 && !/[)\]]/.test(before.slice(open)) && closeAt !== -1 && !/[([]/.test(after.slice(0, closeAt))
    const bracketText = isInBracket ? `${before.slice(open + 1)}${match[0]}${after.slice(0, closeAt)}`.trim().replace(/[.!]+$/, '') : ''
    // The bracket is whole; only the words straight before it could turn it around ("Big bang, not (recommended)").
    const isBracketed = isInBracket && MARK_ALONE.test(bracketText) && !NEGATED_TAIL.test(before.slice(0, open))
    const isMarkWord = /^recommended$/i.test(match[0])
    const isLeading = isMarkWord && before.trim() === '' && /^\s*(?:$|[:\-–—]\s)/.test(after) && !NEGATION_CUE.test(after)
    // A hyphen glued to a word ("not-recommended") is part of that word, never a separator.
    const isTrailing =
      isMarkWord &&
      /(?:\s[-–—]|[–—:,←*|])\s*(?:(?:strongly|highly)\s+)?$/.test(before) &&
      /^[\s.!)\]*]*$/.test(after) &&
      !NEGATION_CUE.test(before)

    if (isBracketed || isLeading || isTrailing) {
      return true
    }
  }

  return false
}

type HeaderKind = 'labelled' | 'numbered' | 'bare'
type Header = { number: number | null; text: string; kind: HeaderKind }

function headerOf(line: string): Header | null {
  const labelled = Q_HEADER.exec(line) ?? DECISION_HEADER.exec(line)
  const match = labelled ?? NUMBERED_HEADER.exec(line)

  return match === null ? null : { number: Number(match[1]), text: (match[2] ?? '').trim(), kind: labelled !== null ? 'labelled' : 'numbered' }
}

type ParsedOption = { option: CockpitOption; isMarked: boolean }

function optionOf(line: string): ParsedOption | null {
  const match = OPTION_LINE.exec(line)

  if (match === null) {
    return null
  }

  const letter = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').toLowerCase()
  const full = (match[5] ?? '').trim()
  const label = full || `Option ${letter.toUpperCase()}`

  // The mark is read from the whole label: a long one is cut to 80 characters for the drawing.
  return letter === '' ? null : { option: { value: letter, label: label.slice(0, 80) }, isMarked: labelMarksRecommended(full) }
}

/**
 * Every option letter an explicit "Recommended: b" line in the text names, so
 * a caller can tell one clear recommendation from a conflict. Prose ("I would
 * recommend option B", "I would not recommend option A") never names one.
 */
function recommendedLettersIn(text: string): Set<string> {
  const letters = new Set<string>()

  for (const line of text.split('\n')) {
    const rest = recommendLine(line)
    const match = rest === null ? null : RECOMMEND_LETTER.exec(rest)
    const letter = match?.slice(1).find(group => group !== undefined)

    if (letter !== undefined) {
      letters.add(letter.toLowerCase())
    }
  }

  return letters
}

// What may follow a question's "?" and still leave it asking: nothing, or a cue to choose.
const CHOICE_CUE = /^(?:\(?(?:pick|choose|select)\b[^)]*\)?|options?|choices?|either|one of)[\s:.)]*$/i
// An unlabelled question that explains rather than asks: "Why ...?", "How did CI fail?", "What caused it?".
const EXPLAINS = /^(?:why|how come|how (?:did|does|do|was|were|is|are|has|had)|what (?:caused|happened|went wrong|broke|failed|changed))\b/i
// A yes/no question about a fact ("Did the parser regress?"): it asks only when it offers a choice.
const FACT_QUESTION = /^(?:did|does|was|were|has|had|have|is|are)\b/i
const CHOICE_WORD = /\b(?:which|or|should|shall|prefer|rather|want|would you|ok(?:ay)? to)\b/i
const YES_NO = /^(?:yes|no|y|n)\b/i

/**
 * Whether a header or prose line puts a question to the reader: a "?" that
 * ends it or is followed only by a cue to choose. A question the line answers
 * itself ("Did it regress? No.", "Why did CI fail? Two reasons:") is prose. An
 * unlabelled one is prose too when it explains ("Why ...?", "How did CI
 * fail?") or asks about a fact its own option lines answer ("Did the parser
 * regress?" over "a) unit tests pass"): a fact question asks only with a
 * choice word in it or a yes/no among its options.
 */
function asksReader(line: string, kind: HeaderKind | 'prose', options: readonly CockpitOption[]): boolean {
  const at = line.lastIndexOf('?')

  if (at === -1 || !(line.slice(at + 1).trim() === '' || CHOICE_CUE.test(line.slice(at + 1).trim()))) {
    return false
  }

  if (kind === 'labelled') {
    return true
  }

  if (EXPLAINS.test(line)) {
    return false
  }

  return !FACT_QUESTION.test(line) || CHOICE_WORD.test(line) || options.some(option => YES_NO.test(option.label))
}

/** Options written on the question's own line: "Which store? (a) Postgres (b) SQLite". */
function inlineOptions(text: string): { question: string; options: CockpitOption[] } | null {
  const marks = [...text.matchAll(INLINE_OPTION)]

  if (marks.length < 2 || marks[0]?.[1]?.toLowerCase() !== 'a') {
    return null
  }

  const options: CockpitOption[] = []

  marks.forEach((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length
    const end = marks[index + 1]?.index ?? text.length
    const label = text.slice(start, end).trim().replace(/[,;]$/, '').trim()

    options.push({ value: (mark[1] ?? '').toLowerCase(), label: label.slice(0, 80) || `Option ${(mark[1] ?? '').toUpperCase()}` })
  })

  return { question: text.slice(0, marks[0]?.index ?? 0).trim(), options }
}

const isUniqueLetters = (options: readonly CockpitOption[]) => new Set(options.map(option => option.value)).size === options.length

/**
 * The one recommended letter of a question, or null. An option label that
 * marks itself and a "Recommended: b" line both count; two marks that
 * disagree are no recommendation at all, so the card never defaults to a
 * guess (a negated or passing mention never counts, see labelMarksRecommended).
 */
function pickRecommended(marked: ReadonlySet<string>, named: ReadonlySet<string>, letters: ReadonlySet<string>): string | null {
  const said = new Set([...marked, ...[...named].filter(letter => letters.has(letter))])

  return said.size === 1 ? ([...said][0] ?? null) : null
}

/**
 * Finds the option questions in an answer, deterministically: a header
 * (`Q1`, `Question 2`, `Decision 3:`, `1.`, or a bare line with a `?`) followed
 * by at least two lettered options (`a)`, `(b)`, `C.`, `Option D`), or options
 * written inline on the header. A block counts only when its header or prose
 * asks the reader (see asksReader) or a "recommend" sits in it, so numbered
 * steps with lettered sub-points, self-answered status lists, explanations and
 * code are skipped. Each question carries the recommended letter when the
 * block (or a later "Recommended: Q1 a, Q2 c" line) names exactly one.
 */
export function parseDecisions(answer: string): CockpitQuestion[] {
  const lines = stripFences(answer).split('\n')
  const cleaned = lines.map(cleanLine)
  const questions: CockpitQuestion[] = []
  let index = 0

  const nextNonBlank = (from: number): number => {
    let at = from

    while (at < cleaned.length && cleaned[at] === '') {
      at += 1
    }

    return at
  }

  while (index < cleaned.length && questions.length < MAX_QUESTIONS) {
    const line = cleaned[index] ?? ''
    let header = headerOf(line)

    if (header === null && line.includes('?') && optionOf(line) === null) {
      const following = nextNonBlank(index + 1)
      const hasOptionsBelow = following < cleaned.length && following <= index + 2 && optionOf(cleaned[following] ?? '') !== null

      header = hasOptionsBelow || inlineOptions(line) !== null ? { number: null, text: line, kind: 'bare' } : null
    }

    if (header === null) {
      index += 1
      continue
    }

    let questionText = header.text
    let options: CockpitOption[] = []
    const marked = new Set<string>()
    const blockText: string[] = [line]
    // The header, its prose and a trailing recommendation: what a question or a "Recommended: b" is read from.
    const notes: string[] = []
    // The lines that may ask the reader, judged once the options are known.
    const asking: { text: string; kind: HeaderKind | 'prose' }[] = []
    let cursor = index + 1
    const inline = inlineOptions(questionText)

    if (inline !== null) {
      questionText = inline.question
      options = inline.options
      notes.push(inline.question)
      asking.push({ text: inline.question, kind: header.kind })
      inline.options.forEach(option => {
        if (labelMarksRecommended(option.label)) {
          marked.add(option.value)
        }
      })
    } else {
      notes.push(header.text)
      asking.push({ text: header.text, kind: header.kind })
      // Up to two lines of question text may sit between the header and its options.
      let prose = 0

      for (;;) {
        const at = nextNonBlank(cursor)
        const text = cleaned[at] ?? ''

        if (at >= cleaned.length || at > cursor + 1 || headerOf(text) !== null) {
          break
        }

        const parsed = optionOf(text)

        if (parsed !== null) {
          const option = parsed.option

          if (options.some(held => held.value === option.value)) {
            break
          }

          options.push(option)

          if (parsed.isMarked) {
            marked.add(option.value)
          }

          blockText.push(text)
          cursor = at + 1
          continue
        }

        if (options.length === 0 && prose < 2) {
          prose += 1
          questionText = `${questionText} ${text}`.trim()
          blockText.push(text)
          notes.push(text)
          asking.push({ text, kind: 'prose' })
          cursor = at + 1
          continue
        }

        // An indented continuation of the last option is part of it, not the end of the list.
        if (options.length > 0 && /^\s{2,}\S/.test(lines[at] ?? '') && !RECOMMEND_WORD.test(text)) {
          blockText.push(text)
          cursor = at + 1
          continue
        }

        break
      }
    }

    // A recommendation line may follow the options directly.
    const trailing = nextNonBlank(cursor)
    const trailingText = trailing <= cursor + 1 ? (cleaned[trailing] ?? '') : ''

    if (trailingText !== '' && RECOMMEND_WORD.test(trailingText) && headerOf(trailingText) === null) {
      blockText.push(trailingText)
      notes.push(trailingText)
      cursor = trailing + 1
    }

    const block = blockText.join('\n')
    // Any "recommend", even "not recommended", says a choice is on the table; only a "?" that asks counts.
    const isAsking = asking.some(line => asksReader(line.text, line.kind, options))
    const isQuestion = options.length >= 2 && isUniqueLetters(options) && (isAsking || RECOMMEND_WORD.test(block))

    if (!isQuestion) {
      index += 1
      continue
    }

    const letters = new Set(options.map(option => option.value))
    const recommended = pickRecommended(marked, recommendedLettersIn(notes.join('\n')), letters)
    const number = header.number ?? (questions.at(-1)?.number ?? 0) + 1

    if (!questions.some(held => held.number === number)) {
      questions.push({
        number,
        text: (questionText || `Question ${number}`).slice(0, 200),
        options: options.slice(0, MAX_OPTIONS),
        recommended,
        picked: null,
      })
    }

    index = Math.max(cursor, index + 1)
  }

  // A "Recommended: Q1 a, Q2 c" line anywhere fills in the questions still without one, but only a
  // line that is nothing but such pairs ("Recommendation: avoid Q1 a; go with Q1 b" names none), and
  // a question the line names twice with different letters gets none from it.
  for (const line of cleaned) {
    const rest = recommendLine(line)
    const pairs = rest !== null && RECOMMEND_PAIRS.test(rest) ? [...rest.matchAll(RECOMMEND_PER_QUESTION)] : []

    for (const match of pairs) {
      const question = questions.find(held => held.number === Number(match[1]))
      const letter = (match[2] ?? '').toLowerCase()
      const isConflicted = pairs.some(other => Number(other[1]) === Number(match[1]) && (other[2] ?? '').toLowerCase() !== letter)

      if (question !== undefined && !isConflicted && question.recommended === null && question.options.some(option => option.value === letter)) {
        question.recommended = letter
      }
    }
  }

  return questions
}

/**
 * What to do after `$.prompt.fill` with the answers: done when the box took
 * them; submit as the person only when the engine itself said there is no
 * box (`no_composer`); otherwise keep the cards. A refusal with no cause (a
 * hook's, or a failed call) is unknown, never read as "no box".
 */
export function fillOutcome(filled: { isFilled: boolean; refusal?: 'no_composer' | 'dialog' | undefined }): 'filled' | 'submit' | 'keep' {
  return filled.isFilled ? 'filled' : filled.refusal === 'no_composer' ? 'submit' : 'keep'
}

/** The reply a set of answers sends: "Q1 a, Q2 c" (ASCII by construction, cleaned anyway: it may go out as the person). */
export const answersText = (answers: readonly { number: number; value: string }[]): string =>
  personText(answers.map(answer => `Q${answer.number} ${answer.value}`).join(', '))

// Waiting on you --------------------------------------------------------------

// Characters that draw as nothing or move other text: controls, format characters (zero-width,
// bidi overrides and isolates, the U+E0000 tag block used to smuggle ASCII), private use, lone
// surrogates, line and paragraph separators, variation selectors and blank-looking letters.
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0\u2800]/gu

/**
 * The text as it will be seen: every invisible or reordering character
 * removed and whitespace runs folded to one space.
 */
export const visibleText = (text: string): string =>
  text
    // A control or line break between two words still parts them once it is gone.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()

// Typographic punctuation, spelled the plain way so what is sent is ASCII the person can read.
const PLAIN_PUNCTUATION: readonly (readonly [RegExp, string])[] = [
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u2022\u00B7]/g, '*'],
  [/\u00A0/g, ' '],
]

/**
 * Text that goes out as the person's own words (a Done item, an answer, a
 * quick-reply phrase): printable ASCII only. Invisible characters (controls,
 * Cf format characters such as zero-width, bidi overrides and the U+E0000 tag
 * block) are dropped first, accents come off their letters, typographic
 * punctuation is spelled plainly, and anything else that is not printable
 * ASCII is dropped. Claude can copy injected text into a marker line, and
 * the band draws exactly this string, so nothing sent with the person's
 * authority can hide from them or read differently on screen.
 */
export function personText(text: string): string {
  let plain = visibleText(text).normalize('NFKD').replace(/\p{M}/gu, '')

  for (const [pattern, replacement] of PLAIN_PUNCTUATION) {
    plain = plain.replace(pattern, replacement)
  }

  // The normalizing above can bring back invisibles (NFKD of a compatibility form), so clean again last.
  return visibleText(plain.replace(/[^\x20-\x7E]/g, ''))
}

// Only the marker is matched by a regex; the item is the rest of the line, cleaned in code. A lazy
// capture followed by optional trailing markers backtracks cubically over a long inner run of spaces.
const WAITING_MARK = /^\s*(?:>\s*)*(?:[-*+•]\s+)?(?:\*\*|__)?WAITING ON (?:JOSEPH|YOU)\s*:/i
export const MAX_WAITING_CHARS = 200

/** Every "WAITING ON JOSEPH:" / "WAITING ON YOU:" line of an answer (outside code), as items. */
export function parseWaiting(answer: string): CockpitWaiting[] {
  const items: CockpitWaiting[] = []

  for (const line of stripFences(answer).split('\n')) {
    const mark = WAITING_MARK.exec(line)
    const text = mark === null ? undefined : personText(line.slice(mark[0].length).replace(/\*\*|__/g, '')).slice(0, MAX_WAITING_CHARS).trim()

    if (text === undefined || text === '' || items.some(item => item.text === text)) {
      continue
    }

    items.push({ id: `w${items.length + 1}`, text })

    if (items.length >= MAX_WAITING) {
      break
    }
  }

  return items
}

// Rule capture ----------------------------------------------------------------

export const RULE_PHRASE = /\b(going forward|from now on|standing rule|add (this|that) to memory|put (this|that) in memory|remember (that|to))\b/i
const RULE_PHRASE_FIRM = /\b(?:going forward|from now on|standing rule|add (?:this|that) to memory|put (?:this|that) in memory)\b/i
const REMEMBER_PHRASE = /\bremember (?:that|to)\b/i
// "remember that/to" is a rule only as a request: at the sentence's start or after a word that makes it one.
// "Do you remember that bug?" and "I can't remember to be honest" are not.
const REMEMBER_LEAD = /^(?:(?:please|pls|also|and|but|so|just|now|then|ok|okay|always|kindly|you should|you must|you need to|make sure to)[\s,]+)*$/i
const MAX_LEAD_IN_LINES = 5

const stripBullet = (line: string): string => line.replace(/^\s*(?:[-*+•]\s+|\d{1,2}[.)]\s+)?/, '').trim()

// A question that is still a request: "Can you remember that going forward?".
const REQUEST_QUESTION = /^(?:(?:please|pls|also|and|so|ok|okay)[\s,]+)*(?:can|could|would|will) you\b/i

/**
 * Whether a sentence states a standing rule: a firm phrase anywhere, or
 * "remember that/to" asked of Claude. A question ("Is this going forward or
 * not?") states nothing unless it is a request ("Could you, from now on, ...?").
 */
function statesRule(sentence: string): boolean {
  if (sentence.endsWith('?') && !REQUEST_QUESTION.test(sentence)) {
    return false
  }

  if (RULE_PHRASE_FIRM.test(sentence)) {
    return true
  }

  const remember = REMEMBER_PHRASE.exec(sentence)

  if (remember === null) {
    return false
  }

  const lead = sentence.slice(0, remember.index)

  return lead.length <= 60 && REMEMBER_LEAD.test(lead)
}

/**
 * The one sentence of a prompt that states a standing rule, or null. Only
 * short prompts that are not slash commands are read, code is skipped, a
 * sentence over 300 characters or one that looks like it holds a credential
 * is never offered, and the sentence comes back as visibleText (nothing
 * invisible or reordering in it). A lead-in that ends with a colon ("Going forward:") takes
 * the lines under it as its rule, joined with "; ".
 */
export function findRuleSentence(text: string): string | null {
  if (text.length >= MAX_RULE_PROMPT_CHARS || text.trimStart().startsWith('/')) {
    return null
  }

  const lines = stripFences(text).split('\n')

  for (const [at, line] of lines.entries()) {
    const sentences = stripBullet(line).split(/(?<=[.!?])\s+/)

    for (const [place, raw] of sentences.entries()) {
      let sentence = raw.trim()

      if (!statesRule(sentence)) {
        continue
      }

      if (sentence.endsWith(':') && place === sentences.length - 1) {
        const body: string[] = []

        for (const next of lines.slice(at + 1, at + 1 + MAX_LEAD_IN_LINES)) {
          const item = stripBullet(next)

          if (item === '') {
            if (body.length > 0) {
              break
            }

            continue
          }

          body.push(item)
        }

        // A lead-in with nothing under it is no rule.
        if (body.length === 0) {
          continue
        }

        sentence = `${sentence} ${body.join('; ')}`
      }

      // Drawn, offered and written as it is seen: a tag, bidi or zero-width character pasted along
      // would otherwise reach a CLAUDE.md that loads as standing instructions, unseen.
      const seen = visibleText(sentence)

      return seen === '' || seen.length > MAX_RULE_CHARS || looksSecret(seen) ? null : seen
    }
  }

  return null
}

/** A rule's dedupe form: no bullet, lowercased, whitespace collapsed, no trailing punctuation. */
export const normalizeRule = (sentence: string): string => normalizePrompt(sentence.replace(/^\s*[-*+]\s+/, ''))

export const CAPTURED_HEADING = '## Captured rules'

/**
 * True when a file already holds the rule as a line of its own (in any
 * section: a rule anywhere in a loaded CLAUDE.md is already in force),
 * compared in dedupe form. Lines inside fenced code do not count.
 */
export function hasRule(text: string, sentence: string): boolean {
  const wanted = normalizeRule(sentence)

  return stripFences(text)
    .split('\n')
    .some(line => normalizeRule(line) === wanted)
}

/**
 * The file's text with the rule added as a bullet at the end of its
 * "## Captured rules" section (before the next level-1 or level-2 heading),
 * the section created at the end when the file has none. Never a blind
 * append: a file whose tail is a generated block keeps that block whole.
 * Headings inside fenced code are not headings, and a CRLF file gets CRLF lines.
 */
export function insertCapturedRule(text: string, sentence: string, preamble = ''): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const cr = eol === '\r\n' ? '\r' : ''
  const entry = `- ${sentence.trim()}`
  // Split on "\n" alone so each line keeps its own "\r" and the file's endings survive as they were.
  const lines = text.split('\n')
  // Same line count as `lines` (a fence's lines blanked): where headings are looked for.
  const visible = stripFences(text).split('\n')
  const isHeading = (at: number) => /^#{1,2}\s/.test(visible[at] ?? '')
  const headingAt = visible.findIndex(line => line.trim().toLowerCase() === CAPTURED_HEADING.toLowerCase())

  if (headingAt === -1) {
    const base = text.trimEnd()
    const lead = base === '' ? preamble.replace(/\n/g, eol) : `${base}${eol}${eol}`

    return `${lead}${CAPTURED_HEADING}${eol}${eol}${entry}${eol}`
  }

  let end = headingAt + 1

  while (end < lines.length && !isHeading(end)) {
    end += 1
  }

  let insertAt = end

  while (insertAt > headingAt + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
    insertAt -= 1
  }

  const added = insertAt === headingAt + 1 ? [cr, `${entry}${cr}`] : [`${entry}${cr}`]
  const needsGap = end < lines.length && insertAt === end ? [cr] : []

  return [...lines.slice(0, insertAt), ...added, ...needsGap, ...lines.slice(insertAt)].join('\n')
}

// Standing --------------------------------------------------------------------

const CHECK_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const CHECK_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR'])

/**
 * The CI rollup of a `statusCheckRollup` list. Any failed check is `failing`;
 * anything running, queued, unknown or absent is `pending`; only a non-empty
 * list of finished, passing checks is `green`. Right after a push the list is
 * empty, which must never read as green.
 */
export function ciRollup(rollup: unknown): CockpitCi {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return 'pending'
  }

  let isPending = false

  for (const item of rollup as unknown[]) {
    const check = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null

    if (check === null) {
      isPending = true
      continue
    }

    if ('status' in check || 'conclusion' in check) {
      const status = String(check.status ?? '').toUpperCase()
      const conclusion = String(check.conclusion ?? '').toUpperCase()

      if (status === 'COMPLETED' && CHECK_FAILED.has(conclusion)) {
        return 'failing'
      }

      isPending ||= status !== 'COMPLETED' || !CHECK_OK.has(conclusion)
      continue
    }

    const state = String(check.state ?? '').toUpperCase()

    if (state === 'FAILURE' || state === 'ERROR') {
      return 'failing'
    }

    isPending ||= state !== 'SUCCESS'
  }

  return isPending ? 'pending' : 'green'
}

/** The pull request from `gh pr view --json ...` stdout, or null when it is not the shape asked for. */
export function parsePr(stdout: string): CockpitPr | null {
  let data: unknown

  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null) {
    return null
  }

  const pr = data as Record<string, unknown>

  if (typeof pr.number !== 'number') {
    return null
  }

  const state = typeof pr.state === 'string' ? pr.state.toUpperCase() : 'UNKNOWN'

  return {
    number: pr.number,
    state,
    mergeable: typeof pr.mergeable === 'string' ? pr.mergeable.toUpperCase() : 'UNKNOWN',
    mergeState: typeof pr.mergeStateStatus === 'string' ? pr.mergeStateStatus.toUpperCase() : 'UNKNOWN',
    ci: ciRollup(pr.statusCheckRollup),
    isMerged: state === 'MERGED' || (typeof pr.mergedAt === 'string' && pr.mergedAt !== ''),
    headSha: typeof pr.headRefOid === 'string' && /^[0-9a-f]{7,64}$/i.test(pr.headRefOid) ? pr.headRefOid.toLowerCase() : null,
    mergedAt: typeof pr.mergedAt === 'string' && Number.isFinite(Date.parse(pr.mergedAt)) ? Date.parse(pr.mergedAt) : null,
  }
}

const MERGEABLE_WORD: Record<string, string> = { MERGEABLE: 'mergeable', CONFLICTING: 'conflicts' }

const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000))

/** The PR, CI and merged parts of the standing line, from how the PR lookup went. */
function prParts(standing: CockpitStanding): string[] {
  const pr = standing.pr

  if (standing.prStatus === 'ok' && pr !== null) {
    const isOpen = pr.state === 'OPEN'
    const mergeable = MERGEABLE_WORD[pr.mergeable] ?? 'mergeable?'
    const behind = pr.mergeState === 'BEHIND' ? ', behind' : ''
    const head = isOpen ? `PR #${pr.number} open/${mergeable}${behind}` : `PR #${pr.number} ${pr.state.toLowerCase()}`

    // A MERGED state already says it; any other state says whether it merged.
    return pr.state === 'MERGED' ? [head, `CI ${pr.ci}`] : [head, `CI ${pr.ci}`, pr.isMerged ? 'merged' : 'not merged']
  }

  return { none: ['no PR'], error: ['PR unknown'], unavailable: ['PR lookup unavailable'], ok: ['PR unknown'], skipped: [] }[standing.prStatus]
}

/**
 * The standing line: "branch · PR #N state/mergeable · CI rollup · merged? ·
 * idle Nm", with "(stale Nm)" once the last refresh is over three minutes old.
 */
export function standingLine(standing: CockpitStanding | null, now: number, lastToolAt: number, isWorking: boolean): string {
  if (standing === null) {
    return 'standing: checking…'
  }

  const parts: string[] = [
    standing.branch === null
      ? standing.prStatus === 'unavailable'
        ? 'git unavailable'
        : 'no git'
      : standing.branch === 'HEAD'
        ? 'detached HEAD'
        : standing.branch,
  ]

  // Without a branch there is no PR to speak of.
  if (standing.branch !== null) {
    parts.push(...prParts(standing))
  }

  parts.push(isWorking ? 'working' : lastToolAt > 0 ? `idle ${minutes(now - lastToolAt)}m` : 'no tool calls yet')

  const stale = now - standing.refreshedAt > STALE_MS ? ` (stale ${minutes(now - standing.refreshedAt)}m)` : ''

  return `${parts.join(' · ')}${stale}`
}

/** Everything the band knows that bears on "is this session done". */
export type CompletionInput = {
  standing: CockpitStanding | null
  now: number
  isWorking: boolean
  hasPending: boolean
  waiting: number
  openDecisions: number
  background: { tasks: number; crons: number; at: number; seq: number; token: string; source: 'stop' | 'agents' } | null
  /** The parent (lead) session: unknown until the app's record was read, else its id or none. */
  lead: { state: 'unknown' | 'none' | 'known'; id: string | null }
  lastReportAt: number
}

/**
 * Whether the session is fully done, by what the band can observe, read
 * fail-closed: the standing is fresh (under STALE_MS old, and refreshed after
 * the latest turn's Stop); the PR is merged at this exact HEAD, or there is
 * no PR, nothing is ahead of the upstream and HEAD is in the remote default
 * branch; the tree is clean; nothing is
 * working, queued or waiting on the person; no decision is open; the Stop
 * after the latest turn listed no background task or wakeup; and the lead
 * session, once known, was told after the merge was first seen. Each unmet
 * condition is a short blocker; anything unknown is one too.
 */
export function completion(input: CompletionInput): { isReady: boolean; blockers: string[] } {
  const blockers: string[] = []
  const s = input.standing

  if (s === null) {
    blockers.push('standing unknown')
  } else {
    if (input.now - s.refreshedAt > STALE_MS) blockers.push('standing stale')
    // Readings count only when the refresh started after the latest Stop, by sequence, never by a clock tie.
    if (input.background !== null && (s.stopSeq !== input.background.seq || s.stopToken !== input.background.token)) blockers.push('standing older than the last turn')
    if (s.branch === null) blockers.push('no git branch')
    if (s.prStatus === 'ok' && s.pr !== null) {
      if (!s.pr.isMerged) {
        blockers.push(`PR #${s.pr.number} ${s.pr.state === 'OPEN' ? 'open' : s.pr.state.toLowerCase()}`)
      } else if (s.pr.headSha === null || s.headSha === null) {
        blockers.push('merged head unknown')
      } else if (!s.headSha.startsWith(s.pr.headSha) && !s.pr.headSha.startsWith(s.headSha)) {
        blockers.push('commits after the merged PR')
      }
    } else if (s.prStatus === 'none') {
      // No PR: the work must already be in the remote default branch, and nothing unpushed.
      // A repository with no remote at all has nowhere to push or merge: nothing to wait for.
      if (s.hasRemote === false) {
        // nothing to ship
      } else if (s.hasRemote === null) {
        blockers.push('remotes unknown')
      } else {
        if (s.aheadOfUpstream === null) blockers.push('unpushed commits unknown (no upstream)')
        else if (s.aheadOfUpstream > 0) blockers.push(`${s.aheadOfUpstream} unpushed commit${s.aheadOfUpstream === 1 ? '' : 's'}`)
        if (s.defaultBranch === null || s.inDefault === null) blockers.push('default branch unknown')
        else if (!s.inDefault) blockers.push(`not in ${s.defaultBranch}`)
      }
    } else {
      blockers.push('PR unknown')
    }
    if (s.isClean === false) blockers.push(`${s.dirtyFiles ?? '?'} uncommitted change${s.dirtyFiles === 1 ? '' : 's'}`)
    else if (s.isClean !== true) blockers.push('working tree unknown')
  }

  if (input.isWorking) blockers.push('working')
  if (input.hasPending) blockers.push('reply queued')
  if (input.waiting > 0) blockers.push(`${input.waiting} waiting on you`)
  if (input.openDecisions > 0) blockers.push(`${input.openDecisions} decision${input.openDecisions === 1 ? '' : 's'} open`)

  if (input.background === null) {
    blockers.push('background work unknown')
  } else {
    if (input.background.tasks > 0) {
      const n = input.background.tasks
      blockers.push(input.background.source === 'agents' ? `${n} running agent${n === 1 ? '' : 's'}` : `${n} background task${n === 1 ? '' : 's'}`)
    }
    if (input.background.crons > 0) blockers.push(`${input.background.crons} wakeup${input.background.crons === 1 ? '' : 's'} scheduled`)
  }

  if (input.lead.state === 'unknown') {
    blockers.push('lead session unknown')
  } else if (input.lead.state === 'known') {
    // The report must follow the merge: GitHub's merge time for a PR, else the refresh that first
    // saw HEAD in the default branch. Neither known is a blocker, never a pass.
    const merged = s?.pr?.isMerged === true
    const since = merged ? s?.mergedSeenAt : s?.prStatus === 'none' ? s?.inDefaultSeenAt : null
    if (typeof since !== 'number') blockers.push(merged ? 'merge time unknown' : 'merge time unknown (no PR)')
    else if (!(input.lastReportAt > 0 && input.lastReportAt >= since)) blockers.push('lead session not told')
  }

  return { isReady: blockers.length === 0, blockers }
}

/** The reason the archive request carries, from the standing. */
export function archiveReason(standing: CockpitStanding | null): string {
  const pr = standing?.pr
  const what = pr && pr.isMerged ? `PR #${pr.number} merged` : standing?.hasRemote === false ? 'no remote, all committed' : 'no PR'
  return `${what}, tree clean, nothing waiting`
}

/** What the band knows that bears on "is this a natural break to hand the session off". */
export type HandoffBreakInput = {
  standing: CockpitStanding | null
  /** Items waiting on the person (the `WAITING ON JOSEPH:` lines of the last answer). */
  waiting: number
  background: CockpitBackground | null
  context: CockpitContext | null
  isWorking: boolean
  hasPending: boolean
  /** The option `handoffTokens`: an absolute token count, or 0 for 80 % of the window. */
  tokensLine: number
}

export type HandoffBreak = { reason: 'merged' | 'waiting' | 'context'; text: string }

/** A token count the way the chip shows it: 162k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)))
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * Whether now is a natural break to offer a hand-off to a fresh session, and
 * why: a PR merged at this exact HEAD (the same head test `completion` uses)
 * and seen merged no earlier than this session began (`mergedSeenAt`, GitHub's
 * merge time or the refresh that first saw it, against `context.startedAt`,
 * which /clear starts over: a fresh session on a branch merged before it is
 * not at a break, and an unknown start or merge time is no break);
 * items waiting on the person with no agent running (an observation of the
 * running agents is required: unknown is no break); or the context past an
 * absolute token line (`tokensLine`, 0 meaning 80 % of the window, and no
 * window then no line). Never while a turn runs or a reply is queued. One
 * reason at most, by precedence merged, waiting, context.
 *
 * Deliberately not a break: no PR with HEAD already in the default branch,
 * which a fresh session on main reads as from its first moment, so it would
 * be offered a hand-off at once.
 */
export function handoffBreak(input: HandoffBreakInput): HandoffBreak | null {
  if (input.isWorking || input.hasPending) return null

  const s = input.standing
  const pr = s?.pr ?? null
  const startedAt = input.context?.startedAt ?? null
  if (
    s !== null &&
    pr !== null &&
    pr.isMerged === true &&
    pr.headSha !== null &&
    s.headSha !== null &&
    (s.headSha.startsWith(pr.headSha) || pr.headSha.startsWith(s.headSha)) &&
    s.mergedSeenAt !== null &&
    startedAt !== null &&
    s.mergedSeenAt >= startedAt
  ) {
    return { reason: 'merged', text: `PR #${pr.number} merged` }
  }

  if (input.waiting > 0 && input.background !== null && input.background.tasks === 0) {
    return { reason: 'waiting', text: 'waiting on you, no agents running' }
  }

  const tokens = input.context?.tokens
  if (typeof tokens === 'number' && Number.isFinite(tokens)) {
    const window = input.context?.window
    const line = input.tokensLine > 0 ? input.tokensLine : typeof window === 'number' && window > 0 ? 0.8 * window : Infinity
    if (tokens >= line) return { reason: 'context', text: `context ${formatTokens(tokens)}` }
  }

  return null
}
