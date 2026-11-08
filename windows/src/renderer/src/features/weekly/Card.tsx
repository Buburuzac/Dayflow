import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { slug } from './util.ts'

export interface ExportInfo {
  weekTitle: string
  /** File slug, e.g. "weekly-distribution" */
  graphic: string
  /** Corner of the "Generated with Dayflow" watermark */
  watermark?: 'right' | 'left'
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

/**
 * A weekly section card with a hover-revealed "download PNG" button next to its title (§11).
 * Export captures the card on screen through the main process (webContents.capturePage).
 */
export function WeeklyCard({
  title,
  titleStyle,
  className,
  style,
  exportInfo,
  children,
  headerExtra,
}: {
  title: string
  titleStyle?: CSSProperties
  className?: string
  style?: CSSProperties
  exportInfo?: ExportInfo
  children: ReactNode
  headerExtra?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)

  const doExport = async () => {
    const el = ref.current
    if (!el || !exportInfo) return
    el.scrollIntoView({ block: 'nearest' })
    setExporting(true)
    await nextFrame()
    await nextFrame()
    await new Promise((r) => setTimeout(r, 60))
    const b = el.getBoundingClientRect()
    const name = `dayflow-weekly-${slug(exportInfo.weekTitle)}-${exportInfo.graphic}.png`
    try {
      await window.dayflow.call('weekly:savePng', name, { x: b.left, y: b.top, width: b.width, height: b.height })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div ref={ref} className={`wk-card ${className ?? ''} ${exporting ? 'exporting' : ''}`} style={style}>
      <div className="wk-card-title" style={titleStyle}>
        <span className="wk-title">{title}</span>
        {exportInfo && !exporting && (
          <button className="wk-export" onClick={() => void doExport()} title={`Download ${title} as a full-resolution PNG`}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 1.5v6.2M3.4 5.3 6 7.8l2.6-2.5M2 10h8" />
            </svg>
          </button>
        )}
        {headerExtra}
      </div>
      {children}
      {exporting && (
        <div className={`wk-watermark ${exportInfo?.watermark === 'left' ? 'left' : ''}`}>
          <DayflowMark size={16} />
          <span className="wk-wm-a">Generated with</span>
          <span className="wk-wm-b">Dayflow</span>
        </div>
      )}
    </div>
  )
}

export function DayflowMark({ size = 16, color = '#FF7A2F' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="7.5" fill={color} />
      <path d="M4.2 9.6c1.2-2.6 2.6-2.6 3.8 0s2.6 2.6 3.8 0" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
