// Nudge timing and verdict handling (spec A.8). Dayflow decides when a nudge is due; the
// model only writes it. Pure: all times are unix seconds passed in.

import type { FlowAlertStyle, FlowGoalTask } from '../../shared/flow-types.ts'

export interface Verdict {
  status?: string
  seeing?: string
  action?: string
  message?: string
  reason?: string
  completed_goals?: string[]
}

export function isOffTask(v: Verdict): boolean {
  return v.status === 'off_task' || v.status === 'distracted'
}

/** Friendly follow-up spacing, indexed by unanswered nudges (capped). */
export const FRIENDLY_WAITS = [240, 300, 600]
export const FEISTY_SPACING = 120
export const DRIFT_CLOSE_SECONDS = 60
export const NUDGE_LANDED_SECONDS = 180

export interface NudgeState {
  offTaskSince: number | null
  backOnTaskSince: number | null
  focusedSince: number | null
  lastNudgeAt: number | null
  unansweredNudges: number
  lastReportedOffTask: boolean
  reportedGoalIds: string[]
}

export function initialNudgeState(): NudgeState {
  return {
    offTaskSince: null,
    backOnTaskSince: null,
    focusedSince: null,
    lastNudgeAt: null,
    unansweredNudges: 0,
    lastReportedOffTask: false,
    reportedGoalIds: [],
  }
}

export function nudgeDue(s: NudgeState, style: FlowAlertStyle, tickSeconds: number, now: number): boolean {
  if (s.offTaskSince == null || s.backOnTaskSince != null) return false
  const drift = now - s.offTaskSince
  const sinceLast = s.lastNudgeAt == null ? Infinity : now - s.lastNudgeAt
  switch (style) {
    case 'quiet':
      return false
    case 'friendly':
      return drift >= 60 && sinceLast >= FRIENDLY_WAITS[Math.min(s.unansweredNudges, FRIENDLY_WAITS.length - 1)]
    case 'feisty':
      return drift >= tickSeconds && sinceLast >= FEISTY_SPACING
  }
}

export type NudgeOutcome = 'sent' | 'heldScreenShare' | 'heldNotDue' | 'none' | 'dueNotWritten'

export interface VerdictResult {
  state: NudgeState
  offTask: boolean
  /** Set when the off-task flag differs from what was last reported */
  focusChange: boolean | null
  completed: FlowGoalTask[]
  nudge: NudgeOutcome
  nudgeMessage: string | null
}

export interface VerdictContext {
  style: FlowAlertStyle
  tickSeconds: number
  goalTasks: FlowGoalTask[]
  screenShared: boolean
  now: number
}

/** Resolves "g2", "[g2]", " G2 " → the 1-based goal index. */
export function goalIndex(short: string): number | null {
  const digits = String(short).toLowerCase().replace(/^[g[\] ]+|[g[\] ]+$/g, '')
  if (!/^\d+$/.test(digits)) return null
  return Number(digits)
}

export function handleVerdict(prev: NudgeState, v: Verdict, ctx: VerdictContext): VerdictResult {
  const s: NudgeState = { ...prev, reportedGoalIds: [...prev.reportedGoalIds] }
  const offTask = isOffTask(v)
  const now = ctx.now
  if (offTask) {
    if (s.offTaskSince == null) s.offTaskSince = now
    s.backOnTaskSince = null
  } else if (s.offTaskSince != null) {
    if (s.backOnTaskSince != null && now - s.backOnTaskSince >= DRIFT_CLOSE_SECONDS) {
      s.focusedSince = s.backOnTaskSince
      s.offTaskSince = null
      s.backOnTaskSince = null
    } else if (s.backOnTaskSince == null) {
      s.backOnTaskSince = now
    }
  } else if (s.focusedSince != null && now - s.focusedSince >= NUDGE_LANDED_SECONDS) {
    s.unansweredNudges = 0
  }

  let focusChange: boolean | null = null
  if (offTask !== s.lastReportedOffTask) {
    s.lastReportedOffTask = offTask
    focusChange = offTask
  }

  const completed: FlowGoalTask[] = []
  for (const short of Array.isArray(v.completed_goals) ? v.completed_goals : []) {
    const i = goalIndex(short)
    if (i == null || i < 1 || i > ctx.goalTasks.length) continue
    const task = ctx.goalTasks[i - 1]
    if (s.reportedGoalIds.includes(task.id) || completed.some((t) => t.id === task.id)) continue
    completed.push(task)
  }
  for (const t of completed) s.reportedGoalIds.push(t.id)

  let nudge: NudgeOutcome = 'none'
  let nudgeMessage: string | null = null
  if (v.action === 'nudge') {
    if (ctx.screenShared) nudge = 'heldScreenShare'
    else if (!offTask || !nudgeDue(s, ctx.style, ctx.tickSeconds, now)) nudge = 'heldNotDue'
    else {
      nudge = 'sent'
      s.unansweredNudges += 1
      s.focusedSince = null
      s.lastNudgeAt = now
      nudgeMessage = v.message && v.message.trim() ? v.message.trim() : "Psst... I think you're getting distracted!"
    }
  } else if (offTask && ctx.style !== 'quiet' && nudgeDue(s, ctx.style, ctx.tickSeconds, now)) {
    nudge = 'dueNotWritten'
  }
  return { state: s, offTask, focusChange, completed, nudge, nudgeMessage }
}

/** Every top-level {...} object in a reply (brace-depth scan that skips string contents). */
export function jsonObjects(reply: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < reply.length; i++) {
    const ch = reply[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(reply.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

/** First object as a Verdict, or null when unparseable. */
export function parseVerdict(objects: string[]): Verdict | null {
  if (!objects.length) return null
  try {
    const v = JSON.parse(objects[0]) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
    return {
      status: str(o.status),
      seeing: str(o.seeing),
      action: str(o.action),
      message: str(o.message),
      reason: str(o.reason),
      completed_goals: Array.isArray(o.completed_goals) ? o.completed_goals.map(String) : undefined,
    }
  } catch {
    return null
  }
}

/** Screen-share markers (owner contains, title contains), lowercased — FlowScreenShareDetector. */
export const SCREEN_SHARE_MARKERS: Array<[string, string]> = [
  ['zoom', 'zoom share statusbar window'],
  ['zoom', 'zoom share toolbar window'],
  ['zoom', 'zoom sharing toolbar'],
  ['teams', 'sharing control bar'],
  ['teams', 'sharing toolbar'],
  ['webex', 'sharing control bar'],
  ['', 'is sharing your screen'],
  ['', 'is sharing a window'],
]

/** True when any of the (process, title) windows matches a screen-share marker. */
export function looksLikeScreenShare(windows: Array<{ process: string; title: string }>): boolean {
  return windows.some((w) => {
    const p = w.process.toLowerCase()
    const t = w.title.toLowerCase()
    return SCREEN_SHARE_MARKERS.some(([owner, title]) => (!owner || p.includes(owner)) && t.includes(title))
  })
}
