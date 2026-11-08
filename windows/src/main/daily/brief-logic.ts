// Pure Daily Brief logic (spec-daily.md §3b): prompt pieces, JSON schemas and validation,
// cleaning, merging, Claude output parsing and the read-only hook decision. No Electron imports.

import type {
  BriefPart,
  BriefSectionKey,
  DailyBrief,
  DailyBriefContent,
  DailyBriefFeedbackEvent,
  DailyBriefRunStats,
  DailyBriefUserState,
  DocketFeedback,
  DocketItem,
  DocketLink,
  DocketPerson,
  DocketStatus,
  HandoffEntry,
  SummaryRange,
} from '../../shared/daily-types.ts'
import type { Category, TimelineCard } from '../../shared/types.ts'
import { firstBalancedObject } from './standup.ts'

export const SECTION_KEYS: BriefSectionKey[] = [
  'docket',
  'keep_tracking',
  'completed_yesterday',
  'team_decisions',
  'related_reading',
  'industry_news',
  'site_seeing',
]
export const EXTRAS_KEYS: BriefSectionKey[] = SECTION_KEYS.filter((k) => k !== 'docket')

export const SECTION_TITLES: Record<BriefSectionKey, string> = {
  docket: 'Your docket today',
  keep_tracking: 'Keep tracking',
  completed_yesterday: 'What you completed yesterday',
  team_decisions: 'Key team decisions',
  related_reading: 'Related to your interests',
  industry_news: 'Latest in your industry',
  site_seeing: 'Recent site-seeing',
}

export const FEEDBACK_DAYS = 21
export const MAX_FEEDBACK_EVENTS = 2000
export const MAX_AUTOMATIC_BRIEF_ATTEMPTS = 2
export const BRIEF_MIN_SOURCE_MINUTES = 60
export const MAX_CANDIDATES = 60

export function emptyUserState(): DailyBriefUserState {
  return { checkedItemKeys: [], dismissedItemKeys: [], addedTasks: [], hasBeenShown: false, promptEdits: {}, folders: {}, handoffs: [] }
}

export function itemKey(section: string, title: string): string {
  return `${section}|${title}`
}

function sectionNonEmpty(c: DailyBriefContent, k: BriefSectionKey): boolean {
  const v = c[k]
  return Array.isArray(v) && v.length > 0
}

/** orderedKinds: known non-empty sections in `order`, deduplicated, then the rest in enum order. */
export function orderedKinds(c: DailyBriefContent): BriefSectionKey[] {
  const out: BriefSectionKey[] = []
  for (const k of c.order ?? []) {
    if (SECTION_KEYS.includes(k) && !out.includes(k) && sectionNonEmpty(c, k)) out.push(k)
  }
  for (const k of SECTION_KEYS) if (!out.includes(k) && sectionNonEmpty(c, k)) out.push(k)
  return out
}

// ---- Card filtering and lines (3b.2 / 3b.3) ----

export function briefCards(cards: TimelineCard[], categories: Category[]): TimelineCard[] {
  const idle = new Set(categories.filter((c) => c.isIdle).map((c) => c.name.trim().toLowerCase()))
  return cards.filter((c) => {
    const n = c.category.trim().toLowerCase()
    return !c.isError && n !== 'idle' && n !== 'system' && !idle.has(n)
  })
}

export function cardLines(cards: TimelineCard[], includesDetail: boolean): string {
  return [...cards]
    .sort((a, b) => a.startTs - b.startTs)
    .map((c) => {
      const summary = includesDetail ? c.summary.trim() : c.summary.trim().slice(0, 400)
      const apps = [c.appSites?.primary, c.appSites?.secondary].filter((s): s is string => !!s && !!s.trim())
      let line = `[cardId ${c.id ?? '?'}] ${c.startTime}–${c.endTime} · ${c.category} · ${c.title.trim()}`
      if (summary) line += ` — ${summary}`
      if (apps.length) line += ` · apps: ${apps.join(', ')}`
      if (includesDetail) {
        for (const l of c.detailedSummary.split(/\r?\n/)) {
          if (l.trim()) line += `\n    ${l.trim()}`
        }
      }
      return line
    })
    .join('\n')
}

export function categoriesWithDescriptions(categories: Category[]): string {
  const lines = categories
    .filter((c) => !c.isIdle)
    .map((c) => `- ${c.name}: ${c.description.trim() || '(no description)'}`)
  return lines.length ? lines.join('\n') : 'No categories set up.'
}

export function kindsFor(part: BriefPart): BriefSectionKey[] {
  return part === 'docket' ? ['docket'] : EXTRAS_KEYS
}

