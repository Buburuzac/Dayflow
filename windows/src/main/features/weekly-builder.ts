// Pure computation for the Weekly review page (docs/spec-weekly.md §2–§9).
// No Electron imports so it can run under `node --test`.

import type { Category, TimelineCard } from '../../shared/types.ts'
import type {
  Hex,
  WeeklyContextChartsSnapshot,
  WeeklyDashboardSnapshot,
  WeeklyDonutItem,
  WeeklyDonutSnapshot,
  WeeklyFocusHeatmapRow,
  WeeklyFocusHeatmapSnapshot,
  WeeklySankeyFlow,
  WeeklySankeyModel,
  WeeklySankeyNode,
  WeeklySankeySnapshot,
  WeeklySankeySnapshotApp,
  WeeklySankeySnapshotCategory,
  WeeklySankeySnapshotLink,
  WeeklyTimeLabel,
  WeeklyTreemapApp,
  WeeklyTreemapCategory,
  WeeklyTreemapSnapshot,
  WeeklyWorkflowCell,
  WeeklyWorkflowRow,
  WeeklyWorkflowSnapshot,
  WeeklyWorkflowTotalItem,
  SankeyIcon,
  Rect,
} from '../../shared/weekly-types.ts'
import { parseClock } from '../time.ts'

// ---------------------------------------------------------------------------
// Week ranges (§2). Weeks start Monday 04:00 local time.

export interface WeekRange {
  start: Date
  end: Date
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function weekContaining(date: Date): WeekRange {
  const dow = (date.getDay() + 6) % 7 // Monday = 0
  let start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - dow, 4, 0, 0, 0)
  if (date.getTime() < start.getTime()) start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7, 4)
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 4) }
}

/** Week starting on the given Monday ("yyyy-MM-dd"); any other day resolves to its containing week. */
export function weekFromDay(day: string): WeekRange {
  const [y, m, d] = day.split('-').map(Number)
  return weekContaining(new Date(y, m - 1, d, 12))
}

export function shiftWeek(range: WeekRange, weeks: number): WeekRange {
  const s = range.start
  const start = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * weeks, 4)
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 4) }
}

export function weekDayStrings(range: WeekRange): string[] {
  const s = range.start
  return Array.from({ length: 7 }, (_, i) => ymd(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i, 12)))
}

export const toUnix = (d: Date): number => Math.floor(d.getTime() / 1000)

export const DAY_IDS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thur', 'Fri', 'Sat', 'Sun']

// ---------------------------------------------------------------------------
// Keys, colours (§3.3–§3.5)

export const BUILDER_PALETTE = ['93BCFF', 'DE9DFC', '6CDACD', 'FFA189', 'FFC6B7', 'BFB6AE']
export const DONUT_PALETTE = ['93BCFF', 'DE9DFC', '6CDACD', 'FFA189', 'BFB6AE']
export const OTHER_COLOR = 'BFB6AE'

export function normalizedKey(s: string): string {
  return s
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '-')
    .split('-')
    .filter(Boolean)
    .join('_')
}

