// Hand-drawn SVG charts for ```chart blocks (bar, line, stacked_bar, donut, heatmap, gantt).
// Plot height 180 px; default palette by index; hover titles show exact values.

import { CHART_PALETTE, type ChartSpec, type DonutChart, type GanttChart, type HeatmapChart, type StackedBarChart } from './charts.ts'

const W = 560
const H = 180
const PAD = { l: 40, r: 10, t: 8, b: 24 }

const pal = (i: number) => CHART_PALETTE[i % CHART_PALETTE.length]

function fmt(v: number): string {
  if (Math.abs(v) >= 100) return String(Math.round(v))
  return String(Math.round(v * 10) / 10)
}

/** ~4 "nice" ticks from min..max. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1
  const span = max - min
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return ticks
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s
}

function YAxis({ ticks, y }: { ticks: number[]; y: (v: number) => number }) {
  return (
    <g className="ch-axis">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="ch-grid" />
          <text x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
    </g>
  )
}

function XLabels({ labels, cx, band }: { labels: string[]; cx: (i: number) => number; band: number }) {
  const maxChars = Math.max(3, Math.floor(band / 6.5))
  return (
    <g className="ch-axis">
      {labels.map((l, i) => (
        <text key={i} x={cx(i)} y={H - 6} textAnchor="middle">
          <title>{l}</title>
          {truncate(l, maxChars)}
        </text>
      ))}
    </g>
  )
}

function bandScale(n: number) {
  const inner = W - PAD.l - PAD.r
  const band = inner / n
  return { band, cx: (i: number) => PAD.l + band * i + band / 2 }
}

function linearY(min: number, max: number) {
  const ticks = niceTicks(min, max)
  const lo = Math.min(ticks[0], min)
  const hi = ticks[ticks.length - 1]
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo || 1))
  return { ticks, y }
}

function BarChart({ x, y, color }: { x: string[]; y: number[]; color: string }) {
  const { band, cx } = bandScale(x.length)
  const { ticks, y: sy } = linearY(Math.min(0, ...y), Math.max(0, ...y))
  const bw = Math.min(48, band * 0.62)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ch-svg" role="img">
      <YAxis ticks={ticks} y={sy} />
      {y.map((v, i) => {
        const top = Math.min(sy(v), sy(0))
        return (
          <rect key={i} x={cx(i) - bw / 2} y={top} width={bw} height={Math.max(1, Math.abs(sy(v) - sy(0)))} rx={3} fill={color}>
            <title>{`${x[i]}: ${fmt(v)}`}</title>
          </rect>
        )
      })}
      <XLabels labels={x} cx={cx} band={band} />
    </svg>
  )
}

/** Catmull-Rom spline through points, as cubic Bézier segments. */
export function catmullRomPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`
  }
  return d
}

function LineChart({ x, y, color }: { x: string[]; y: number[]; color: string }) {
  const { band, cx } = bandScale(x.length)
  const { ticks, y: sy } = linearY(Math.min(0, ...y), Math.max(...y))
  const pts = y.map((v, i) => [cx(i), sy(v)] as [number, number])
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ch-svg" role="img">
      <YAxis ticks={ticks} y={sy} />
      <path d={catmullRomPath(pts)} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={3.5} fill="#fff" stroke={color} strokeWidth={2}>
          <title>{`${x[i]}: ${fmt(y[i])}`}</title>
        </circle>
      ))}
      <XLabels labels={x} cx={cx} band={band} />
    </svg>
  )
}

function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="ch-legend">
      {items.map((it, i) => (
        <span key={i}>
          <i style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

function StackedBar({ chart }: { chart: StackedBarChart }) {
  const { x, series } = chart
  const { band, cx } = bandScale(x.length)
  const totals = x.map((_, i) => series.reduce((s, se) => s + Math.max(0, se.values[i]), 0))
  const { ticks, y: sy } = linearY(0, Math.max(...totals, 0))
  const bw = Math.min(48, band * 0.62)
  const colors = series.map((s, i) => s.color ?? pal(i))
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch-svg" role="img">
        <YAxis ticks={ticks} y={sy} />
        {x.map((label, i) => {
          let acc = 0
          return (
            <g key={i}>
              {series.map((s, si) => {
                const v = Math.max(0, s.values[i])
                const y0 = sy(acc)
                acc += v
                const y1 = sy(acc)
                return (
                  <rect key={si} x={cx(i) - bw / 2} y={y1} width={bw} height={Math.max(0, y0 - y1)} fill={colors[si]}>
                    <title>{`${label} · ${s.name}: ${fmt(s.values[i])}`}</title>
                  </rect>
                )
              })}
            </g>
          )
        })}
        <XLabels labels={x} cx={cx} band={band} />
      </svg>
      <Legend items={series.map((s, i) => ({ label: s.name, color: colors[i] }))} />
    </>
  )
}

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)]
  const large = a1 - a0 > Math.PI ? 1 : 0
  const [x0, y0] = p(r1, a0)
  const [x1, y1] = p(r1, a1)
  const [x2, y2] = p(r0, a1)
  const [x3, y3] = p(r0, a0)
  return `M${x0},${y0} A${r1},${r1} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`
}

function Donut({ chart }: { chart: DonutChart }) {
  const values = chart.values.map((v) => Math.max(0, v))
  const total = values.reduce((a, b) => a + b, 0)
  const colors = chart.labels.map((_, i) => chart.colors?.[i] ?? pal(i))
  const r1 = H / 2 - 6
  const r0 = r1 * 0.6
  const cx = H / 2
  const cy = H / 2
  const inset = 1 / r1 // ~1 px angular inset
  let a = 0
  return (
    <>
      <svg viewBox={`0 0 ${H} ${H}`} className="ch-svg ch-donut" role="img">
        {total > 0 ? (
          values.map((v, i) => {
            const span = (v / total) * Math.PI * 2
            const a0 = a
            a += span
            if (v <= 0) return null
            if (span >= Math.PI * 2 - 1e-6) {
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={(r0 + r1) / 2} fill="none" stroke={colors[i]} strokeWidth={r1 - r0}>
                    <title>{`${chart.labels[i]}: ${fmt(v)}`}</title>
                  </circle>
                </g>
              )
            }
            return (
              <path key={i} d={arcPath(cx, cy, r0, r1, a0 + inset, a0 + span - inset)} fill={colors[i]}>
                <title>{`${chart.labels[i]}: ${fmt(v)} (${Math.round((v / total) * 100)}%)`}</title>
              </path>
            )
          })
        ) : (
          <circle cx={cx} cy={cy} r={(r0 + r1) / 2} fill="none" stroke="#eee" strokeWidth={r1 - r0} />
        )}
      </svg>
      <Legend items={chart.labels.map((l, i) => ({ label: l, color: colors[i] }))} />
    </>
  )
}

function Heatmap({ chart }: { chart: HeatmapChart }) {
  const color = chart.color ?? pal(1)
  const flat = chart.values.flat()
  const min = Math.min(...flat)
  const max = Math.max(...flat)
  const left = 76
  const cw = (W - left - PAD.r) / chart.x.length
  const ch = (H - PAD.t - PAD.b) / chart.y.length
  const op = (v: number) => (max === min ? 1 : 0.2 + 0.8 * Math.min(1, Math.max(0, (v - min) / (max - min))))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ch-svg" role="img">
      <g className="ch-axis">
        {chart.y.map((l, r) => (
          <text key={r} x={left - 6} y={PAD.t + ch * r + ch / 2} dy="0.32em" textAnchor="end">
            <title>{l}</title>
            {truncate(l, 11)}
          </text>
        ))}
      </g>
      {chart.values.map((row, r) =>
        row.map((v, c) => (
          <rect
            key={`${r}-${c}`}
            x={left + cw * c + cw * 0.05}
            y={PAD.t + ch * r + ch * 0.05}
            width={cw * 0.9}
            height={ch * 0.9}
            rx={2}
            fill={color}
            fillOpacity={op(v)}
          >
            <title>{`${chart.y[r]} · ${chart.x[c]}: ${fmt(v)}`}</title>
          </rect>
        )),
      )}
      <XLabels labels={chart.x} cx={(i) => left + cw * i + cw / 2} band={cw} />
    </svg>
  )
}

function Gantt({ chart }: { chart: GanttChart }) {
  const labels = [...new Set(chart.items.map((i) => i.label))]
  const min = Math.min(...chart.items.map((i) => i.start))
  const max = Math.max(...chart.items.map((i) => i.end))
  const left = 90
  const sx = (v: number) => left + ((W - left - PAD.r) * (v - min)) / (max - min || 1)
  const rowH = (H - PAD.t - PAD.b) / labels.length
  const ticks = Array.from({ length: 6 }, (_, i) => min + ((max - min) * i) / 5)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ch-svg" role="img">
      <g className="ch-axis">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={sx(t)} x2={sx(t)} y1={PAD.t} y2={H - PAD.b} className="ch-grid" />
            <text x={sx(t)} y={H - 6} textAnchor="middle">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {labels.map((l, r) => (
          <text key={l} x={left - 6} y={PAD.t + rowH * r + rowH / 2} dy="0.32em" textAnchor="end">
            <title>{l}</title>
            {truncate(l, 14)}
          </text>
        ))}
      </g>
      {chart.items.map((it, i) => {
        const r = labels.indexOf(it.label)
        const h = Math.min(22, rowH * 0.7)
        return (
          <rect
            key={i}
            x={sx(it.start)}
            y={PAD.t + rowH * r + (rowH - h) / 2}
            width={Math.max(2, sx(it.end) - sx(it.start))}
            height={h}
            rx={4}
            fill={it.color ?? pal(i)}
          >
            <title>{`${it.label}: ${fmt(it.start)}–${fmt(it.end)}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

export function ChartView({ chart }: { chart: ChartSpec }) {
  let body
  switch (chart.type) {
    case 'bar':
      body = <BarChart x={chart.x} y={chart.y} color={chart.color ?? pal(0)} />
      break
    case 'line':
      body = <LineChart x={chart.x} y={chart.y} color={chart.color ?? pal(0)} />
      break
    case 'stacked_bar':
      body = <StackedBar chart={chart} />
      break
    case 'donut':
      body = <Donut chart={chart} />
      break
    case 'heatmap':
      body = <Heatmap chart={chart} />
      break
    case 'gantt':
      body = <Gantt chart={chart} />
      break
  }
  return (
    <figure className={`ch ch-${chart.type}`}>
      {chart.title.trim() && <figcaption>{chart.title}</figcaption>}
      {body}
    </figure>
  )
}