export function feedbackSummary(events: DailyBriefFeedbackEvent[], kinds: string[], now: Date): string {
  const cutoff = now.getTime() - FEEDBACK_DAYS * 86400_000
  const relevant = events
    .filter((e) => kinds.includes(e.section) && Date.parse(e.at) >= cutoff)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (relevant.length === 0) return 'No feedback yet.'
  const counts = new Map<string, Map<string, number>>()
  for (const e of relevant) {
    const m = counts.get(e.section) ?? new Map<string, number>()
    m.set(e.action, (m.get(e.action) ?? 0) + 1)
    counts.set(e.section, m)
  }
  const countLines = [...counts.keys()].sort().map((s) => {
    const parts = [...counts.get(s)!.entries()].map(([a, n]) => `${a} ${n}`).sort()
    return `- ${s}: ${parts.join(', ')}`
  })
  const latest = relevant.slice(-30).map((e) => `- ${e.day} · ${e.section} · ${e.action} · "${e.itemTitle}"`)
  return `Counts by section:\n${countLines.join('\n')}\n\nLatest actions:\n${latest.join('\n')}`
}

export function recentBriefItems(briefs: DailyBrief[], kinds: BriefSectionKey[], today: string): string {
  const recent = briefs
    .filter((b) => b.day !== today)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, 5)
  const blocks: string[] = []
  for (const b of recent) {
    const c = b.content
    const lines: string[] = []
    for (const k of kinds) {
      switch (k) {
        case 'docket':
          c.docket?.forEach((i) => lines.push(`- docket: ${i.title}`))
          break
        case 'keep_tracking':
          c.keep_tracking?.forEach((i) => lines.push(`- keep_tracking: ${i.label} — ${i.status}`))
          break
        case 'completed_yesterday':
          c.completed_yesterday?.forEach((i) => lines.push(`- completed_yesterday: ${i.title}`))
          break
        case 'team_decisions':
          c.team_decisions?.forEach((i) => lines.push(`- team_decisions: ${i.decision}`))
          break
        case 'related_reading':
          c.related_reading?.forEach((i) => lines.push(`- related_reading: ${i.title} (${i.url})`))
          break
        case 'industry_news':
          c.industry_news?.forEach((i) => lines.push(`- industry_news: ${i.headline} (${i.url})`))
          break
        case 'site_seeing':
          c.site_seeing?.forEach((i) => lines.push(`- site_seeing: ${i.caption || i.file}`))
          break
      }
    }
    if (lines.length) blocks.push(`#### ${b.day}\n${lines.join('\n')}`)
  }
  return blocks.length ? blocks.join('\n\n') : 'None yet.'
}

/** Template choice: user override when non-blank; ensures the override slot exists. */
export function chooseTemplate(defaultTemplate: string, override: string): { template: string; usedOverride: boolean } {
  const usedOverride = override.trim().length > 0
  let t = usedOverride ? override : defaultTemplate
  if (!t.includes('{{OVERRIDE_INSTRUCTIONS}}')) t += '\n\n{{OVERRIDE_INSTRUCTIONS}}'
  return { template: t, usedOverride }
}

/** Replaces every {{KEY}} in a single pass (values are never re-expanded), then collapses 3+ newlines. */
export function buildPrompt(template: string, values: Record<string, string>): string {
  let out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m,
  )
  while (/\n{3,}/.test(out)) out = out.replace(/\n{3,}/g, '\n\n')
  return out
}

export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

// ---- JSON schemas (3b.4) ----

type Schema = Record<string, unknown>
const str = { type: 'string' }
const strArr = { type: 'array', items: str }
function obj(properties: Record<string, unknown>, required: string[]): Schema {
  return { type: 'object', properties, required, additionalProperties: false }
}
const person = obj({ name: str, note: str }, ['name'])
const link = obj({ title: str, url: str, app: str }, ['title'])
const feedbackNote = obj({ name: str, source: str, text: str, url: str }, ['name', 'text'])

export const DOCKET_SCHEMA: Schema = obj(
  {
    notes: str,
    items: {
      type: 'array',
      items: obj(
        {
          title: str, detail: str, due: str,
          people: { type: 'array', items: person },
          links: { type: 'array', items: link },
          prompt: str, agent: { type: 'boolean' },
          feedback: { type: 'array', items: feedbackNote },
          feedbackSummary: str, feedbackUrl: str, attach: strArr, why: str,
        },
        ['title', 'prompt', 'agent', 'why'],
      ),
    },
  },
  ['notes', 'items'],
)

export const EXTRAS_SCHEMA: Schema = obj(
  {
    notes: str,
    order: { type: 'array', items: { type: 'string', enum: EXTRAS_KEYS } },
    keep_tracking: { type: 'array', items: obj({ label: str, status: str, app: str, asOf: str, url: str, why: str }, ['label', 'status', 'why']) },
    completed_yesterday: {
      type: 'array',
      items: obj({ project: str, title: str, apps: strArr, cardId: { type: 'integer' }, why: str }, ['title', 'why']),
    },
    team_decisions: {
      type: 'array',
      items: obj({ decision: str, date: str, people: strArr, place: str, app: str, url: str, why: str }, ['decision', 'why']),
    },
    related_reading_intro: str,
    related_reading: {
      type: 'array',
      items: obj({ title: str, source: str, url: str, reason: str, why: str }, ['title', 'url', 'why']),
    },
    industry_news: {
      type: 'array',
      items: obj({ headline: str, source: str, url: str, published: str, why: str }, ['headline', 'url', 'why']),
    },
    site_seeing: { type: 'array', items: obj({ file: str, caption: str, why: str }, ['file', 'why']) },
  },
  ['notes', 'order'],
)

