import { useState } from 'react'
import type { WeeklyTreemapApp, WeeklyTreemapChange, WeeklyTreemapSnapshot } from '../../../../shared/weekly-types.ts'
import { WeeklyCard, type ExportInfo } from './Card.tsx'
import { place, type LayoutRect } from './squarify.ts'
import { hex } from './util.ts'
import { AppAvatar } from './AppAvatar.tsx'

const CAT_GAP = 6
const TILE_GAP = 4

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

function durationText(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  const r = m % 60
  return h > 0 ? (r > 0 ? `${h}hr ${r}m` : `${h}hr`) : `${r}m`
}

const sortApps = (apps: WeeklyTreemapApp[]) =>
  [...apps].sort((a, b) => Math.max(b.durationSeconds, 1) - Math.max(a.durationSeconds, 1) || a.name.localeCompare(b.name))

const tooSmall = (r: LayoutRect) => r.w < 44 || r.h < 28 || r.w * r.h < 1600

/** Merges the smallest tiles into "Other" until every remaining tile is legible (§8 leaf aggregation). */
function aggregateLeaves(apps: WeeklyTreemapApp[], rect: LayoutRect): { item: WeeklyTreemapApp; rect: LayoutRect }[] {
  let working = sortApps(apps)
  let placed = place(working, (a) => a.durationSeconds, rect, TILE_GAP)
  while (working.length > 1) {
    placed = place(working, (a) => a.durationSeconds, rect, TILE_GAP)
    if (!placed.some((p) => !p.item.isAggregate && tooSmall(p.rect))) break
    const candidates = working.filter((a) => !a.isAggregate)
    if (candidates.length === 0) break
    const smallest = candidates[candidates.length - 1]
    let other = working.find((a) => a.isAggregate)
    working = working.filter((a) => a !== smallest && a !== other)
    other = other
      ? { ...other, durationSeconds: other.durationSeconds + smallest.durationSeconds }
      : {
          id: 'other',
          name: 'Other',
          colorHex: 'BFB6AE',
          durationSeconds: smallest.durationSeconds,
          change: null,
          isAggregate: true,
          isPlaceholder: false,
        }
    working = sortApps([...working, other])
    placed = place(working, (a) => a.durationSeconds, rect, TILE_GAP)
  }
  return placed
}

function Badge({ change }: { change: WeeklyTreemapChange }) {
  return <span className={`wk-badge ${change.kind}`}>{change.text}</span>
}

interface Hover {
  app: WeeklyTreemapApp
  rect: LayoutRect
  shell: string
  border: string
}

export function TreemapCard({ data, width, exportInfo }: { data: WeeklyTreemapSnapshot; width: number; exportInfo?: ExportInfo }) {
  const [hover, setHover] = useState<Hover | null>(null)
  const content: LayoutRect = { x: 0, y: 0, w: Math.max(797, width - 80), h: 400 }
  const cats = place(
    data.categories,
    (c) => c.apps.reduce((s, a) => s + a.durationSeconds, 0),
    content,
    CAT_GAP,
  )

  return (
    <WeeklyCard title={data.title} className="wk-treemap" style={{ width, height: 549 }} titleStyle={{ left: 40, top: 34 }} exportInfo={exportInfo}>
      <div className="wk-treemap-scroll" style={{ overflowX: content.w > width - 80 ? 'auto' : 'visible' }}>
        <div className="wk-treemap-content" style={{ width: content.w, height: content.h }} onMouseLeave={() => setHover(null)}>
          {cats.map(({ item: cat, rect }) => {
            const base = cat.colorHex
            const shell = hex(base, 0.25)
            const border = hex(base, 0.75)
            const total = cat.apps.reduce((s, a) => s + a.durationSeconds, 0)
            const dur = durationText(total)
            const font = '12px Figtree, "Segoe UI", sans-serif'
            const avail = rect.w - 20
            const oneLine = textWidth(cat.name, font) + 8 + textWidth(dur, font) <= avail
            const twoLines = !oneLine && rect.h >= 90
            const headerH = oneLine || !twoLines ? 8 + 15 + 8 : 8 + 30 + 8
            const leafRect: LayoutRect = { x: 8, y: headerH, w: rect.w - 16, h: rect.h - headerH - 8 }
            const leaves = leafRect.w > 0 && leafRect.h > 0 ? aggregateLeaves(cat.apps, leafRect) : []
            return (
              <div
                key={cat.id}
                className="wk-tm-cat"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, background: shell, border: `0.75px solid ${border}` }}
              >
                <div className={`wk-tm-header ${twoLines ? 'stack' : ''}`}>
                  <span className="wk-tm-name">{cat.name}</span>
                  {(oneLine || twoLines) && <span>{dur}</span>}
                </div>
                {leaves.map(({ item: app, rect: r }) => (
                  <Leaf
                    key={app.id}
                    app={app}
                    rect={{ ...r, x: r.x + leafRect.x, y: r.y + leafRect.y }}
                    fill={hex(base, 0.42)}
                    border={hex(base)}
                    onHover={(on) =>
                      setHover(
                        on
                          ? { app, rect: { x: rect.x + leafRect.x + r.x, y: rect.y + leafRect.y + r.y, w: r.w, h: r.h }, shell, border }
                          : null,
                      )
                    }
                  />
                ))}
              </div>
            )
          })}
          {hover && <HoverCard hover={hover} bounds={content} />}
        </div>
      </div>
    </WeeklyCard>
  )
}

