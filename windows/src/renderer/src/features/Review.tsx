// Timeline review (TimelineReviewOverlay, spec C.3): rate each card of a day as Distracted,
// Neutral or Focused by dragging it left / up / right, with the arrow keys or the buttons.
// Ratings are stored by time range (review:* channels).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScreenshotInfo, SettingsWithSecrets, TimelineCard } from '../../../shared/types.ts'
import type { ReviewDayData, ReviewRating, ReviewSummary } from '../../../shared/review-types.ts'
import { clock24, currentDay, dayLabel, fmtDuration, shiftDay } from '../dates.ts'
import './review.css'

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)

const BASE_W = 340
const BASE_H = 440
const DRAG_START = 10
const HINT = 30
const COMMIT_X = 140
const COMMIT_UP = 120
const SPEED_KEY = 'timelineReviewPlaybackSpeedMultiplier'
const SPEEDS = [1, 2, 3, 6]
const LABEL: Record<ReviewRating, string> = { distracted: 'Distracted', neutral: 'Neutral', focused: 'Focused' }

type Input = 'drag' | 'trackpad' | 'keyboard' | 'button'

interface Drag {
  x0: number
  y0: number
  dx: number
  dy: number
  active: boolean
  overSummary: boolean
  pointerId: number
}

interface Exit {
  rating: ReviewRating
  x: number
  y: number
  rot: number
  ms: number
}

/** Predicted rating for a drag offset; null below the hint threshold. */
function predict(dx: number, dy: number, threshold: number): ReviewRating | null {
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= threshold) return 'focused'
    if (dx <= -threshold) return 'distracted'
    return null
  }
  return dy <= -threshold ? 'neutral' : null
}

function committed(dx: number, dy: number): ReviewRating | null {
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= COMMIT_X) return 'focused'
    if (dx <= -COMMIT_X) return 'distracted'
    return null
  }
  return dy <= -COMMIT_UP ? 'neutral' : null
}