export const SUMMARY_SCHEMA: Schema = obj(
  {
    overview: str,
    milestones: strArr,
    projects: {
      type: 'array',
      items: obj({ title: str, bullets: strArr, impact: str, imageEntryIndex: { type: 'integer' } }, ['title', 'bullets']),
    },
  },
  ['overview', 'milestones', 'projects'],
)

/**
 * Minimal JSON-schema validator for the subset used above (type, properties, required,
 * additionalProperties:false, items, enum). Returns a list of problems; empty means valid.
 * Unknown extra properties are reported, so callers can decide to strip rather than reject.
 */
export function validateSchema(value: unknown, schema: Schema, path = '$'): string[] {
  const errs: string[] = []
  const type = schema.type as string | undefined
  const typeOk = (() => {
    switch (type) {
      case 'object':
        return !!value && typeof value === 'object' && !Array.isArray(value)
      case 'array':
        return Array.isArray(value)
      case 'string':
        return typeof value === 'string'
      case 'boolean':
        return typeof value === 'boolean'
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      case 'number':
        return typeof value === 'number'
      default:
        return true
    }
  })()
  if (!typeOk) return [`${path}: expected ${type}`]
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errs.push(`${path}: not one of ${schema.enum.join(', ')}`)
  if (type === 'object') {
    const o = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Schema>
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errs.push(`${path}.${r}: required`)
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) errs.push(...validateSchema(v, props[k], `${path}.${k}`))
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unexpected property`)
    }
  }
  if (type === 'array' && schema.items) {
    ;(value as unknown[]).forEach((v, i) => errs.push(...validateSchema(v, schema.items as Schema, `${path}[${i}]`)))
  }
  return errs
}

/** Tolerant coercion for providers without native structured output: drops wrong-typed fields and bad items. */
export function coerceToSchema(value: unknown, schema: Schema): unknown {
  const type = schema.type as string | undefined
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const props = (schema.properties ?? {}) as Record<string, Schema>
    const out: Record<string, unknown> = {}
    for (const [k, s] of Object.entries(props)) {
      if (!(k in (value as Record<string, unknown>))) continue
      const v = coerceToSchema((value as Record<string, unknown>)[k], s)
      if (v !== undefined) out[k] = v
    }
    for (const r of (schema.required ?? []) as string[]) if (!(r in out)) return undefined
    return out
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return undefined
    return value.map((v) => coerceToSchema(v, (schema.items ?? {}) as Schema)).filter((v) => v !== undefined)
  }
  if (type === 'integer') {
    const n = typeof value === 'string' ? Number(value) : value
    return typeof n === 'number' && Number.isInteger(n) ? n : undefined
  }
  if (type === 'string') {
    if (typeof value === 'number') return String(value)
    if (typeof value !== 'string') return undefined
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return undefined
    return value
  }
  if (type === 'boolean') return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined
  return value
}

// ---- Cleaning (3b.6) ----

function s(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

export function cleanUrl(v: unknown): string | undefined {
  const t = s(v)
  if (!t) return undefined
  try {
    const u = new URL(t)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return t
  } catch {
    /* not a URL */
  }
  return undefined
}

function arr<T>(v: T[] | undefined): T[] | undefined {
  return v && v.length > 0 ? v : undefined
}

function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

export function cleanDocket(items: unknown): DocketItem[] | undefined {
  if (!Array.isArray(items)) return undefined
  const out: DocketItem[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const title = s(r.title)
    if (!title) continue
    const objs = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [])
    const people: DocketPerson[] = []
    for (const o of objs(r.people)) {
      const name = s(o.name)
      if (name) people.push(prune({ name, note: s(o.note) }))
    }
    const links: DocketLink[] = []
    for (const o of objs(r.links)) {
      const t = s(o.title)
      if (t) links.push(prune({ title: t, url: cleanUrl(o.url), app: s(o.app)?.toLowerCase() }))
    }
    const feedback: DocketFeedback[] = []
    for (const o of objs(r.feedback)) {
      const name = s(o.name)
      const text = s(o.text)
      if (name && text) feedback.push(prune({ name, source: s(o.source), text, url: cleanUrl(o.url) }))
    }
    const attach = Array.isArray(r.attach) ? r.attach.map(s).filter((x): x is string => !!x) : []
    out.push(
      prune({
        title,
        detail: s(r.detail),
        due: s(r.due),
        people: arr(people),
        links: arr(links),
        prompt: s(r.prompt),
        agent: typeof r.agent === 'boolean' ? r.agent : undefined,
        feedback: arr(feedback),
        feedbackSummary: s(r.feedbackSummary),
        feedbackUrl: cleanUrl(r.feedbackUrl),
        attach: arr(attach),
      }),
    )
  }
  return arr(out)
}

export interface Candidate {
  file: string
  cardId: number
}

export interface CleanResult {
  content: DailyBriefContent
  /** Candidate files to copy into <briefDir>/images/. */
  imagesToCopy: string[]
}

/** Cleans the extras part. Images referenced by completed_yesterday / site_seeing must be candidates. */
export function cleanExtras(raw: unknown, candidates: Candidate[]): CleanResult {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const images = new Set<string>()
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as Record<string, unknown>[]).filter((x) => x && typeof x === 'object') : [])
  const c: DailyBriefContent = { order: [] }

  c.keep_tracking = arr(
    list('keep_tracking')
      .map((i) => prune({ label: s(i.label)!, status: s(i.status)!, app: s(i.app)?.toLowerCase(), asOf: s(i.asOf), url: cleanUrl(i.url) }))
      .filter((i) => i.label && i.status),
  )
  c.completed_yesterday = arr(
    list('completed_yesterday')
      .map((i) => {
        const title = s(i.title)
        if (!title) return null
        const cardId = typeof i.cardId === 'number' ? i.cardId : typeof i.cardId === 'string' ? Number(i.cardId) : NaN
        const cand = Number.isInteger(cardId) ? candidates.find((x) => x.cardId === cardId) : undefined
        if (cand) images.add(cand.file)
        const apps = Array.isArray(i.apps) ? i.apps.map(s).filter((x): x is string => !!x).map((x) => x.toLowerCase()) : []
        return prune({
          project: s(i.project),
          title,
          apps: arr(apps),
          cardId: cand ? cardId : undefined,
          imageFile: cand ? `images/${cand.file}` : undefined,
        })
      })
      .filter((i): i is NonNullable<typeof i> => !!i),
  )
  c.team_decisions = arr(
    list('team_decisions')
      .map((i) =>
        prune({
          decision: s(i.decision)!,
          date: s(i.date),
          people: arr(Array.isArray(i.people) ? i.people.map(s).filter((x): x is string => !!x) : []),
          place: s(i.place),
          app: s(i.app)?.toLowerCase(),
          url: cleanUrl(i.url),
        }),
      )
      .filter((i) => i.decision),
  )
  c.related_reading = arr(
    list('related_reading')
      // No imageUrl: a model-chosen remote image would load with zero clicks and could carry data out.
      .map((i) => prune({ title: s(i.title)!, source: s(i.source), url: cleanUrl(i.url)!, reason: s(i.reason) }))
      .filter((i) => i.title && i.url),
  )
  if (c.related_reading) c.related_reading_intro = s(r.related_reading_intro)
  c.industry_news = arr(
    list('industry_news')
      .map((i) => prune({ headline: s(i.headline)!, source: s(i.source), url: cleanUrl(i.url)!, published: s(i.published) }))
      .filter((i) => i.headline && i.url),
  )
  const seen = new Set<string>()
  c.site_seeing = arr(
    list('site_seeing')
      .map((i) => {
        const f = s(i.file)
        if (!f) return null
        const base = f.split(/[\\/]/).pop()!
        if (seen.has(base) || !candidates.some((x) => x.file === base)) return null
        seen.add(base)
        images.add(base)
        return prune({ file: `images/${base}`, caption: s(i.caption) })
      })
      .filter((i): i is NonNullable<typeof i> => !!i),
  )
  const order = Array.isArray(r.order) ? r.order.map(s).filter((x): x is string => !!x) : []
  const kept: BriefSectionKey[] = []
  for (const k of order) {
    if (EXTRAS_KEYS.includes(k as BriefSectionKey) && !kept.includes(k as BriefSectionKey) && sectionNonEmpty(c, k as BriefSectionKey)) {
      kept.push(k as BriefSectionKey)
    }
  }
  c.order = kept
  prune(c)
  return { content: c, imagesToCopy: [...images] }
}

/** 3b.2 step 6: merges the two parts. Throws when both failed. */
export function mergeParts(
  docket: { items: DocketItem[] | undefined } | { error: string },
  extras: DailyBriefContent | { error: string },
): { content: DailyBriefContent; failedParts: Partial<Record<BriefPart, string>> } {
  const failedParts: Partial<Record<BriefPart, string>> = {}
  if ('error' in docket) failedParts.docket = docket.error
  if ('error' in extras) failedParts.extras = extras.error
  if (failedParts.docket && failedParts.extras) {
    const msgs = [...new Set([failedParts.docket, failedParts.extras])]
    throw new Error(msgs.join(' '))
  }
  const content: DailyBriefContent = 'error' in extras ? { order: [] } : { ...extras, order: [...extras.order] }
  delete content.docket
  if (!('error' in docket) && docket.items && docket.items.length) {
    content.docket = docket.items
    content.order = ['docket', ...content.order.filter((k) => k !== 'docket')]
  }
  return { content, failedParts }
}

/** 3b.7: on success with a failed part, keep that part's sections from the existing brief. */
export function keepFailedParts(
  content: DailyBriefContent,
  failedParts: Partial<Record<BriefPart, string>>,
  existing: DailyBrief | null,
): DailyBriefContent {
  if (!existing) return content
  const out: DailyBriefContent = { ...content }
  if (failedParts.docket && existing.content.docket) {
    out.docket = existing.content.docket
    out.order = ['docket', ...out.order.filter((k) => k !== 'docket')]
  }
  if (failedParts.extras) {
    for (const k of EXTRAS_KEYS) {
      const v = existing.content[k]
      if (v) (out as unknown as Record<string, unknown>)[k] = v
    }
    if (existing.content.related_reading_intro) out.related_reading_intro = existing.content.related_reading_intro
    const docketFirst = out.docket ? (['docket'] as BriefSectionKey[]) : []
    out.order = [...docketFirst, ...existing.content.order.filter((k) => k !== 'docket')]
  }
  return out
}

export function hasAnySection(c: DailyBriefContent): boolean {
  return SECTION_KEYS.some((k) => sectionNonEmpty(c, k))
}

// ---- Claude CLI output (3b.5) ----

export interface ClaudeEvent {
  type?: string
  subtype?: string
  [k: string]: unknown
}

/** Every balanced top-level JSON value ({...} or [...]) found in text. */
export function balancedJsonValues(text: string): unknown[] {
  const out: unknown[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '{' && ch !== '[') {
      i++
      continue
    }
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end < 0) {
      // Unclosed from here: a later opener may still start a complete value.
      i++
      continue
    }
    try {
      out.push(JSON.parse(text.slice(i, end + 1)))
      i = end + 1
    } catch {
      i++
    }
  }
  return out
}

function asEvents(v: unknown): ClaudeEvent[] | null {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : null
  if (!list) return null
  const events = list.filter((e): e is ClaudeEvent => !!e && typeof e === 'object')
  return events.some((e) => e.type === 'result') ? events : null
}

/** Parses stdout of `claude -p --output-format json --verbose` (or stream-json lines). */
export function parseClaudeEvents(stdout: string): ClaudeEvent[] {
  try {
    const ev = asEvents(JSON.parse(stdout))
    if (ev) return ev
  } catch {
    /* fall through */
  }
  // stream-json: one event per line
  const lines: ClaudeEvent[] = []
  for (const l of stdout.split(/\r?\n/)) {
    const t = l.trim()
    if (!t.startsWith('{')) continue
    try {
      lines.push(JSON.parse(t) as ClaudeEvent)
    } catch {
      /* noise */
    }
  }
  if (lines.some((e) => e.type === 'result')) return lines
  for (const v of balancedJsonValues(stdout)) {
    const ev = asEvents(v)
    if (ev) return ev
  }
  return []
}

export function resultEnvelope(events: ClaudeEvent[]): ClaudeEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'result') return events[i]
  return null
}

export function isSuccessEnvelope(env: ClaudeEvent): boolean {
  return env.is_error !== true && (!env.subtype || env.subtype === 'success')
}

/** structured_output when present, else the first balanced object in `result` that parses. */
export function structuredFromEnvelope(env: ClaudeEvent): Record<string, unknown> | null {
  const so = env.structured_output
  if (so && typeof so === 'object' && !Array.isArray(so)) return so as Record<string, unknown>
  if (typeof so === 'string') {
    try {
      const v = JSON.parse(so)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      /* not JSON */
    }
  }
  return objectFromText(typeof env.result === 'string' ? env.result : '')
}

export function objectFromText(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '')
  for (const v of balancedJsonValues(cleaned)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  }
  const o = firstBalancedObject(cleaned)
  if (o) {
    try {
      return JSON.parse(o)
    } catch {
      /* no */
    }
  }
  return null
}

export const SHAPE_ERROR = "Claude's answer came back in an unexpected shape. Try again."

export function classifyClaudeFailure(env: ClaudeEvent | null, stderr: string, stdout: string): string {
  const subtype = String(env?.subtype ?? '')
  if (subtype === 'error_max_turns') return 'Claude ran out of steps before finishing. Try again.'
  if (subtype.includes('structured_output')) return SHAPE_ERROR
  const text = [typeof env?.result === 'string' ? env.result : '', stderr, stdout].find((t) => t.trim()) ?? ''
  return classifyErrorText(text)
}

export function classifyErrorText(text: string): string {
  const t = text.toLowerCase()
  if (/usage limit|rate limit|limit reached|5-hour limit|weekly limit/.test(t)) return 'Claude hit its usage limit. Try again after it resets.'
  if (/not logged in|login|log in|authenticate|oauth|token (has )?expired|invalid api key.*login/.test(t)) {
    return 'Claude isn\'t signed in. Open a terminal, run `claude`, then type /login.'
  }
  if (/is not recognized as an internal or external command|enoent|not found|cannot find/.test(t)) {
    return "Dayflow couldn't find Claude Code on this PC."
  }
  if (/credit|billing|api key|blocked|payment|quota/.test(t)) {
    return "Claude's account has a billing or API key problem, so the brief couldn't run."
  }
  if (/model.*(not|isn't|unavailable|invalid|access)|invalid model/.test(t)) return "Your Claude account can't use the model the brief needs."
  if (/econnreset|etimedout|network|socket|overloaded|503|502|529|timeout|fetch failed|connection/.test(t)) {
    return "Dayflow couldn't reach Claude. Try again in a bit."
  }
  if (/json|schema|unexpected token|parse/.test(t)) return SHAPE_ERROR
  return "Claude couldn't finish the brief. Try again."
}

export function statsFromEvents(events: ClaudeEvent[], fallbackModel: string): Partial<DailyBriefRunStats> {
  const env = resultEnvelope(events)
  const usage = (env?.usage ?? {}) as Record<string, number>
  let model: string | undefined
  const mu = env?.modelUsage as Record<string, { outputTokens?: number }> | undefined
  if (mu && Object.keys(mu).length) {
    model = Object.entries(mu).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0][0]
  }
  if (!model) model = (events.find((e) => e.type === 'system')?.model as string | undefined) ?? fallbackModel
  const toolCalls: Record<string, number> = {}
  for (const e of events) {
    if (e.type !== 'assistant') continue
    const content = ((e.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[]
    for (const b of content) {
      if (b.type === 'tool_use' && typeof b.name === 'string' && b.name !== 'StructuredOutput') {
        toolCalls[b.name] = (toolCalls[b.name] ?? 0) + 1
      }
    }
  }
  return {
    model,
    costUSD: typeof env?.total_cost_usd === 'number' ? env.total_cost_usd : undefined,
    numTurns: typeof env?.num_turns === 'number' ? env.num_turns : undefined,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    toolCalls,
  }
}

export function transcriptText(prompt: string, events: ClaudeEvent[], stderr: string, stdout: string): string {
  const parts: string[] = [`# Prompt\n\n${prompt}`]
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'init') {
      const servers = (e.mcp_servers as { name: string; status: string }[] | undefined) ?? []
      parts.push(
        `# Session started\n\nmodel: ${String(e.model ?? '')}\ntools: ${((e.tools as string[]) ?? []).join(', ')}\nconnectors: ${
          servers.map((m) => `${m.name} (${m.status})`).join(', ') || 'none'
        }`,
      )
    } else if (e.type === 'assistant' || e.type === 'user') {
      const content = ((e.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[] | string
      if (typeof content === 'string') continue
      for (const b of content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(`## Claude\n\n${b.text}`)
        else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) parts.push(`## Claude (thinking)\n\n${b.thinking}`)
        else if (b.type === 'tool_use') parts.push(`## Tool call: ${String(b.name)}\n\n${JSON.stringify(b.input ?? {}, null, 2)}`)
        else if (b.type === 'tool_result') {
          const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2)
          parts.push(`## ${b.is_error ? 'Tool error' : 'Tool result'}\n\n${(body ?? '').slice(0, 20000)}`)
        }
      }
    } else if (e.type === 'result') {
      const so = e.structured_output ? JSON.stringify(e.structured_output, null, 2) : String(e.result ?? '')
      parts.push(`# Result\n\n${String(e.subtype ?? '')}\n\n${so}`)
    }
  }
  if (stderr.trim()) parts.push(`# stderr\n\n${stderr}`)
  if (events.length === 0 && stdout.trim()) parts.push(`# Raw output\n\n${stdout}`)
  return parts.join('\n\n---\n\n')
}

