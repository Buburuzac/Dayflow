// Session state machine (FlowSessionMirror.apply / handleDeadline, spec A.3). Pure: returns the
// effects a transition causes; the controller performs them.

import type { FlowAlertStyle, FlowGoalTask, FlowNativeSnapshot, FlowSessionSummary, FlowStartRequest } from '../../shared/flow-types.ts'

export const IDLE_SNAPSHOT: FlowNativeSnapshot = { phase: 'idle', alertStyle: 'friendly', alwaysOn: false }

export type FlowEffect =
  | { type: 'resetDistraction' }
  | { type: 'toast'; message: string }
  | { type: 'agentStart' }
  | { type: 'agentPause' }
  | { type: 'agentResume' }
  | { type: 'agentGoalsChanged' }
  | { type: 'agentStop' }
  | { type: 'timelineFinish' }
  | { type: 'showBreak' }
  | { type: 'cancelBreakOverlay' }
  | { type: 'hideOverlay' }
  | { type: 'sessionEnded' }
  | { type: 'nudge'; message: string; escalated: boolean }

const isOn = (p: FlowNativeSnapshot['phase']) => p === 'active' || p === 'break'

/** Effects of moving from `prev` to `next` (FlowSessionMirror.apply). */
export function transitionEffects(prev: FlowNativeSnapshot, next: FlowNativeSnapshot): FlowEffect[] {
  const fx: FlowEffect[] = []
  const a = prev.phase
  const b = next.phase
  if ((a === 'idle' || a === 'ended') && b === 'active') {
    fx.push({ type: 'resetDistraction' }, { type: 'toast', message: 'Your flow session starts now!' }, { type: 'agentStart' })
  } else if (b === 'break' && a !== 'break') {
    fx.push({ type: 'showBreak' }, { type: 'agentPause' })
  } else if (a === 'break' && b === 'active') {
    fx.push(
      { type: 'cancelBreakOverlay' },
      { type: 'toast', message: "Break's over. Back to it!" },
      { type: 'agentResume' },
      { type: 'agentGoalsChanged' },
    )
  } else if (a === 'active' && b === 'active') {
    fx.push({ type: 'agentGoalsChanged' })
  } else if ((b === 'idle' || b === 'ended') && isOn(a)) {
    fx.push({ type: 'resetDistraction' }, { type: 'timelineFinish' }, { type: 'agentStop' })
    if (b === 'idle') fx.push({ type: 'hideOverlay' })
  } else if (b === 'idle' && a === 'ended') {
    fx.push({ type: 'resetDistraction' }, { type: 'hideOverlay' })
  }
  return fx
}

/** The nearest pending deadline (unix seconds), or null. */
export function nearestDeadline(s: FlowNativeSnapshot, snoozeUntil: number | null): number | null {
  const c: number[] = []
  if (s.phase === 'active' && s.sessionEndsAt != null) c.push(s.sessionEndsAt)
  if (s.phase === 'break' && s.breakEndsAt != null) c.push(s.breakEndsAt)
  if (snoozeUntil != null) c.push(snoozeUntil)
  return c.length ? Math.min(...c) : null
}

/** Timer delay in ms for a deadline: max(0.5 s, deadline − now). */
export function deadlineDelayMs(deadline: number, nowMs: number): number {
  return Math.max(500, deadline * 1000 - nowMs)
}

export interface DeadlineInput {
  snapshot: FlowNativeSnapshot
  snoozeUntil: number | null
  isDistracted: boolean
  nudgeStreak: number
  now: number
}

export interface DeadlineResult {
  snapshot: FlowNativeSnapshot
  snoozeUntil: number | null
  nudgeStreak: number
  /** Effects beyond those of the phase transition (which the caller derives with transitionEffects) */
  effects: FlowEffect[]
}

