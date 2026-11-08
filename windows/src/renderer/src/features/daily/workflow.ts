// Daily view "workflow grid" and stat chips (spec-daily.md §3a.9). Pure helpers.

import type { Category, TimelineCard } from '../../../../shared/types.ts'

export const SLOT_MINUTES = 15

export interface WorkflowRow {
  category: string
  color: string
  /** Occupancy 0..1 per slot */
  slots: number[]
  minutes: number
}

export interface WorkflowGrid {
  /** Clock minute (since local midnight of the day) of the first slot. */
  startMinute: number
  slotCount: number
  rows: WorkflowRow[]
}

export interface WorkflowStats {
  contextSwitches: number
  interrupted: number
  focusedMinutes: number
  distractedMinutes: number
  transitionMinutes: number
}

const isSystem = (c: TimelineCard) => c.isError || c.category.trim().toLowerCase() === 'system'

/** Clock minute since midnight, continuing past 24:00 for the 0–4 AM tail of a logical day. */
function clockMinute(ts: number, dayStartTs: number): number {
  return (ts - dayStartTs) / 60 + 4 * 60
}

export function workflowGrid(cards: TimelineCard[], categories: Category[], dayStartTs: number): WorkflowGrid {
  const live = cards.filter((c) => !isSystem(c))
  let first = 9 * 60
  let last = 21 * 60
  if (live.length) {
    first = Math.min(first, Math.floor(Math.min(...live.map((c) => clockMinute(c.startTs, dayStartTs))) / 60) * 60)
    last = Math.max(last, Math.ceil(Math.max(...live.map((c) => clockMinute(c.endTs, dayStartTs))) / 60) * 60)
  }
  const slotCount = Math.max(1, Math.round((last - first) / SLOT_MINUTES))
  const used = new Set(live.map((c) => c.category))
  const known = categories.filter((c) => used.has(c.name))
  const unknown = [...used].filter((n) => !categories.some((c) => c.name === n)).sort()
  const rows: WorkflowRow[] = [
    ...known.map((c) => ({ category: c.name, color: c.color })),
    ...unknown.map((n) => ({ category: n, color: '#BBBBBB' })),
  ].map(({ category, color }) => {
    const slots = new Array<number>(slotCount).fill(0)
    let minutes = 0
    for (const c of live) {
      if (c.category !== category) continue
      const s = clockMinute(c.startTs, dayStartTs)
      const e = clockMinute(c.endTs, dayStartTs)
      minutes += Math.max(0, e - s)
      for (let i = 0; i < slotCount; i++) {
        const a = first + i * SLOT_MINUTES
        const b = a + SLOT_MINUTES
        const overlap = Math.max(0, Math.min(b, e) - Math.max(a, s))
        if (overlap > 0) slots[i] = Math.min(1, slots[i] + overlap / SLOT_MINUTES)
      }
    }
    return { category, color, slots, minutes }
  })
  return { startMinute: first, slotCount, rows }
}

export function workflowStats(cards: TimelineCard[], categories: Category[]): WorkflowStats {
  const live = cards.filter((c) => !isSystem(c)).sort((a, b) => a.startTs - b.startTs)
  const idle = new Set(categories.filter((c) => c.isIdle).map((c) => c.name))
  let contextSwitches = 0
  let transition = 0
  for (let i = 1; i < live.length; i++) {
    if (live[i].category !== live[i - 1].category) contextSwitches++
    const gap = live[i].startTs - live[i - 1].endTs
    if (gap > 0) transition += gap
  }
  const mins = (c: TimelineCard) => Math.max(0, c.endTs - c.startTs) / 60
  return {
    contextSwitches,
    interrupted: live.filter((c) => c.distractions.length > 0).length,
    focusedMinutes: live.filter((c) => !idle.has(c.category)).reduce((s, c) => s + mins(c), 0),
    distractedMinutes: live.filter((c) => idle.has(c.category)).reduce((s, c) => s + mins(c), 0),
    transitionMinutes: transition / 60,
  }
}

export function fmtMinutes(m: number): string {
  const r = Math.round(m)
  if (r < 60) return `${r}m`
  return `${Math.floor(r / 60)}h ${String(r % 60).padStart(2, '0')}m`
}

export function clockLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24
  const ap = h >= 12 ? 'pm' : 'am'
  return `${h % 12 === 0 ? 12 : h % 12}${ap}`
}

/** Integer when within 0.01 of one, otherwise one decimal (formatCompactHours). */
export function compactHours(minutes: number): string {
  const h = minutes / 60
  return Math.abs(h - Math.round(h)) < 0.01 ? String(Math.round(h)) : h.toFixed(1)
}