// ---- Read-only hook (3b.4) ----

/**
 * Decides whether a PreToolUse call is allowed. Self-contained (no outer references) because its
 * source is embedded verbatim into the hook script that Claude Code runs.
 *
 * Allowlist: `mcp__<server>__<tool>` is split on the first `__` after the server name; the tool
 * part is split into words (snake_case, kebab-case, camelCase, ALLCAPS, digits), and words that
 * repeat the server's own name (e.g. "slack" in `slack_read_channel`) are dropped. The call is
 * allowed only when at least one word is a read verb and EVERY word is a read verb or a known
 * harmless noun. Anything unknown is denied — a missed read tool is a lost source, a missed write
 * tool would break the brief's read-only promise.
 */
export function hookDecision(toolName: string): { allow: boolean } {
  const name = String(toolName || '').trim()
  if (!name.startsWith('mcp__')) return { allow: false }
  const rest = name.slice(5)
  const sep = rest.indexOf('__')
  if (sep <= 0) return { allow: false }
  const server = rest.slice(0, sep)
  const tool = rest.slice(sep + 2)
  const split = (s: string) =>
    s
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
      .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  const serverWords = split(server)
  // Generic web / browser servers take arbitrary URLs: the same exfiltration channel as WebFetch.
  const webServer = 'fetch browser browse puppeteer playwright chrome chromium selenium web http https curl scrape scraper crawl crawler firecrawl url request requests'.split(' ')
  if (serverWords.some((w) => webServer.includes(w))) return { allow: false }
  const words = split(tool).filter((w) => !serverWords.includes(w))
  if (words.length === 0) return { allow: false }
  const deniedDayflow = [
    'create_category', 'delete_category', 'update_category', 'delete_activity', 'update_activity', 'set_day_goal',
  ]
  if (server.toLowerCase() === 'dayflow' && deniedDayflow.includes(tool.toLowerCase())) return { allow: false }
  // "download" is deliberately absent: downloads write files to disk.
  const verbs = 'get list search read fetch query find view retrieve describe lookup show count'.split(' ')
  const nouns = (
    'message messages event events file files issue issues channel channels user users thread threads calendar ' +
    'calendars email emails mail mails inbox page pages document documents doc docs comments comment ' +
    'folder folders drive drives attachment attachments contact contacts task tasks project projects team teams ' +
    'member members profile profiles status statuses history info details detail metadata recent public private ' +
    'workspace workspaces space spaces repo repos repository repositories commits branches labels tags cycles ' +
    'milestones initiatives notifications conversation conversations replies reactions canvas canvases notes ' +
    'meeting meetings timeline observations time breakdown activity activities summary summaries content contents ' +
    'text by id ids for in of from all my me and or with to on at list item items record records data shared ' +
    'database databases table tables row rows sheet sheets spreadsheet spreadsheets slide slides permissions ' +
    'organization organizations org orgs view views board boards card cards ticket tickets'
  ).split(' ')
  if (!words.some((w) => verbs.includes(w))) return { allow: false }
  return { allow: words.every((w) => verbs.includes(w) || nouns.includes(w)) }
}

