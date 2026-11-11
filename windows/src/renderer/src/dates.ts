// Renderer-side date helpers; the logical day starts at 4 AM, as in the main process.

const BOUNDARY = 4

export function clock24(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function currentDay(): string {
  const d = new Date()
  if (d.getHours() < BOUNDARY) d.setDate(d.getDate() - 1)
  return ymd(d)
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return ymd(new Date(y, m - 1, d + delta, 12))
}

/** Unix seconds of the 4 AM start of a logical day. */
export function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, BOUNDARY).getTime() / 1000)
}

export function dayLabel(day: string): string {
  if (day === currentDay()) return 'Today'
  if (day === shiftDay(currentDay(), -1)) return 'Yesterday'
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

export function fmtDuration(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
