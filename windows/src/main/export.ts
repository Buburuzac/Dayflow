// Timeline → Markdown export (the macOS app's "Export timeline" feature).

import type { TimelineCard } from '../shared/types.ts'

export function cardsToMarkdown(days: { day: string; cards: TimelineCard[] }[]): string {
  const lines: string[] = ['# Dayflow timeline', '']
  for (const { day, cards } of days) {
    const visible = cards.filter((c) => !c.isError)
    if (visible.length === 0) continue
    lines.push(`## ${day}`, '')
    for (const c of visible) {
      lines.push(`### ${c.startTime} – ${c.endTime} · ${c.title}`)
      lines.push(`*${c.category}${c.subcategory ? ` / ${c.subcategory}` : ''}*`, '')
      if (c.summary) lines.push(c.summary, '')
      if (c.detailedSummary) {
        lines.push('<details><summary>Details</summary>', '', c.detailedSummary, '', '</details>', '')
      }
      if (c.distractions.length) {
        lines.push('Distractions:')
        for (const d of c.distractions) lines.push(`- ${d.startTime}–${d.endTime} ${d.title}${d.summary ? `: ${d.summary}` : ''}`)
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}
