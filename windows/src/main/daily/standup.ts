// Pure logic for the Daily standup / recap (spec-daily.md §3a). No Electron imports.

import { randomUUID } from 'node:crypto'
import type {
  DailyBulletItem,
  DailyStandupDraft,
  DailyStandupGenerationMetadata,
  StandupPlaceholder,
} from '../../shared/daily-types.ts'
import type { TimelineCard } from '../../shared/types.ts'
import { parseClock, shiftDay } from '../time.ts'

export const DEFAULT_TITLES = {
  highlights: "Yesterday's highlights",
  tasks: "Today's tasks",
  blockers: 'Blockers',
} as const

/**
 * Minimum minutes of activity for a day to be a standup source.
 * The macOS app used 180 min in the scheduler and 120 min in the Daily view; the Windows port
 * deliberately unifies both at 120 minutes so the view and the scheduler always agree.
 */
export const SOURCE_MIN_MINUTES = 120
export const MAX_SOURCE_LOOKBACK_DAYS = 3
export const MAX_AUTOMATIC_ATTEMPTS = 3

export const PLACEHOLDER_MESSAGES: Record<StandupPlaceholder | 'todayNotGenerated', string> = {
  notGenerated: 'Daily data has not been generated yet. If this is unexpected, please report a bug.',
  todayNotGenerated: "Today's daily recap will be generated tomorrow morning.",
  insufficientHistory: 'Not enough captured activity in the previous 3 days to generate a standup.',
  noProviderSelected:
    'No Daily provider is selected. Click the gear button above, then choose a provider to turn recap generation back on.',
}

export function bullet(text: string): DailyBulletItem {
  return { id: randomUUID().toUpperCase(), text }
}

export function placeholderDraft(kind: StandupPlaceholder): DailyStandupDraft {
  const msg = PLACEHOLDER_MESSAGES[kind]
  const insufficient = kind === 'insufficientHistory'
  return {
    highlightsTitle: insufficient ? 'Recent highlights' : DEFAULT_TITLES.highlights,
    highlights: [bullet(msg)],
    tasksTitle: insufficient ? 'Tasks' : DEFAULT_TITLES.tasks,
    tasks: [bullet(msg)],
    blockersTitle: DEFAULT_TITLES.blockers,
    blockersBody: msg,
  }
}

export function hasGeneratedContent(d: DailyStandupDraft): boolean {
  return d.highlights.length > 0 || d.tasks.length > 0 || d.blockersBody.trim().length > 0
}

/** Decodes a stored payload tolerantly. A missing `generation` means a legacy Dayflow-backend row. */
export function decodeDraft(json: string): DailyStandupDraft | null {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const items = (x: unknown): DailyBulletItem[] =>
    Array.isArray(x)
      ? x
          .filter((i) => i && typeof i === 'object' && typeof (i as DailyBulletItem).text === 'string')
          .map((i) => ({
            id: typeof (i as DailyBulletItem).id === 'string' ? (i as DailyBulletItem).id : randomUUID().toUpperCase(),
            text: (i as DailyBulletItem).text,
          }))
      : []
  const gen = o.generation && typeof o.generation === 'object' ? (o.generation as DailyStandupGenerationMetadata) : null
  return {
    highlightsTitle: typeof o.highlightsTitle === 'string' ? o.highlightsTitle : DEFAULT_TITLES.highlights,
    highlights: items(o.highlights),
    tasksTitle: typeof o.tasksTitle === 'string' ? o.tasksTitle : DEFAULT_TITLES.tasks,
    tasks: items(o.tasks),
    blockersTitle: typeof o.blockersTitle === 'string' ? o.blockersTitle : DEFAULT_TITLES.blockers,
    blockersBody: typeof o.blockersBody === 'string' ? o.blockersBody : '',
    generation: gen ?? { provider: 'dayflow', runtime: 'dayflow_backend' },
  }
}

// ---- Source-day resolution (3a.2) ----

export interface SourceDayDeps {
  /** generation.sourceDay of every stored standup except the target day's. */
  consumed: Set<string>
  /** Activity minutes recorded on a logical day. */
  activityMinutes: (day: string) => number
}

export function resolveSourceDay(
  targetDay: string,
  deps: SourceDayDeps,
  minMinutes = SOURCE_MIN_MINUTES,
): string | null {
  for (let offset = 1; offset <= MAX_SOURCE_LOOKBACK_DAYS; offset++) {
    const key = shiftDay(targetDay, -offset)
    if (deps.consumed.has(key)) continue
    if (deps.activityMinutes(key) >= minMinutes) return key
  }
  return null
}

// ---- Text formats (3a.4) ----