/** handleDeadline: snooze expiry, natural session end, break end. */
export function handleDeadline(d: DeadlineInput): DeadlineResult {
  let { snapshot, snoozeUntil, nudgeStreak } = d
  const effects: FlowEffect[] = []
  if (snoozeUntil != null && snoozeUntil <= d.now) {
    snoozeUntil = null
    if (d.isDistracted && snapshot.phase === 'active' && snapshot.alertStyle !== 'quiet') {
      nudgeStreak += 1
      effects.push({ type: 'nudge', message: 'Snooze is up — ready to get back to it?', escalated: nudgeStreak >= 2 })
    }
  }
  if (snapshot.phase === 'active' && snapshot.sessionEndsAt != null && snapshot.sessionEndsAt <= d.now) {
    snapshot = { ...snapshot, phase: 'ended' }
    effects.push({ type: 'sessionEnded' })
  }
  if (snapshot.phase === 'break' && snapshot.breakEndsAt != null && snapshot.breakEndsAt <= d.now) {
    snapshot = { ...snapshot, phase: 'active', breakEndsAt: undefined }
  }
  return { snapshot, snoozeUntil, nudgeStreak, effects }
}

/** Snapshot restored on launch: a session whose end time has passed resets to idle. */
export function restoreSnapshot(saved: FlowNativeSnapshot | null | undefined, now: number): FlowNativeSnapshot {
  if (!saved || typeof saved !== 'object' || !saved.phase) return { ...IDLE_SNAPSHOT }
  if (saved.phase !== 'idle' && saved.sessionEndsAt != null && saved.sessionEndsAt <= now) {
    return { ...IDLE_SNAPSHOT, alertStyle: saved.alertStyle ?? 'friendly' }
  }
  return saved
}

let goalCounter = 0
export function newGoalId(): string {
  goalCounter = (goalCounter + 1) % 1e6
  return `goal-${Date.now().toString(36)}-${goalCounter}`
}

export function tasksFromTitles(titles: string[]): FlowGoalTask[] {
  return titles
    .map((t) => t.trim())
    .filter(Boolean)
    .map((title) => ({ id: newGoalId(), title }))
}

export function withGoals(s: FlowNativeSnapshot, tasks: FlowGoalTask[]): FlowNativeSnapshot {
  return { ...s, goalTasks: tasks, goals: tasks.map((t) => t.title) }
}

/** Snapshot for a newly started session. */
export function startSnapshot(req: FlowStartRequest, now: number): FlowNativeSnapshot {
  const style: FlowAlertStyle = (['quiet', 'friendly', 'feisty'] as const).includes(req.alertStyle) ? req.alertStyle : 'friendly'
  const minutes = req.minutes != null && req.minutes > 0 ? Math.floor(req.minutes) : null
  return withGoals(
    {
      phase: 'active',
      alertStyle: style,
      alwaysOn: minutes == null,
      sessionStartedAt: now,
      sessionEndsAt: minutes != null ? now + minutes * 60 : undefined,
    },
    tasksFromTitles(req.goals ?? []),
  )
}

/** Extends a timed session (or resumes an ended one) by `minutes`. */
export function extendSnapshot(s: FlowNativeSnapshot, minutes: number, now: number): FlowNativeSnapshot {
  const m = Math.max(1, Math.floor(minutes))
  if (s.phase === 'ended') return { ...s, phase: 'active', alwaysOn: false, sessionEndsAt: now + m * 60 }
  if (s.phase !== 'active' && s.phase !== 'break') return s
  if (s.alwaysOn || s.sessionEndsAt == null) return s
  return { ...s, sessionEndsAt: Math.max(s.sessionEndsAt, now) + m * 60 }
}

/** Starts a break of `minutes`. */
export function breakSnapshot(s: FlowNativeSnapshot, minutes: number, now: number): FlowNativeSnapshot {
  if (s.phase !== 'active') return s
  return { ...s, phase: 'break', breakEndsAt: now + Math.max(1, Math.floor(minutes)) * 60 }
}

/**
 * Newest-first session history with `summary` in it. Ending an extended session again replaces
 * that session's earlier summary (same startedAt) instead of adding a duplicate; it keeps the id.
 */
export function upsertSummary(all: FlowSessionSummary[], summary: FlowSessionSummary): FlowSessionSummary[] {
  const prev = all.find((s) => s.startedAt === summary.startedAt)
  const next = prev ? { ...summary, id: prev.id } : summary
  return [next, ...all.filter((s) => s.startedAt !== summary.startedAt)]
}
