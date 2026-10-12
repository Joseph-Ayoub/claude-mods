// rd-ledger: the mapping (components.json, SPEC §3.3). The READ side is
// lead-owned and complete: an empty mapping, resolution, pre-tag, digests. The
// WRITE side (load with validation, save, queue decisions, import merge,
// deadlines) is workstream W2's; its signatures below are the contract.
// Pure: no `$`, no I/O. Tables are null-prototype objects (CYB-8).

import type { Activity, Component, Deadline, Entity, Filing, ImportedRegistry, Mapping, PretagRule, QueueDecision, RepoRule, Resolution } from '../types'
import { sha256 } from './hash'
import { CAP } from './store'
import { bareObject, cleanField, globMatch, hasOwn, isDate, isId, isRedacted, oneLine } from './text'

export const ACTIVITIES: readonly Activity[] = ['direct_research', 'direct_support', 'non_qualified']
export const FILINGS = ['c-corp', 's-corp', 'schedule-c', 'partnership', 'other'] as const
export const isActivity = (x: unknown): x is Activity => typeof x === 'string' && (ACTIVITIES as readonly string[]).includes(x)

/** An empty, valid mapping (gen 0). */
export const emptyMapping = (): Mapping => ({ v: 1, gen: 0, entities: bareObject({}), components: bareObject({}), repos: bareObject({}), pretag: [], extra: {} })

/** The seed written on first run: one `default` entity and the help text (SPEC §3.3). */
export const seedMapping = (): Mapping => {
  const m = emptyMapping()
  m.entities['default'] = { name: 'My business', filing: null }
  m.extra['_help'] = 'Edit by hand or through /rd review. Top-level keys starting with _ are ignored. Ids are kebab-case; activity is direct_research, direct_support or non_qualified; filing is c-corp, s-corp, schedule-c, partnership or other.'
  return m
}

const ruleToResolution = (rule: RepoRule, m: Mapping, via: 'hash' | 'bare'): Resolution | null => {
  if ('component' in rule) {
    if (!hasOwn(m.components, rule.component)) return null
    return { kind: 'component', component: rule.component, entity: (m.components[rule.component] as { entity: string }).entity, via }
  }
  if ('ignore' in rule) return { kind: 'ignored', via }
  if ('nonRd' in rule) return hasOwn(m.entities, rule.entity) ? { kind: 'nonRd', entity: rule.entity, via } : null
  return null
}

/**
 * Where a repository lands: the `key#hash` entry outranks the bare key; a
 * rule naming an unknown component or entity resolves unmapped (never a guess).
 */
export const resolveRepo = (m: Mapping, repoKey: string, rootHash: string | null): Resolution => {
  if (rootHash && hasOwn(m.repos, `${repoKey}#${rootHash}`)) {
    const r = ruleToResolution(m.repos[`${repoKey}#${rootHash}`] as RepoRule, m, 'hash')
    if (r) return r
  }
  if (hasOwn(m.repos, repoKey)) {
    const r = ruleToResolution(m.repos[repoKey] as RepoRule, m, 'bare')
    if (r) return r
  }
  return { kind: 'unmapped' }
}

/** True when the bare key is mapped but this hash has no entry of its own (DBM-8: a `new location?` row). */
export const isNewLocation = (m: Mapping, repoKey: string, rootHash: string | null): boolean =>
  rootHash !== null && hasOwn(m.repos, repoKey) && !hasOwn(m.repos, `${repoKey}#${rootHash}`)

/**
 * The pre-tag for a (component, repo, day): the first rule whose `repo` equals
 * the row's repoKey and whose `branch` glob matches any branch seen that day
 * for that repo (null matches every branch); else the component's defaults.
 */
export const pretag = (m: Mapping, component: string, repoKey: string, branches: readonly string[]): { activity: Activity; poe: boolean } => {
  for (const rule of m.pretag) {
    if (rule.repo !== repoKey) continue
    if (rule.branch === null || branches.some(b => globMatch(rule.branch as string, b))) return { activity: rule.activity, poe: rule.poe }
  }
  const c = hasOwn(m.components, component) ? m.components[component] : undefined
  return c ? { activity: c.activity, poe: c.poe } : { activity: 'non_qualified', poe: false }
}

