/** Parses the model's line-based detailed summary without changing its source text. */
export interface DetailLine { start: string; end: string; text: string; raw: string }

export function clockText24(raw: string): string | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(raw.trim())
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > (match[3] ? 12 : 23) || minute > 59) return null
  if (match[3]) hour = (hour % 12) + (match[3].toUpperCase() === 'PM' ? 12 : 0)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function detailLines(summary: string): DetailLine[] {
  return summary.split('\n').filter((line) => line.trim()).map((raw) => {
    const match = /^\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[-–—]\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*:\s*(.*)$/i.exec(raw)
    const start = match && clockText24(match[1])
    const end = match && clockText24(match[2])
    return start && end ? { start, end, text: match![3], raw } : { start: '', end: '', text: raw, raw }
  })
}
