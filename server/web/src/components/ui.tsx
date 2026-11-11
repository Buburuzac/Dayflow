import { useEffect, useState, type ReactNode } from 'react'
import { errorText } from '../api/client.ts'
import type { ShareLevel } from '../api/types.ts'
import { initials } from '../lib/format.ts'

export function DayflowMark({ size = 16, color = '#FF7A2F' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="7.5" fill={color} />
      <path d="M4.2 9.6c1.2-2.6 2.6-2.6 3.8 0s2.6 2.6 3.8 0" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden />
      {label}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="notice err row between">
      <span>{errorText(error)}</span>
      {onRetry && (
        <button className="link-btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div>{children}</div>}
    </div>
  )
}

const PERSON_HUES = ['#F3854B', '#B984FF', '#6AADFF', '#4CB8A4', '#E07AA8', '#E9B949']

/** Stable colour per person (avatar background, contribution bars). */
export function personColor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PERSON_HUES[h % PERSON_HUES.length]
}

export function Avatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  if (url && !broken)
    return <img className="avatar" src={url} alt="" width={size} height={size} onError={() => setBroken(true)} referrerPolicy="no-referrer" />
  return (
    <span className="avatar initials" style={{ width: size, height: size, fontSize: size * 0.4, background: personColor(name) }}>
      {initials(name)}
    </span>
  )
}

export const SHARE_LABEL: Record<ShareLevel, string> = { time: 'Time only', cards: 'Cards', detailed: 'Detailed' }
export const SHARE_HINT: Record<ShareLevel, string> = {
  time: 'Minutes and day only',
  cards: 'Plus card title and summary',
  detailed: 'Plus detailed summary and distractions',
}

export function ShareBadge({ level }: { level: ShareLevel }) {
  return (
    <span className={`share-badge ${level}`} title={SHARE_HINT[level]}>
      {SHARE_LABEL[level]}
    </span>
  )
}

export function ProjectChip({ name, color, unconfirmed, onClick }: { name: string; color: string; unconfirmed?: boolean; onClick?: () => void }) {
  return (
    <span className={`project-chip ${unconfirmed ? 'unconfirmed' : ''}`} style={{ ['--pc' as string]: color }} onClick={onClick} title={unconfirmed ? 'Not confirmed yet' : name}>
      <i />
      {name}
      {unconfirmed && <b>?</b>}
    </span>
  )
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal aria-label={title}>
        <div className="modal-head">
          <h2 className="serif">{title}</h2>
          <button className="icon-btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Tag-style input: Enter / comma / Tab adds a chip, Backspace on empty removes the last one. */
export function ChipInput({ value, onChange, placeholder, disabled }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    const next = [...value]
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p)
    onChange(next)
    setDraft('')
  }
  return (
    <div className={`chip-input ${disabled ? 'disabled' : ''}`}>
      {value.map((v) => (
        <span key={v} className="chip">
          {v}
          {!disabled && (
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab') && draft.trim()) {
              e.preventDefault()
              add(draft)
            } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={() => draft.trim() && add(draft)}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text')
            if (/[,\n]/.test(t)) {
              e.preventDefault()
              add(draft + t)
            }
          }}
        />
      )}
    </div>
  )
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-field">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      <button
        className="btn"
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  )
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={o.id === value} className={o.id === value ? 'active' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