/** The entity of a component, or null. */
export const entityOf = (m: Mapping, component: string): string | null => (hasOwn(m.components, component) ? (m.components[component] as { entity: string }).entity : null)

/** sha256 of the mapping file's text as loaded; what a confirmed revision records. */
export const mappingDigest = (text: string): string => sha256(text)

// ---------------------------------------------------------------------------------
// W2 — the write side. Implement exactly these exported names and signatures.
// ---------------------------------------------------------------------------------

const KNOWN_KEYS: readonly string[] = ['v', 'gen', 'entities', 'components', 'repos', 'pretag']
const DAY_MS = 86_400_000
/** The longest change description a history line keeps. */
const CHANGE_CAP = 200

const isRecordObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isFiling = (x: unknown): x is Filing => typeof x === 'string' && (FILINGS as readonly string[]).includes(x)
/** An own field only: a hand-edited file must not reach `Object.prototype` through a missing key. */
const own = (x: Record<string, unknown>, key: string): unknown => (hasOwn(x, key) ? x[key] : undefined)
/** An outside string as a problem line may show it: one clean short line, a token redacted, never raw. */
const shown = (s: string): string => cleanField(s, 40).value ?? '(empty)'

/** A bare repo key as repoKeyOf and the store mint it: one clean line of at most 100 code points, without `#` or `|`. */
const isBareKey = (s: string): boolean => s !== '' && !/[#|]/.test(s) && cleanField(s, CAP.repoKey).value === s

/** A `repos` key: a bare key, or `key#<12 hex>` (one location of that repository). */
const isRepoRuleKey = (s: string): boolean => {
  const hashed = /^(.+)#[0-9a-f]{12}$/.exec(s)
  return isBareKey(hashed ? (hashed[1] as string) : s)
}

/** A pre-tag branch glob: one clean line of at most 100 characters, `*` allowed only as the last one (globMatch's shape). */
const isBranchGlob = (s: string): boolean => s.length >= 1 && s.length <= 100 && oneLine(s, 100) === s && !s.slice(0, -1).includes('*')

/** Names the fields of a kept entry that a save will not write back, so a hand-added field is never lost silently. */
const noteUnknownFields = (problems: string[], what: string, x: Record<string, unknown>, allowed: readonly string[]): void => {
  const unknown = Object.keys(x).filter(k => !allowed.includes(k))
  if (unknown.length > 0) problems.push(`${what}: field ${unknown.map(shown).join(', ')} is not kept on save`)
}

/** A cleaned display name; a redaction is kept (the record must not hold the token) but said out loud. */
const takeName = (problems: string[], what: string, x: unknown): string | null => {
  const name = cleanField(typeof x === 'string' ? x : null, CAP.name).value
  if (name !== null && isRedacted(name)) problems.push(`${what}: the name held a credential or an address and was replaced with ${name}`)
  return name
}

const decodeEntity = (problems: string[], id: string, x: unknown): Entity | null => {
  const what = `entity ${shown(id)}`
  const drop = (why: string): null => (problems.push(`${what} dropped: ${why}`), null)
  if (!isId(id)) return drop('the id is not lower-case kebab-case')
  if (!isRecordObject(x)) return drop('not an object')
  const name = takeName(problems, what, own(x, 'name'))
  if (name === null) return drop('no name')
  const filing = own(x, 'filing')
  if (filing !== undefined && filing !== null && !isFiling(filing)) return drop(`filing must be one of ${FILINGS.join(', ')}`)
  noteUnknownFields(problems, what, x, ['name', 'filing'])
  return { name, filing: isFiling(filing) ? filing : null }
}

const decodeComponent = (problems: string[], id: string, x: unknown): Component | null => {
  const what = `component ${shown(id)}`
  const drop = (why: string): null => (problems.push(`${what} dropped: ${why}`), null)
  if (!isId(id)) return drop('the id is not lower-case kebab-case')
  if (!isRecordObject(x)) return drop('not an object')
  const name = takeName(problems, what, own(x, 'name'))
  if (name === null) return drop('no name')
  const entity = own(x, 'entity')
  if (typeof entity !== 'string' || !isId(entity)) return drop('entity is not an id')
  const activity = own(x, 'activity')
  if (!isActivity(activity)) return drop(`activity must be one of ${ACTIVITIES.join(', ')}`)
  const poe = own(x, 'poe')
  if (typeof poe !== 'boolean') return drop('poe must be true or false')
  const rdt = own(x, 'rdt')
  if (rdt !== undefined && rdt !== null && (typeof rdt !== 'string' || !isId(rdt))) return drop('rdt is not an id')
  noteUnknownFields(problems, what, x, ['name', 'entity', 'activity', 'poe', 'rdt'])
  return { name, entity, activity, poe, rdt: typeof rdt === 'string' ? rdt : null }
}

const decodeRule = (problems: string[], key: string, x: unknown): RepoRule | null => {
  const what = `repos ${shown(key)}`
  const drop = (why: string): null => (problems.push(`${what} dropped: ${why}`), null)
  if (!isRepoRuleKey(key)) return drop('the key must be a repository name, or name#<12 hex digits>')
  if (!isRecordObject(x)) return drop('not an object')
  const component = own(x, 'component')
  const ignore = own(x, 'ignore')
  const nonRd = own(x, 'nonRd')
  // Exactly one shape: a rule that says two things is a guess, so it is dropped rather than read one way.
  if (component !== undefined && ignore === undefined && nonRd === undefined) {
    if (typeof component !== 'string' || !isId(component)) return drop('component is not an id')
    noteUnknownFields(problems, what, x, ['component'])
    return { component }
  }
  if (ignore === true && component === undefined && nonRd === undefined) {
    noteUnknownFields(problems, what, x, ['ignore'])
    return { ignore: true }
  }
  if (nonRd === true && component === undefined && ignore === undefined) {
    const entity = own(x, 'entity')
    if (typeof entity !== 'string' || !isId(entity)) return drop('entity is not an id')
    noteUnknownFields(problems, what, x, ['nonRd', 'entity'])
    return { nonRd: true, entity }
  }
  return drop('must be { component }, { ignore: true } or { nonRd: true, entity }')
}

const decodePretag = (problems: string[], index: number, x: unknown): PretagRule | null => {
  const what = `pretag rule ${index + 1}`
  const drop = (why: string): null => (problems.push(`${what} dropped: ${why}`), null)
  if (!isRecordObject(x)) return drop('not an object')
  const repo = own(x, 'repo')
  if (typeof repo !== 'string' || !isBareKey(repo)) return drop('repo must be a repository name')
  const branch = own(x, 'branch')
  if (branch !== null && (typeof branch !== 'string' || !isBranchGlob(branch))) return drop('branch must be null, a name, or a prefix ending in one * (at most 100 characters)')
  const activity = own(x, 'activity')
  if (!isActivity(activity)) return drop(`activity must be one of ${ACTIVITIES.join(', ')}`)
  const poe = own(x, 'poe')
  if (typeof poe !== 'boolean') return drop('poe must be true or false')
  noteUnknownFields(problems, what, x, ['repo', 'branch', 'activity', 'poe'])
  return { repo, branch, activity, poe }
}

/** A JSON value copied deeply (extra values came from JSON.parse or the seed, so the round trip is exact). */
const jsonCopy = (x: unknown): unknown => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)))