export function donutKey(s: string): string {
  return s.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function displayName(category: string): string {
  return category.trim() || 'Uncategorized'
}

export function fallbackColorHex(key: string, palette: string[]): string {
  let h = 5381n
  for (const b of new TextEncoder().encode(key)) h = BigInt.asIntN(64, (h << 5n) + h + BigInt(b))
  const a = h < 0n ? -h : h
  return palette[Number(a % BigInt(palette.length))]
}

export function cleanHex(color: string | undefined | null): string {
  const c = (color ?? '').replace(/#/g, '').trim().toUpperCase()
  return c || OTHER_COLOR
}

interface CategoryEntry {
  name: string
  colorHex: string
  order: number
  isIdle: boolean
  isSystem: boolean
}

function categoryLookup(categories: Category[], keyFn: (s: string) => string): Map<string, CategoryEntry> {
  const m = new Map<string, CategoryEntry>()
  categories.forEach((c, order) => {
    const k = keyFn(c.name)
    if (m.has(k)) return
    m.set(k, { name: c.name, colorHex: cleanHex(c.color), order, isIdle: !!c.isIdle, isSystem: k === 'system' })
  })
  return m
}

// ---------------------------------------------------------------------------
// Time (§3.1–§3.2)

export function parseMinute(s: string | null | undefined): number | null {
  if (!s) return null
  return parseClock(s)
}

export function normalizedMinuteRange(start: number, end: number): { start: number; end: number } {
  const s = start < 240 ? start + 1440 : start
  let e = end < 240 ? end + 1440 : end
  if (e <= s) e += 1440
  return { start: s, end: e }
}

// ---------------------------------------------------------------------------
// App identity (§3.8–§3.10)

const FALLBACK_APPS = [
  'ChatGPT', 'Claude', 'Codex', 'Cursor', 'Xcode', 'Dayflow', 'Figma', 'Slack', 'Zoom', 'YouTube', 'Reddit',
  'Substack', 'Notion', 'Linear', 'GitHub', 'Safari', 'Chrome', 'Calendar', 'Mail', 'Messages',
]

const PRETTY_NAMES: [string, string][] = [
  ['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['xcode', 'Xcode'],
  ['dayflow', 'Dayflow'], ['figma', 'Figma'], ['slack', 'Slack'], ['zoom', 'Zoom'], ['meet.google', 'Meet'],
  ['google meet', 'Meet'], ['youtube', 'YouTube'], ['reddit', 'Reddit'], ['twitter', 'X'], ['x.com', 'X'],
  ['substack', 'Substack'], ['notion', 'Notion'], ['linear', 'Linear'], ['github', 'GitHub'], ['safari', 'Safari'],
  ['chrome', 'Chrome'], ['calendar', 'Calendar'], ['mail', 'Mail'], ['messages', 'Messages'], ['maps', 'Maps'],
  ['clickup', 'ClickUp'], ['runway', 'Runway'], ['flora', 'Flora'],
]

const APP_COLORS: [string, string][] = [
  ['chatgpt', '333333'], ['claude', 'D97757'], ['codex', '111111'], ['cursor', '111111'], ['xcode', '4085FD'],
  ['dayflow', 'FF7A2F'], ['figma', 'FF7262'], ['slack', '36C5F0'], ['zoom', '4085FD'], ['meet', '34A853'],
  ['youtube', 'FF0000'], ['reddit', 'FF613C'], ['x', '111111'], ['substack', 'FF6E3E'], ['notion', '111111'],
  ['linear', '5E6AD2'], ['github', '24292F'], ['safari', '2E8BFF'], ['chrome', '4285F4'], ['calendar', 'A29993'],
  ['mail', '4F8EF7'], ['messages', '38D06E'], ['other', 'D9D9D9'],
]

function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

export function fallbackAppName(text: string): string {
  const lower = text.toLowerCase()
  return FALLBACK_APPS.find((c) => lower.includes(c.toLowerCase())) ?? 'Other'
}

export function prettyAppName(source: string): string {
  const lower = source.toLowerCase()
  for (const [needle, name] of PRETTY_NAMES) if (lower.includes(needle)) return name
  const first = source.split(/[,;|\n]/)[0] ?? ''
  const cleaned = first
    .replace(/https:\/\//gi, '')
    .replace(/http:\/\//gi, '')
    .replace(/www\./gi, '')
    .replace(/com\.apple\./gi, '')
    .trim()
  if (!cleaned) return 'Other'
  if (cleaned.includes('.') && !cleaned.includes(' ')) return titleCase(cleaned.split('.')[0] || cleaned)
  return titleCase(cleaned)
}

export function appColorHex(name: string): string {
  const lower = name.toLowerCase()
  for (const [needle, hex] of APP_COLORS) if (lower.includes(needle)) return hex
  return fallbackColorHex(name, BUILDER_PALETTE)
}

export function normalizedHost(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  const alias = (h: string) => (h === 'codex.com' || h === 'codex.so' ? 'chatgpt.com' : h)
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      const u = new URL(s)
      if (u.hostname) return alias(u.hostname)
    } catch {
      /* fall through */
    }
  }
  if (s.includes('/')) {
    try {
      const u = new URL('https://' + s)
      if (u.hostname) return alias(u.hostname)
    } catch {
      /* fall through */
    }
  }
  if (!s.includes('.')) return alias(s + '.com')
  return alias(s)
}

export type AppKind = 'work' | 'personal' | 'distraction'

// ---------------------------------------------------------------------------
// Card facts (§3.6–§3.7)

export interface Interval {
  start: number
  end: number
}

export interface CardFact {
  id: string
  card: TimelineCard
  dayString: string
  dayLabel: string
  dayOrder: number
  startMinute: number
  endMinute: number
  durationMinutes: number
  categoryKey: string
  categoryName: string
  categoryColorHex: Hex
  isSystem: boolean
  isIdle: boolean
  isDistraction: boolean
  isFullDistraction: boolean
  isDistractionBucket: boolean
  appKey: string
  appName: string
  appColorHex: Hex
  appKind: AppKind
  faviconPrimaryRaw: string | null
  faviconSecondaryRaw: string | null
  faviconPrimaryHost: string | null
  faviconSecondaryHost: string | null
  /** Embedded distraction intervals aligned to this card's normalized range */
  embeddedIntervals: Interval[]
}

const hasDistractionWord = (s: string) => s.includes('distraction') || s.includes('distracted')

export function alignedDistractionIntervals(card: TimelineCard, parentStart: number, parentEnd: number): Interval[] {
  const out: Interval[] = []
  for (const d of card.distractions ?? []) {
    const ds = parseMinute(d.startTime)
    const de = parseMinute(d.endTime)
    if (ds === null || de === null) continue
    const n = normalizedMinuteRange(ds, de)
    let best: Interval | null = null
    let bestScore = Infinity
    for (const off of [0, -1440, 1440]) {
      const c = { start: n.start + off, end: n.end + off }
      if (!(c.start >= parentStart - 2 && c.end <= parentEnd + 2 && c.end > c.start)) continue
      const score = Math.abs(c.start - parentStart) + Math.abs(parentEnd - c.end) * 0.1
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
    if (best) out.push(best)
  }
  return out
}

export function buildFacts(cards: TimelineCard[], categories: Category[], range: WeekRange): CardFact[] {
  const lookup = categoryLookup(categories, normalizedKey)
  const days = weekDayStrings(range)
  const facts: CardFact[] = []
  for (const card of cards) {
    const s = parseMinute(card.startTime)
    const e = parseMinute(card.endTime)
    if (s === null || e === null) continue
    const r = normalizedMinuteRange(s, e)
    const duration = Math.max(Math.round(r.end - r.start), 0)
    if (duration === 0) continue

    const trimmed = card.category.trim()
    const categoryKey = normalizedKey(trimmed)
    const cat = lookup.get(categoryKey)
    const categoryName = cat?.name ?? trimmed
    const categoryColorHex = cat ? cat.colorHex : cleanHex(fallbackColorHex(categoryKey, BUILDER_PALETTE))
    const isSystem = !!cat?.isSystem || categoryKey === 'system' || card.isError
    const isIdle = !!cat?.isIdle || categoryKey === 'idle'

    const hasEmbedded = (card.distractions?.length ?? 0) > 0
    const text = `${categoryName} ${card.subcategory} ${card.title} ${card.summary}`.toLowerCase()
    const isDistraction = hasEmbedded || hasDistractionWord(text)
    const catText = `${categoryName} ${card.subcategory}`.toLowerCase()
    const isFullDistraction = hasDistractionWord(catText) ? true : hasEmbedded ? false : isDistraction
    const isDistractionBucket = categoryKey.includes('distraction') || categoryName.toLowerCase().includes('distraction')

    const primary = card.appSites?.primary ?? null
    const secondary = card.appSites?.secondary ?? null
    const rawApp = [primary, secondary].map((x) => (x ?? '').trim()).find((x) => x.length > 0)
    const source = rawApp ?? fallbackAppName(`${card.title} ${card.summary}`)
    const appName = prettyAppName(source)
    const appKey = normalizedKey(appName) || 'other'
    const appColor = appColorHex(appName)

    let appKind: AppKind = 'work'
    if (isDistraction) appKind = 'distraction'
    else {
      const t = `${appName} ${categoryName}`.toLowerCase()
      if (['youtube', 'reddit', 'x', 'twitter', 'tiktok', 'netflix', 'game'].some((n) => t.includes(n))) appKind = 'distraction'
      else if (['personal', 'shopping', 'maps', 'messages', 'photos', 'music'].some((n) => t.includes(n))) appKind = 'personal'
    }

    const dayIndex = days.indexOf(card.day)
    facts.push({
      id: card.id ? `card-${card.id}` : `${card.day}-${r.start}-${r.end}-${normalizedKey(card.title)}`,
      card,
      dayString: card.day,
      dayLabel: dayIndex >= 0 ? DAY_LABELS[dayIndex] : '',
      dayOrder: dayIndex >= 0 ? dayIndex : Infinity,
      startMinute: r.start,
      endMinute: r.end,
      durationMinutes: duration,
      categoryKey,
      categoryName,
      categoryColorHex,
      isSystem,
      isIdle,
      isDistraction,
      isFullDistraction,
      isDistractionBucket,
      appKey,
      appName,
      appColorHex: appColor,
      appKind,
      faviconPrimaryRaw: primary,
      faviconSecondaryRaw: secondary,
      faviconPrimaryHost: normalizedHost(primary),
      faviconSecondaryHost: normalizedHost(secondary),
      embeddedIntervals: hasEmbedded ? alignedDistractionIntervals(card, r.start, r.end) : [],
    })
  }
  facts.sort((a, b) => {
    if (a.dayOrder !== b.dayOrder) {
      if (a.dayOrder === Infinity) return 1
      if (b.dayOrder === Infinity) return -1
      return a.dayOrder - b.dayOrder
    }
    return a.startMinute - b.startMinute
  })
  return facts
}

export const isVisible = (f: CardFact) => !f.isSystem && !f.isIdle

export function distractedMinutes(facts: CardFact[]): number {
  let total = 0
  for (const f of facts) {
    if (f.isFullDistraction) total += f.endMinute - f.startMinute
    else for (const iv of f.embeddedIntervals) total += iv.end - iv.start
  }
  return total
}

// ---------------------------------------------------------------------------
// Formatting helpers

export function durationText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h > 0 && r > 0) return `${h}h ${r}m`
  if (h > 0) return `${h}h`
  return `${r}m`
}

/** Gate format: "0h" when <= 0. */
export function gateDurationText(minutes: number): string {
  if (minutes <= 0) return '0h'
  return durationText(minutes)
}

export function treemapDurationText(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h > 0 && r > 0) return `${h}hr ${r}m`
  if (h > 0) return `${h}hr`
  return `${r}m`
}

function clockDate(minute: number): Date {
  const m = Math.round(minute)
  return new Date(2000, 0, 1, Math.floor(m / 60) % 24, m % 60)
}

export function hourAxisLabel(minute: number, locale?: string): string {
  const d = clockDate(minute)
  if (d.getMinutes() === 0) return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).format(d)
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d)
}