type Presentation = 'full' | 'compact' | 'labelOnly'

function Leaf({
  app,
  rect,
  fill,
  border,
  onHover,
}: {
  app: WeeklyTreemapApp
  rect: LayoutRect
  fill: string
  border: string
  onHover: (on: boolean) => void
}) {
  const { w, h } = rect
  const typo = w >= 160 && h >= 110 ? { name: 20, detail: 12, spacing: 4, pad: 12 } : w >= 90 && h >= 54 ? { name: 16, detail: 12, spacing: 3, pad: 10 } : { name: 13, detail: 10, spacing: 2, pad: 6 }
  const hasFavicon = !app.isAggregate && app.id !== 'other' && app.name !== 'Other'
  const hasChange = !!app.change
  const fullHeight = hasChange ? (hasFavicon ? 92 : 72) : hasFavicon ? 70 : 56
  const pres: Presentation = w >= 90 && h >= fullHeight ? 'full' : w >= 58 && h >= 34 ? 'compact' : 'labelOnly'
  const nameSize = pres === 'full' ? typo.name : pres === 'compact' ? Math.max(11, typo.name - 2) : Math.max(10, typo.name - 3)
  const detailSize = pres === 'full' ? typo.detail : Math.max(10, typo.detail - 1)
  const icon = Math.max(12, Math.round(nameSize * 1.15))
  return (
    <div
      className={`wk-tm-leaf ${pres}`}
      style={{ left: rect.x, top: rect.y, width: w, height: h, background: fill, border: `0.5px solid ${border}`, padding: typo.pad, gap: typo.spacing }}
      onMouseEnter={() => pres !== 'full' && onHover(true)}
      onMouseLeave={() => pres !== 'full' && onHover(false)}
    >
      <div className="wk-tm-leaf-name" style={{ fontSize: nameSize }}>
        {hasFavicon && <AppAvatar name={app.name} colorHex={app.colorHex} size={icon} />}
        <span>{app.name}</span>
      </div>
      {pres !== 'labelOnly' && (
        <div className="wk-tm-leaf-dur" style={{ fontSize: detailSize }}>
          {durationText(app.durationSeconds)}
        </div>
      )}
      {pres === 'full' && app.change && <Badge change={app.change} />}
    </div>
  )
}

function HoverCard({ hover, bounds }: { hover: Hover; bounds: LayoutRect }) {
  const W = 176
  const H = 92
  const { rect } = hover
  const left = Math.max(0, Math.min(bounds.w - W, rect.x + rect.w / 2 - W / 2))
  let top = rect.y - 10 - H
  if (top < -60) top = Math.min(bounds.h + 40 - H, rect.y + rect.h + 10)
  return (
    <div className="wk-tm-hover" style={{ left, top, width: W, height: H, borderColor: hover.border }}>
      <div className="wk-tm-hover-tint" style={{ background: hover.shell }} />
      <div className="wk-tm-hover-name">{hover.app.name}</div>
      <div className="wk-tm-hover-dur">{durationText(hover.app.durationSeconds)}</div>
      {hover.app.change && <Badge change={hover.app.change} />}
    </div>
  )
}
