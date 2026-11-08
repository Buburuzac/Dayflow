// Date helpers. A logical Dayflow day runs from 4 AM to 4 AM local time (same as the desktop app).

export const DAY_BOUNDARY_HOUR = 4
const DAY_MS = 86_400_000

export type RangeMode = 'day' | 'week' | 'month' | 'custom'
export interface DateRange {
  from: string
  to: string
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Noon of the calendar date, so DST shifts never move it to another day. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

export function isDay(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDay(s).getTime())
}

/** Logical day containing `now` (before 4 AM still counts as the previous day). */
export function logicalDay(now: Date = new Date()): string {
  const d = new Date(now)
  if (d.getHours() < DAY_BOUNDARY_HOUR) d.setDate(d.getDate() - 1)
  return ymd(d)
}

export function shiftDay(day: string, delta: number): string {
  const d = parseDay(day)
  d.setDate(d.getDate() + delta)
  return ymd(d)
}

/** Epoch ms of the 4 AM start of a logical day. */
export function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, DAY_BOUNDARY_HOUR).getTime()
}

/** Timestamps from the server may be unix seconds (desktop cards) or ms; normalise to ms. */
export function toMs(ts: number): number {
  return ts < 1e11 ? ts * 1000 : ts
}

/** Minutes since the 4 AM start of `day` (0..1440; can exceed 1440 for cards running past 4 AM). */
export function minuteOfDay(ts: number, day: string): number {
  return (toMs(ts) - dayStartMs(day)) / 60_000
}

/** Inclusive list of days from..to (capped at 400). */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = []
  if (from > to) return out
  let d = from
  for (let i = 0; i < 400 && d <= to; i++) {
    out.push(d)
    d = shiftDay(d, 1)
  }
  return out
}

/** Monday of the ISO week containing `day`. */
export function weekStart(day: string): string {
  const dow = (parseDay(day).getDay() + 6) % 7
  return shiftDay(day, -dow)
}

export function monthStart(day: string): string {
  return `${day.slice(0, 8)}01`
}

export function monthEnd(day: string): string {
  const d = parseDay(monthStart(day))
  return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12))
}

export function rangeFor(mode: RangeMode, anchor: string, custom?: DateRange): DateRange {
  switch (mode) {
    case 'day':
      return { from: anchor, to: anchor }
    case 'week': {
      const from = weekStart(anchor)
      return { from, to: shiftDay(from, 6) }
    }
    case 'month':
      return { from: monthStart(anchor), to: monthEnd(anchor) }
    case 'custom': {
      const r = custom ?? { from: anchor, to: anchor }
      return r.from <= r.to ? r : { from: r.to, to: r.from }
    }
  }
}

/** Step a range backwards/forwards by its own length. */
export function shiftRange(mode: RangeMode, range: DateRange, dir: -1 | 1): DateRange {
  switch (mode) {
    case 'day':
      return rangeFor('day', shiftDay(range.from, dir))
    case 'week':
      return rangeFor('week', shiftDay(range.from, 7 * dir))
    case 'month': {
      const d = parseDay(range.from)
      return rangeFor('month', ymd(new Date(d.getFullYear(), d.getMonth() + dir, 1, 12)))
    }
    case 'custom': {
      const len = rangeLength(range)
      return { from: shiftDay(range.from, len * dir), to: shiftDay(range.to, len * dir) }
    }
  }
}

export function rangeLength(range: DateRange): number {
  return Math.round((parseDay(range.to).getTime() - parseDay(range.from).getTime()) / DAY_MS) + 1
}

const fmt = (day: string, o: Intl.DateTimeFormatOptions) => parseDay(day).toLocaleDateString('en-GB', o)

export function dayLabel(day: string, today: string = logicalDay()): string {
  if (day === today) return 'Today'
  if (day === shiftDay(today, -1)) return 'Yesterday'
  return fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })
}

export function shortDay(day: string): string {
  return fmt(day, { weekday: 'short', day: 'numeric' })
}

export function weekdayShort(day: string): string {
  return fmt(day, { weekday: 'short' })
}

export function rangeLabel(mode: RangeMode, range: DateRange, today: string = logicalDay()): string {
  if (mode === 'day') return dayLabel(range.from, today)
  if (mode === 'month') return fmt(range.from, { month: 'long', year: 'numeric' })
  if (range.from === range.to) return fmt(range.from, { day: 'numeric', month: 'short', year: 'numeric' })
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4)
  const sameMonth = sameYear && range.from.slice(5, 7) === range.to.slice(5, 7)
  const a = fmt(
    range.from,
    sameMonth ? { day: 'numeric' } : sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
  )
  const b = fmt(range.to, { day: 'numeric', month: 'short', year: 'numeric' })
  return `${a} – ${b}`
}

/** "14:05" for a timestamp (seconds or ms). */
export function clock(ts: number): string {
  return new Date(toMs(ts)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** Axis label for an hour offset from the 4 AM boundary. */
export function axisHour(hourFromBoundary: number): string {
  const h = (hourFromBoundary + DAY_BOUNDARY_HOUR) % 24
  return `${String(h).padStart(2, '0')}:00`
}