export function shortTime(minute: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(clockDate(minute))
}

// ---------------------------------------------------------------------------
// Time window (§3.11)

export function weeklyActivityWindow(visible: CardFact[]): { start: number; end: number } {
  if (visible.length === 0) return { start: 540, end: 1320 }
  const minStart = Math.min(...visible.map((f) => f.startMinute))
  const maxEnd = Math.max(...visible.map((f) => f.endMinute))
  const paddedStart = Math.max(240, minStart - 30)
  const paddedEnd = Math.min(1680, maxEnd + 30)
  const start = Math.floor(paddedStart / 15) * 15
  let end = Math.ceil(paddedEnd / 15) * 15
  if (end === 1440) end = 1680
  if (end <= start) return { start: 540, end: 1320 }
  return { start, end }
}

export function timeLabels(start: number, end: number, locale?: string): WeeklyTimeLabel[] {
  const out: WeeklyTimeLabel[] = []
  for (let m = Math.ceil(start / 60) * 60; m <= Math.floor(end / 60) * 60; m += 60) {
    out.push({ id: `time-${m}`, label: hourAxisLabel(m, locale), minute: m })
  }
  return out
}

// ---------------------------------------------------------------------------
// Donut (§4)

export function buildDonut(cards: TimelineCard[], categories: Category[], range: WeekRange): WeeklyDonutSnapshot {
  const lookup = categoryLookup(categories, donutKey)
  const days = new Set(weekDayStrings(range))
  const acc = new Map<string, { name: string; colorHex: string; order: number; minutes: number }>()
  for (const card of cards) {
    if (!days.has(card.day) || card.isError) continue
    const name = displayName(card.category)
    const key = donutKey(name)
    const cat = lookup.get(key)
    if (key === 'system' || key === 'idle' || cat?.isSystem || cat?.isIdle) continue
    const s = parseMinute(card.startTime)
    const e = parseMinute(card.endTime)
    if (s === null || e === null) continue
    const r = normalizedMinuteRange(s, e)
    const minutes = Math.max(Math.round(r.end - r.start), 0)
    if (minutes <= 0) continue
    const cur = acc.get(key)
    if (cur) cur.minutes += minutes
    else
      acc.set(key, {
        name: cat?.name ?? name,
        colorHex: cat ? cat.colorHex : fallbackColorHex(key, DONUT_PALETTE),
        order: cat?.order ?? Infinity,
        minutes,
      })
  }
  const raw = [...acc.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort(
      (a, b) =>
        b.minutes - a.minutes ||
        (a.order === b.order ? 0 : a.order < b.order ? -1 : 1) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    )
  if (raw.length === 0) return { items: [], totalMinutes: 0 }
  let items: WeeklyDonutItem[] = raw.map((r) => ({ id: r.id, name: r.name, colorHex: r.colorHex, minutes: r.minutes }))
  if (items.length > 5) {
    const rest = items.slice(4).reduce((s, i) => s + i.minutes, 0)
    items = [...items.slice(0, 4), { id: 'other', name: 'Other', colorHex: OTHER_COLOR, minutes: rest }]
  }
  return { items, totalMinutes: items.reduce((s, i) => s + i.minutes, 0) }
}

// ---------------------------------------------------------------------------
// Context charts (§5)

export function buildContextCharts(facts: CardFact[], range: WeekRange): WeeklyContextChartsSnapshot {
  const days = weekDayStrings(range)
  const out = days.map((day, i) => {
    const dayFacts = facts.filter((f) => f.dayString === day && isVisible(f)).sort((a, b) => a.startMinute - b.startMinute)
    let shifts = 0
    for (let j = 1; j < dayFacts.length; j++) if (dayFacts[j].categoryKey !== dayFacts[j - 1].categoryKey) shifts++
    let distracted = 0
    for (const f of dayFacts) {
      if ((f.card.distractions?.length ?? 0) > 0) {
        for (const d of f.card.distractions) if (parseMinute(d.startTime) !== null) distracted++
      } else if (f.isDistraction) distracted++
    }
    return { day: DAY_LABELS[i], distracted, shifts }
  })
  let best = 0
  out.forEach((d, i) => {
    if (d.distracted + d.shifts > out[best].distracted + out[best].shifts) best = i
  })
  const top = out[best]
  const insight =
    top.distracted + top.shifts === 0
      ? 'No context shift or distraction pattern was detected in this week.'
      : `${top.day} had the most interruptions, with ${top.shifts} context shifts and ${top.distracted} distractions.`
  return { comparison: { days: out, insight } }
}

// ---------------------------------------------------------------------------
// Workflow grid (§6)

function workflowBucket(f: CardFact): { id: string; name: string; color: string } {
  if (f.isDistractionBucket) return { id: 'distraction', name: 'Distraction', color: 'FF5950' }
  return { id: f.categoryKey, name: f.categoryName, color: f.categoryColorHex }
}

export function buildWorkflow(facts: CardFact[], range: WeekRange, locale?: string): WeeklyWorkflowSnapshot {
  const visible = facts.filter(isVisible)
  const win = weeklyActivityWindow(visible)
  const slotCount = Math.max(1, Math.floor((win.end - win.start) / 15))
  const days = weekDayStrings(range)
  const rows: WeeklyWorkflowRow[] = days.map((day, di) => {
    const dayFacts = visible.filter((f) => f.dayString === day)
    const cells: WeeklyWorkflowCell[] = []
    for (let i = 0; i < slotCount; i++) {
      const s = win.start + 15 * i
      const e = s + 15
      const buckets = new Map<string, { name: string; color: string; minutes: number }>()
      let sum = 0
      for (const f of dayFacts) {
        const overlap = Math.max(0, Math.min(f.endMinute, e) - Math.max(f.startMinute, s))
        if (overlap <= 0) continue
        const b = workflowBucket(f)
        const cur = buckets.get(b.id)
        if (cur) cur.minutes += overlap
        else buckets.set(b.id, { name: b.name, color: b.color, minutes: overlap })
        sum += overlap
      }
      const id = `${DAY_IDS[di]}-${i}`
      if (sum <= 0) {
        cells.push({ id, categoryName: null, colorHex: null, minutes: 0, occupancy: 0 })
        continue
      }
      const dominant = [...buckets.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))[0]
      cells.push({ id, categoryName: dominant.name, colorHex: dominant.color, minutes: Math.round(sum), occupancy: Math.min(1, sum / 15) })
    }
    return { id: DAY_IDS[di], label: DAY_LABELS[di], cells }
  })
  const totalsMap = new Map<string, { name: string; color: string; minutes: number }>()
  for (const f of visible) {
    const b = workflowBucket(f)
    const cur = totalsMap.get(b.id)
    if (cur) cur.minutes += f.durationMinutes
    else totalsMap.set(b.id, { name: b.name, color: b.color, minutes: f.durationMinutes })
  }
  const totals: WeeklyWorkflowTotalItem[] = [...totalsMap.entries()]
    .filter(([, v]) => v.minutes > 0)
    .sort((a, b) => b[1].minutes - a[1].minutes || a[1].name.localeCompare(b[1].name))
    .slice(0, 7)
    .map(([id, v]) => ({ id, name: v.name, minutes: v.minutes, duration: durationText(v.minutes), colorHex: v.color }))
  return {
    title: 'Your workflow this week',
    startMinute: win.start,
    endMinute: win.end,
    slotMinutes: 15,
    timeLabels: timeLabels(win.start, win.end, locale),
    rows,
    totals,
  }
}

