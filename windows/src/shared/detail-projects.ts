import type { DetailProjectRef, TimelineCard } from './types.ts'
import { detailLines } from './detailed.ts'

export interface ProjectRecord { key: string; minutes: number; text: string; time: string }

export function clockMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(clock.trim())
  if (!match) return null
  const h = Number(match[1]), m = Number(match[2])
  if (h > (match[3] ? 12 : 23) || m > 59) return null
  return (match[3] ? h % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0) : h) * 60 + m
}

function interval(start: string, end: string): [number, number] | null {
  const a = clockMinutes(start), b = clockMinutes(end)
  if (a === null || b === null) return null
  const finish = b <= a ? b + 1440 : b
  return finish - a > 0 && finish - a <= 720 ? [a, finish] : null
}

function coveredMinutes(target: [number, number], covers: [number, number][]): number {
  const parts: [number, number][] = []
  for (const [a, b] of covers) for (const shift of [-1440, 0, 1440]) {
    const from = Math.max(target[0], a + shift), to = Math.min(target[1], b + shift)
    if (to > from) parts.push([from, to])
  }
  parts.sort((a, b) => a[0] - b[0])
  let total = 0, end = target[0]
  for (const [a, b] of parts) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b) }
  return total
}

export function projectRecords(card: Pick<TimelineCard, 'detailedSummary' | 'distractions'>): ProjectRecord[] {
  // Keep one slot per distraction so index i lines up with card.distractions[i].
  const distractionSlots = card.distractions.map((d) => interval(d.startTime, d.endTime))
  const known = (ranges: ([number, number] | null)[]) => ranges.filter((range): range is [number, number] => range !== null)
  const distractionRanges = known(distractionSlots)
  const lines = detailLines(card.detailedSummary).map((line, i) => ({
    key: `detail:${i}`, minutes: (() => { const range = interval(line.start, line.end); return range ? Math.max(0, range[1] - range[0] - coveredMinutes(range, distractionRanges)) : 1 })(),
    text: line.text, time: line.start ? `${line.start}–${line.end}` : '',
  }))
  const distractions = card.distractions.map((d, i) => ({
    key: `distraction:${i}`, minutes: (() => { const range = distractionSlots[i]; return range ? Math.max(0, range[1] - range[0] - coveredMinutes(range, known(distractionSlots.slice(0, i)))) : 1 })(), text: d.title, time: `${d.startTime}–${d.endTime}`,
  }))
  return [...lines, ...distractions]
}

export function initialDetailProjects(card: TimelineCard): Record<string, DetailProjectRef[]> {
  const defaults = (card.projects ?? []).map((p) => ({ projectId: p.projectId, share: p.share, source: p.source, confidence: p.confidence, confirmed: p.confirmed }))
  return Object.fromEntries(projectRecords(card).map((r) => [r.key, card.detailProjects?.[r.key] ?? defaults.map((p) => ({ ...p }))]))
}

/** Convert line durations and per-line assignments into card shares (always totals at most one). */
export function detailProjectShares(card: TimelineCard, rows: Record<string, DetailProjectRef[]>): DetailProjectRef[] {
  const records = projectRecords(card)
  const weight = records.reduce((s, r) => s + r.minutes, 0)
  if (!weight) return []
  const sums = new Map<string, { confirmed: number; suggested: number; ref: DetailProjectRef }>()
  for (const r of records) {
    const refs = rows[r.key] ?? []
    const total = refs.reduce((s, p) => s + Math.max(0, p.share), 0)
    const scale = total > 1 ? 1 / total : 1
    for (const p of refs) {
      const old = sums.get(p.projectId)
      const part = r.minutes / weight * Math.max(0, p.share) * scale
      sums.set(p.projectId, { confirmed: (old?.confirmed ?? 0) + (p.confirmed ? part : 0), suggested: (old?.suggested ?? 0) + (p.confirmed ? 0 : part), ref: p })
    }
  }
  return [...sums.entries()].map(([projectId, p]) => ({ projectId, share: Math.round((p.confirmed || p.suggested) * 1000) / 1000, source: p.confirmed ? 'manual' as const : p.ref.source, confidence: p.ref.confidence, confirmed: p.confirmed > 0 })).filter((p) => p.share > 0)
}