const mapTable = <A, B>(table: Record<string, A>, f: (a: A) => B): Record<string, B> => {
  const out = bareObject<B>({})
  for (const key of Object.keys(table)) out[key] = f(table[key] as A)
  return out
}

const canonicalRule = (r: RepoRule): RepoRule => ('component' in r ? { component: r.component } : 'ignore' in r ? { ignore: true } : { nonRd: true, entity: r.entity })

/** A deep copy with null-prototype tables: the write side never shares structure with its input. */
const cloneMapping = (m: Mapping): Mapping => {
  const extra = bareObject<unknown>({})
  for (const key of Object.keys(m.extra)) extra[key] = jsonCopy(m.extra[key])
  return {
    v: 1,
    gen: m.gen,
    entities: mapTable(m.entities, e => ({ name: e.name, filing: e.filing })),
    components: mapTable(m.components, c => ({ name: c.name, entity: c.entity, activity: c.activity, poe: c.poe, rdt: c.rdt })),
    repos: mapTable(m.repos, canonicalRule),
    pretag: m.pretag.map(r => ({ repo: r.repo, branch: r.branch, activity: r.activity, poe: r.poe })),
    extra,
  }
}

/**
 * CONTRACT (W2). The mapping from the file's text (null when the file does not
 * exist → the seed). Validates every table: ids by `isId`, names through
 * `cleanField(…, CAP.name)`, enums closed, `repos` keys `key` or `key#<12 hex>`
 * with `#` and `|` otherwise forbidden, pre-tag globs ≤ 100 chars; invalid
 * entries are dropped and named in `problems` (never silently kept); a `v`
 * other than 1 or unparseable JSON returns the seed with `readOnly: true` (the
 * file must not be rewritten). Unknown top-level keys go to `extra`; keys
 * starting with `_` are left in `extra` untouched. Tables come back as
 * null-prototype objects.
 *
 * Beyond the contract, on the side of the person's file: a table that is
 * present but not an object (or `pretag` not a list) also sets `readOnly`,
 * since a save would write it back empty. A rule naming an unknown component
 * or entity, and a component naming an unknown entity, are kept as written
 * (resolution already treats such a rule as unmapped) and named in `problems`.
 */
