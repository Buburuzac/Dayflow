import type { WeeklyContextChartsSnapshot } from '../../../../shared/weekly-types.ts'
import { WeeklyCard, type ExportInfo } from './Card.tsx'

const DISTRACTED = '#FF8A8A'
const SHIFTS = '#A78CFF'

/** Catmull-Rom (uniform) through the points, as cubic Bézier segments. */
function catmullRom(points: [number, number][]): string {
  if (points.length === 0) return ''
  let d = `M${points[0][0]},${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`
  }
  return d
}

export function ContextCard({ data, width, exportInfo }: { data: WeeklyContextChartsSnapshot; width: number; exportInfo?: ExportInfo }) {
  const days = data.comparison.days
  const chartWidth = Math.max(320, width - 48)
  const chartHeight = 104
  const maxValue = Math.max(0, ...days.map((d) => Math.max(d.distracted, d.shifts)))
  const yMax = Math.max(maxValue + 2, 4)
  const pad = 5 // keep the markers inside the plot
  const x = (i: number) => pad + (i / 6) * (chartWidth - 2 * pad)
  const y = (v: number) => chartHeight - pad - (v / yMax) * (chartHeight - 2 * pad)
  const series = [
    { key: 'distracted' as const, color: DISTRACTED },
    { key: 'shifts' as const, color: SHIFTS },
  ]

  return (
    <WeeklyCard
      title="Context shift and distractions comparison"
      className="wk-context"
      style={{ width, height: 300 }}
      titleStyle={{ left: 24, top: 16, right: 24 }}
      exportInfo={exportInfo}
    >
      <div className="wk-context-upper">
        <div className="wk-context-legend">
          <span>
            <i style={{ background: DISTRACTED }} />
            Number of times distracted
          </span>
          <span>
            <i style={{ background: SHIFTS }} />
            Number of context shifts
          </span>
        </div>
        <div className="wk-context-count">Count</div>
        <svg width={chartWidth} height={chartHeight} className="wk-context-svg">
          <path d={`M0.5,0 V${chartHeight - 0.5} H${chartWidth}`} fill="none" stroke="rgba(90,83,76,0.9)" strokeWidth={1} />
          {series.map((s) => {
            const pts = days.map((d, i) => [x(i), y(d[s.key])] as [number, number])
            return (
              <g key={s.key}>
                <path d={catmullRom(pts)} fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" />
                {pts.map(([px, py], i) => (
                  <circle key={i} cx={px} cy={py} r={3.6} fill={s.color}>
                    <title>
                      {days[i].day}: {days[i][s.key]} {s.key === 'distracted' ? 'distractions' : 'context shifts'}
                    </title>
                  </circle>
                ))}
              </g>
            )
          })}
        </svg>
        <div className="wk-context-days" style={{ width: chartWidth }}>
          {days.map((d) => (
            <span key={d.day}>{d.day}</span>
          ))}
        </div>
      </div>
      <div className="wk-context-footer">
        <i />
        <span>{data.comparison.insight}</span>
      </div>
    </WeeklyCard>
  )
}
