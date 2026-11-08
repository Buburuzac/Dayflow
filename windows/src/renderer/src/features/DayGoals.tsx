// Day goals: compact focus-target / distraction-budget header shown above the Timeline,
// with an inline editor and the once-a-day goal flow (spec-daily.md §1c, §6).

import { useCallback, useEffect, useState } from 'react'
import type {
  DayGoalCategorySnapshot,
  DayGoalPlan,
  DayGoalProgress,
  DayGoalPromptState,
  DayGoalReference,
} from '../../../shared/daily-types.ts'
import type { AppStatus, Category, SettingsWithSecrets } from '../../../shared/types.ts'
import { currentDay, shiftDay } from '../dates.ts'
import { goalsApi } from './daily/api.ts'
import { compactHours, fmtMinutes } from './daily/workflow.ts'
import './daily.css'

const norm = (s: string) => s.trim().toLowerCase()

function selectable(categories: Category[]): Category[] {
  return categories.filter((c) => !c.isIdle && norm(c.name) !== 'system')
}

function snap(c: Category, i: number): DayGoalCategorySnapshot {
  return { categoryID: norm(c.name), name: c.name, colorHex: c.color, sortOrder: i }
}

export function DayGoalHeader({ day, settings }: { day: string; settings: SettingsWithSecrets }) {
  const [progress, setProgress] = useState<DayGoalProgress | null>(null)
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [flow, setFlow] = useState<DayGoalPromptState | null>(null)

  const load = useCallback(() => {
    void goalsApi.progress(day).then(setProgress)
  }, [day])

  useEffect(() => {
    load()
    const off1 = window.dayflow.onCardsChanged(load)
    const off2 = window.dayflow.on('goals:changed', (d) => d === day && load())
    return () => {
      off1()
      off2()
    }
  }, [load, day])

  useEffect(() => {
    void window.dayflow.getStatus().then(setStatus)
    return window.dayflow.onStatus(setStatus)
  }, [])

  useEffect(() => {
    if (day !== currentDay()) return
    void goalsApi.prompt(day).then((p) => p.show && setFlow(p))
  }, [day])

  if (!progress) return null
  const { plan } = progress
  const isToday = day === currentDay()
  const caption =
    status?.recorder === 'paused'
      ? 'Dayflow is paused. Resume to continue tracking your progress.'
      : status?.recorder === 'stopped' || status?.recorder === 'error'
        ? 'Start Dayflow to continue tracking your progress.'
        : 'Tracking progress from your focus and distraction categories.'

  const save = async (next: DayGoalPlan) => setProgress(await goalsApi.set({ ...next, isSkipped: false }))

  return (
    <div className={`dg-header ${plan.isSkipped ? 'skipped' : ''}`}>
      <div className="dg-title">
        <span>{isToday ? "Today's targets" : 'Targets'}</span>
        {plan.isSkipped ? (
          <button className="link-btn" onClick={() => void save(plan)}>
            Set goals
          </button>
        ) : (
          <button className="link-btn" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </div>
      <div className="dg-bars">
        <FocusBar progress={progress} />
        <DistractionBar progress={progress} />
      </div>
      {isToday && !plan.isSkipped && <div className="dg-caption">{caption}</div>}
      {editing && !plan.isSkipped && <GoalEditor plan={plan} categories={settings.categories} onChange={(p) => void save(p)} />}
      {flow && (
        <GoalFlow
          day={day}
          state={flow}
          plan={plan}
          categories={settings.categories}
          onClose={(p) => {
            setFlow(null)
            if (p) setProgress(p)
          }}
        />
      )}
    </div>
  )
}

function FocusBar({ progress }: { progress: DayGoalProgress }) {
  const target = progress.plan.focusTargetMinutes
  const focus = progress.focusMinutes
  const over = target > 0 && focus > target
  const total = Math.max(target, focus, 1)
  return (
    <div className="dg-bar-block">
      <div className="dg-bar-label">
        <span>Focus</span>
        <span>
          <b>{compactHours(focus)}</b> / {compactHours(target)} hr fulfilled
        </span>
      </div>
      <div className={`dg-bar ${over ? 'over' : ''}`}>
        {progress.focusSegments.map((s) => (
          <span key={s.name} title={`${s.name}: ${fmtMinutes(s.minutes)}`} style={{ width: `${(s.minutes / total) * 100}%`, background: s.colorHex }} />
        ))}
        {over && <i className="dg-target-mark" style={{ left: `${(target / total) * 100}%` }} />}
      </div>
    </div>
  )
}

function DistractionBar({ progress }: { progress: DayGoalProgress }) {
  const limit = progress.plan.distractionLimitMinutes
  const used = progress.distractedMinutes
  const over = used > limit
  const remaining = Math.max(0, limit - used)
  const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : used > 0 ? 1 : 0
  return (
    <div className="dg-bar-block">
      <div className="dg-bar-label">
        <span>Distraction budget</span>
        <span>
          {over ? (
            <>
              <b>{compactHours(used)}</b> / {compactHours(limit)} hr used
            </>
          ) : (
            <>
              <b>{compactHours(remaining)}</b> / {compactHours(limit)} hr left
            </>
          )}
        </span>
      </div>
      <div className={`dg-bar distraction ${over ? 'over' : ''}`}>
        <span style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  )
}

function DurationPicker({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return (
    <span className="dg-duration">
      <select value={h} onChange={(e) => onChange(Number(e.target.value) * 60 + m)}>
        {Array.from({ length: 13 }, (_, i) => (
          <option key={i} value={i}>
            {i} h
          </option>
        ))}
      </select>
      <select value={m} onChange={(e) => onChange(h * 60 + Number(e.target.value))}>
        {Array.from({ length: 12 }, (_, i) => i * 5).map((v) => (
          <option key={v} value={v}>
            {v} min
          </option>
        ))}
      </select>
    </span>
  )
}

function GoalEditor({
  plan,
  categories,
  onChange,
}: {
  plan: DayGoalPlan
  categories: Category[]
  onChange: (p: DayGoalPlan) => void
}) {
  const cats = selectable(categories)
  const has = (list: DayGoalCategorySnapshot[], c: Category) => list.some((s) => s.categoryID === norm(c.name) || norm(s.name) === norm(c.name))
  const toggle = (kind: 'focus' | 'distraction', c: Category) => {
    const key = kind === 'focus' ? 'focusCategories' : 'distractionCategories'
    const other = kind === 'focus' ? 'distractionCategories' : 'focusCategories'
    const list = plan[key]
    const next = has(list, c) ? list.filter((s) => norm(s.name) !== norm(c.name)) : [...list, snap(c, list.length)]
    // A category counts as focus or distraction, not both.
    onChange({ ...plan, [key]: next, [other]: plan[other].filter((s) => norm(s.name) !== norm(c.name)) })
  }
  return (
    <div className="dg-editor">
      <div className="dg-editor-row">
        <span>Focus target</span>
        <DurationPicker minutes={plan.focusTargetMinutes} onChange={(m) => onChange({ ...plan, focusTargetMinutes: m })} />
      </div>
      <div className="dg-cats">
        {cats.map((c) => (
          <button key={c.name} className={`dg-cat ${has(plan.focusCategories, c) ? 'on' : ''}`} style={{ ['--cat' as string]: c.color }} onClick={() => toggle('focus', c)}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="dg-editor-row">
        <span>Distraction limit</span>
        <DurationPicker minutes={plan.distractionLimitMinutes} onChange={(m) => onChange({ ...plan, distractionLimitMinutes: m })} />
      </div>
      <div className="dg-cats">
        {cats.map((c) => (
          <button
            key={c.name}
            className={`dg-cat ${has(plan.distractionCategories, c) ? 'on' : ''}`}
            style={{ ['--cat' as string]: c.color }}
            onClick={() => toggle('distraction', c)}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function GoalFlow({
  day,
  state,
  plan,
  categories,
  onClose,
}: {
  day: string
  state: DayGoalPromptState
  plan: DayGoalPlan
  categories: Category[]
  onClose: (p: DayGoalProgress | null) => void
}) {
  const [step, setStep] = useState<'review' | 'setup'>(state.startOn)
  const [draft, setDraft] = useState<DayGoalPlan>(plan)
  const [ref, setRef] = useState<DayGoalReference | null>(null)

  useEffect(() => {
    if (step === 'review') void goalsApi.reviewShown(day)
  }, [step, day])

  useEffect(() => {
    if (step !== 'setup') return
    void goalsApi.reference(day, draft.focusCategories, draft.distractionCategories).then(setRef)
  }, [step, day, draft.focusCategories, draft.distractionCategories])

  const finish = async (skip: boolean) => {
    await goalsApi.promptHandled(day)
    onClose(skip ? await goalsApi.skip(day) : await goalsApi.set({ ...draft, isSkipped: false }))
  }

  return (
    <div className="dg-modal-backdrop">
      <div className="dg-modal">
        {step === 'review' && state.review ? (
          <>
            <h2 className="serif">Yesterday's review</h2>
            <p className="dl-sub">{shiftDay(day, -1)}</p>
            <div className="dg-bars">
              <FocusBar progress={state.review} />
              <DistractionBar progress={state.review} />
            </div>
            {state.review.focusSegments.length > 0 && (
              <ul className="dg-review-cats">
                {state.review.focusSegments.map((s) => (
                  <li key={s.name}>
                    <span className="swatch" style={{ background: s.colorHex }} /> {s.name} <b>{fmtMinutes(s.minutes)}</b>
                  </li>
                ))}
              </ul>
            )}
            <div className="row end">
              <button className="btn" onClick={() => setStep('setup')}>
                Set today's goals
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="serif">Where do you want to spend your time today?</h2>
            <GoalEditor plan={draft} categories={categories} onChange={setDraft} />
            {ref && (
              <div className="dg-ref">
                <div>
                  Focus categories: yesterday <b>{fmtMinutes(ref.yesterdayFocus)}</b>, last week average{' '}
                  <b>{fmtMinutes(ref.weekAverageFocus)}</b>
                </div>
                <div>
                  Distraction categories: yesterday <b>{fmtMinutes(ref.yesterdayDistraction)}</b>, last week average{' '}
                  <b>{fmtMinutes(ref.weekAverageDistraction)}</b>
                </div>
              </div>
            )}
            <div className="row end">
              <button className="btn ghost" onClick={() => void finish(true)}>
                Skip
              </button>
              <button className="btn" onClick={() => void finish(false)}>
                Confirm
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
