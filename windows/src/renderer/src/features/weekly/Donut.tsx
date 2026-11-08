import { useId } from 'react'
import type { WeeklyDonutSnapshot } from '../../../../shared/weekly-types.ts'
import { WeeklyCard, type ExportInfo } from './Card.tsx'
import { hex } from './util.ts'

function pt(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)]
}

function sectorPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0
  const [x0, y0] = pt(cx, cy, r1, a0)
  const [x1, y1] = pt(cx, cy, r1, a1)
  const [x2, y2] = pt(cx, cy, r0, a1)
  const [x3, y3] = pt(cx, cy, r0, a0)
  return `M${x0},${y0} A${r1},${r1} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function DonutCard({
  data,
  width,
  loading,
  exportInfo,
}: {
  data: WeeklyDonutSnapshot
  width: number
  loading: boolean
  exportInfo?: ExportInfo
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const base = Math.min(235, Math.max(176, width * 0.43))
  const size = Math.min(230, Math.max(110, base * 0.86))
  const ring = size - 4
  const c = size / 2
  const outer = ring / 2
  const inner = outer * 0.75
  const hole = ring * 0.75 - 6
  const total = data.items.reduce((s, i) => s + i.minutes, 0)
  const pad = 1.5 / outer // 1.5pt of arc at the outer edge, split across both sides
  let cursor = 0
  const sectors = data.items.map((item) => {
    const span = total > 0 ? (item.minutes / total) * Math.PI * 2 : 0
    const a0 = cursor + (data.items.length > 1 ? pad : 0)
    const a1 = cursor + span - (data.items.length > 1 ? pad : 0)
    cursor += span
    // A full circle cannot be drawn as a single arc; split it.
    const full = span >= Math.PI * 2 - 1e-6
    return { item, path: full ? null : sectorPath(c, c, inner, outer, a0, Math.max(a0, a1)) }
  })
  const h = Math.floor(data.totalMinutes / 60)
  const m = data.totalMinutes % 60

  return (
    <WeeklyCard title="Weekly distribution" className="wk-donut" style={{ width, height: 300 }} titleStyle={{ left: 18, top: 16 }} exportInfo={exportInfo}>
      <div className="wk-donut-body">
        <div className="wk-donut-chart" style={{ width: size, height: size }}>
          {loading ? (
            <div className="wk-spinner" style={{ width: size * 0.4, height: size * 0.4 }} />
          ) : (
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
              <defs>
                <filter id={`${uid}-shadow`} x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="0" stdDeviation="2.5" floodColor="rgb(99,71,56)" floodOpacity="0.35" />
                </filter>
                <filter id={`${uid}-glow`}>
                  <feGaussianBlur stdDeviation="2" />
                </filter>
              </defs>
              <circle cx={c} cy={c} r={size / 2 - 3} fill="#fff" filter={`url(#${uid}-shadow)`} />
              {data.items.length === 0 ? (
                <circle cx={c} cy={c} r={(size - 20) / 2 - 10} fill="none" stroke="#EBE6E3" strokeWidth={20} />
              ) : (
                sectors.map(({ item, path }, i) => {
                  const clip = `${uid}-clip-${i}`
                  return (
                    <g key={item.id}>
                      <clipPath id={clip}>
                        {path ? <path d={path} /> : <circle cx={c} cy={c} r={outer} />}
                      </clipPath>
                      <g clipPath={`url(#${clip})`}>
                        {path ? (
                          <path d={path} fill={hex(item.colorHex, 0.8)} />
                        ) : (
                          <circle cx={c} cy={c} r={(outer + inner) / 2} fill="none" stroke={hex(item.colorHex, 0.8)} strokeWidth={outer - inner} />
                        )}
                        {path ? (
                          <path d={path} fill="none" stroke={hex(item.colorHex)} strokeWidth={8} filter={`url(#${uid}-glow)`} strokeLinejoin="round" />
                        ) : (
                          <>
                            <circle cx={c} cy={c} r={outer} fill="none" stroke={hex(item.colorHex)} strokeWidth={8} filter={`url(#${uid}-glow)`} />
                            <circle cx={c} cy={c} r={inner} fill="none" stroke={hex(item.colorHex)} strokeWidth={8} filter={`url(#${uid}-glow)`} />
                          </>
                        )}
                      </g>
                      <title>
                        {item.name}: {Math.floor(item.minutes / 60)}h {item.minutes % 60}m
                      </title>
                    </g>
                  )
                })
              )}
              {data.items.length > 0 && <circle cx={c} cy={c} r={hole / 2} fill="#fff" />}
            </svg>
          )}
          {!loading && (
            <div className="wk-donut-center">
              <div className="wk-donut-total">TOTAL</div>
              {data.items.length === 0 ? (
                <div className="wk-donut-value muted">No activity</div>
              ) : (
                <>
                  <div className="wk-donut-value">{plural(h, 'hour')}</div>
                  <div className="wk-donut-value">{plural(m, 'minute')}</div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="wk-donut-legend">
          {!loading &&
            data.items.map((item) => (
              <div key={item.id} className="wk-legend-row">
                <span className="wk-legend-swatch" style={{ background: hex(item.colorHex) }} />
                <span className="wk-legend-name">{item.name}</span>
                <span className="wk-legend-pct">{data.totalMinutes > 0 ? Math.round((item.minutes / data.totalMinutes) * 100) : 0}%</span>
              </div>
            ))}
        </div>
      </div>
    </WeeklyCard>
  )
}