/**
 * Write-type verbs that are also passed to Claude as `--disallowedTools` glob rules, so the tools
 * disappear from the session even if the hook never runs. Claude Code globs are case-sensitive and
 * `*` spans `__`, so each verb is listed in snake, kebab, camel and ALLCAPS forms, anchored on a
 * separator to avoid catching nouns (`_set` must not match `_settings`). This is a backstop only:
 * a verb missing here is still denied by the hook's allowlist.
 */
const WRITE_VERBS_PREFIX_SAFE = (
  'send delete remove trash create update write upload download publish forward reply execute insert modify ' +
  'upsert rename submit approve merge cancel reschedule invite purge transfer deploy unlink overwrite destroy erase'
).split(' ')
const WRITE_VERBS_ANCHORED = (
  'post set add put run start stop mark save share move edit clear drop pay archive schedule restore exec patch ' +
  'import kill unschedule assign close comment react label tag star pin snooze mute'
).split(' ')

export function mcpWriteDenyRules(): string[] {
  const out = new Set<string>()
  const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1)
  for (const v of [...WRITE_VERBS_PREFIX_SAFE, ...WRITE_VERBS_ANCHORED]) {
    const U = v.toUpperCase()
    for (const r of [`mcp__*_${v}_*`, `mcp__*_${v}`, `mcp__*_${v}-*`, `mcp__*-${v}-*`, `mcp__*-${v}`, `mcp__*_${U}_*`, `mcp__*_${U}`]) out.add(r)
  }
  for (const v of WRITE_VERBS_PREFIX_SAFE) {
    out.add(`mcp__*__${v}*`) // sendMessage, send-email
    out.add(`mcp__*${cap(v)}*`) // slackSendMessage, SendEmail
  }
  return [...out]
}

