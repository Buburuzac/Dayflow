// Time helpers ported from Dayflow's TimeParsing.swift / StorageDateHelpers.swift.
// Pure functions: no Electron imports, so they can run under `node --test`.

/** Dayflow's logical day starts at 4 AM local time. */
export const DAY_BOUNDARY_HOUR = 4

/** Parses "h:mm AM", "hh:mm AM", "h:mmAM" (case-insensitive) into minutes since midnight. */
export function parseClock(text: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]?\.?\s*$/.exec(text)
  if (!m) {
    // Fallback: 24h "HH:MM"
    const h24 = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
    if (!h24) return null
    const h = Number(h24[1])
    const min = Number(h24[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
  }
  let h = Number(m[1])
  const min = Number(m[2])
  if (h < 1 || h > 12 || min > 59) return null
  const pm = m[3].toUpperCase() === 'P'
  if (h === 12) h = 0
  if (pm) h += 12
  return h * 60 + min
}

/** Formats a unix timestamp (seconds) as "h:mm AM" in local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts * 1000)
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`
}

/** "MM:SS" or "HH:MM:SS" → seconds. Returns 0 for malformed input, like the original. */
export function parseVideoTimestamp(text: string): number {
  const parts = text.trim().split(':').map((p) => Number(p))
  if (parts.some((p) => !Number.isFinite(p))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

export function formatMMSS(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Logical day ("YYYY-MM-DD") for a unix timestamp, using the 4 AM boundary. */
export function logicalDay(ts: number): string {
  const d = new Date(ts * 1000)
  if (d.getHours() < DAY_BOUNDARY_HOUR) d.setDate(d.getDate() - 1)
  return ymd(d)
}

/** [start, end) unix seconds of a logical day. */
export function dayRange(day: string): { start: number; end: number } {
  const [y, mo, da] = day.split('-').map(Number)
  const start = new Date(y, mo - 1, da, DAY_BOUNDARY_HOUR, 0, 0, 0)
  const end = new Date(y, mo - 1, da + 1, DAY_BOUNDARY_HOUR, 0, 0, 0)
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) }
}

export function shiftDay(day: string, delta: number): string {
  const [y, mo, da] = day.split('-').map(Number)
  return ymd(new Date(y, mo - 1, da + delta, 12))
}

/**
 * Resolves a clock-only time to a timestamp: the candidate (previous / same / next day)
 * nearest to `anchorTs`. Mirrors resolveClock in StorageManager+TimelineCards.swift.
 */
export function resolveClockNear(minutes: number, anchorTs: number): number {
  const anchor = new Date(anchorTs * 1000)
  const same = new Date(anchor)
  same.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  const candidates = [-1, 0, 1].map((delta) => {
    const c = new Date(same)
    c.setDate(c.getDate() + delta)
    return Math.floor(c.getTime() / 1000)
  })
  return candidates.reduce((best, c) => (Math.abs(c - anchorTs) < Math.abs(best - anchorTs) ? c : best))
}

/** Resolves a card's clock range to timestamps around an anchor; handles midnight crossings. */
export function resolveCardRange(
  startClock: string,
  endClock: string,
  anchorTs: number,
): { startTs: number; endTs: number } | null {
  const s = parseClock(startClock)
  const e = parseClock(endClock)
  if (s === null || e === null) return null
  const startTs = resolveClockNear(s, anchorTs)
  let endTs = resolveClockNear(e, anchorTs)
  if (endTs < startTs) endTs += 24 * 3600
  return { startTs, endTs }
}
