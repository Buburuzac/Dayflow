// Flow focus sessions: setup, running session, break and summary screens. Native
// replacement for the hosted dayflow.so/flow web app; talks to src/main/flow over flow:*.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SettingsWithSecrets } from '../../../shared/types.ts'
import type {
  FlowAgentSettings,
  FlowAlertStyle,
  FlowSessionSummary,
  FlowState,
  FlowTimelineEntry,
} from '../../../shared/flow-types.ts'
import creatureUrl from './flow/creature.png'
import creatureTeaUrl from './flow/creature-tea.png'
import './flow.css'

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)

const STYLES: Array<{ id: FlowAlertStyle; title: string; text: string }> = [
  { id: 'quiet', title: 'Quiet', text: 'No interruptions. Distractions are only logged for your summary.' },
  { id: 'friendly', title: 'Friendly', text: 'A gentle nudge after about a minute of drift.' },
  { id: 'feisty', title: 'Feisty', text: 'Quick, direct nudges that keep coming until you are back.' },
]
const DURATIONS = [25, 50, 90]

function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function dur(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const timeOf = (ts: number) => new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const isoSec = (iso: string) => new Date(iso).getTime() / 1000

function providerLabel(s: SettingsWithSecrets, f: FlowAgentSettings | null): string {
  switch (s.provider) {
    case 'claude_cli':
      return `Claude ${f?.flowAgentModel || 'haiku'}`
    case 'codex_cli':
      return f?.flowAgentModel || s.cliModel ? `Codex (${f?.flowAgentModel || s.cliModel})` : 'Codex'
    case 'gemini':
      return `Gemini (${s.geminiModel})`
    case 'openai_compatible':
      return `your local model (${s.openaiModel})`
  }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function FlowView({ settings }: { settings: SettingsWithSecrets }) {
  const [state, setState] = useState<FlowState | null>(null)
  const [flowSettings, setFlowSettings] = useState<FlowAgentSettings | null>(null)
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    void call<FlowState>('flow:getState').then(setState)
    void call<FlowAgentSettings>('flow:getSettings').then(setFlowSettings)
    return window.dayflow.on('flow:state', (s) => setState(s as FlowState))
  }, [])

  // Ctrl+Shift+D: simulate a distraction (debug, as ⌘⇧D on macOS).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        void call('flow:simulateDistraction')
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        setShowLog((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const saveSettings = useCallback((patch: Partial<FlowAgentSettings>) => {
    void call<FlowAgentSettings>('flow:saveSettings', patch).then(setFlowSettings)
  }, [])

  if (!state) return <div className="flow-page" />
  const phase = state.snapshot.phase

  return (
    <div className="flow-page">
      <div className="flow-scroll">
        {phase === 'idle' && (
          <FlowSetup settings={settings} flowSettings={flowSettings} onSettings={saveSettings} onStart={setState} />
        )}
        {(phase === 'active' || phase === 'break') && <FlowRunning state={state} onState={setState} />}
        {phase === 'ended' && <FlowSummaryView state={state} onState={setState} />}
        {showLog && <AgentLog state={state} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Setup

function FlowSetup({
  settings,
  flowSettings,
  onSettings,
  onStart,
}: {
  settings: SettingsWithSecrets
  flowSettings: FlowAgentSettings | null
  onSettings: (p: Partial<FlowAgentSettings>) => void
  onStart: (s: FlowState) => void
}) {
  const [goals, setGoals] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [minutes, setMinutes] = useState<number | null>(50)
  const [custom, setCustom] = useState('')
  const [style, setStyle] = useState<FlowAlertStyle>('friendly')
  const [sessions, setSessions] = useState<FlowSessionSummary[]>([])
  const [openSettings, setOpenSettings] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    void call<FlowSessionSummary[]>('flow:sessions').then(setSessions)
  }, [])
  // Defaults apply once, when the settings first arrive.
  const seeded = useRef(false)
  useEffect(() => {
    if (!flowSettings || seeded.current) return
    seeded.current = true
    setStyle(flowSettings.flowDefaultAlertStyle)
    setMinutes(flowSettings.flowDefaultMinutes > 0 ? flowSettings.flowDefaultMinutes : null)
  }, [flowSettings])

  const addGoal = () => {
    const t = draft.trim()
    if (!t) return
    setGoals((g) => [...g, t])
    setDraft('')
  }

  const start = async () => {
    setStarting(true)
    const extra = draft.trim()
    const s = await call<FlowState>('flow:start', { goals: extra ? [...goals, extra] : goals, minutes, alertStyle: style })
    setStarting(false)
    onStart(s)
  }

  return (
    <div className="flow-setup">
      <div className="flow-hero">
        <img src={creatureUrl} alt="" className="flow-hero-creature" />
        <div>
          <h1>Flow</h1>
          <p className="muted">
            Start a focus session. While it runs, Dayflow looks at your screen every {flowSettings?.flowAgentTickSeconds ?? 15} seconds
            and a little creature nudges you when you drift.
          </p>
        </div>
      </div>

      <section className="flow-panel">
        <h2>What do you want to get done?</h2>
        <ul className="flow-goal-list">
          {goals.map((g, i) => (
            <li key={i} className="flow-goal">
              <span className="flow-goal-dot" />
              <span className="flow-goal-title">{g}</span>
              <button className="link-btn" onClick={() => setGoals((all) => all.filter((_, j) => j !== i))} title="Remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="flow-goal-add">
          <input
            value={draft}
            placeholder={goals.length ? 'Add another goal' : 'e.g. Finish the Q3 report draft'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addGoal()
              }
            }}
          />
          <button className="btn ghost" onClick={addGoal} disabled={!draft.trim()}>
            Add
          </button>
        </div>
        <small className="muted">Optional. Without goals, Flow judges by whether you stick with one kind of work.</small>
      </section>

      <section className="flow-panel">
        <h2>How long?</h2>
        <div className="flow-chips">
          {DURATIONS.map((m) => (
            <button key={m} className={`flow-chip ${minutes === m ? 'on' : ''}`} onClick={() => setMinutes(m)}>
              {m} min
            </button>
          ))}
          <button className={`flow-chip ${minutes === null ? 'on' : ''}`} onClick={() => setMinutes(null)}>
            Open-ended
          </button>
          <span className="flow-custom">
            <input
              type="number"
              min={1}
              max={600}
              placeholder="Custom"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value)
                const v = Number(e.target.value)
                if (v > 0) setMinutes(Math.min(600, Math.floor(v)))
              }}
            />
            min
          </span>
        </div>
      </section>

      <section className="flow-panel">
        <h2>Alert style</h2>
        <div className="flow-styles">
          {STYLES.map((s) => (
            <button key={s.id} className={`flow-style ${style === s.id ? 'on' : ''}`} onClick={() => setStyle(s.id)}>
              <b>{s.title}</b>
              <span>{s.text}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="flow-start-row">
        <button className="btn flow-start" onClick={() => void start()} disabled={starting}>
          {starting ? 'Starting…' : 'Start session'}
        </button>
        <span className="muted">
          {flowSettings?.flowAgentEnabled === false
            ? 'Screen checks are turned off: Flow will only keep time.'
            : `Screen checks use ${providerLabel(settings, flowSettings)}.`}
        </span>
      </div>

      {sessions.length > 0 && (
        <section className="flow-panel">
          <h2>Recent sessions</h2>
          <ul className="flow-history">
            {sessions.slice(0, 8).map((s) => {
              const total = s.focusedSeconds + s.distractedSeconds
              const pct = total > 0 ? Math.round((s.focusedSeconds / total) * 100) : 100
              return (
                <li key={s.id}>
                  <span className="flow-history-date">
                    {new Date(s.startedAt * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })},{' '}
                    {timeOf(s.startedAt)}
                  </span>
                  <span>{dur(s.endedAt - s.startedAt)}</span>
                  <span className="flow-history-bar">
                    <TimelineBar entries={s.entries} start={s.startedAt} end={s.endedAt} slim />
                  </span>
                  <span className="muted">{pct}% focused</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="flow-panel">
        <button className="flow-disclosure" onClick={() => setOpenSettings((o) => !o)}>
          {openSettings ? '▾' : '▸'} Flow settings
        </button>
        {openSettings && flowSettings && <FlowSettingsForm s={flowSettings} onChange={onSettings} />}
      </section>
    </div>
  )
}

function FlowSettingsForm({ s, onChange }: { s: FlowAgentSettings; onChange: (p: Partial<FlowAgentSettings>) => void }) {
  return (
    <div className="flow-settings form">
      <label className="check">
        <input type="checkbox" checked={s.flowAgentEnabled} onChange={(e) => onChange({ flowAgentEnabled: e.target.checked })} />
        Watch my screen during sessions
      </label>
      <label>
        Check every
        <select value={s.flowAgentTickSeconds} onChange={(e) => onChange({ flowAgentTickSeconds: Number(e.target.value) })}>
          {[10, 15, 30, 60].map((n) => (
            <option key={n} value={n}>
              {n} seconds
            </option>
          ))}
        </select>
      </label>
      <label>
        Default alert style
        <select value={s.flowDefaultAlertStyle} onChange={(e) => onChange({ flowDefaultAlertStyle: e.target.value as FlowAlertStyle })}>
          {STYLES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Default length
        <select value={s.flowDefaultMinutes} onChange={(e) => onChange({ flowDefaultMinutes: Number(e.target.value) })}>
          {[25, 50, 90].map((n) => (
            <option key={n} value={n}>
              {n} minutes
            </option>
          ))}
          <option value={0}>Open-ended</option>
        </select>
      </label>
      <label>
        Show nudges as
        <select value={s.flowUseNotifications ? 'notify' : 'overlay'} onChange={(e) => onChange({ flowUseNotifications: e.target.value === 'notify' })}>
          <option value="overlay">The Flow creature on screen</option>
          <option value="notify">Windows notifications</option>
        </select>
      </label>
      {!s.flowUseNotifications && (
        <label>
          Creature position
          <select value={s.flowNudgeVariant} onChange={(e) => onChange({ flowNudgeVariant: e.target.value as FlowAgentSettings['flowNudgeVariant'] })}>
            <option value="side">Bottom right</option>
            <option value="top">Top right</option>
          </select>
        </label>
      )}
      <label>
        Model override <em>(empty: haiku for Claude, your configured model otherwise)</em>
        <input value={s.flowAgentModel} onChange={(e) => onChange({ flowAgentModel: e.target.value })} placeholder="haiku" />
      </label>
      <label>
        Extra instructions for the watcher
        <textarea rows={3} value={s.flowAgentExtra} onChange={(e) => onChange({ flowAgentExtra: e.target.value })} />
      </label>
      <small className="muted">Flow settings are stored in flow-settings.json in the Dayflow data folder. Ctrl+Shift+L shows the agent log.</small>
    </div>
  )
}

// ---------------------------------------------------------------- Running

function FlowRunning({ state, onState }: { state: FlowState; onState: (s: FlowState) => void }) {
  const now = useNow(true)
  const snap = state.snapshot
  const onBreak = snap.phase === 'break'
  const [menu, setMenu] = useState<null | 'break' | 'end'>(null)
  const [draft, setDraft] = useState('')
  const act = (channel: string, ...args: unknown[]) => void call<FlowState>(channel, ...args).then(onState)

  const started = snap.sessionStartedAt ?? now
  const remaining = snap.sessionEndsAt != null ? snap.sessionEndsAt - now : null
  const total = snap.sessionEndsAt != null ? snap.sessionEndsAt - started : null
  const progress = total && total > 0 ? Math.min(1, Math.max(0, (now - started) / total)) : null
  const snoozed = state.snoozeUntil != null && state.snoozeUntil > now

  return (
    <div className="flow-running">
      <div className={`flow-timer-card ${onBreak ? 'break' : state.isDistracted ? 'drift' : ''}`}>
        <img src={onBreak ? creatureTeaUrl : creatureUrl} alt="" className="flow-timer-creature" />
        <div className="flow-timer-label">
          {onBreak ? 'Taking a break' : snap.alwaysOn ? 'Flow session in progress · elapsed' : 'Flow session in progress'}
        </div>
        <div className="flow-timer">
          {onBreak && snap.breakEndsAt
            ? clock(snap.breakEndsAt - now)
            : remaining != null
              ? clock(remaining)
              : clock(now - started)}
        </div>
        {onBreak && snap.breakEndsAt ? (
          <div className="muted">{clock(snap.breakEndsAt - now)} until your break ends.</div>
        ) : (
          <div className="flow-focus-chip">
            <span className={`dot ${state.isDistracted ? 'drift' : 'ok'}`} />
            {snoozed
              ? `Snoozed until ${timeOf(state.snoozeUntil!)}`
              : state.isDistracted
                ? 'Looks like you drifted'
                : state.agentRunning
                  ? 'Focused'
                  : 'Timer only'}
          </div>
        )}
        {progress != null && !onBreak && (
          <div className="flow-progress">
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        <div className="flow-controls">
          {onBreak ? (
            <button className="btn" onClick={() => act('flow:resume')}>
              Resume
            </button>
          ) : menu === 'break' ? (
            <div className="flow-confirm">
              <span>How long will your break be?</span>
              {[5, 10, 15].map((m) => (
                <button
                  key={m}
                  className="flow-chip"
                  onClick={() => {
                    setMenu(null)
                    act('flow:break', m)
                  }}
                >
                  {m} min
                </button>
              ))}
              <button className="link-btn" onClick={() => setMenu(null)}>
                Keep going
              </button>
            </div>
          ) : menu === 'end' ? (
            <div className="flow-confirm">
              <span>
                <b>Ending early?</b> Your summary will cover the session so far.
              </span>
              <button className="btn ghost" onClick={() => setMenu(null)}>
                Keep going
              </button>
              <button
                className="btn danger-btn"
                onClick={() => {
                  setMenu(null)
                  act('flow:end')
                }}
              >
                End
              </button>
            </div>
          ) : (
            <>
              <button className="btn ghost" onClick={() => setMenu('break')}>
                Break
              </button>
              {!snap.alwaysOn && (
                <>
                  <button className="btn ghost" onClick={() => act('flow:extend', 5)} title="Add 5 minutes">
                    +5 min
                  </button>
                  <button className="btn ghost" onClick={() => act('flow:extend', 15)} title="Add 15 minutes">
                    +15 min
                  </button>
                </>
              )}
              <button className="btn" onClick={() => (snap.alwaysOn ? act('flow:end') : setMenu('end'))}>
                End session
              </button>
            </>
          )}
        </div>
      </div>

      <section className="flow-panel">
        <h2>Goals</h2>
        <ul className="flow-goal-list">
          {(snap.goalTasks ?? []).map((g) => (
            <li key={g.id} className="flow-goal">
              <input type="checkbox" checked={false} onChange={() => act('flow:setGoalDone', g.id, true)} />
              <span className="flow-goal-title">{g.title}</span>
              <button className="link-btn" onClick={() => act('flow:removeGoal', g.id)} title="Remove">
                ✕
              </button>
            </li>
          ))}
          {state.completedGoals.map((g) => (
            <li key={g.id} className="flow-goal done">
              <input type="checkbox" checked onChange={() => act('flow:setGoalDone', g.id, false)} />
              <span className="flow-goal-title">{g.title}</span>
            </li>
          ))}
        </ul>
        <div className="flow-goal-add">
          <input
            value={draft}
            placeholder="Add a goal"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                act('flow:addGoal', draft.trim())
                setDraft('')
              }
            }}
          />
        </div>
      </section>

      <section className="flow-panel">
        <h2>This session</h2>
        {state.timeline.length > 0 ? (
          <>
            <TimelineBar entries={state.timeline} start={started} end={now} />
            <EntryList entries={state.timeline} />
          </>
        ) : (
          <p className="muted">The session log fills in after the first minute.</p>
        )}
        <div className="flow-agent-status">
          <span className={`dot ${state.agentRunning ? 'ok' : ''}`} /> {state.agentStatus}
          {state.recordingPaused && state.agentRunning && <> · Recording is paused, so Flow takes its own screenshots.</>}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- Summary

function FlowSummaryView({ state, onState }: { state: FlowState; onState: (s: FlowState) => void }) {
  const s = state.lastSummary
  const act = (channel: string, ...args: unknown[]) => void call<FlowState>(channel, ...args).then(onState)
  const total = s ? s.focusedSeconds + s.distractedSeconds : 0
  return (
    <div className="flow-summary">
      <div className="flow-hero">
        <img src={creatureUrl} alt="" className="flow-hero-creature" />
        <div>
          <h1>Session complete</h1>
          {s && (
            <p className="muted">
              {timeOf(s.startedAt)} – {timeOf(s.endedAt)} · {dur(s.endedAt - s.startedAt)}
              {s.plannedMinutes ? ` of ${s.plannedMinutes} planned minutes` : ''}
            </p>
          )}
        </div>
      </div>
      {s && (
        <>
          <div className="flow-stats">
            <Stat label="Focused" value={dur(s.focusedSeconds)} tone="focused" />
            <Stat label="Distracted" value={dur(s.distractedSeconds)} tone="distracted" />
            <Stat label="Breaks" value={dur(s.breakSeconds)} tone="break" />
            <Stat label="Focus" value={`${total > 0 ? Math.round((s.focusedSeconds / total) * 100) : 100}%`} tone="" />
            <Stat label="Nudges" value={String(s.nudges)} tone="" />
          </div>
          {s.completedGoals.length > 0 && (
            <section className="flow-panel">
              <h2>Wins</h2>
              <ul className="flow-wins">
                {s.completedGoals.map((g, i) => (
                  <li key={i}>✓ {g}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="flow-panel">
            <h2>Timeline</h2>
            {s.entries.length ? (
              <>
                <TimelineBar entries={s.entries} start={s.startedAt} end={s.endedAt} />
                <EntryList entries={s.entries} />
              </>
            ) : (
              <p className="muted">No session log was written for this session.</p>
            )}
          </section>
        </>
      )}
      <div className="flow-start-row">
        <button className="btn" onClick={() => act('flow:reset')}>
          Start a new session
        </button>
        <button className="btn ghost" onClick={() => act('flow:extend', 10)}>
          Keep going for 10 min
        </button>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`flow-stat ${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

// ---------------------------------------------------------------- Shared bits

function TimelineBar({ entries, start, end, slim }: { entries: FlowTimelineEntry[]; start: number; end: number; slim?: boolean }) {
  const span = Math.max(1, end - start)
  return (
    <div className={`flow-tl-bar ${slim ? 'slim' : ''}`}>
      {entries.map((e) => {
        const a = Math.max(start, isoSec(e.startedAt))
        const b = Math.min(end, isoSec(e.endedAt))
        if (b <= a) return null
        return (
          <span
            key={e.id}
            className={`seg ${e.kind}`}
            style={{ left: `${((a - start) / span) * 100}%`, width: `${((b - a) / span) * 100}%` }}
            title={`${e.title} · ${timeOf(a)} – ${timeOf(b)}`}
          />
        )
      })}
    </div>
  )
}

function EntryList({ entries }: { entries: FlowTimelineEntry[] }) {
  const rows = useMemo(() => [...entries], [entries])
  return (
    <ul className="flow-entries">
      {rows.map((e) => (
        <li key={e.id} className={e.kind}>
          <span className="flow-entry-time">
            {timeOf(isoSec(e.startedAt))} – {timeOf(isoSec(e.endedAt))}
          </span>
          <span className={`flow-entry-kind ${e.kind}`} />
          <span className="flow-entry-title">
            {e.title}
            {e.completedTasks?.map((t) => (
              <span key={t} className="flow-entry-win">
                ✓ {t}
              </span>
            ))}
          </span>
          <span className="flow-entry-meta">{[e.site, e.category].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ul>
  )
}

function AgentLog({ state }: { state: FlowState }) {
  return (
    <section className="flow-panel flow-log">
      <h2>
        Agent log <span className="muted">({state.agentEngine ?? 'no engine'} · {state.agentStatus})</span>
      </h2>
      <div className="row">
        <button className="btn ghost" onClick={() => void call('flow:tickNow')} disabled={!state.agentRunning}>
          Check now
        </button>
        <button className="btn ghost" onClick={() => void call('flow:simulateDistraction')} disabled={state.snapshot.phase !== 'active'}>
          Simulate distraction
        </button>
      </div>
      <pre>
        {state.transcript
          .slice()
          .reverse()
          .map((l) => `${timeOf(l.at)}  ${l.text}`)
          .join('\n\n') || '(empty)'}
      </pre>
    </section>
  )
}