/** Per-tool counts of `<iso> allow|deny <tool>` lines written by the hook script. */
export function hookLogCounts(log: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of log.split(/\r?\n/)) {
    const m = /^\S+ (?:allow|deny) (\S+)\s*$/.exec(line)
    if (m) out[m[1]] = (out[m[1]] ?? 0) + 1
  }
  return out
}

/**
 * Heartbeat check: every MCP tool call Claude made must have a matching hook log line. A call with
 * no line means the hook didn't run (crashed before logging, timed out, disabled by managed
 * settings, ...) and Claude fell back to the user's own permission rules. Returns the tool names
 * that were called more often than the hook saw them; empty means the guard covered every call.
 */
export function unguardedToolCalls(toolCalls: Record<string, number> | undefined, log: string): string[] {
  const seen = hookLogCounts(log)
  return Object.entries(toolCalls ?? {})
    .filter(([name, n]) => name.startsWith('mcp__') && (seen[name] ?? 0) < n)
    .map(([name]) => name)
}

/** Source of the Node hook script (run with ELECTRON_RUN_AS_NODE=1 by the Electron binary). */
export function hookScriptSource(logFile: string | null): string {
  return `// Dayflow Daily Brief read-only guard (PreToolUse hook). Generated; do not edit.
'use strict'
const hookDecision = ${hookDecision.toString()}
const fs = require('fs')
const LOG = ${JSON.stringify(logFile)}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  let tool = ''
  try { tool = String(JSON.parse(input).tool_name || '') } catch (e) { tool = '' }
  const d = hookDecision(tool)
  if (LOG) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + (d.allow ? 'allow' : 'deny') + ' ' + tool + '\\n') } catch (e) {} }
  if (d.allow) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
    process.exit(0)
  } else {
    process.stderr.write("Dayflow's daily brief can only read from your tools, so " + (tool || 'that tool') + ' was blocked.')
    process.exit(2)
  }
})
`
}

