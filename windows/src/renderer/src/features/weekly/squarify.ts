// Squarified treemap layout (spec §8), ported verbatim. Pure.

export interface LayoutRect {
  x: number
  y: number
  w: number
  h: number
}

function worstAspect(areas: number[], total: number, short: number): number {
  const strip = total / short
  let worst = 0
  for (const a of areas) {
    const len = a / strip
    worst = Math.max(worst, Math.max(strip / len, len / strip))
  }
  return worst
}

function squarify(areas: number[], rect: LayoutRect): LayoutRect[] {
  if (areas.length === 1) return [{ ...rect }]
  const out: LayoutRect[] = []
  let r = { ...rect }
  let remaining = [...areas]
  while (remaining.length > 0 && r.w > 0 && r.h > 0) {
    const short = Math.min(r.w, r.h)
    let row: number[] = []
    let best = Infinity
    for (const a of remaining) {
      const cand = [...row, a]
      const worst = worstAspect(cand, cand.reduce((s, x) => s + x, 0), short)
      if (row.length === 0 || worst <= best) {
        row = cand
        best = worst
      } else break
    }
    const sum = row.reduce((s, x) => s + x, 0)
    const strip = sum / short
    if (r.w >= r.h) {
      let y = r.y
      for (const a of row) {
        const h = a / strip
        out.push({ x: r.x, y, w: strip, h })
        y += h
      }
      r = { x: r.x + strip, y: r.y, w: r.w - strip, h: r.h }
    } else {
      let x = r.x
      for (const a of row) {
        const w = a / strip
        out.push({ x, y: r.y, w, h: strip })
        x += w
      }
      r = { x: r.x, y: r.y + strip, w: r.w, h: r.h - strip }
    }
    remaining = remaining.slice(row.length)
  }
  return out
}

/** Places items (already in order) into rect; frames are inset by gap/2. Items with value <= 0 are skipped. */
export function place<T>(items: T[], value: (t: T) => number, rect: LayoutRect, gap: number): { item: T; rect: LayoutRect }[] {
  const visible = items.filter((i) => value(i) > 0)
  const total = visible.reduce((s, i) => s + value(i), 0)
  if (!total || rect.w <= 0 || rect.h <= 0) return []
  const areas = visible.map((i) => (value(i) / total) * rect.w * rect.h)
  const frames = squarify(areas, rect)
  const out: { item: T; rect: LayoutRect }[] = []
  frames.forEach((f, i) => {
    const r = { x: f.x + gap / 2, y: f.y + gap / 2, w: f.w - gap, h: f.h - gap }
    if (r.w > 0 && r.h > 0 && visible[i]) out.push({ item: visible[i], rect: r })
  })
  return out
}
