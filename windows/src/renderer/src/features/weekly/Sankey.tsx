import { useEffect, useId, useState, type MouseEvent } from 'react'
import type { WeeklySankeyFlow, WeeklySankeyModel, WeeklySankeyNode } from '../../../../shared/weekly-types.ts'
import { WeeklyCard, type ExportInfo } from './Card.tsx'
import { hex } from './util.ts'

const VW = 1748
const VH = 933

function ribbon(x0: number, y0t: number, y0b: number, x1: number, y1t: number, y1b: number, tension: number): string {
  const c = Math.max(90, (x1 - x0) * tension)
  return (
    `M${x0},${y0t} C${x0 + c},${y0t} ${x1 - c},${y1t} ${x1},${y1t} ` +
    `L${x1},${y1b} C${x1 - c},${y1b} ${x0 + c},${y0b} ${x0},${y0b} Z`
  )
}

function tint(h: string): string {
  const c = h.toUpperCase()
  if (c === '000000' || c === '333333' || c === '111111') return 'CAC2BA'
  if (c === 'D9D9D9' || c === 'BFB6AE') return 'CFC8C1'
  return c
}

type Stop = [string, number, number] // color, opacity, offset

function flowStops(f: WeeklySankeyFlow, isSource: boolean): Stop[] {
  const s = Math.max(0.08, Math.min(0.36, f.opacity))
  const to = tint(f.toColorHex)
  const from = tint(f.fromColorHex)
  if (isSource) {
    return [
      ['E3D8CF', 0.18, 0],
      ['ECE3DC', 0.16, 0.24],
      [to, Math.min(0.12, s * 0.42), 0.58],
      [to, Math.min(0.2, s * 0.72), 0.82],
      [to, Math.min(0.32, s * 1.08), 1],
    ]
  }
  return [
    [from, Math.min(0.2, s * 0.68), 0],
    [from, Math.min(0.11, s * 0.4), 0.24],
    [to, Math.min(0.05, s * 0.2), 0.54],
    [to, Math.min(0.12, s * 0.42), 0.78],
    [to, Math.min(0.27, s * 0.9), 1],
  ]
}

function NodeIcon({ node }: { node: WeeklySankeyNode }) {
  if (node.icon.type !== 'monogram') return null
  return (
    <span className="wk-sk-icon" style={{ background: hex(node.icon.backgroundHex), color: hex(node.icon.foregroundHex) }}>
      {node.icon.text}
    </span>
  )
}