// ---------------------------------------------------------------------------
// Heatmap (§7)

function addInterval(values: number[], winStart: number, bucket: number, rawStart: number, rawEnd: number, w = 1): void {
  const winEnd = winStart + values.length * bucket
  const s = Math.max(rawStart, winStart)
  const e = Math.min(rawEnd, winEnd)
  if (!(e > s)) return
  const first = Math.max(0, Math.floor((s - winStart) / bucket))
  const last = Math.min(values.length - 1, Math.ceil((e - winStart) / bucket) - 1)
  for (let i = first; i <= last; i++) {
    const bs = winStart + i * bucket
    const overlap = Math.max(0, Math.min(e, bs + bucket) - Math.max(s, bs))
    values[i] += overlap * w
  }
}

export function runLengths(values: boolean[]): number[] {
  const out = new Array<number>(values.length).fill(0)
  let i = 0
  while (i < values.length) {
    if (!values[i]) {
      i++
      continue
    }
    let j = i
    while (j < values.length && values[j]) j++
    for (let k = i; k < j; k++) out[k] = j - i
    i = j
  }
  return out
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function heatmapScores(focus: number[], distraction: number[], switches: number[], bucket: number): number[] {
  const clean = focus.map((f, i) => f >= bucket * 0.6 && distraction[i] < 1)
  const runs = runLengths(clean)
  const raw = focus.map((f, i) => {
    const focusRatio = clamp(f / bucket, 0, 1)
    const distRatio = clamp(distraction[i] / bucket, 0, 1)
    const sustained = Math.min(1, runs[i] / 6)
    const focusStrength = focusRatio * (0.35 + 0.65 * sustained)
    const distractionStrength = Math.min(1, distRatio * 1.25)
    const switchStrength = Math.min(1, switches[i] / 2) * 0.22
    return clamp(distractionStrength + switchStrength - focusStrength, -1, 1)
  })
  if (raw.length <= 2) return raw
  return raw.map((v, i) => {
    if (!(v < 0)) return v
    const neigh = raw.slice(Math.max(0, i - 1), Math.min(raw.length - 1, i + 1) + 1).filter((x) => x < 0)
    if (neigh.length <= 1) return v
    const avg = neigh.reduce((s, x) => s + x, 0) / neigh.length
    return clamp(v * 0.55 + avg * 0.45, -1, 1)
  })
}

export function buildHeatmap(facts: CardFact[], range: WeekRange, locale?: string): WeeklyFocusHeatmapSnapshot {
  const visible = facts.filter(isVisible)
  const win = weeklyActivityWindow(visible)
  const bucket = 5
  const count = Math.max(1, Math.ceil((win.end - win.start) / bucket))
  const endMinute = win.start + bucket * count
  const days = weekDayStrings(range)
  const rows: WeeklyFocusHeatmapRow[] = [6, 0, 1, 2, 3, 4, 5].map((offset) => {
    const dayFacts = visible.filter((f) => f.dayString === days[offset]).sort((a, b) => a.startMinute - b.startMinute)
    const focus = new Array<number>(count).fill(0)
    const dist = new Array<number>(count).fill(0)
    const sw = new Array<number>(count).fill(0)
    let prev: CardFact | null = null
    for (const f of dayFacts) {
      if (prev && f.startMinute - prev.endMinute <= 20 && `${f.categoryKey}|${f.appKey}` !== `${prev.categoryKey}|${prev.appKey}`) {
        if (f.startMinute >= win.start && f.startMinute < endMinute) {
          const idx = Math.floor((f.startMinute - win.start) / bucket)
          if (idx >= 0 && idx < count) sw[idx] += 1
        }
      }
      if (f.isFullDistraction) addInterval(dist, win.start, bucket, f.startMinute, f.endMinute)
      else {
        addInterval(focus, win.start, bucket, f.startMinute, f.endMinute)
        for (const iv of f.embeddedIntervals) {
          addInterval(dist, win.start, bucket, iv.start, iv.end)
          addInterval(focus, win.start, bucket, iv.start, iv.end, -1)
        }
      }
      prev = f
    }
    return { id: DAY_IDS[offset], label: DAY_LABELS[offset], values: heatmapScores(focus, dist, sw, bucket) }
  })
  return {
    title: 'Focus and distraction heat map',
    focusedLabel: 'Focused work',
    distractedLabel: 'Distracted',
    startMinute: win.start,
    endMinute,
    bucketMinutes: bucket,
    timeLabels: timeLabels(win.start, endMinute, locale),
    rows,
  }
}

// ---------------------------------------------------------------------------
// Treemap (§8, data only — layout happens in the renderer)

const hasFaviconField = (f: CardFact) =>
  [f.faviconPrimaryRaw, f.faviconSecondaryRaw, f.faviconPrimaryHost, f.faviconSecondaryHost].some((x) => (x ?? '').trim() !== '')

export function buildTreemap(facts: CardFact[], previousFacts: CardFact[]): WeeklyTreemapSnapshot {
  const prev = new Map<string, number>()
  for (const f of previousFacts.filter(isVisible)) {
    const k = `${f.categoryKey}|${f.appKey}`
    prev.set(k, (prev.get(k) ?? 0) + f.durationMinutes)
  }
  const byCat = new Map<string, CardFact[]>()
  for (const f of facts.filter(isVisible)) {
    const list = byCat.get(f.categoryKey)
    if (list) list.push(f)
    else byCat.set(f.categoryKey, [f])
  }
  const categories: (WeeklyTreemapCategory & { total: number })[] = []
  for (const [catKey, catFacts] of byCat) {
    const byApp = new Map<string, CardFact[]>()
    for (const f of catFacts) {
      const l = byApp.get(f.appKey)
      if (l) l.push(f)
      else byApp.set(f.appKey, [f])
    }
    const apps: WeeklyTreemapApp[] = []
    for (const [appKey, appFacts] of byApp) {
      const minutes = appFacts.reduce((s, f) => s + f.durationMinutes, 0)
      const src = appFacts.find(hasFaviconField) ?? appFacts[0]
      const p = prev.get(`${catKey}|${appKey}`) ?? 0
      let change: WeeklyTreemapApp['change'] = null
      if (p !== 0) {
        const delta = minutes - p
        change =
          delta > 0
            ? { text: `+ ${delta}m`, kind: 'positive' }
            : delta < 0
              ? { text: `- ${Math.abs(delta)}m`, kind: 'negative' }
              : { text: '0m', kind: 'neutral' }
      }
      apps.push({
        id: `${catKey}-${appKey}`,
        name: src.appName,
        colorHex: src.appColorHex,
        durationSeconds: minutes * 60,
        change,
        isAggregate: false,
        isPlaceholder: false,
        faviconPrimaryRaw: src.faviconPrimaryRaw,
        faviconSecondaryRaw: src.faviconSecondaryRaw,
        faviconPrimaryHost: src.faviconPrimaryHost,
        faviconSecondaryHost: src.faviconSecondaryHost,
      })
    }
    apps.sort((a, b) => Math.max(b.durationSeconds, 1) - Math.max(a.durationSeconds, 1) || a.name.localeCompare(b.name))
    const kept = apps.slice(0, 8)
    categories.push({
      id: catKey,
      name: catFacts[0].categoryName,
      colorHex: catFacts[0].categoryColorHex,
      apps: kept,
      total: kept.reduce((s, a) => s + a.durationSeconds, 0),
    })
  }
  categories.sort((a, b) => Math.max(b.total, 1) - Math.max(a.total, 1) || a.name.localeCompare(b.name))
  return {
    title: 'Most used per category',
    categories: categories.slice(0, 5).map(({ total: _t, ...c }) => c),
  }
}

// ---------------------------------------------------------------------------
// Sankey snapshot (§9.1)

interface Bucket {
  key: string
  name: string
  color: string
  minutes: number
}

function visibleBuckets(
  facts: CardFact[],
  keyOf: (f: CardFact) => string,
  nameOf: (f: CardFact) => string,
  colorOf: (f: CardFact) => string,
  maxVisible: number,
): { buckets: Bucket[]; map: (key: string) => string } {
  const m = new Map<string, Bucket>()
  for (const f of facts) {
    const k = keyOf(f)
    const b = m.get(k)
    if (b) b.minutes += f.durationMinutes
    else m.set(k, { key: k, name: nameOf(f), color: colorOf(f), minutes: f.durationMinutes })
  }
  let sorted = [...m.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))
  if (sorted.length > maxVisible) {
    let overflow = sorted.slice(maxVisible - 1).reduce((s, b) => s + b.minutes, 0)
    let kept = sorted.slice(0, maxVisible - 1)
    const existingOther = kept.find((b) => b.key === 'other')
    if (existingOther) {
      overflow += existingOther.minutes
      kept = kept.filter((b) => b.key !== 'other')
    }
    sorted = [...kept, { key: 'other', name: 'Other', color: OTHER_COLOR, minutes: overflow }]
  }
  const set = new Set(sorted.map((b) => b.key))
  return { buckets: sorted, map: (k) => (set.has(k) ? k : 'other') }
}

