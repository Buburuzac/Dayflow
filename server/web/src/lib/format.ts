// Number formatting and timesheet hour rounding.

export const HOUR_STEP = 0.25

/** Round hours to the nearest 0.25 h (never negative). */
export function roundQuarter(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0
  return Math.round(hours * 4) / 4
}

export function minutesToQuarterHours(minutes: number): number {
  return roundQuarter(minutes / 60)
}

/** Step by ±0.25 h from the nearest quarter, clamped to 0..24. */
export function stepHours(hours: number, dir: -1 | 1): number {
  return Math.min(24, Math.max(0, roundQuarter(roundQuarter(hours) + dir * HOUR_STEP)))
}

/**
 * Parse user input: "1.5", "1,5", "1:30", "90m", "2h". Returns null when unparseable.
 * The result is rounded to 0.25 h and clamped to 0..24.
 */
export function parseHours(input: string): number | null {
  const s = input.trim().toLowerCase().replace(',', '.')
  if (!s) return 0
  let h: number
  let m: RegExpExecArray | null
  if ((m = /^(\d+):(\d{1,2})$/.exec(s))) h = Number(m[1]) + Number(m[2]) / 60
  else if ((m = /^(\d+(?:\.\d+)?)\s*m(?:in)?$/.exec(s))) h = Number(m[1]) / 60
  else if ((m = /^(\d*\.?\d+)\s*h?$/.exec(s))) h = Number(m[1])
  else return null
  if (!Number.isFinite(h)) return null
  return Math.min(24, roundQuarter(h))
}

/** 1.75 → "1.75 h", 2 → "2 h". */
export function fmtHours(hours: number): string {
  const s = (Math.round(hours * 100) / 100).toString()
  return `${s} h`
}

/** 135 → "2h 15m", 40 → "40m", 120 → "2h". */
export function fmtMinutes(minutes: number): string {
  const m = Math.round(minutes)
  if (m < 60) return `${m}m`
  const r = m % 60
  return r ? `${Math.floor(m / 60)}h ${String(r).padStart(2, '0')}m` : `${m / 60}h`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export function relativeTime(ts: number | null, now = Date.now()): string {
  if (!ts) return 'never'
  const t = ts < 1e11 ? ts * 1000 : ts
  const s = Math.max(0, (now - t) / 1000)
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
