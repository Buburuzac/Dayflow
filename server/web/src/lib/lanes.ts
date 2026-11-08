// Lane layout for the personal timeline: one lane per device, overlapping cards side by side.

export interface Interval {
  id: string
  start: number
  end: number
}

export interface Placed<T extends Interval> {
  item: T
  /** sub-column inside the lane */
  col: number
  /** number of sub-columns in this item's overlap cluster */
  cols: number
}

/**
 * Greedy interval colouring: overlapping items get different columns; every item in one
 * connected overlap cluster shares the same column count so their widths line up.
 * Touching intervals (a.end === b.start) do not overlap.
 */
export function layoutLane<T extends Interval>(items: T[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id))
  const out: Placed<T>[] = []
  let cluster: Placed<T>[] = []
  let colEnds: number[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length
    out.push(...cluster)
    cluster = []
    colEnds = []
    clusterEnd = -Infinity
  }
  for (const it of sorted) {
    const end = Math.max(it.end, it.start)
    if (cluster.length && it.start >= clusterEnd) flush()
    let col = colEnds.findIndex((e) => e <= it.start)
    if (col === -1) {
      col = colEnds.length
      colEnds.push(end)
    } else colEnds[col] = end
    cluster.push({ item: it, col, cols: 1 })
    clusterEnd = Math.max(clusterEnd, end)
  }
  if (cluster.length) flush()
  return out
}

export interface LaneDevice {
  id: string
  name: string
}

/** Group items by device, ordered like `devices`; unknown device ids get their own lanes at the end. */
export function groupByDevice<T extends { deviceId: string }>(items: T[], devices: LaneDevice[]): { device: LaneDevice; items: T[] }[] {
  const map = new Map<string, T[]>()
  for (const it of items) {
    const list = map.get(it.deviceId)
    if (list) list.push(it)
    else map.set(it.deviceId, [it])
  }
  const lanes: { device: LaneDevice; items: T[] }[] = []
  for (const d of devices) {
    const list = map.get(d.id)
    if (list) {
      lanes.push({ device: d, items: list })
      map.delete(d.id)
    }
  }
  let n = 1
  for (const [id, list] of map) lanes.push({ device: { id, name: `Other device ${n++}` }, items: list })
  return lanes
}

/**
 * Visible hour window as offsets from the 4 AM boundary (0..24), covering every interval
 * (given in minutes from the boundary), snapped to whole hours and at least `minSpan` hours wide.
 */
export function hourWindow(intervals: { start: number; end: number }[], minSpan = 8, fallback: [number, number] = [4, 14]): [number, number] {
  if (!intervals.length) return fallback
  const lo = Math.min(...intervals.map((i) => i.start))
  const hi = Math.max(...intervals.map((i) => i.end))
  let a = Math.max(0, Math.floor(lo / 60))
  let b = Math.min(24, Math.ceil(hi / 60))
  if (b - a < minSpan) {
    const pad = minSpan - (b - a)
    a = Math.max(0, a - Math.floor(pad / 2))
    b = Math.min(24, a + minSpan)
    a = Math.max(0, b - minSpan)
  }
  return [a, b]
}
