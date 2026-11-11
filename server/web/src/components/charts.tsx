// Hand-written SVG charts in the style of the desktop Weekly page (serif peach titles, thin axes, muted labels).

import type { ReactNode } from 'react'
import { axisHour, parseDay, weekdayShort } from '../lib/dates.ts'
import { fmtMinutes } from '../lib/format.ts'
import { useWidth } from '../lib/hooks.ts'

const AXIS = 'rgba(90,83,76,0.9)'
const GRID = 'rgba(0,0,0,0.06)'
const LABEL = '#a5a5a5'

export function ChartCard({ title, extra, children, className }: { title: string; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`chart-card ${className ?? ''}`}>
      <header>
        <span className="chart-title">{title}</span>
        {extra}
      </header>
      {children}
    </section>
  )
}

function rgb(h: string): [number, number, number] {
  const c = h.replace('#', '')
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0) as [number, number, number]
}

export function mix(a: string, b: string, t: number): string {
  const x = rgb(a)
  const y = rgb(b)
  const m = x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t))))
  return `rgb(${m[0]},${m[1]},${m[2]})`
}

/** Nice y-axis step in hours for a max value in minutes. */
function hourTicks(maxMinutes: number): number[] {
  const maxH = Math.max(1, maxMinutes / 60)
  const step = maxH <= 4 ? 1 : maxH <= 10 ? 2 : maxH <= 24 ? 4 : maxH <= 60 ? 10 : 20
  const top = Math.ceil(maxH / step) * step
  const out: number[] = []
  for (let h = 0; h <= top; h += step) out.push(h)
  return out
}

