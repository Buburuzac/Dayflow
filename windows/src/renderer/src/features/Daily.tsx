// Daily page: standup card (done / next / blockers), workflow grid, and the Daily Brief.
// Spec: docs/spec-daily.md §1a, §1b, §3a.9.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DailySettings, StandupView } from '../../../shared/daily-types.ts'
import type { SettingsWithSecrets, TimelineCard } from '../../../shared/types.ts'
import { currentDay, dayLabel, dayStart, shiftDay } from '../dates.ts'
import { dailyApi } from './daily/api.ts'
import { BriefPanel } from './daily/BriefPanel.tsx'
import { StandupCard } from './daily/StandupCard.tsx'
import { clockLabel, fmtMinutes, workflowGrid, workflowStats } from './daily/workflow.ts'
import './daily.css'

export function DailyView({ settings }: { settings: SettingsWithSecrets }) {
  const [day, setDay] = useState(currentDay)
  const [view, setView] = useState<StandupView | null>(null)
  const [daily, setDaily] = useState<DailySettings | null>(null)
  const [cards, setCards] = useState<TimelineCard[]>([])
  const [gear, setGear] = useState(false)

  const load = useCallback(() => {
    void dailyApi.standup(day).then(setView)
  }, [day])

  useEffect(() => {
    load()
    const offChanged = window.dayflow.on('daily:standup-changed', (d) => d === day && load())
    return offChanged
  }, [load, day])

  useEffect(() => {
    void dailyApi.settings().then(setDaily)
    // A recap / brief notification was clicked: jump to that day.
    return window.dayflow.on('daily:open', (d) => typeof d === 'string' && setDay(d))
  }, [])

  useEffect(() => {
    const loadCards = () => void window.dayflow.getCards(day).then(setCards)
    loadCards()
    return window.dayflow.onCardsChanged(loadCards)
  }, [day])

  const updateSettings = async (patch: Partial<DailySettings>) => {
    setDaily(await dailyApi.setSettings(patch))
    load()
  }

  const isToday = day === currentDay()

  if (!view || !daily) return null

  return (
    <div className="dl-page">
      <header className="tl-header">
        <div className="date-nav">
          <button className="icon-btn" onClick={() => setDay((d) => shiftDay(d, -1))} title="Previous day">
            ‹
          </button>
          <h1>{dayLabel(day)}</h1>
          <button className="icon-btn" disabled={isToday} onClick={() => setDay((d) => shiftDay(d, 1))} title="Next day">
            ›
          </button>
          {!isToday && (
            <button className="link-btn" onClick={() => setDay(currentDay())}>
              Today
            </button>
          )}
        </div>
        <div className="dl-gear-wrap">
          <button className="icon-btn" title="Daily settings" onClick={() => setGear((g) => !g)}>
            ⚙
          </button>
          {gear && <DailySettingsMenu view={view} daily={daily} settings={settings} onChange={updateSettings} onClose={() => setGear(false)} />}
        </div>
      </header>

      <div className="dl-scroll">
        {!view.unlocked ? (
          <LockedCard view={view} onUnlock={() => void dailyApi.unlock().then(setDaily).then(load)} />
        ) : (
          <>
            {view.provider !== 'none' && !view.providerAvailable && (
              <div className="notice err dl-notice">
                {view.providerLabel} isn't set up, so recaps can't be generated. Check the AI provider in Settings.
              </div>
            )}
            <StandupCard key={day} view={view} onView={setView} />
            <WorkflowSection cards={cards} settings={settings} day={day} />
          </>
        )}
        {isToday && <BriefPanel settings={daily} onSettings={(p) => void updateSettings(p)} />}
      </div>
    </div>
  )
}

function LockedCard({ view, onUnlock }: { view: StandupView; onUnlock: () => void }) {
  const { batches, required } = view.unlockProgress
  const pct = Math.min(100, Math.round((batches / required) * 100))
  return (
    <section className="dl-card dl-locked">
      <h2 className="serif">Daily unlocks after 5 hours of recording</h2>
      <p>
        Dayflow writes a standup from your previous day once it has enough history to learn from. So far{' '}
        <b>{Math.round((batches * 15) / 60 * 10) / 10} h</b> of the 5 h needed have been analyzed.
      </p>
      <div className="dl-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <button className="btn ghost" onClick={onUnlock}>
        Turn on Daily now
      </button>
    </section>
  )
}