export function buildSankey(facts: CardFact[], range: WeekRange, locale?: string): WeeklySankeySnapshot {
  const visible = facts.filter(isVisible)
  const startFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  const s = range.start
  const sourceName = `${startFmt.format(s)}-${startFmt.format(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6, 12))}`
  if (visible.length === 0) return { id: 'empty-weekly-sankey', sourceName, categories: [], apps: [], links: [] }
  const cats = visibleBuckets(visible, (f) => f.categoryKey, (f) => f.categoryName, (f) => f.categoryColorHex, 6)
  const apps = visibleBuckets(visible, (f) => f.appKey, (f) => f.appName, (f) => f.appColorHex, 10)
  const linkMap = new Map<string, number>()
  for (const f of visible) {
    const k = `${cats.map(f.categoryKey)}|${apps.map(f.appKey)}`
    linkMap.set(k, (linkMap.get(k) ?? 0) + f.durationMinutes)
  }
  const links: WeeklySankeySnapshotLink[] = [...linkMap.entries()]
    .filter(([, m]) => m > 0)
    .map(([k, minutes]) => {
      const [from, to] = k.split('|')
      return { id: `${from}-${to}`, from, to, minutes }
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : b.minutes - a.minutes))
  const categories: WeeklySankeySnapshotCategory[] = cats.buckets.map((b) => ({
    id: b.key,
    name: b.name,
    minutes: b.minutes,
    colorHex: b.color,
  }))
  const appItems: WeeklySankeySnapshotApp[] = apps.buckets.map((b) => {
    const src = visible.find((f) => f.appKey === b.key && hasFaviconField(f)) ?? visible.find((f) => f.appKey === b.key)
    return {
      id: b.key,
      name: b.name,
      minutes: b.minutes,
      colorHex: b.color,
      faviconPrimaryRaw: src?.faviconPrimaryRaw ?? null,
      faviconSecondaryRaw: src?.faviconSecondaryRaw ?? null,
      faviconPrimaryHost: src?.faviconPrimaryHost ?? null,
      faviconSecondaryHost: src?.faviconSecondaryHost ?? null,
    }
  })
  return { id: `weekly-sankey-${ymd(range.start)}`, sourceName, categories, apps: appItems, links }
}