export function SankeyCard({ model, width, weekKey, exportInfo }: { model: WeeklySankeyModel; width: number; weekKey: string; exportInfo?: ExportInfo }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [hovered, setHovered] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  useEffect(() => {
    setHovered(null)
    setPinned(null)
  }, [weekKey])

  const s = width / VW
  const height = width * (VH / VW)
  const active = pinned ?? hovered
  const sourceId = model.source.id
  const flowLit = (f: WeeklySankeyFlow) => !active || active === sourceId || f.from === active || f.to === active
  const nodeLit = (id: string) =>
    !active ||
    active === id ||
    active === sourceId ||
    model.flows.some((f) => (f.from === active && f.to === id) || (f.to === active && f.from === id))
  const toggle = (id: string) => (e: MouseEvent) => {
    e.stopPropagation()
    setPinned((p) => (p === id ? null : id))
  }

  const cats = model.categories
  const apps = model.apps
  const hasData = cats.length > 0 && apps.length > 0
  const catTop = cats[0]?.bar.y ?? 0
  const lastCat = cats[cats.length - 1]
  const catBottom = lastCat ? lastCat.bar.y + lastCat.bar.height : 0
  const appTop = apps[0]?.bar.y ?? 0
  const lastApp = apps[apps.length - 1]
  const appBottom = lastApp ? lastApp.bar.y + lastApp.bar.height : 0
  const src = model.source.bar

  const nodeHandlers = (id: string) => ({
    onMouseEnter: () => setHovered(id),
    onMouseLeave: () => setHovered((h) => (h === id ? null : h)),
    onClick: toggle(id),
  })

  return (
    <WeeklyCard
      title="Weekly breakdown"
      className="wk-sankey"
      style={{ width, height }}
      titleStyle={{ left: 72 * s, top: 64 * s - 12 }}
      exportInfo={exportInfo}
    >
      <div className="wk-sankey-canvas" onMouseLeave={() => setHovered(null)} onClick={() => setPinned(null)}>
        <svg width={width} height={height} viewBox={`0 0 ${VW} ${VH}`}>
          <defs>
            <linearGradient id={`${uid}-env1`} gradientUnits="userSpaceOnUse" x1={src.x + src.width} x2={760} y1={0} y2={0}>
              <stop offset={0} stopColor="#E6DBD1" stopOpacity={0.48} />
              <stop offset={0.42} stopColor="#EFE9E3" stopOpacity={0.34} />
              <stop offset={0.76} stopColor="#F4EEE9" stopOpacity={0.2} />
              <stop offset={1} stopColor="#F7F2ED" stopOpacity={0.08} />
            </linearGradient>
            <linearGradient id={`${uid}-env2`} gradientUnits="userSpaceOnUse" x1={772} x2={1334} y1={0} y2={0}>
              <stop offset={0} stopColor="#EFE7E0" stopOpacity={0.08} />
              <stop offset={0.46} stopColor="#F4EEE9" stopOpacity={0.11} />
              <stop offset={1} stopColor="#EFE7E0" stopOpacity={0.07} />
            </linearGradient>
            {model.flows.map((f, i) => (
              <linearGradient key={f.id} id={`${uid}-f${i}`} gradientUnits="userSpaceOnUse" x1={f.x0} x2={f.x1} y1={0} y2={0}>
                {flowStops(f, f.from === sourceId).map(([c, o, off], j) => (
                  <stop key={j} offset={off} stopColor={`#${c}`} stopOpacity={o} />
                ))}
              </linearGradient>
            ))}
          </defs>
          {hasData && (
            <>
              <path d={ribbon(src.x + src.width, src.y, src.y + src.height, 760, catTop, catBottom, 0.15)} fill={`url(#${uid}-env1)`} />
              <path d={ribbon(772, catTop, catBottom, 1334, appTop, appBottom, 0.22)} fill={`url(#${uid}-env2)`} opacity={0.72} />
            </>
          )}
          {model.flows.map((f, i) => (
            <path
              key={f.id}
              className="wk-sk-flow"
              d={ribbon(f.x0, f.y0Top, f.y0Bottom, f.x1, f.y1Top, f.y1Bottom, f.curveTension)}
              fill={`url(#${uid}-f${i})`}
              stroke="transparent"
              strokeWidth={16 / s}
              pointerEvents="all"
              opacity={flowLit(f) ? 1 : 0.12}
              onMouseEnter={() => setHovered(f.to)}
              onClick={toggle(f.to)}
            />
          ))}
          {hasData && (
            <rect
              {...nodeHandlers(sourceId)}
              className="wk-sk-bar"
              x={src.x}
              y={src.y}
              width={src.width}
              height={src.height}
              fill={hex(model.source.barColorHex)}
            />
          )}
          {[...cats, ...apps].map((n) => (
            <rect
              key={n.id}
              {...nodeHandlers(n.id)}
              className="wk-sk-bar"
              x={n.bar.x}
              y={n.bar.y}
              width={n.bar.width}
              height={n.bar.height}
              fill={hex(n.barColorHex)}
              opacity={nodeLit(n.id) ? 1 : 0.25}
            />
          ))}
        </svg>
        {hasData &&
          [model.source, ...cats].map((n) => (
            <div
              key={n.id}
              {...nodeHandlers(n.id)}
              className="wk-sk-label"
              style={{ left: n.label.x * s, top: n.label.y * s, width: n.label.width * s, height: 54 * s, opacity: nodeLit(n.id) ? 1 : 0.25 }}
            >
              <div className="wk-sk-name">{n.name}</div>
              <div className="wk-sk-metric">
                {n.metric}
                <i />
                {n.percent}
              </div>
            </div>
          ))}
        {hasData &&
          apps.map((n) => (
            <div
              key={n.id}
              {...nodeHandlers(n.id)}
              className="wk-sk-label app"
              style={{ left: n.label.x * s, top: n.label.y * s, width: n.label.width * s, height: 56 * s, opacity: nodeLit(n.id) ? 1 : 0.25 }}
            >
              <NodeIcon node={n} />
              <span className="wk-sk-name">{n.name}</span>
              <span className="wk-sk-metric">
                {n.metric}
                <i />
                <span className="pct">{n.percent}</span>
              </span>
            </div>
          ))}
        {!hasData && <div className="wk-sk-empty">No activity was recorded this week.</div>}
      </div>
    </WeeklyCard>
  )
}
