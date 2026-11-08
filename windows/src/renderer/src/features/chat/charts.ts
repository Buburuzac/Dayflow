// Inline chart markup (§5 of docs/spec-chat.md): splits a message into text and chart blocks
// and validates the chart JSON. Pure, unit-tested.

export const CHART_PALETTE = ['#F96E00', '#1F6FEB', '#2E7D32', '#8E24AA', '#00897B']

export interface BarLineChart {
  type: 'bar' | 'line'
  title: string
  x: string[]
  y: number[]
  color: string | null
}
export interface StackedBarChart {
  type: 'stacked_bar'
  title: string
  x: string[]
  series: Array<{ name: string; values: number[]; color: string | null }>
}
export interface DonutChart {
  type: 'donut'
  title: string
  labels: string[]
  values: number[]
  colors: string[] | null
}
export interface HeatmapChart {
  type: 'heatmap'
  title: string
  x: string[]
  y: string[]
  values: number[][]
  color: string | null
}
export interface GanttChart {
  type: 'gantt'
  title: string
  items: Array<{ label: string; start: number; end: number; color: string | null }>
}
export type ChartSpec = BarLineChart | StackedBarChart | DonutChart | HeatmapChart | GanttChart

export type MessageBlock = { kind: 'text'; text: string } | { kind: 'chart'; chart: ChartSpec; raw: string }

/**
 * Sanitizes a hex color: trims, strips '#', needs 6 or 8 hex digits. 8 digits are AARRGGBB
 * (Swift Color(hex:)), converted to CSS #RRGGBBAA. Invalid → null.
 */
export function sanitizeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const h = v.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(h)) return null
  const u = h.toUpperCase()
  return u.length === 6 ? `#${u}` : `#${u.slice(2)}${u.slice(0, 2)}`
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isStr) ? (v as string[]) : null)
const numArr = (v: unknown): number[] | null => (Array.isArray(v) && v.every(isNum) ? (v as number[]) : null)

/** Validates chart JSON for a type; null when it should be rendered as raw text. */
export function validateChart(type: string, json: unknown): ChartSpec | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const o = json as Record<string, unknown>
  if (!isStr(o.title)) return null
  const title = o.title
  const t = type.toLowerCase()
  if (t === 'bar' || t === 'line') {
    const x = strArr(o.x)
    const y = numArr(o.y)
    if (!x || !y || x.length === 0 || x.length !== y.length) return null
    return { type: t, title, x, y, color: sanitizeColor(o.color) }
  }
  if (t === 'stacked_bar') {
    const x = strArr(o.x)
    if (!x || x.length === 0 || !Array.isArray(o.series)) return null
    const series: StackedBarChart['series'] = []
    for (const s of o.series as unknown[]) {
      if (!s || typeof s !== 'object') return null
      const so = s as Record<string, unknown>
      const values = numArr(so.values)
      if (!isStr(so.name) || !values) return null
      if (values.length === 0 || values.length !== x.length) continue
      series.push({ name: so.name, values, color: sanitizeColor(so.color) })
    }
    if (series.length === 0) return null
    return { type: 'stacked_bar', title, x, series }
  }
  if (t === 'donut' || t === 'pie') {
    const labels = strArr(o.labels)
    const values = numArr(o.values)
    if (!labels || !values || labels.length === 0 || labels.length !== values.length) return null
    let colors: string[] | null = null
    const rawColors = strArr(o.colors)
    if (rawColors && rawColors.length === labels.length) {
      colors = rawColors.map((c, i) => sanitizeColor(c) ?? CHART_PALETTE[i % CHART_PALETTE.length])
    }
    return { type: 'donut', title, labels, values, colors }
  }
  if (t === 'heatmap') {
    const x = strArr(o.x)
    const y = strArr(o.y)
    if (!x || !y || x.length === 0 || y.length === 0 || !Array.isArray(o.values)) return null
    const rows = (o.values as unknown[]).map(numArr)
    if (rows.length !== y.length || rows.some((r) => !r || r.length !== x.length)) return null
    return { type: 'heatmap', title, x, y, values: rows as number[][], color: sanitizeColor(o.color) }
  }
  if (t === 'gantt') {
    if (!Array.isArray(o.items)) return null
    const items: GanttChart['items'] = []
    for (const it of o.items as unknown[]) {
      if (!it || typeof it !== 'object') return null
      const io = it as Record<string, unknown>
      if (!isStr(io.label) || !isNum(io.start) || !isNum(io.end)) return null
      if (io.end <= io.start) continue
      items.push({ label: io.label, start: io.start, end: io.end, color: sanitizeColor(io.color) })
    }
    if (items.length === 0) return null
    return { type: 'gantt', title, items }
  }
  return null
}

const CHART_RE = /```chart\s+type\s*=\s*([A-Za-z_]+)\s*\n?([\s\S]*?)\n?```/g

/** Splits message text into ordered text and chart blocks; invalid charts stay as raw text. */
export function splitMessageBlocks(content: string): MessageBlock[] {
  const text = content.replace(/\r\n/g, '\n')
  const blocks: MessageBlock[] = []
  let last = 0
  let pendingText = ''
  const pushText = (t: string) => {
    pendingText += t
  }
  const flushText = () => {
    if (pendingText.trim()) blocks.push({ kind: 'text', text: pendingText })
    pendingText = ''
  }
  CHART_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CHART_RE.exec(text))) {
    pushText(text.slice(last, m.index))
    last = m.index + m[0].length
    let chart: ChartSpec | null = null
    try {
      chart = validateChart(m[1], JSON.parse(m[2].trim()))
    } catch {
      chart = null
    }
    if (chart) {
      flushText()
      blocks.push({ kind: 'chart', chart, raw: m[0] })
    } else {
      pushText(m[0])
    }
  }
  pushText(text.slice(last))
  flushText()
  return blocks
}