export function ReviewView({
  settings,
  day: initialDay,
  onClose,
}: {
  settings: SettingsWithSecrets
  day?: string
  onClose?: () => void
}) {
  const [day, setDay] = useState(initialDay ?? currentDay())
  const [data, setData] = useState<ReviewDayData | null>(null)
  const [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [index, setIndex] = useState(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [exit, setExit] = useState<Exit | null>(null)
  const [entering, setEntering] = useState(false)
  const [scale, setScale] = useState(1)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(() => {
    const v = Number(localStorage.getItem(SPEED_KEY))
    return SPEEDS.includes(v) ? v : 3
  })
  const stageRef = useRef<HTMLDivElement>(null)
  const wheel = useRef({ x: 0, y: 0, t: 0 })
  const busy = useRef(false)

  useEffect(() => {
    if (initialDay) setDay(initialDay)
  }, [initialDay])

  useEffect(() => {
    setData(null)
    setIndex(0)
    setExit(null)
    void call<ReviewDayData>('review:day', day).then((d) => {
      setData(d)
      setSummary(d.summary)
    })
  }, [day])

  // Fit the 340×440 card between 0.1× and 1.4×.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const s = Math.min((el.clientWidth - 40) / BASE_W, (el.clientHeight - 30) / BASE_H)
      setScale(Math.min(1.4, Math.max(0.1, s)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [data !== null, (data?.cards.length ?? 0) > index])

  const colors = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of settings.categories) m.set(c.name.toLowerCase(), c.color)
    return m
  }, [settings.categories])

  const deck = data?.cards ?? []
  const card = deck[index] ?? null
  const next = deck[index + 1] ?? null

  const commit = useCallback(
    (rating: ReviewRating, _input: Input, fromDrag?: { dx: number; dy: number }) => {
      if (!card || busy.current) return
      busy.current = true
      void call<ReviewSummary>('review:rate', day, card.startTs, card.endTs, rating).then(setSummary)
      const dist = 1.6 * Math.max(BASE_W, BASE_H) * scale
      let x = 0
      let y = 0
      let rot = 0
      let speedFactor = 0
      if (fromDrag && (fromDrag.dx || fromDrag.dy)) {
        const len = Math.hypot(fromDrag.dx, fromDrag.dy)
        x = (fromDrag.dx / len) * dist
        y = (fromDrag.dy / len) * dist
        rot = Math.max(-18, Math.min(18, fromDrag.dx / 18))
        speedFactor = Math.min(len / 1200, 1)
      } else if (rating === 'focused') {
        x = dist
        rot = 14
      } else if (rating === 'distracted') {
        x = -dist
        rot = -14
      } else y = -dist
      const ms = fromDrag ? (0.28 - 0.1 * speedFactor) * 1000 : 240
      setDrag(null)
      setExit({ rating, x, y, rot, ms })
      window.setTimeout(() => {
        setExit(null)
        setIndex((i) => i + 1)
        busy.current = false
      }, ms)
    },
    [card, day, scale],
  )

  const undo = useCallback(() => {
    if (busy.current || index === 0) return
    setIndex((i) => i - 1)
    setEntering(true)
    window.setTimeout(() => setEntering(false), 30)
  }, [index])

  // Keys: ← distracted, → focused, ↑ neutral, Z undo, Space play/pause, Esc close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      if (e.key === 'Escape' && onClose) {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault()
        undo()
        return
      }
      if (!card) return
      if (e.key === 'ArrowLeft') commit('distracted', 'keyboard')
      else if (e.key === 'ArrowRight') commit('focused', 'keyboard')
      else if (e.key === 'ArrowUp') commit('neutral', 'keyboard')
      else if (e.key === ' ') setPlaying((p) => !p)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, commit, undo, onClose])

  // ---- Drag ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || exit) return
    const target = e.target as HTMLElement
    if (target.closest('button, .rv-progress')) return
    setDrag({
      x0: e.clientX,
      y0: e.clientY,
      dx: 0,
      dy: 0,
      active: false,
      overSummary: !!target.closest('.rv-summary'),
      pointerId: e.pointerId,
    })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const dx = e.clientX - drag.x0
    const dy = e.clientY - drag.y0
    let active = drag.active
    if (!active && Math.hypot(dx, dy) >= DRAG_START) {
      // Over the summary only clearly horizontal drags count, so it can still scroll.
      if (drag.overSummary && !(Math.abs(dx) > 1.2 * Math.abs(dy))) {
        setDrag(null)
        return
      }
      active = true
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
    setDrag({ ...drag, dx, dy, active })
  }
  const onPointerUp = () => {
    if (!drag) return
    const r = drag.active ? committed(drag.dx, drag.dy) : null
    if (r) commit(r, 'drag', { dx: drag.dx, dy: drag.dy })
    else setDrag(null)
  }

  // Horizontal wheel / precision touchpad swipes.
  const onWheel = (e: React.WheelEvent) => {
    if (!card || exit) return
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const w = wheel.current
    const now = performance.now()
    if (now - w.t > 250) w.x = 0
    w.t = now
    w.x -= e.deltaX
    if (w.x >= COMMIT_X) {
      w.x = 0
      commit('focused', 'trackpad')
    } else if (w.x <= -COMMIT_X) {
      w.x = 0
      commit('distracted', 'trackpad')
    }
  }

  const cycleSpeed = () => {
    const n = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    setSpeed(n)
    localStorage.setItem(SPEED_KEY, String(n))
  }

  // ---- Render ----
  const dx = drag?.active ? drag.dx : 0
  const dy = drag?.active ? drag.dy : 0
  const hint = drag?.active ? predict(dx, dy, HINT) : null
  let transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`
  let transition = drag?.active ? 'none' : 'transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.05), opacity 0.2s'
  let opacity = 1
  if (exit) {
    transform = `translate(${exit.x}px, ${exit.y}px) rotate(${exit.rot}deg)`
    transition = `transform ${exit.ms}ms ease-in, opacity ${exit.ms}ms ease-in`
    opacity = 0
  } else if (entering) {
    transform = `translate(0, ${BASE_H * scale}px)`
    transition = 'none'
  }

  let body: React.ReactNode
  if (!data) body = <div className="rv-center"><div className="rv-spinner" /></div>
  else if (data.totalCards === 0) {
    body = (
      <div className="rv-center">
        <div className="rv-big">Nothing to review yet</div>
        <p className="muted">Come back after a few timeline cards appear.</p>
      </div>
    )
  } else if (!card) {
    body = (
      <div className="rv-center">
        <div className="rv-big">All caught up!</div>
        <p className="muted rv-caught">
          You've reviewed all your activities so far.
          <br />
          The Timeline right panel will be updated with your rating.
        </p>
        {summary && <SummaryBars summary={summary} />}
        {index > 0 && (
          <button className="rv-capsule ghost" onClick={undo}>
            Undo last rating
          </button>
        )}
        {onClose && (
          <button className="rv-capsule" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    )
  } else {
    body = (
      <>
        <div className="rv-stage" ref={stageRef} onWheel={onWheel}>
          <div className="rv-deck" style={{ width: BASE_W * scale, height: BASE_H * scale }}>
            {next && (
              <div className="rv-card-wrap behind" style={{ transform: `scale(${0.94 + 0.06 * Math.min(1, Math.hypot(dx, dy) / 140)})` }}>
                <ReviewCard card={next} index={index + 1} total={deck.length} color={colorFor(colors, next.category)} scale={scale} playing={false} speed={speed} />
              </div>
            )}
            <div
              key={card.id}
              className="rv-card-wrap"
              style={{ transform, transition, opacity }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
            >
              <ReviewCard
                card={card}
                index={index}
                total={deck.length}
                color={colorFor(colors, card.category)}
                scale={scale}
                playing={playing && !drag?.active && !exit}
                speed={speed}
                onTogglePlay={() => setPlaying((p) => !p)}
                onSpeed={cycleSpeed}
                hint={exit?.rating ?? hint}
              />
            </div>
          </div>
        </div>
        <p className="rv-help">Drag each card left, up or right, or use the arrow keys, to review your day.</p>
        <div className="rv-actions">
          <button className="rv-btn undo" onClick={undo} disabled={index === 0} title="Undo (Z)">
            <kbd>Z</kbd> Undo
          </button>
          <button className="rv-btn distracted" onClick={() => commit('distracted', 'button')} title="Distracted (←)">
            <span className="rv-tri" style={{ transform: 'rotate(0deg)' }} /> Distracted
          </button>
          <button className="rv-btn neutral" onClick={() => commit('neutral', 'button')} title="Neutral (↑)">
            <span className="rv-tri" style={{ transform: 'rotate(90deg)' }} /> Neutral
          </button>
          <button className="rv-btn focused" onClick={() => commit('focused', 'button')} title="Focused (→)">
            <span className="rv-tri" style={{ transform: 'rotate(180deg)' }} /> Focused
          </button>
        </div>
      </>
    )
  }

  return (
    <div className="rv-root">
      <header className="rv-header">
        <div className="rv-daynav">
          <button className="icon-btn" onClick={() => setDay((d) => shiftDay(d, -1))} title="Previous day">
            ‹
          </button>
          <h1>Review · {dayLabel(day)}</h1>
          <button className="icon-btn" disabled={day >= currentDay()} onClick={() => setDay((d) => shiftDay(d, 1))} title="Next day">
            ›
          </button>
        </div>
        {summary && (
          <div className="rv-head-summary">
            <span className="rv-dot distracted" /> {fmtDuration(summary.distracted)}
            <span className="rv-dot neutral" /> {fmtDuration(summary.neutral)}
            <span className="rv-dot focused" /> {fmtDuration(summary.focused)}
          </div>
        )}
        {onClose && (
          <button className="rv-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        )}
      </header>
      {body}
    </div>
  )
}

function colorFor(colors: Map<string, string>, category: string): string {
  return colors.get(category.toLowerCase()) ?? '#B984FF'
}

// ---------------------------------------------------------------- Card

function ReviewCard({
  card,
  index,
  total,
  color,
  scale,
  playing,
  speed,
  onTogglePlay,
  onSpeed,
  hint,
}: {
  card: TimelineCard
  index: number
  total: number
  color: string
  scale: number
  playing: boolean
  speed: number
  onTogglePlay?: () => void
  onSpeed?: () => void
  hint?: ReviewRating | null
}) {
  return (
    <div className="rv-card" style={{ width: BASE_W, height: BASE_H, transform: `scale(${scale})` }}>
      <CardPlayer cardId={card.id} playing={playing} speed={speed} onTogglePlay={onTogglePlay} onSpeed={onSpeed} />
      <div className="rv-card-body">
        <div className="rv-card-title">{card.title}</div>
        <div className="rv-pills">
          <span className="rv-pill cat" style={{ background: color }}>
            {card.category}
          </span>
          <span className="rv-pill">
            {clock24(card.startTs)} - {clock24(card.endTs)}
          </span>
        </div>
        <div className="rv-summary">{card.summary || card.detailedSummary}</div>
      </div>
      <div className="rv-count">
        {index + 1}/{total}
      </div>
      {hint && <div className={`rv-badge ${hint}`}>{LABEL[hint]}</div>}
    </div>
  )
}

/** Inline timelapse of the card's screenshots: delta × speed × 20 per display frame, looping. */
function CardPlayer({
  cardId,
  playing,
  speed,
  onTogglePlay,
  onSpeed,
}: {
  cardId: number
  playing: boolean
  speed: number
  onTogglePlay?: () => void
  onSpeed?: () => void
}) {
  const [frames, setFrames] = useState<ScreenshotInfo[]>([])
  const [time, setTime] = useState(0)
  const timeRef = useRef(0)
  timeRef.current = time

  useEffect(() => {
    let alive = true
    setFrames([])
    setTime(0)
    void window.dayflow.getCardScreenshots(cardId).then((f) => alive && setFrames(f))
    return () => {
      alive = false
    }
  }, [cardId])

  const first = frames[0]?.capturedAt ?? 0
  const end = frames.length ? frames[frames.length - 1].capturedAt - first : 0

  useEffect(() => {
    if (!playing || frames.length < 2) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000)
      last = now
      let t = timeRef.current + delta * speed * 20
      if (t > end) t = 0
      setTime(t)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, end, frames.length])

  const index = useMemo(() => {
    let i = 0
    for (let k = 0; k < frames.length; k++) {
      if (frames[k].capturedAt - first <= time) i = k
      else break
    }
    return i
  }, [frames, first, time])

  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setTime(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * end)
  }

  const frame = frames[index]
  return (
    <div className="rv-media" onClick={onTogglePlay}>
      {frame ? <img src={window.dayflow.imageUrl(frame.filePath)} alt="" draggable={false} /> : <div className="rv-media-empty">No screenshots</div>}
      {frame && !playing && onTogglePlay && <div className="rv-play">▶</div>}
      {onSpeed && frames.length > 1 && (
        <button
          className="rv-speed"
          onClick={(e) => {
            e.stopPropagation()
            onSpeed()
          }}
        >
          {speed * 20}x
        </button>
      )}
      {frames.length > 1 && (
        <div
          className="rv-progress"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            seek(e)
          }}
          onPointerMove={(e) => e.buttons === 1 && seek(e)}
        >
          <div style={{ width: `${end ? (time / end) * 100 : 0}%` }} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Summary bars

export function SummaryBars({ summary }: { summary: ReviewSummary }) {
  const items = (['distracted', 'neutral', 'focused'] as ReviewRating[])
    .map((r) => ({ r, secs: summary[r] }))
    .filter((x) => x.secs > 0)
  const total = items.reduce((a, x) => a + x.secs, 0)
  if (!total) return null
  return (
    <div className="rv-bars">
      <div className="rv-bar-row">
        {items.map((x) => (
          <div key={x.r} className={`rv-bar ${x.r}`} style={{ flexGrow: x.secs }} />
        ))}
      </div>
      <div className="rv-bar-labels">
        {items.map((x) => (
          <span key={x.r} className={`rv-bar-label ${x.r}`}>
            <span className="rv-icon">{x.r === 'distracted' ? '〰' : x.r === 'neutral' ? '◡' : '✦'}</span>
            {LABEL[x.r]} <b>{fmtDuration(x.secs)}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * "Review cards" button with the unreviewed-count badge, for the Timeline footer.
 * Shows nothing when there's nothing to prompt for.
 */
export function ReviewPromptButton({ day, onOpen }: { day: string; onOpen: () => void }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const load = () => void call<number>('review:promptCount', day).then(setCount).catch(() => setCount(0))
    load()
    const off1 = window.dayflow.onCardsChanged(load)
    const off2 = window.dayflow.on('review:changed', load)
    return () => {
      off1()
      off2()
    }
  }, [day])
  if (!count) return null
  return (
    <button className="btn ghost rv-prompt" onClick={onOpen} aria-label={`${count} cards to review`}>
      Review cards <span className="rv-prompt-badge">{count}</span>
    </button>
  )
}
