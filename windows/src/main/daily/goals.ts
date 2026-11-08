// Pure Day-goal logic (spec-daily.md §6): default plan, carry-forward, snapshot resolution, and the
// DaySummaryStats computation with overlap removal. No Electron imports.

import type {
  CategoryDuration,
  DayGoalCategorySnapshot,
  DayGoalPlan,
  DayGoalProgress,
} from '../../shared/daily-types.ts'
import type { Category, TimelineCard } from '../../shared/types.ts'

export const DEFAULT_FOCUS_MINUTES = 270
export const DEFAULT_DISTRACTION_MINUTES = 120
const DAY_MINUTES = 1440
const FOCUS_BLOCK_GAP = 5

export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

const isDistractionName = (n: string) => ['distraction', 'distractions'].includes(normalizeName(n))
const isSystemName = (n: string) => normalizeName(n) === 'system'

/** Categories the user can pick as focus/distraction: not System, not idle. */
export function selectableCategories(categories: Category[]): Category[] {
  return categories.filter((c) => !c.isIdle && !isSystemName(c.name))
}

export function snapshot(c: Category, sortOrder: number): DayGoalCategorySnapshot {
  return { categoryID: normalizeName(c.name), name: c.name, colorHex: c.color, sortOrder }
}

export function defaultPlan(day: string, categories: Category[]): DayGoalPlan {
  const selectable = selectableCategories(categories)
  return {
    day,
    focusTargetMinutes: DEFAULT_FOCUS_MINUTES,
    distractionLimitMinutes: DEFAULT_DISTRACTION_MINUTES,
    focusCategories: selectable.filter((c) => !isDistractionName(c.name)).map(snapshot),
    distractionCategories: selectable.filter((c) => isDistractionName(c.name)).map(snapshot),
    isSkipped: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** Re-resolves snapshots against current categories (by id, then normalized name). Unmatched stay as is. */
export function resolveSnapshots(snaps: DayGoalCategorySnapshot[], categories: Category[]): DayGoalCategorySnapshot[] {
  return snaps.map((s, i) => {
    const byId = categories.find((c) => normalizeName(c.name) === s.categoryID)
    const byName = byId ?? categories.find((c) => normalizeName(c.name) === normalizeName(s.name))
    return byName
      ? { categoryID: normalizeName(byName.name), name: byName.name, colorHex: byName.color, sortOrder: i }
      : { ...s, sortOrder: i }
  })
}

/** carriedForwardGoalPlan: the most recent saved plan (or the default) moved to `day`. */
export function carriedForwardPlan(saved: DayGoalPlan | null, day: string, categories: Category[]): DayGoalPlan {
  const base = saved ?? defaultPlan(day, categories)
  const moved: DayGoalPlan =
    base.day === day ? { ...base } : { ...base, day, isSkipped: false, createdAt: 0, updatedAt: 0 }
  return {
    ...moved,
    focusCategories: resolveSnapshots(moved.focusCategories, categories),
    distractionCategories: resolveSnapshots(moved.distractionCategories, categories),
  }
}

/** Plan normalized for saving: reindexed sort orders and resolved snapshots, deduplicated. */
export function normalizePlan(plan: DayGoalPlan, categories: Category[]): DayGoalPlan {
  const dedupe = (s: DayGoalCategorySnapshot[]) => {
    const seen = new Set<string>()
    return s.filter((x) => (seen.has(x.categoryID) ? false : (seen.add(x.categoryID), true)))
  }
  const clamp = (m: number) => Math.max(0, Math.min(12 * 60 + 55, Math.round(m / 5) * 5))
  return {
    ...plan,
    focusTargetMinutes: clamp(plan.focusTargetMinutes),
    distractionLimitMinutes: clamp(plan.distractionLimitMinutes),
    focusCategories: dedupe(resolveSnapshots(plan.focusCategories, categories)),
    distractionCategories: dedupe(resolveSnapshots(plan.distractionCategories, categories)),
  }
}

// ---- DaySummaryStats ----

export interface Interval {
  start: number
  end: number
  category: string
  id: number
}

type CardLike = Pick<TimelineCard, 'id' | 'startTs' | 'endTs' | 'category' | 'isError'>

/** Minutes since the day's 4 AM start, clipped to [0, 1440]; empty ranges dropped; System cards dropped. */
export function cardIntervals(cards: CardLike[], dayStartTs: number): Interval[] {
  const out: Interval[] = []
  for (const c of cards) {
    if (c.isError || isSystemName(c.category)) continue
    let start = (c.startTs - dayStartTs) / 60
    let end = (c.endTs - dayStartTs) / 60
    if (end < start) end += DAY_MINUTES
    start = Math.max(0, Math.min(DAY_MINUTES, start))
    end = Math.max(0, Math.min(DAY_MINUTES, end))
    if (end <= start) continue
    out.push({ start, end, category: c.category, id: c.id })
  }
  return out
}

/**
 * Removes overlaps so each minute counts once: sort by start, longer first on equal starts,
 * smaller id first on full ties; then trim each start to the covered-until mark.
 */
export function removeOverlaps(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.id - b.id,
  )
  const out: Interval[] = []
  let coveredUntil = -Infinity
  for (const iv of sorted) {
    const start = Math.max(iv.start, coveredUntil)
    if (iv.end > start) {
      out.push({ ...iv, start })
      coveredUntil = iv.end
    }
  }
  return out
}

function matches(category: string, snaps: DayGoalCategorySnapshot[], categories: Category[]): boolean {
  const n = normalizeName(category)
  const current = categories.find((c) => normalizeName(c.name) === n)
  if (current && snaps.some((s) => s.categoryID === normalizeName(current.name))) return true
  return snaps.some((s) => normalizeName(s.name) === n)
}

export function mergeBlocks(intervals: { start: number; end: number }[], gap = FOCUS_BLOCK_GAP) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last && iv.start - last.end < gap) last.end = Math.max(last.end, iv.end)
    else out.push({ start: iv.start, end: iv.end })
  }
  return out
}