// ---------------------------------------------------------------------------
// Sankey model (§9.2), virtual canvas 1748 x 933

interface ColumnSpec {
  x: number
  width: number
  top: number
  bottom: number
  gap: number
  minHeight: number
  labelX: number
  labelTop: number
  labelBottom: number
  labelWidth: number
  labelHeight: number
  labelSpacing: number
}

export const SANKEY_LAYOUT = {
  width: 1748,
  height: 933,
  source: { x: 72, width: 12, top: 273, bottom: 706, gap: 0, minHeight: 0, labelX: 105, labelTop: 0, labelBottom: 0, labelWidth: 220, labelHeight: 52, labelSpacing: 0 },
  categories: { x: 760, width: 12, top: 126, bottom: 828, gap: 20, minHeight: 40, labelX: 802, labelTop: 64, labelBottom: 874, labelWidth: 260, labelHeight: 54, labelSpacing: 12 },
  apps: { x: 1334, width: 12, top: 54, bottom: 928, gap: 20, minHeight: 28, labelX: 1372, labelTop: 38, labelBottom: 923, labelWidth: 330, labelHeight: 56, labelSpacing: 10 },
} satisfies Record<string, ColumnSpec | number>

export function sankeyDuration(minutes: number): string {
  const m = Math.max(0, minutes)
  const h = Math.floor(m / 60)
  return h <= 0 ? `${m % 60}min` : `${h}hr ${m % 60}min`
}