function DailySettingsMenu({
  view,
  daily,
  settings,
  onChange,
  onClose,
}: {
  view: StandupView
  daily: DailySettings
  settings: SettingsWithSecrets
  onChange: (p: Partial<DailySettings>) => void
  onClose: () => void
}) {
  const providerName =
    settings.provider === 'gemini'
      ? 'Gemini'
      : settings.provider === 'claude_cli'
        ? 'Claude (CLI)'
        : settings.provider === 'codex_cli'
          ? 'ChatGPT (Codex CLI)'
          : 'Local model'
  return (
    <div className="dl-menu" onMouseLeave={onClose}>
      <div className="dl-menu-title">Daily recap provider</div>
      <label className="dl-radio">
        <input type="radio" checked={daily.recapEnabled} onChange={() => onChange({ recapEnabled: true })} />
        {providerName} <span className="dl-sub">(your AI provider{!view.providerAvailable && daily.recapEnabled ? ', not set up' : ''})</span>
      </label>
      <label className="dl-radio">
        <input type="radio" checked={!daily.recapEnabled} onChange={() => onChange({ recapEnabled: false })} />
        None <span className="dl-sub">(turns generation off)</span>
      </label>
      <div className="dl-menu-title">Daily Brief</div>
      <label className="dl-radio">
        <input type="checkbox" checked={daily.briefEnabled} onChange={(e) => onChange({ briefEnabled: e.target.checked })} />
        Write a Daily Brief each morning
      </label>
      {settings.provider === 'claude_cli' && (
        <label className="dl-field">
          Brief model
          <input
            defaultValue={daily.briefModel}
            onBlur={(e) => e.target.value.trim() && onChange({ briefModel: e.target.value.trim() })}
            placeholder="opus"
          />
        </label>
      )}
      <div className="dl-menu-title">Day goals</div>
      <label className="dl-radio">
        <input
          type="checkbox"
          checked={daily.showDailyGoalPopups}
          onChange={(e) => onChange({ showDailyGoalPopups: e.target.checked })}
        />
        Ask me to set goals each day
      </label>
    </div>
  )
}

function WorkflowSection({ cards, settings, day }: { cards: TimelineCard[]; settings: SettingsWithSecrets; day: string }) {
  const grid = useMemo(() => workflowGrid(cards, settings.categories, dayStart(day)), [cards, settings.categories, day])
  const stats = useMemo(() => workflowStats(cards, settings.categories), [cards, settings.categories])
  if (grid.rows.length === 0) {
    return (
      <section className="dl-card">
        <h2 className="serif">Your workflow</h2>
        <div className="dl-empty-small">Nothing recorded on this day yet.</div>
      </section>
    )
  }
  const hours = Array.from({ length: Math.floor((grid.slotCount * 15) / 60) + 1 }, (_, i) => grid.startMinute + i * 60)
  return (
    <section className="dl-card">
      <h2 className="serif">Your workflow</h2>
      <div className="dl-chips">
        <span className="total-chip">
          Context switched <b>{stats.contextSwitches}×</b>
        </span>
        <span className="total-chip">
          Interrupted <b>{stats.interrupted}×</b>
        </span>
        <span className="total-chip">
          Focused for <b>{fmtMinutes(stats.focusedMinutes)}</b>
        </span>
        <span className="total-chip">
          Distracted for <b>{fmtMinutes(stats.distractedMinutes)}</b>
        </span>
        <span className="total-chip">
          Transitioning <b>{fmtMinutes(stats.transitionMinutes)}</b>
        </span>
      </div>
      <div className="dl-grid" style={{ ['--slots' as string]: grid.slotCount }}>
        {grid.rows.map((r) => (
          <div key={r.category} className="dl-grid-row">
            <div className="dl-grid-label" title={r.category}>
              <span className="swatch" style={{ background: r.color }} />
              {r.category}
              <b>{fmtMinutes(r.minutes)}</b>
            </div>
            <div className="dl-grid-cells">
              {r.slots.map((v, i) => (
                <span key={i} style={{ background: r.color, opacity: v > 0 ? 0.15 + v * 0.85 : 0.06 }} />
              ))}
            </div>
          </div>
        ))}
        <div className="dl-grid-row dl-grid-axis">
          <div className="dl-grid-label" />
          <div className="dl-grid-hours">
            {hours.map((m) => (
              <span key={m} style={{ left: `${((m - grid.startMinute) / (grid.slotCount * 15)) * 100}%` }}>
                {clockLabel(m)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