/** Vertical bars, one per day. */
export function DayBars({ days, color }: { days: { day: string; minutes: number }[]; color: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const h = 190
  const left = 34
  const bottom = 24
  const w = Math.max(240, width)
  const ticks = hourTicks(Math.max(0, ...days.map((d) => d.minutes)))
  const top = ticks[ticks.length - 1] * 60
  const plotW = w - left - 4
  const plotH = h - bottom - 8
  const slot = plotW / Math.max(1, days.length)
  const barW = Math.max(3, Math.min(38, slot * 0.62))
  const many = days.length > 14
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={h} role="img" aria-label="Hours by day">
          {ticks.map((t) => {
            const y = 8 + plotH - (t * 60 * plotH) / top
            return (
              <g key={t}>
                <line x1={left} x2={w} y1={y} y2={y} stroke={t === 0 ? AXIS : GRID} />
                <text x={left - 6} y={y + 3.5} textAnchor="end" fontSize={10.5} fill={LABEL}>
                  {t}h
                </text>
              </g>
            )
          })}
          {days.map((d, i) => {
            const bh = top ? (d.minutes * plotH) / top : 0
            const x = left + i * slot + (slot - barW) / 2
            const dt = parseDay(d.day)
            const showLabel = !many || dt.getDate() === 1 || dt.getDay() === 1
            return (
              <g key={d.day}>
                {bh > 0 && (
                  <rect x={x} y={8 + plotH - bh} width={barW} height={bh} rx={Math.min(4, barW / 3)} fill={color}>
                    <title>
                      {d.day}: {fmtMinutes(d.minutes)}
                    </title>
                  </rect>
                )}
                {showLabel && (
                  <text x={x + barW / 2} y={h - 7} textAnchor="middle" fontSize={10.5} fill={LABEL}>
                    {many ? dt.getDate() : weekdayShort(d.day)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/** Horizontal bars per member with their totals; with `total`, each member's share of it too. */
export function MemberBars({ rows, color, total }: { rows: { id: string; name: string; minutes: number }[]; color: string; total?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const rowH = 30
  const labelW = Math.min(150, Math.max(90, width * 0.3))
  const valueW = total ? 104 : 64
  const max = Math.max(1, ...rows.map((r) => r.minutes))
  const w = Math.max(260, width)
  const barMax = w - labelW - valueW - 8
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={rows.length * rowH + 4} role="img" aria-label="Totals by member">
          {rows.map((r, i) => {
            const y = i * rowH + 4
            const bw = Math.max(2, (r.minutes / max) * barMax)
            return (
              <g key={r.id}>
                <text x={0} y={y + 15} fontSize={12.5} fill="#333">
                  {r.name.length > 20 ? `${r.name.slice(0, 19)}…` : r.name}
                </text>
                <rect x={labelW} y={y + 4} width={barMax} height={14} rx={7} fill="rgba(0,0,0,0.04)" />
                <rect x={labelW} y={y + 4} width={bw} height={14} rx={7} fill={color} />
                <text x={w - 2} y={y + 15} fontSize={12} textAnchor="end" fill="#707070">
                  {fmtMinutes(r.minutes)}
                  {total ? <tspan fill="#a5a5a5">{` · ${total > 0 ? Math.round((r.minutes / total) * 100) : 0}%`}</tspan> : null}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/** Member × day heat grid. */
export function HeatGrid({ members, days, value, color }: { members: { id: string; name: string }[]; days: string[]; value: (memberId: string, day: string) => number; color: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const labelW = 120
  const gap = 3
  const cell = Math.max(14, Math.min(46, (Math.max(260, width) - labelW) / Math.max(1, days.length) - gap))
  const cellH = 26
  const gridW = days.length * (cell + gap)
  const max = Math.max(1, ...members.flatMap((m) => days.map((d) => value(m.id, d))))
  const showText = cell >= 30
  const many = days.length > 14
  return (
    <div ref={ref} className="chart-box hscroll">
      {width > 0 && (
        <svg width={labelW + gridW} height={members.length * (cellH + gap) + 22} role="img" aria-label="Minutes by member and day">
          {days.map((d, j) => {
            const dt = parseDay(d)
            if (many && !(dt.getDate() === 1 || dt.getDay() === 1)) return null
            return (
              <text key={d} x={labelW + j * (cell + gap) + cell / 2} y={12} textAnchor="middle" fontSize={10.5} fill={LABEL}>
                {many ? dt.getDate() : weekdayShort(d)}
              </text>
            )
          })}
          {members.map((m, i) => {
            const y = 20 + i * (cellH + gap)
            return (
              <g key={m.id}>
                <text x={0} y={y + cellH / 2 + 4} fontSize={12.5} fill="#333">
                  {m.name.length > 16 ? `${m.name.slice(0, 15)}…` : m.name}
                </text>
                {days.map((d, j) => {
                  const v = value(m.id, d)
                  const t = v > 0 ? 0.15 + 0.85 * Math.pow(v / max, 0.75) : 0
                  return (
                    <g key={d}>
                      <rect
                        x={labelW + j * (cell + gap)}
                        y={y}
                        width={cell}
                        height={cellH}
                        rx={3}
                        fill={v > 0 ? mix('#FFF1E8', color, t) : 'rgba(152,152,152,0.10)'}
                      >
                        <title>
                          {m.name}, {d}: {fmtMinutes(v)}
                        </title>
                      </rect>
                      {showText && v > 0 && (
                        <text x={labelW + j * (cell + gap) + cell / 2} y={y + cellH / 2 + 4} textAnchor="middle" fontSize={10.5} fill={t > 0.55 ? '#fff' : '#555'} pointerEvents="none">
                          {(v / 60).toFixed(1)}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/** One-day strip (offsets from the 4 AM boundary) with duration segments; used for "time only" members. */
export function DayStrip({ segments, window, color }: { segments: { start: number; end: number; label?: string }[]; window: [number, number]; color: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const w = Math.max(200, width)
  const [a, b] = window
  const span = (b - a) * 60
  const x = (m: number) => ((Math.max(a * 60, Math.min(b * 60, m)) - a * 60) / span) * w
  const step = b - a > 12 ? 3 : 2
  const ticks: number[] = []
  for (let hh = Math.ceil(a / step) * step; hh <= b; hh += step) ticks.push(hh)
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={34}>
          <rect x={0} y={4} width={w} height={12} rx={6} fill="rgba(0,0,0,0.045)" />
          {segments.map((s, i) => (
            <rect key={i} x={x(s.start)} y={4} width={Math.max(2, x(s.end) - x(s.start))} height={12} rx={3} fill={color}>
              <title>{s.label}</title>
            </rect>
          ))}
          {ticks.map((t) => (
            <text key={t} x={Math.min(w - 16, Math.max(16, ((t - a) / (b - a)) * w))} y={30} textAnchor="middle" fontSize={10} fill={LABEL}>
              {axisHour(t)}
            </text>
          ))}
        </svg>
      )}
    </div>
  )
}

/** Stacked horizontal share bar (category / project totals). */
export function ShareBar({ parts }: { parts: { key: string; color: string; value: number; label: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  if (!total) return null
  return (
    <svg className="share-bar" width="100%" height={10} preserveAspectRatio="none" viewBox={`0 0 ${total} 10`}>
      {parts.reduce<{ x: number; els: ReactNode[] }>(
        (acc, p) => {
          acc.els.push(
            <rect key={p.key} x={acc.x} y={0} width={p.value} height={10} fill={p.color}>
              <title>{p.label}</title>
            </rect>,
          )
          acc.x += p.value
          return acc
        },
        { x: 0, els: [] },
      ).els}
    </svg>
  )
}
