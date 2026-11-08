import type { WeeklyWorkflowSnapshot } from '../../../../shared/weekly-types.ts'
import { WeeklyCard, type ExportInfo } from './Card.tsx'
import { axisLabelStyle, hex, shortTime } from './util.ts'

const CELL = 13
const GAP = 2

function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const r = m % 60
  return h > 0 ? (r > 0 ? `${h}h ${r}m` : `${h}h`) : `${r}m`
}

export function WorkflowCard({ data, width, exportInfo }: { data: WeeklyWorkflowSnapshot; width: number; exportInfo?: ExportInfo }) {
  const n = data.rows[0]?.cells.length ?? 0
  const gridWidth = n * CELL + Math.max(0, n - 1) * GAP
  const gridHeight = data.rows.length * CELL + Math.max(0, data.rows.length - 1) * GAP
  const span = data.endMinute - data.startMinute

  return (
    <WeeklyCard title={data.title} className="wk-workflow" style={{ width }} titleStyle={{ left: 79, top: 16 }} exportInfo={exportInfo}>
      <div className="wk-workflow-panel wk-hscroll">
        <div className="wk-workflow-inner" style={{ width: 30 + 13 + gridWidth }}>
          <div className="wk-workflow-days">
            {data.rows.map((r) => (
              <div key={r.id} style={{ height: CELL, marginBottom: GAP }}>
                {r.label}
              </div>
            ))}
          </div>
          <div className="wk-workflow-grid">
            <svg width={gridWidth} height={gridHeight}>
              {data.rows.map((row, ri) =>
                row.cells.map((cell, ci) => {
                  const slotStart = data.startMinute + ci * data.slotMinutes
                  const slotEnd = Math.min(data.endMinute, slotStart + data.slotMinutes)
                  const range = `${shortTime(slotStart)}–${shortTime(slotEnd)}`
                  const empty = !cell.colorHex || cell.occupancy <= 0
                  return (
                    <rect
                      key={cell.id}
                      x={ci * (CELL + GAP)}
                      y={ri * (CELL + GAP)}
                      width={CELL}
                      height={CELL}
                      rx={2.5}
                      fill={empty ? 'rgba(152,152,152,0.10)' : hex(cell.colorHex, 0.3 + 0.7 * cell.occupancy)}
                    >
                      <title>
                        {empty
                          ? `${row.label} ${range}: No activity`
                          : `${row.label} ${range}: ${cell.categoryName}, ${fmtMinutes(cell.minutes)}`}
                      </title>
                    </rect>
                  )
                }),
              )}
            </svg>
            <div className="wk-axis-line" style={{ width: gridWidth }} />
            <div className="wk-axis-labels" style={{ width: gridWidth }}>
              {data.timeLabels.map((t) => (
                <span key={t.id} style={axisLabelStyle(span > 0 ? (t.minute - data.startMinute) / span : 0, gridWidth)}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="wk-footer wk-hscroll">
        <span className="wk-footer-label">Week total</span>
        {data.totals.length === 0 ? (
          <span className="wk-footer-empty">
            No captured activity during {shortTime(data.startMinute)}–{shortTime(data.endMinute)}
          </span>
        ) : (
          data.totals.map((t) => (
            <span key={t.id} className="wk-footer-item">
              <span>{t.name}</span>
              <b style={{ color: hex(t.colorHex) }}>{t.duration}</b>
            </span>
          ))
        )}
      </div>
    </WeeklyCard>
  )
}
