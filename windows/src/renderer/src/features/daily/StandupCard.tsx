import { useEffect, useRef, useState } from 'react'
import type { DailyBulletItem, DailyStandupDraft, StandupView } from '../../../../shared/daily-types.ts'
import { dailyApi, errorText } from './api.ts'

type RegenState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; label: string; error?: string }

function newId(): string {
  return crypto.randomUUID().toUpperCase()
}

export function StandupCard({ view, onView }: { view: StandupView; onView: (v: StandupView) => void }) {
  const [draft, setDraft] = useState<DailyStandupDraft>(view.draft)
  const [regen, setRegen] = useState<RegenState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<DailyStandupDraft | null>(null)
  const day = view.day
  const isPlaceholder = view.placeholder !== null

  // Reset local state when the stored draft changes (day switch, regenerate, external edit).
  useEffect(() => {
    if (!pending.current) setDraft(view.draft)
  }, [view])

  useEffect(() => {
    setRegen({ kind: 'idle' })
    return () => {
      // Changing the viewed day cancels an in-flight regeneration and flushes a pending edit.
      void dailyApi.cancelRegenerate(day)
      if (saveTimer.current && pending.current) {
        clearTimeout(saveTimer.current)
        void dailyApi.edit(day, pending.current)
      }
      pending.current = null
    }
  }, [day])

  const update = (next: DailyStandupDraft) => {
    setDraft(next)
    if (isPlaceholder) return // placeholders are never persisted
    pending.current = next
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const d = pending.current
      pending.current = null
      if (d) void dailyApi.edit(day, d)
    }, 250)
  }

  const regenerate = async () => {
    setRegen({ kind: 'running' })
    try {
      const r = await dailyApi.regenerate(day)
      if (r.status === 'cancelled') return
      onView(r.view)
      setDraft(r.view.draft)
      setRegen(
        r.status === 'ok'
          ? { kind: 'done', label: 'Regenerated' }
          : r.status === 'error'
            ? { kind: 'done', label: 'Failed', error: r.message }
            : { kind: 'done', label: 'No data' },
      )
    } catch (err) {
      setRegen({ kind: 'done', label: 'Failed', error: errorText(err) })
    }
    setTimeout(() => setRegen((s) => (s.kind === 'done' && !s.error ? { kind: 'idle' } : s)), 2000)
  }

  const copy = async () => {
    await dailyApi.copy(day, draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const generatedBy = draft.generation && !isPlaceholder
    ? [draft.generation.modelOrTool, draft.generation.generatedAt && new Date(draft.generation.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', hour12: false })]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <section className="dl-card dl-standup">
      <header className="dl-card-head">
        <div>
          <h2 className="serif">{view.titles.heading}</h2>
          {generatedBy && <div className="dl-sub">Generated with {generatedBy}</div>}
        </div>
        <div className="dl-actions">
          <button className="btn ghost" onClick={() => void copy()} disabled={isPlaceholder}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn ghost" onClick={() => void regenerate()} disabled={regen.kind === 'running' || view.provider === 'none'}>
            {regen.kind === 'running' ? (
              <span>
                Regenerating<span className="dl-dots" />
              </span>
            ) : regen.kind === 'done' ? (
              regen.label
            ) : (
              'Regenerate'
            )}
          </button>
        </div>
      </header>
      {regen.kind === 'done' && regen.error && (
        <div className="notice err dl-notice" onClick={() => setRegen({ kind: 'idle' })}>
          {regen.error}
        </div>
      )}
      {isPlaceholder ? (
        <div className="dl-placeholder">{draft.highlights[0]?.text}</div>
      ) : (
        <div className="dl-standup-body">
          <BulletSection
            title={view.titles.highlights}
            items={draft.highlights}
            onChange={(highlights) => update({ ...draft, highlights })}
          />
          <BulletSection title={view.titles.tasks} items={draft.tasks} onChange={(tasks) => update({ ...draft, tasks })} />
          <div className="dl-section">
            <input
              className="dl-section-title-edit"
              value={draft.blockersTitle || view.titles.blockers}
              onChange={(e) => update({ ...draft, blockersTitle: e.target.value })}
              aria-label="Blockers title"
            />
            <AutoTextarea
              className="dl-blockers"
              value={draft.blockersBody}
              placeholder="No blockers. Type one per line."
              onChange={(blockersBody) => update({ ...draft, blockersBody })}
            />
          </div>
        </div>
      )}
    </section>
  )
}

function BulletSection({
  title,
  items,
  onChange,
}: {
  title: string
  items: DailyBulletItem[]
  onChange: (items: DailyBulletItem[]) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  const move = (fromId: string, toId: string) => {
    if (fromId === toId) return
    const from = items.findIndex((i) => i.id === fromId)
    const to = items.findIndex((i) => i.id === toId)
    if (from < 0 || to < 0) return
    const next = [...items]
    const [it] = next.splice(from, 1)
    next.splice(to, 0, it)
    onChange(next)
  }

  return (
    <div className="dl-section">
      <h3>{title}</h3>
      <ul className="dl-bullets">
        {items.map((it) => (
          <li
            key={it.id}
            className={dragId === it.id ? 'dragging' : ''}
            onDragOver={(e) => {
              e.preventDefault()
              if (dragId) move(dragId, it.id)
            }}
          >
            <span
              className="dl-grip"
              draggable
              title="Drag to reorder"
              onDragStart={(e) => {
                setDragId(it.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setDragId(null)}
            >
              ⋮⋮
            </span>
            <AutoTextarea
              value={it.text}
              autoFocus={focusId === it.id}
              onChange={(text) => onChange(items.map((x) => (x.id === it.id ? { ...x, text } : x)))}
              onBlur={() => {
                setFocusId(null)
                if (!it.text.trim()) onChange(items.filter((x) => x.id !== it.id))
              }}
              onEnter={() => {
                const id = newId()
                const i = items.findIndex((x) => x.id === it.id)
                const next = [...items]
                next.splice(i + 1, 0, { id, text: '' })
                setFocusId(id)
                onChange(next)
              }}
            />
          </li>
        ))}
      </ul>
      <button
        className="link-btn dl-add"
        onClick={() => {
          const id = newId()
          setFocusId(id)
          onChange([...items, { id, text: '' }])
        }}
      >
        + Add item
      </button>
    </div>
  )
}

export function AutoTextarea({
  value,
  onChange,
  onBlur,
  onEnter,
  autoFocus,
  placeholder,
  className,
}: {
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  onEnter?: () => void
  autoFocus?: boolean
  placeholder?: string
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      className={`dl-text ${className ?? ''}`}
      rows={1}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (onEnter && e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          onEnter()
        }
      }}
    />
  )
}