/** Claude permission-rule path form: C:\\Users\\a → //c/Users/a (POSIX form with a leading //). */
export function claudeAbsRulePath(winPath: string): string {
  const p = winPath.replace(/\\/g, '/')
  const m = /^([A-Za-z]):\/(.*)$/.exec(p)
  return m ? `//${m[1].toLowerCase()}/${m[2]}` : `/${p.startsWith('/') ? p : `/${p}`}`
}

// ---- Docket status / hand-offs (3b.8) ----

export function lastHandoff(state: DailyBriefUserState, title: string): HandoffEntry | undefined {
  for (let i = state.handoffs.length - 1; i >= 0; i--) if (state.handoffs[i].title === title) return state.handoffs[i]
  return undefined
}

export function docketStatus(entry: HandoffEntry | undefined): DocketStatus {
  if (!entry) return 'new'
  if (entry.dismissed) return 'dismissed'
  if (entry.reviewed) return 'reviewed'
  if (entry.failed) return 'failed'
  if (entry.method === 'run') return entry.finishedAt ? 'ready' : 'inProgress'
  // Terminal / copy hand-offs have no tracked output: they count as handed over.
  return 'ready'
}

/**
 * Body of the .cmd file a terminal hand-off runs with `cmd /k call "<file>"`. Each value is quoted
 * and `%` is doubled so cmd doesn't expand it; Windows paths can't contain `"`, and `ask` is
 * stripped of quotes and line breaks.
 */
