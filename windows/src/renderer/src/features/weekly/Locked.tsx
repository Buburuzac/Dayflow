import { useEffect, useState, type ReactNode } from 'react'
import type { WeeklyAccessState } from '../../../../shared/weekly-types.ts'
import { WEEKLY_RECORDED_MINUTES_GATE } from '../../../../shared/weekly-types.ts'
import { DayflowMark } from './Card.tsx'

export function ProgressBar({ progress }: { progress: number }) {
  const p = Math.max(0, Math.min(1, progress))
  return (
    <div className="wk-progress">
      <div className="wk-progress-fill" style={{ width: `calc(${p} * (100% - 24px) + 24px)` }} />
      <div className="wk-progress-knob" style={{ left: `calc(${p} * (100% - 24px))` }}>
        <DayflowMark size={14} color="#FF6E00" />
      </div>
    </div>
  )
}

export function gateDuration(minutes: number): string {
  if (minutes <= 0) return '0h'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

/** Per-week gate (§1.1.2): shown when the selected week has less than 15 h recorded. */
export function DataGate({ recordedMinutes, onShowAnyway }: { recordedMinutes: number; onShowAnyway: () => void }) {
  const remaining = Math.max(0, WEEKLY_RECORDED_MINUTES_GATE - recordedMinutes)
  return (
    <div className="wk-card wk-gate">
      <div className="wk-gate-title">Keep recording to unlock this week</div>
      <div className="wk-gate-sub">Weekly insights need at least 15 hours of recorded activity for the selected week.</div>
      <div className="wk-pill">{gateDuration(recordedMinutes)} / 15h</div>
      <ProgressBar progress={recordedMinutes / WEEKLY_RECORDED_MINUTES_GATE} />
      <div className="wk-gate-remaining">{gateDuration(remaining)} more to unlock this week</div>
      <button className="wk-show-anyway" onClick={onShowAnyway}>
        Show anyway
      </button>
    </div>
  )
}

type NotifyState = 'idle' | 'requesting' | 'scheduled' | 'denied' | 'failed'

const NOTIFY_TITLES: Record<NotifyState, string> = {
  idle: 'Notify me when ready',
  requesting: 'Setting reminder...',
  scheduled: "We'll notify you",
  denied: 'Open notification settings',
  failed: 'Try again',
}

/** Global unlock (§1.1.1): blurred, slowly scrolling preview with the unlock card on top. */
export function AccessLocked({
  access,
  width,
  preview,
  onView,
  onShowAnyway,
}: {
  access: WeeklyAccessState
  width: number
  preview: ReactNode
  onView: () => void
  onShowAnyway: () => void
}) {
  const [notify, setNotify] = useState<NotifyState>(access.notificationScheduled ? 'scheduled' : 'idle')
  useEffect(() => {
    if (access.notificationScheduled) setNotify('scheduled')
  }, [access.notificationScheduled])

  const scale = Math.min(0.95, Math.max(0.58, (width - 96) / 958))
  const eta = access.estimatedUnlockAt
    ? new Date(access.estimatedUnlockAt * 1000).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    : null

  const onNotify = async () => {
    if (access.unlocked) return onView()
    if (notify === 'denied') {
      window.open('ms-settings:notifications')
      return
    }
    setNotify('requesting')
    try {
      const r = await window.dayflow.call<string>('weekly:notifyWhenReady')
      setNotify(r === 'unsupported' ? 'denied' : 'scheduled')
    } catch {
      setNotify('failed')
    }
  }

  return (
    <div className="wk-locked">
      <div className="wk-locked-preview" aria-hidden>
        <div className="wk-locked-scroller" style={{ transform: `scale(${scale})` }}>
          {preview}
        </div>
      </div>
      <div className="wk-unlock-card">
        <div className="wk-unlock-title">Unlock Weekly</div>
        <div className="wk-unlock-sub">Weekly unlocks after 30 hours of recorded timeline data</div>
        <div className="wk-pill">{access.recordedText}</div>
        <ProgressBar progress={access.progress} />
        <button
          className="wk-unlock-btn"
          disabled={!access.unlocked && (notify === 'requesting' || notify === 'scheduled')}
          onClick={() => void onNotify()}
        >
          {access.unlocked ? 'View Weekly' : NOTIFY_TITLES[notify]}
        </button>
        {eta && !access.unlocked && <div className="wk-unlock-eta">Earliest unlock if you keep recording: {eta}</div>}
        <button className="wk-show-anyway" onClick={onShowAnyway}>
          Show anyway
        </button>
      </div>
    </div>
  )
}
