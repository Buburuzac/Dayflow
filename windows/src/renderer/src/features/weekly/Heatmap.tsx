import type { WeeklyFocusHeatmapSnapshot } from '../../../../shared/weekly-types.ts'
import { WeeklyCard, type ExportInfo } from './Card.tsx'
import { axisLabelStyle, clamp01, lerpColor } from './util.ts'

const NEUTRAL_T = 0.045
const FOCUS_SOFT = 'E3DBFD'
const FOCUS_DARK = '4276E9'
const DIST_SOFT = 'F8D1CA'
const DIST_DARK = 'FC7645'
const CELL_W = 6
const CELL_H = 12
const GAP = 1

/** Centre-boosted value for long same-sign runs (§7 colour mapping). */
export function adjustedValue(values: number[], i: number): number {
  const v = values[i]
  if (Math.abs(v) < NEUTRAL_T) return v
  const sign = Math.sign(v)
  const same = (x: number) => Math.abs(x) >= NEUTRAL_T && Math.sign(x) === sign
  let a = i
  let b = i
  while (a > 0 && same(values[a - 1])) a--
  while (b < values.length - 1 && same(values[b + 1])) b++
  const len = b - a + 1
  if (len < 4) return v
  const center = (len - 1) / 2
  let t = clamp01(1 - Math.abs(i - a - center) / Math.max(center, 1))
  t = t * t * (3 - 2 * t)
  const edge = Math.max(NEUTRAL_T, Math.abs(v) * (1 - 0.65))
  const peak = Math.min(1, Math.abs(v) + 0.34)
  return sign * (edge + (peak - edge) * t)
}

function cellColor(v: number): string {
  if (Math.abs(v) < NEUTRAL_T) return 'rgba(152,152,152,0.10)'
  const p = Math.pow(clamp01(Math.abs(v)), 0.72)
  return v < 0 ? lerpColor(FOCUS_SOFT, FOCUS_DARK, p) : lerpColor(DIST_SOFT, DIST_DARK, p)
}

export function HeatmapCard({ data, width, exportInfo }: { data: WeeklyFocusHeatmapSnapshot; width: number; exportInfo?: ExportInfo }) {
  const n = data.rows[0]?.values.length ?? 0
  const gridWidth = n * CELL_W + Math.max(0, n - 1) * GAP
  const gridHeight = data.rows.length * CELL_H + Math.max(0, data.rows.length - 1) * GAP
  const span = data.endMinute - data.startMinute
  const legendWidth = Math.min(Math.max(282.156, width * 0.32), 420)

  return (
    <WeeklyCard
      title={data.title}
      className="wk-heatmap"
      style={{ width, height: 238 }}
      titleStyle={{ left: 44, top: 34 }}
      exportInfo={exportInfo}
      headerExtra={
        <div className="wk-heat-legend" style={{ width: legendWidth }}>
          <div className="wk-heat-bar" />
          <div className="wk-heat-legend-labels">
            <span>{data.focusedLabel}</span>
            <span>{data.distractedLabel}</span>
          </div>
        </div>
      }
    >
      <div className="wk-heat-body wk-hscroll">
        <div className="wk-heat-inner" style={{ width: 22 + 6 + gridWidth }}>
          <div className="wk-heat-days">
            {data.rows.map((r) => (
              <div key={r.id} style={{ height: CELL_H, marginBottom: GAP }}>
                {r.label}
              </div>
            ))}
          </div>
          <div>
            <svg width={gridWidth} height={gridHeight}>
              {data.rows.map((row, ri) =>
                row.values.map((_, ci) => {
                  const v = adjustedValue(row.values, ci)
                  return (
                    <rect
                      key={ci}
                      x={ci * (CELL_W + GAP)}
                      y={ri * (CELL_H + GAP)}
                      width={CELL_W}
                      height={CELL_H}
                      rx={0.5}
                      fill={cellColor(v)}
                    />
                  )
                }),
              )}
            </svg>
            <div className="wk-axis-labels wk-heat-axis" style={{ width: gridWidth }}>
              {data.timeLabels.map((t) => (
                <span key={t.id} style={axisLabelStyle(span > 0 ? (t.minute - data.startMinute) / span : 0, gridWidth)}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </WeeklyCard>
  )
}