export function terminalScript(cwd: string, commandPath: string, ask: string): string {
  const q = (v: string) => `"${v.replace(/["\r\n]/g, ' ').replace(/%/g, '%%')}"`
  return ['@echo off', 'chcp 65001 >nul', `cd /d ${q(cwd)}`, `call ${q(commandPath)} ${q(ask)}`, ''].join('\r\n')
}

/**
 * Detached runner for background hand-offs, run as `<electron> dayflow-run.js <config.json>` with
 * ELECTRON_RUN_AS_NODE=1. It feeds the prompt file to the agent, writes its output, and always
 * writes `<out>.exit` (the exit code, or -1 when the agent couldn't start), even after Dayflow quits.
 */
export const RUNNER_SOURCE = `// Dayflow background hand-off runner. Generated; do not edit.
'use strict'
const fs = require('fs')
const { spawn } = require('child_process')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
let finished = false
const done = (code) => {
  if (finished) return
  finished = true
  try { fs.writeFileSync(cfg.exitFile, String(code)) } catch (e) {}
  process.exit(0)
}
try {
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const inFd = fs.openSync(cfg.promptFile, 'r')
  const outFd = fs.openSync(cfg.outFile, 'w')
  const opts = { cwd: cfg.cwd, stdio: [inFd, outFd, outFd], windowsHide: true, env }
  const child = cfg.viaShell ? spawn(cfg.shellCommand, Object.assign({ shell: true }, opts)) : spawn(cfg.file, cfg.args, opts)
  fs.closeSync(inFd)
  fs.closeSync(outFd)
  child.on('error', () => done(-1))
  child.on('close', (code) => done(code === null ? -1 : code))
} catch (e) {
  done(-1)
}
`

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  )
}

// ---- Range summary (3b.9) ----

export const RANGE_LABELS: Record<SummaryRange, string> = {
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  quarter_to_date: 'Quarter to date',
  year_to_date: 'Year to date',
}

export function isSummaryRange(v: unknown): v is SummaryRange {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RANGE_LABELS, v)
}

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Calendar-day start of a range (not the 4 AM boundary). */
export function rangeStartDay(range: SummaryRange, now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  switch (range) {
    case 'last_7_days':
      d.setDate(d.getDate() - 7)
      return ymdLocal(d)
    case 'last_30_days':
      d.setDate(d.getDate() - 30)
      return ymdLocal(d)
    case 'quarter_to_date':
      return ymdLocal(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1, 12))
    case 'year_to_date':
      return ymdLocal(new Date(now.getFullYear(), 0, 1, 12))
  }
}

export interface SummaryEntry {
  day: string
  project?: string
  title: string
  apps?: string[]
  imageFile?: string
  briefDay: string
}

export function summaryEntryLines(entries: SummaryEntry[]): string {
  return entries
    .map((e, i) => {
      let l = `[${i}] ${e.day}`
      if (e.project?.trim()) l += ` · ${e.project.trim()}`
      l += ` · ${e.title}`
      if (e.apps?.length) l += ` · apps: ${e.apps.join(', ')}`
      if (e.imageFile) l += ' · (has screenshot)'
      return l
    })
    .join('\n')
}