export const loadMapping = (text: string | null): { mapping: Mapping; problems: string[]; readOnly: boolean } => {
  if (text === null) return { mapping: seedMapping(), problems: [], readOnly: false }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { mapping: seedMapping(), problems: ['components.json is not valid JSON; it will not be rewritten'], readOnly: true }
  }
  if (!isRecordObject(raw) || own(raw, 'v') !== 1) return { mapping: seedMapping(), problems: ['components.json is not version 1; it will not be rewritten'], readOnly: true }
  const top = raw
  const problems: string[] = []
  let readOnly = false
  const m = emptyMapping()
  m.extra = bareObject<unknown>({})
  const gen = own(top, 'gen')
  if (typeof gen === 'number' && Number.isSafeInteger(gen) && gen >= 0) m.gen = gen
  else if (gen !== undefined) problems.push('gen is not a whole number; read as 0')
  const table = (name: string): Record<string, unknown> => {
    const t = own(top, name)
    if (t === undefined) return {}
    if (isRecordObject(t)) return t
    problems.push(`${name} is not an object; the file will not be rewritten`)
    readOnly = true
    return {}
  }
  const entities = table('entities')
  for (const id of Object.keys(entities)) {
    const e = decodeEntity(problems, id, entities[id])
    if (e) m.entities[id] = e
  }
  const components = table('components')
  for (const id of Object.keys(components)) {
    const c = decodeComponent(problems, id, components[id])
    if (!c) continue
    if (!hasOwn(m.entities, c.entity)) problems.push(`component ${shown(id)} names entity ${shown(c.entity)}, which is not in entities`)
    m.components[id] = c
  }
  const repos = table('repos')
  for (const key of Object.keys(repos)) {
    const r = decodeRule(problems, key, repos[key])
    if (!r) continue
    if ('component' in r && !hasOwn(m.components, r.component)) problems.push(`repos ${shown(key)} names component ${shown(r.component)}, which is not in components; it stays unmapped`)
    if ('nonRd' in r && !hasOwn(m.entities, r.entity)) problems.push(`repos ${shown(key)} names entity ${shown(r.entity)}, which is not in entities; it stays unmapped`)
    m.repos[key] = r
  }
  const pretag = own(top, 'pretag')
  if (Array.isArray(pretag)) {
    for (const [i, x] of pretag.entries()) {
      const rule = decodePretag(problems, i, x)
      if (rule) m.pretag.push(rule)
    }
  } else if (pretag !== undefined) {
    problems.push('pretag is not a list; the file will not be rewritten')
    readOnly = true
  }
  for (const key of Object.keys(top)) {
    if (KNOWN_KEYS.includes(key)) continue
    if (!key.startsWith('_')) problems.push(`unknown top-level key ${shown(key)} is kept as written and not used`)
    m.extra[key] = top[key]
  }
  return { mapping: m, problems, readOnly }
}