export function sankeyPercent(minutes: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.max(1, Math.round((minutes / total) * 100))}%`
}

interface BandInput {
  id: string
  name: string
  minutes: number
  colorHex: string
  icon: SankeyIcon
}
interface Band extends BandInput {
  bar: Rect
  label: { x: number; y: number; width: number }
}

const midY = (r: Rect) => r.y + r.height / 2

function allocateBands(items: BandInput[], spec: ColumnSpec): Band[] {
  if (items.length === 0) return []
  const n = items.length
  const available = Math.max(n * spec.minHeight, spec.bottom - spec.top - spec.gap * Math.max(0, n - 1))
  const total = items.reduce((s, i) => s + i.minutes, 0)
  const flexible = Math.max(0, available - spec.minHeight * n)
  let cursor = spec.top
  return items.map((item) => {
    const h = total > 0 ? spec.minHeight + (flexible * item.minutes) / total : spec.minHeight + flexible / n
    const band: Band = { ...item, bar: { x: spec.x, y: cursor, width: spec.width, height: h }, label: { x: 0, y: 0, width: 0 } }
    cursor += h + spec.gap
    return band
  })
}

function allocateStack<T extends { minutes: number }>(items: T[], top: number, height: number): (T & { top: number; bottom: number })[] {
  const total = items.reduce((s, i) => s + i.minutes, 0)
  let cursor = top
  return items.map((item) => {
    const h = total > 0 ? (item.minutes / total) * height : height / Math.max(items.length, 1)
    const seg = { ...item, top: cursor, bottom: cursor + h }
    cursor += h
    return seg
  })
}

export function placeLabels(nodes: Band[], spec: ColumnSpec): Band[] {
  const sorted = [...nodes].sort((a, b) => midY(a.bar) - midY(b.bar))
  const placed = sorted.map((n) => ({ ...n, label: { ...n.label } }))
  let cursor = spec.labelTop
  for (const n of placed) {
    const y = Math.max(midY(n.bar) - spec.labelHeight / 2, cursor)
    n.label = { x: spec.labelX, y, width: spec.labelWidth }
    cursor = y + spec.labelHeight + spec.labelSpacing
  }
  const last = placed.length - 1
  if (last >= 0) {
    const overflow = placed[last].label.y + spec.labelHeight - spec.labelBottom
    if (overflow > 0) {
      placed[last].label.y -= overflow
      for (let i = last - 1; i >= 0; i--) {
        placed[i].label.y = Math.min(placed[i].label.y, placed[i + 1].label.y - spec.labelHeight - spec.labelSpacing)
      }
      if (placed[0].label.y < spec.labelTop) {
        placed[0].label.y = spec.labelTop
        for (let i = 1; i <= last; i++) {
          placed[i].label.y = Math.max(placed[i].label.y, placed[i - 1].label.y + spec.labelHeight + spec.labelSpacing)
        }
      }
    }
  }
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  return placed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

function appIcon(app: WeeklySankeySnapshotApp): SankeyIcon {
  const lookup = `${app.id} ${app.name}`.toLowerCase()
  if (app.id === 'x' || app.name.toLowerCase() === 'x' || lookup.includes('twitter')) {
    return { type: 'monogram', text: 'X', backgroundHex: '000000', foregroundHex: 'FFFFFF' }
  }
  // Privacy-first: favicons are never fetched; every app gets a monogram in its colour.
  return {
    type: 'monogram',
    text: (app.name.trim()[0] ?? '?').toUpperCase(),
    backgroundHex: app.id === 'other' ? 'BFB6AE' : app.colorHex,
    foregroundHex: 'FFFFFF',
  }
}

export function buildSankeyModel(snapshot: WeeklySankeySnapshot): WeeklySankeyModel {
  const L = SANKEY_LAYOUT
  const total = snapshot.categories.reduce((s, c) => s + c.minutes, 0)
  const links = snapshot.links
  const apps: BandInput[] = snapshot.apps.map((a) => ({
    id: a.id,
    name: a.name,
    minutes: a.minutes > 0 ? a.minutes : links.filter((l) => l.to === a.id).reduce((s, l) => s + l.minutes, 0),
    colorHex: a.colorHex,
    icon: appIcon(a),
  }))
  const catBands = allocateBands(
    snapshot.categories.map((c) => ({ id: c.id, name: c.name, minutes: c.minutes, colorHex: c.colorHex, icon: { type: 'none' } })),
    L.categories,
  )
  const catById = new Map(catBands.map((b) => [b.id, b]))
  const bary = new Map<string, number>()
  for (const a of apps) {
    const incoming = links.filter((l) => l.to === a.id)
    let w = 0
    for (const l of incoming) {
      const c = catById.get(l.from)
      if (c) w += midY(c.bar) * l.minutes
    }
    const t = incoming.reduce((s, l) => s + l.minutes, 0)
    bary.set(a.id, t > 0 ? w / t : 999)
  }
  const orderedApps = apps
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      if (x.a.id === 'other' && y.a.id !== 'other') return 1
      if (y.a.id === 'other' && x.a.id !== 'other') return -1
      return (bary.get(x.a.id) ?? 999) - (bary.get(y.a.id) ?? 999) || x.i - y.i
    })
    .map((x) => x.a)
  const appBands = allocateBands(orderedApps, L.apps)
  const appById = new Map(appBands.map((b) => [b.id, b]))

  const sourceBar: Rect = { x: L.source.x, y: L.source.top, width: L.source.width, height: L.source.bottom - L.source.top }
  const source: WeeklySankeyNode = {
    id: 'source-weekly-activity',
    name: snapshot.sourceName,
    metric: sankeyDuration(total),
    percent: '100%',
    minutes: total,
    barColorHex: 'D9CBC0',
    icon: { type: 'none' },
    bar: sourceBar,
    label: { x: L.source.labelX, y: midY(sourceBar) - L.source.labelHeight / 2, width: L.source.labelWidth },
  }

  const sourceSegs = new Map(
    allocateStack(catBands.map((c) => ({ id: c.id, minutes: c.minutes })), sourceBar.y, sourceBar.height).map((s) => [s.id, s]),
  )
  const flows: WeeklySankeyFlow[] = []
  for (const c of catBands) {
    const seg = sourceSegs.get(c.id)
    if (!seg) continue
    flows.push({
      id: `source-${c.id}`,
      from: source.id,
      to: c.id,
      fromColorHex: source.barColorHex,
      toColorHex: c.colorHex,
      x0: sourceBar.x + sourceBar.width,
      y0Top: seg.top,
      y0Bottom: seg.bottom,
      x1: c.bar.x,
      y1Top: c.bar.y,
      y1Bottom: c.bar.y + c.bar.height,
      curveTension: 0.15,
      opacity: 0.14 + 0.08 * Math.sqrt(c.minutes / Math.max(total, 1)),
    })
  }

  const maxLink = Math.max(Math.max(0, ...links.map((l) => l.minutes)), 1)
  const catSegs = new Map<string, { top: number; bottom: number }>()
  const appSegs = new Map<string, { top: number; bottom: number }>()
  for (const c of catBands) {
    const out = links
      .filter((l) => l.from === c.id)
      .sort((a, b) => (appById.get(a.to)?.bar.y ?? 0) - (appById.get(b.to)?.bar.y ?? 0))
    for (const s of allocateStack(out, c.bar.y, c.bar.height)) catSegs.set(s.id, s)
  }
  for (const a of appBands) {
    const inc = links
      .filter((l) => l.to === a.id)
      .sort((x, y) => (catById.get(x.from)?.bar.y ?? 0) - (catById.get(y.from)?.bar.y ?? 0))
    for (const s of allocateStack(inc, a.bar.y, a.bar.height)) appSegs.set(s.id, s)
  }
  for (const l of links) {
    const c = catById.get(l.from)
    const a = appById.get(l.to)
    const cs = catSegs.get(l.id)
    const as = appSegs.get(l.id)
    if (!c || !a || !cs || !as) continue
    flows.push({
      id: l.id,
      from: l.from,
      to: l.to,
      fromColorHex: c.colorHex,
      toColorHex: a.colorHex,
      x0: c.bar.x + c.bar.width,
      y0Top: cs.top,
      y0Bottom: cs.bottom,
      x1: a.bar.x,
      y1Top: as.top,
      y1Bottom: as.bottom,
      curveTension: 0.42,
      opacity: 0.08 + 0.18 * Math.sqrt(l.minutes / maxLink),
    })
  }

  const toNode = (b: Band): WeeklySankeyNode => ({
    id: b.id,
    name: b.name,
    metric: sankeyDuration(b.minutes),
    percent: sankeyPercent(b.minutes, total),
    minutes: b.minutes,
    barColorHex: b.colorHex,
    icon: b.icon,
    bar: b.bar,
    label: b.label,
  })
  return {
    id: snapshot.id,
    source,
    categories: placeLabels(catBands, L.categories).map(toNode),
    apps: placeLabels(appBands, L.apps).map(toNode),
    flows,
  }
}

// ---------------------------------------------------------------------------
// Whole dashboard

export function buildDashboard(
  cards: TimelineCard[],
  previousCards: TimelineCard[],
  categories: Category[],
  range: WeekRange,
  locale?: string,
): WeeklyDashboardSnapshot {
  const facts = buildFacts(cards, categories, range)
  const prevFacts = buildFacts(previousCards, categories, shiftWeek(range, -1))
  const sankey = buildSankey(facts, range, locale)
  return {
    donut: buildDonut(cards, categories, range),
    contextCharts: buildContextCharts(facts, range),
    workflow: buildWorkflow(facts, range, locale),
    heatmap: buildHeatmap(facts, range, locale),
    treemap: buildTreemap(facts, prevFacts),
    sankey,
    sankeyModel: buildSankeyModel(sankey),
  }
}

/** Recorded minutes for the per-week gate (§1.1.2): cards starting in the week, excluding System. */
export function recordedMinutesFor(cards: TimelineCard[], range: WeekRange): number {
  const s = toUnix(range.start)
  const e = toUnix(range.end)
  let secs = 0
  for (const c of cards) if (c.startTs >= s && c.startTs < e && c.category !== 'System') secs += c.endTs - c.startTs
  return Math.floor(secs / 60)
}

// ---------------------------------------------------------------------------
// Access gate (§1.1.1)

export const BATCH_TARGET = 120

export function accessProgress(count: number, nowSec: number) {
  const capped = Math.min(Math.max(count, 0), BATCH_TARGET)
  const minutes = capped * 15
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const recorded = minutes === 0 ? '0h' : h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
  const isComplete = count >= BATCH_TARGET
  return {
    completedBatchCount: count,
    targetBatchCount: BATCH_TARGET,
    progress: capped / BATCH_TARGET,
    isComplete,
    recordedText: `${recorded} / 30h`,
    estimatedUnlockAt: isComplete ? null : nowSec + (BATCH_TARGET - capped) * 15 * 60,
  }
}

// ---------------------------------------------------------------------------
// Fixture dashboard for the locked-page preview (deterministic)

export function buildPreviewDashboard(locale?: string): WeeklyDashboardSnapshot {
  const categories: Category[] = [
    { name: 'Research', color: '#93BCFF', description: '' },
    { name: 'Design', color: '#DE9DFC', description: '' },
    { name: 'Communication', color: '#6CDACD', description: '' },
    { name: 'Personal', color: '#FFC6B7', description: '' },
    { name: 'Distraction', color: '#FF5950', description: '' },
  ]
  const plan: [string, string][] = [
    ['Research', 'chatgpt.com'],
    ['Design', 'Figma'],
    ['Communication', 'Slack'],
    ['Research', 'Claude'],
    ['Design', 'Visual Studio Code'],
    ['Distraction', 'youtube.com'],
    ['Research', 'github.com'],
    ['Communication', 'Zoom'],
    ['Personal', 'Messages'],
    ['Distraction', 'reddit.com'],
  ]
  let seed = 7
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const range = weekFromDay('2026-04-20')
  const days = weekDayStrings(range)
  const fmt = (m: number) => {
    const h = Math.floor(m / 60) % 24
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  }
  const cards: TimelineCard[] = []
  let id = 1
  days.forEach((day, di) => {
    let t = 540 + Math.floor(rand() * 4) * 15
    const end = di >= 5 ? 900 : 1110
    while (t < end) {
      const [cat, app] = plan[Math.floor(rand() * plan.length)]
      const len = 20 + Math.floor(rand() * 7) * 10
      cards.push({
        id: id++,
        batchId: null,
        startTs: 0,
        endTs: 0,
        startTime: fmt(t),
        endTime: fmt(t + len),
        day,
        title: `${cat} session`,
        summary: '',
        detailedSummary: '',
        category: cat,
        subcategory: '',
        distractions:
          cat !== 'Distraction' && rand() < 0.2
            ? [{ startTime: fmt(t + 5), endTime: fmt(t + 10), title: 'Feed', summary: '' }]
            : [],
        appSites: { primary: app },
        isError: false,
      })
      t += len + (rand() < 0.3 ? 15 : 0)
    }
  })
  const prev = cards.slice(0, 40).map((c) => ({ ...c, day: ymd(new Date(range.start.getTime() - 7 * 86400000)) }))
  return buildDashboard(cards, prev, categories, range, locale)
}
