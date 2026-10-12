// Pure helpers for model-pin: no `$`, so the tests can pin their behavior down
// without an engine. The one hard problem is comparing a pin to the model the
// session reports: /model shows a display name or a resolved id, a settings
// pin is often an alias, and a gateway may prefix or date-stamp the id. A
// naive string compare would show drift on every session.

/** Longest model string accepted anywhere (pin, status text, command args). */
const MAX_MODEL_LENGTH = 100

/**
 * Whether `value` may be used as a pin: a single token of the characters model
 * ids and aliases use. It reaches `/model <pin>` and the composer, so anything
 * with whitespace, a newline or a shell/command metacharacter is refused
 * rather than trusted (a settings file is data, not instructions).
 */
export const isValidPin = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_MODEL_LENGTH &&
  /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/.test(value)

/**
 * Reduces a model id, alias or display name to one comparable form: lowercase,
 * no `[1m]`-style or parenthetical suffix, no provider prefix (`anthropic.`,
 * `us.anthropic.`, `bedrock/`), no date stamp or version tail, no `claude-`
 * lead, and spaces, dots and underscores folded to hyphens, so the display
 * name "Fable 5.1" and the id `claude-fable-5-1` meet at `fable-5-1`.
 */
export const normalizeModel = (raw: string): string => {
  let id = raw.trim().toLowerCase()
  id = id.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '')
  id = id.replace(/^(?:[a-z]{2,6}\.)?anthropic[./]/, '')
  id = id.replace(/^(?:bedrock|vertex_ai|vertex|azure|foundry)\//, '')
  id = id.replace(/[\s._]+/g, '-')
  id = id.replace(/-v\d+(?::\d+)?$/, '').replace(/:\d+$/, '')
  id = id.replace(/-latest$/, '').replace(/[@-]\d{8}$/, '')
  id = id.replace(/^claude-/, '')

  return id.replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/**
 * An alias is a bare family word (`opus`, `fable`, `sonnet`): it names no
 * version, so it can only be matched against the family of a resolved id.
 */
export const isAlias = (normalized: string): boolean => /^[a-z]+$/.test(normalized)

/**
 * The model families an alias can name. A bare word outside this list
 * (`default`, `opusplan`, a gateway's own name) resolves to something that
 * never spells the word, so family matching cannot work for it.
 */
const FAMILIES = new Set(['fable', 'opus', 'sonnet', 'haiku'])

/**
 * Whether a pin can be checked against the model the session reports. Not for
 * a bare word outside the known families (`opusplan` runs Opus or Sonnet by
 * mode; `default` is whatever the account defaults to) or a provider ARN
 * (`arn:aws:bedrock:...`, an inference profile whose id never matches the
 * model's). Such a pin is honored only by exact match and never drives a badge
 * or a re-apply: comparing it would report drift on every session and spend
 * the one re-apply for nothing.
 */
export const isComparable = (pin: string): boolean => {
  const id = normalizeModel(pin)

  if (id === '' || /^arn:/i.test(pin.trim())) {
    return false
  }

  return !isAlias(id) || FAMILIES.has(id)
}

/**
 * Whether two model strings name the same model once normalized. An alias
 * matches any id of its family (`fable` vs `claude-fable-5-1`), which is a
 * deliberate trade: a settings pin written as an alias cannot be resolved
 * without switching, and flagging drift on every session is worse than missing
 * a same-family version change. A pin stored as a resolved id compares exactly.
 * Anything empty never matches, so an unknown model is never "the pin".
 */
export const sameModel = (a: string, b: string): boolean => {
  const left = normalizeModel(a)
  const right = normalizeModel(b)

  if (left === '' || right === '') {
    return false
  }

  if (left === right) {
    return true
  }

  if (isAlias(left)) {
    return right.split('-').includes(left)
  }

  if (isAlias(right)) {
    return left.split('-').includes(right)
  }

  return false
}

/**
 * The bracketed variant tags of a model string (`[1m]`), lowercased. normalizeModel
 * drops them so a badge does not flag `opus[1m]` against `claude-opus-5-5`, but
 * a variant can change the context window and its pricing, so a switch the mod
 * makes on its own must not add or drop one.
 */
const variantOf = (raw: string): string => (raw.match(/\[[^\]]*\]/g) ?? []).join('').toLowerCase()

/**
 * The argument for a /model the mod may run by itself, or undefined when the
 * switch must be left to the person. The built-in /model may save its argument
 * as the default for every new session (user settings), so a pin from a
 * project, local, policy or --settings file, or the /model-pin override, must
 * never be run for them: it would quietly rewrite their global default, and a
 * cloned repository's settings are not theirs to trust with that. Only when
 * the person's own default already names the pin (equal once normalized, so
 * not merely the same family, and with the same `[1m]`-style variant) does the
 * mod run it, and then with that default as written, so saving it again
 * changes nothing.
 */
export const silentSwitchArg = (userModel: unknown, pin: string): string | undefined => {
  if (!isValidPin(userModel) || !isValidPin(pin)) {
    return undefined
  }

  const own = normalizeModel(userModel)

  return own !== '' && own === normalizeModel(pin) && variantOf(userModel) === variantOf(pin) ? userModel : undefined
}

/**
 * Makes a model string safe for a toast or status line: control characters
 * dropped, length capped. Models are not secrets, but the string came from a
 * file or the engine and is drawn verbatim.
 */
export const clip = (text: string, max = 60): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