/**
 * CONTRACT (W2). The file text to write: `v`, `gen` (already incremented by the caller), the tables in a fixed key order, then `extra`. Two-space JSON.
 * Every entry is written in its canonical field order and `extra` keys keep their order, so load then save is a fixed
 * point after the first save. The output object is null-prototype so an `extra` key named `__proto__` is written, not swallowed.
 * Ends with a newline.
 */
export const saveMapping = (m: Mapping): string => {
  const c = cloneMapping(m)
  const out = bareObject<unknown>({})
  out['v'] = 1
  out['gen'] = Number.isSafeInteger(m.gen) && m.gen >= 0 ? m.gen : 0
  out['entities'] = c.entities
  out['components'] = c.components
  out['repos'] = c.repos
  out['pretag'] = c.pretag
  for (const key of Object.keys(c.extra)) if (!KNOWN_KEYS.includes(key)) out[key] = c.extra[key]
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * CONTRACT (W2). A new mapping with a queue decision applied under `key`
 * (`repoKey#hash` when the hash is known, else the bare key); a `component`
 * decision naming an unknown component or a `nonRd` naming an unknown entity
 * is refused (`null`). Never mutates. A key the loader would drop is refused
 * too, so a pick can never write an entry that vanishes on the next load.
 */
export const applyQueueDecision = (m: Mapping, key: string, decision: QueueDecision): Mapping | null => {
  if (typeof key !== 'string' || !isRepoRuleKey(key)) return null
  let rule: RepoRule
  if ('component' in decision) {
    if (typeof decision.component !== 'string' || !hasOwn(m.components, decision.component)) return null
    rule = { component: decision.component }
  } else if ('ignore' in decision && decision.ignore === true) {
    rule = { ignore: true }
  } else if ('nonRd' in decision && decision.nonRd === true) {
    if (typeof decision.entity !== 'string' || !hasOwn(m.entities, decision.entity)) return null
    rule = { nonRd: true, entity: decision.entity }
  } else {
    return null
  }
  const next = cloneMapping(m)
  next.repos[key] = rule
  return next
}

/**
 * CONTRACT (W2). Merges an imported registry: entities and components whose
 * ids are not already present are added (names cleaned, `rdt` = id, activity
 * `direct_research`, poe false, filing from the import when valid); existing
 * entries are never changed. Returns the added ids.
 * Ids that are not kebab-case, and components whose entity is in neither the
 * mapping nor the import, are skipped (an orphan component would claim hours
 * for an entity nobody files). The ids come back sorted.
 */
export const mergeImport = (m: Mapping, imported: ImportedRegistry): { mapping: Mapping; added: string[] } => {
  const next = cloneMapping(m)
  const added: string[] = []
  const nameOf = (x: Record<string, unknown>, id: string): string => {
    const name = own(x, 'name')
    return cleanField(typeof name === 'string' ? name : null, CAP.name).value ?? id
  }
  const entities: Record<string, unknown> = isRecordObject(imported?.entities) ? imported.entities : {}
  for (const id of Object.keys(entities)) {
    const e = entities[id]
    if (!isId(id) || hasOwn(next.entities, id) || !isRecordObject(e)) continue
    const filing = own(e, 'filing')
    next.entities[id] = { name: nameOf(e, id), filing: isFiling(filing) ? filing : null }
    added.push(id)
  }
  const components: Record<string, unknown> = isRecordObject(imported?.components) ? imported.components : {}
  for (const id of Object.keys(components)) {
    const c = components[id]
    if (!isId(id) || hasOwn(next.components, id) || !isRecordObject(c)) continue
    const entity = own(c, 'entity')
    if (typeof entity !== 'string' || !isId(entity) || !hasOwn(next.entities, entity)) continue
    next.components[id] = { name: nameOf(c, id), entity, activity: 'direct_research', poe: false, rdt: id }
    added.push(id)
  }
  return { mapping: next, added: added.sort() }
}

const FORMS: Record<Filing, { form: string; due: string; extended: string } | null> = {
  'c-corp': { form: 'Form 1120', due: '04-15', extended: '10-15' },
  's-corp': { form: 'Form 1120-S', due: '03-15', extended: '09-15' },
  'schedule-c': { form: 'Schedule C with Form 1040', due: '04-15', extended: '10-15' },
  partnership: { form: 'Form 1065', due: '03-15', extended: '09-15' },
  other: null,
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const pad2 = (n: number): string => String(n).padStart(2, '0')
const daysInMonth = (y: number, month: number): number => (Date.UTC(y, month, 1) - Date.UTC(y, month - 1, 1)) / DAY_MS

/**
 * The Monday on or after `date` (the date itself when it is a Monday), by
 * calendar arithmetic in UTC terms; null for anything that is not a real date
 * (Date.UTC alone would roll 02-31 into March).
 */
const mondayOnOrAfter = (date: string): string | null => {
  if (!isDate(date)) return null
  let [y, month, d] = date.split('-').map(Number) as [number, number, number]
  const dim = daysInMonth(y, month)
  if (d > dim) return null
  const day = Date.UTC(y, month - 1, d) / DAY_MS
  // Day 0 (1970-01-01) was a Thursday: with Monday as 0 that is 3.
  const weekday = (((day + 3) % 7) + 7) % 7
  d += (7 - weekday) % 7
  if (d > dim) {
    d -= dim
    month += 1
    if (month > 12) {
      month = 1
      y += 1
    }
  }
  return `${String(y).padStart(4, '0')}-${pad2(month)}-${pad2(d)}`
}

/**
 * CONTRACT (W2). The deadline calendar for `workYear` (SPEC §6.1 item 5): per
 * entity with a filing, the return and extension dates in `workYear + 1`;
 * plus the next weekly review (the Monday after `today`); sorted by date.
 * The statutory dates are not moved for weekends or holidays, and every label
 * says "calendar tax year; verify with your CPA". When `today` is a Monday the
 * review is that day (the W2 brief's rule). Ties sort by label, then entity id.
 */
export const deadlines = (m: Mapping, workYear: number, today: string): Deadline[] => {
  const out: Deadline[] = []
  const caveat = '(calendar tax year; verify with your CPA)'
  if (Number.isSafeInteger(workYear) && workYear >= 1970 && workYear < 9999) {
    const fileYear = String(workYear + 1)
    for (const id of Object.keys(m.entities)) {
      const filing = (m.entities[id] as Entity).filing
      const f = filing !== null && hasOwn(FORMS, filing) ? FORMS[filing] : null
      if (!f) continue
      out.push({ date: `${fileYear}-${f.due}`, label: `${f.form} due for tax year ${workYear} ${caveat}`, entity: id })
      out.push({ date: `${fileYear}-${f.extended}`, label: `${f.form} extended due date for tax year ${workYear} ${caveat}`, entity: id })
    }
  }
  const review = mondayOnOrAfter(today)
  if (review !== null) out.push({ date: review, label: 'Next weekly review (Monday)', entity: null })
  return out.sort((a, b) => cmp(a.date, b.date) || cmp(a.label, b.label) || cmp(a.entity ?? '', b.entity ?? ''))
}

/**
 * CONTRACT (W2). One mapping-history line: `{ at, gen, change }` as JSON, `change` a short cleaned description.
 * No trailing newline (the caller appends one per line). `change` passes the leak scan, so a description
 * that quotes a token is stored as `[redacted:…]`, never the token.
 */
export const historyLine = (at: number, gen: number, change: string): string =>
  JSON.stringify({ at: Number.isFinite(at) ? at : 0, gen: Number.isSafeInteger(gen) ? gen : 0, change: cleanField(change, CHANGE_CAP).value ?? '' })