export function computeProgress(
  plan: DayGoalPlan,
  isExplicit: boolean,
  cards: CardLike[],
  dayStartTs: number,
  categories: Category[],
): DayGoalProgress {
  const ivs = removeOverlaps(cardIntervals(cards, dayStartTs))
  const dur = (iv: Interval) => iv.end - iv.start
  const total = ivs.reduce((s, iv) => s + dur(iv), 0)
  const focusIvs = ivs.filter((iv) => matches(iv.category, plan.focusCategories, categories))
  const distractIvs = ivs.filter((iv) => matches(iv.category, plan.distractionCategories, categories))

  const byCat = new Map<string, number>()
  for (const iv of ivs) byCat.set(iv.category, (byCat.get(iv.category) ?? 0) + dur(iv))
  const order = (name: string) => {
    const i = categories.findIndex((c) => normalizeName(c.name) === normalizeName(name))
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const color = (name: string) =>
    categories.find((c) => normalizeName(c.name) === normalizeName(name))?.color ?? '#cccccc'
  const categoryDurations: CategoryDuration[] = [...byCat.entries()]
    .map(([name, minutes]) => ({ name, minutes, colorHex: color(name) }))
    .sort(
      (a, b) =>
        Math.round(b.minutes) - Math.round(a.minutes) || order(a.name) - order(b.name) || a.name.localeCompare(b.name),
    )

  const focusSegments = plan.focusCategories
    .map((s) => ({
      name: s.name,
      colorHex: s.colorHex,
      minutes: focusIvs.filter((iv) => matches(iv.category, [s], categories)).reduce((t, iv) => t + dur(iv), 0),
    }))
    .filter((s) => s.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 4)

  return {
    day: plan.day,
    plan,
    isExplicit,
    totalCapturedMinutes: total,
    focusMinutes: focusIvs.reduce((s, iv) => s + dur(iv), 0),
    distractedMinutes: distractIvs.reduce((s, iv) => s + dur(iv), 0),
    focusSegments,
    categoryDurations,
    focusBlocks: mergeBlocks(focusIvs),
  }
}

/** Minutes per category name for a day, overlap-free (used for setup reference stats). */
export function minutesForCategories(
  cards: CardLike[],
  dayStartTs: number,
  snaps: DayGoalCategorySnapshot[],
  categories: Category[],
): number {
  return removeOverlaps(cardIntervals(cards, dayStartTs))
    .filter((iv) => matches(iv.category, snaps, categories))
    .reduce((s, iv) => s + (iv.end - iv.start), 0)
}

/** Integer when within 0.01 of one, otherwise one decimal. */
export function formatCompactHours(minutes: number): string {
  const h = minutes / 60
  return Math.abs(h - Math.round(h)) < 0.01 ? String(Math.round(h)) : h.toFixed(1)
}
