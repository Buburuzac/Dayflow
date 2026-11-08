// Card validation ported from GeminiDirectProvider+ActivityCards.swift
// (validateTimeCoverage / validateTimeline / normalizeCategory).

import type { Category } from '../../shared/types.ts'
import { parseClock } from '../time.ts'
import type { ActivityCardData, LlmProjectGuess } from './types.ts'

interface Range {
  start: number
  end: number
}

function toRange(c: ActivityCardData): Range | null {
  const s = parseClock(c.startTime)
  let e = parseClock(c.endTime)
  if (s === null || e === null) return null
  if (e < s) e += 24 * 60
  return { start: s, end: e }
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = Math.floor(minutes) % 60
  const period = h < 12 ? 'AM' : 'PM'
  const dh = h % 12 === 0 ? 12 : h % 12
  return `${dh}:${String(m).padStart(2, '0')} ${period}`
}

/** Output cards must cover every span the previous cards covered (3 minute tolerance). */
export function validateTimeCoverage(existing: ActivityCardData[], next: ActivityCardData[]): string | null {
  if (existing.length === 0) return null
  const input = mergeRanges(existing.map(toRange).filter((r): r is Range => r !== null))
  const output = next
    .map(toRange)
    .filter((r): r is Range => r !== null && r.end - r.start >= 0.1)
  const flex = 3
  const uncovered: Range[] = []
  for (const range of input) {
    let cursor = range.start
    let guard = 10000
    while (cursor < range.end && guard-- > 0) {
      const covering = output.find((o) => o.start - flex <= cursor && cursor <= o.end + flex)
      if (covering) {
        cursor = Math.max(cursor + 0.01, covering.end)
        continue
      }
      let nextCovered = range.end
      for (const o of output) if (o.start > cursor && o.start < nextCovered) nextCovered = o.start
      uncovered.push({ start: cursor, end: Math.min(nextCovered, range.end) })
      cursor = nextCovered
    }
  }
  const significant = uncovered.filter((u) => u.end - u.start > flex)
  if (significant.length === 0) return null
  let msg = `Missing coverage for time segments: ${significant
    .map((u) => `${minutesToClock(u.start)}-${minutesToClock(u.end)} (${Math.floor(u.end - u.start)} min)`)
    .join(', ')}`
  msg += '\n\nINPUT CARDS:'
  existing.forEach((c, i) => (msg += `\n  ${i + 1}. ${c.startTime} - ${c.endTime}: ${c.title}`))
  msg += '\n\nOUTPUT CARDS:'
  next.forEach((c, i) => (msg += `\n  ${i + 1}. ${c.startTime} - ${c.endTime}: ${c.title}`))
  return msg
}

/** Every card except the last must be at least 10 minutes long. */
export function validateDurations(cards: ActivityCardData[]): string | null {
  for (let i = 0; i < cards.length - 1; i++) {
    const r = toRange(cards[i])
    const minutes = r ? r.end - r.start : 0
    if (minutes < 10) return `Card ${i + 1} '${cards[i].title}' is only ${minutes.toFixed(1)} minutes long`
  }
  return null
}

export function normalizeCategory(raw: string, categories: Category[]): string {
  const cleaned = (raw ?? '').trim()
  if (!cleaned) return categories[0]?.name ?? ''
  const lower = cleaned.toLowerCase()
  const match = categories.find((c) => c.name.trim().toLowerCase() === lower)
  if (match) return match.name
  const idle = categories.find((c) => c.isIdle)
  if (idle && ['idle', 'idle time', idle.name.toLowerCase()].includes(lower)) return idle.name
  return categories[0]?.name ?? cleaned
}

function unit(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace('%', '')) / (v.includes('%') ? 100 : 1) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n > 1 && n <= 100 ? n / 100 : n))
}

/**
 * The model's `"projects":[{"name","share","confidence"}]` for one card. Accepts plain strings,
 * percentages and out-of-range numbers; drops nameless entries and keeps the shares' sum ≤ 1.
 */
export function coerceProjectGuesses(raw: unknown): LlmProjectGuess[] {
  if (!Array.isArray(raw)) return []
  const out: LlmProjectGuess[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ name: item.trim(), share: 1, confidence: 0.5 })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : typeof o.project === 'string' ? o.project.trim() : ''
    if (!name) continue
    out.push({ name, share: unit(o.share, 1), confidence: unit(o.confidence, 0.5) })
  }
  const total = out.reduce((s, p) => s + p.share, 0)
  if (total > 1) for (const p of out) p.share = Math.round((p.share / total) * 1000) / 1000
  return out.filter((p) => p.share > 0)
}

/** Coerces loosely-typed model output into ActivityCardData, dropping cards without parseable times. */
export function coerceCards(raw: unknown[], categories: Category[]): ActivityCardData[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  const out: ActivityCardData[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const card: ActivityCardData = {
      startTime: str(o.startTime ?? o.start_time ?? o.start),
      endTime: str(o.endTime ?? o.end_time ?? o.end),
      category: normalizeCategory(str(o.category), categories),
      subcategory: str(o.subcategory),
      title: str(o.title),
      summary: str(o.summary),
      detailedSummary: str(o.detailedSummary ?? o.detailed_summary),
      distractions: Array.isArray(o.distractions)
        ? (o.distractions as Record<string, unknown>[])
            .filter((d) => d && typeof d === 'object')
            .map((d) => ({
              startTime: str(d.startTime),
              endTime: str(d.endTime),
              title: str(d.title),
              summary: str(d.summary),
            }))
        : [],
      appSites:
        o.appSites && typeof o.appSites === 'object'
          ? {
              primary: str((o.appSites as Record<string, unknown>).primary) || null,
              secondary: str((o.appSites as Record<string, unknown>).secondary) || null,
            }
          : undefined,
    }
    if (parseClock(card.startTime) === null || parseClock(card.endTime) === null) continue
    const projects = coerceProjectGuesses(o.projects)
    if (projects.length) card.projects = projects
    out.push(card)
  }
  return out
}
