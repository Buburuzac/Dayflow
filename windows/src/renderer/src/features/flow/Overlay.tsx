// The Flow nudge overlay, rendered in its own transparent always-on-top window
// (route #flow-overlay). The main process pushes presentations on `flow:overlay`.
// Clicks pass through the window except over the creature, bubble and pills.

import { useEffect, useRef, useState } from 'react'
import type { FlowOverlayAction, FlowOverlayPresentation } from '../../../../shared/flow-types.ts'
import creatureUrl from './creature.png'
import creatureTeaUrl from './creature-tea.png'
import '../flow.css'

const act = (a: FlowOverlayAction) => void window.dayflow.call('flow:overlayAction', a)

/** Tells the main process whether the pointer is over an interactive part ([data-hit]). */
function useHitTesting(presentation: FlowOverlayPresentation): void {
  const last = useRef(false)
  // Each new presentation starts click-through (the main process resets it on hide).
  useEffect(() => {
    last.current = false
    void window.dayflow.call('flow:overlayHit', false)
  }, [presentation])
  useEffect(() => {
    const set = (on: boolean) => {
      if (on === last.current) return
      last.current = on
      void window.dayflow.call('flow:overlayHit', on)
    }
    const move = (e: MouseEvent) => set(!!(e.target as Element | null)?.closest?.('[data-hit]'))
    const leave = () => set(false)
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseleave', leave)
    return () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseleave', leave)
    }
  }, [])
}

function mss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function FlowOverlay() {
  const [p, setP] = useState<FlowOverlayPresentation>({ kind: 'hidden' })
  const [shown, setShown] = useState<FlowOverlayPresentation>({ kind: 'hidden' })
  const [revealed, setRevealed] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useHitTesting(p)

  useEffect(() => {
    const html = document.documentElement
    html.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.classList.add('flow-overlay-body')
    void window.dayflow.call<FlowOverlayPresentation>('flow:overlayState').then(setP)
    return window.dayflow.on('flow:overlay', (next) => setP(next as FlowOverlayPresentation))
  }, [])

  // Keep the last visible presentation on screen while the exit animation plays.
  useEffect(() => {
    if (p.kind !== 'hidden') {
      setShown(p)
      setRevealed(p.kind === 'toast' || p.kind === 'onBreak')
      setSnoozeOpen(false)
    }
  }, [p])

  useEffect(() => {
    if (shown.kind !== 'onBreak') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [shown.kind])

  const visible = p.kind !== 'hidden'
  const k = shown.kind
  const escalated = shown.kind === 'nudge' && shown.escalated
  const top = shown.kind === 'nudge' && shown.variant !== 'side'

  let bubble: string | null = null
  if (shown.kind === 'toast') bubble = shown.message
  else if (shown.kind === 'nudge') bubble = shown.message
  else if (shown.kind === 'onBreak') {
    bubble = shown.breakEndsAt ? `Break time! ${mss(shown.breakEndsAt - now / 1000)} left` : 'Break time!'
  } else if (shown.kind === 'sessionEnded') bubble = "Time's up! Great work."

  return (
    <div className={`fo-root ${visible ? 'in' : 'out'} ${top ? 'top' : 'side'} ${escalated ? 'escalated' : ''}`}>
      <div className="fo-stack">
        {bubble && revealed && (
          <div className="fo-bubble" data-hit>
            {bubble}
          </div>
        )}
        {revealed && k === 'nudge' && (
          <div className="fo-pills" data-hit>
            <button className="fo-pill" onClick={() => act({ action: 'backToWork' })}>
              Whoops! I'll get back to work. <span className="fo-chev">›</span>
            </button>
            {!snoozeOpen ? (
              <button className="fo-pill" onClick={() => setSnoozeOpen(true)}>
                Just a few more minutes!
              </button>
            ) : (
              <div className="fo-pill-row">
                {[5, 10, 15].map((m) => (
                  <button key={m} className="fo-pill small" onClick={() => act({ action: 'snooze', minutes: m })}>
                    {m} min
                  </button>
                ))}
              </div>
            )}
            <button className="fo-pill" onClick={() => act({ action: 'correctMistake' })}>
              Correct Flow's mistake
            </button>
          </div>
        )}
        {revealed && k === 'sessionEnded' && (
          <div className="fo-pills" data-hit>
            <button className="fo-pill" onClick={() => act({ action: 'startNew' })}>
              Start a new session
            </button>
            <button className="fo-pill" onClick={() => act({ action: 'done' })}>
              Done
            </button>
          </div>
        )}
      </div>
      <img
        className={`fo-creature ${k === 'onBreak' ? 'tea' : ''}`}
        src={k === 'onBreak' ? creatureTeaUrl : creatureUrl}
        alt=""
        draggable={false}
        data-hit
        onMouseEnter={() => setRevealed(true)}
        onClick={() => setRevealed(true)}
        onDoubleClick={() => act({ action: 'dismiss' })}
      />
    </div>
  )
}