/** "9:05 AM" → "9:05am"; unparseable values are lowercased as is. */
export function compactClock(display: string): string {
  const m = parseClock(display)
  if (m === null) return display.toLowerCase()
  const h24 = Math.floor(m / 60)
  const min = m % 60
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(min).padStart(2, '0')}${h24 >= 12 ? 'pm' : 'am'}`
}

/**
 * Cards are sorted by their start/end timestamps. (Swift compares the display strings, which
 * puts "10:05 AM" before "9:05 AM"; the numeric order is what that code intends.)
 */
export function makeCardsText(day: string, cards: Pick<TimelineCard, 'startTs' | 'endTs' | 'startTime' | 'endTime' | 'title' | 'summary'>[]): string {
  if (cards.length === 0) return `No timeline activities were recorded for ${day}.`
  const sorted = [...cards].sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs)
  const lines = [`Timeline activities for ${day}:`, '']
  sorted.forEach((c, i) => {
    const title = c.title.trim() || c.summary.trim() || 'Untitled activity'
    lines.push(`${i + 1}. ${compactClock(c.startTime)} - ${compactClock(c.endTime)}: ${title}`)
    const summary = c.summary.trim()
    if (summary && summary !== title) lines.push(`   ${summary}`)
  })
  return lines.join('\n')
}

// ---- Parsing (3a.5) ----

/**
 * Returns the first balanced {...} object in `text` that parses as a JSON object, tracking strings
 * and escapes. An unclosed or unparseable candidate is skipped and the next opening brace tried.
 */
export function firstBalancedObject(text: string): string | null {
  for (let s = text.indexOf('{'); s >= 0; s = text.indexOf('{', s + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = s; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = text.slice(s, i + 1)
          try {
            const v = JSON.parse(candidate)
            if (v && typeof v === 'object' && !Array.isArray(v)) return candidate
          } catch {
            /* try the next opening brace */
          }
          break
        }
      }
    }
  }
  return null
}

export class RecapParseError extends Error {
  readonly kind: 'invalidJSONResponse' | 'invalidResponseShape' | 'emptyGeneratedContent'
  readonly raw: string
  constructor(kind: RecapParseError['kind'], raw: string) {
    super(
      kind === 'emptyGeneratedContent'
        ? 'The model found nothing worth reporting for that day.'
        : kind === 'invalidResponseShape'
          ? 'The model answered without "done" or "next".'
          : 'The model did not return valid JSON.',
    )
    this.kind = kind
    this.raw = raw
  }
}

function normalizeScalar(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.toLowerCase() === 'null') return null
  return t
}

export interface ParsedRecap {
  done: string[]
  next: string | null
}

export function parseRecapResponse(raw: string): ParsedRecap {
  let text = raw.trim()
  const marker = '---END_THINKING---'
  const mi = text.indexOf(marker)
  if (mi >= 0) text = text.slice(mi + marker.length).trim()
  if (text.startsWith('```')) {
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
    const fence = text.lastIndexOf('\n```')
    if (fence >= 0) text = text.slice(0, fence)
    else if (text.endsWith('```')) text = text.slice(0, -3)
    text = text.trim()
  }
  const candidate = firstBalancedObject(text) ?? text
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new RecapParseError('invalidJSONResponse', raw)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RecapParseError('invalidJSONResponse', raw)
  const o = parsed as Record<string, unknown>
  if (!('done' in o) && !('next' in o)) throw new RecapParseError('invalidResponseShape', raw)

  const doneRaw = o.done === undefined || o.done === null ? [] : Array.isArray(o.done) ? o.done : [o.done]
  const seen = new Set<string>()
  const done: string[] = []
  for (const d of doneRaw) {
    const s = normalizeScalar(d)
    if (s === null || seen.has(s)) continue
    seen.add(s)
    done.push(s)
  }
  let next: string | null = null
  if (Array.isArray(o.next)) {
    for (const n of o.next) {
      const s = normalizeScalar(n)
      if (s !== null) {
        next = s
        break
      }
    }
  } else if (o.next !== null && o.next !== undefined) {
    next = normalizeScalar(o.next)
  }
  return { done: done.slice(0, 5), next }
}

export function draftFromParsed(p: ParsedRecap, generation: DailyStandupGenerationMetadata, raw = ''): DailyStandupDraft {
  const draft: DailyStandupDraft = {
    highlightsTitle: DEFAULT_TITLES.highlights,
    highlights: p.done.map(bullet),
    tasksTitle: DEFAULT_TITLES.tasks,
    tasks: p.next ? [bullet(p.next)] : [],
    blockersTitle: DEFAULT_TITLES.blockers,
    blockersBody: '',
    generation,
  }
  if (!hasGeneratedContent(draft)) throw new RecapParseError('emptyGeneratedContent', raw)
  return draft
}

// ---- Titles (3a.7) ----

/** "Today", "Yesterday", a weekday name for 2–6 days ago, or a date otherwise. */
export function relativeDayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === shiftDay(today, -1)) return 'Yesterday'
  if (day === shiftDay(today, 1)) return 'Tomorrow'
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d, 12)
  for (let i = 2; i <= 6; i++) {
    if (day === shiftDay(today, -i)) return date.toLocaleDateString('en-US', { weekday: 'long' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: y === Number(today.slice(0, 4)) ? undefined : 'numeric' })
}

export function standupTitles(targetDay: string, sourceDay: string | null, today: string) {
  const [y, m, d] = targetDay.split('-').map(Number)
  const dateTitle = new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  return {
    highlights: sourceDay ? `Highlights from ${relativeDayLabel(sourceDay, today)}` : 'Recent highlights',
    tasks: `Tasks for ${relativeDayLabel(targetDay, today)}`,
    blockers: 'Blockers',
    heading: `Standup for ${dateTitle}`,
  }
}

// ---- Clipboard (3a.8) ----

export function isPlaceholderText(text: string): boolean {
  const t = text.trim().toLowerCase()
  return Object.values(PLACEHOLDER_MESSAGES).some((m) => m.toLowerCase() === t)
}

export function standupClipboardText(
  draft: DailyStandupDraft,
  titles: { highlights: string; tasks: string; blockers: string },
): string {
  const section = (title: string, lines: string[], emptyLine: string | null) => {
    const kept = lines.map((l) => l.trim()).filter((l) => l && !isPlaceholderText(l))
    const out = [title]
    if (kept.length) out.push(...kept.map((l) => `- ${l}`))
    else if (emptyLine) out.push(emptyLine)
    return out.join('\n')
  }
  return [
    section(titles.highlights, draft.highlights.map((b) => b.text), '- None right now'),
    section(titles.tasks, draft.tasks.map((b) => b.text), '- None right now'),
    section(titles.blockers, draft.blockersBody.split(/\r?\n/), '- None right now'),
  ].join('\n\n')
}
