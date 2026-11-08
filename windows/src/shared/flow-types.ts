// Flow focus sessions: types shared by the main process (src/main/flow) and the renderer
// (features/Flow.tsx, features/flow/*). Mirrors FlowNativeState.swift / FlowAgentSettings.swift.

export type FlowAlertStyle = 'quiet' | 'friendly' | 'feisty'
export type FlowPhase = 'idle' | 'active' | 'break' | 'ended'

export interface FlowGoalTask {
  id: string
  title: string
}

/** Session state; persisted as `flowNativeSnapshot` in flow-state.json. Times are unix seconds. */
export interface FlowNativeSnapshot {
  phase: FlowPhase
  alertStyle: FlowAlertStyle
  sessionEndsAt?: number
  breakEndsAt?: number
  /** Open-ended session (no timer) */
  alwaysOn: boolean
  sessionStartedAt?: number
  /** Open goal titles */
  goals?: string[]
  /** Open goals with ids, for auto check-off */
  goalTasks?: FlowGoalTask[]
}

export type FlowNudgeVariant = 'side' | 'top' | 'peek'

/** FlowAgentSettings; stored in flow-settings.json under the macOS UserDefaults key names. */
export interface FlowAgentSettings {
  flowAgentEnabled: boolean
  /** Model override for the watcher. Empty = "haiku" for Claude CLI, the configured model otherwise. */
  flowAgentModel: string
  flowAgentReasoning: string
  flowAgentTickSeconds: number
  flowAgentShotHeight: number
  flowAgentJpegQuality: number
  flowAgentMaxFailures: number
  flowAgentTickTimeout: number
  flowAgentBriefing: string
  flowAgentExtra: string
  flowAgentTimelineSeconds: number
  flowBreakOverlaySeconds: number
  flowToastSeconds: number
  flowPraiseSeconds: number
  flowNudgeVariant: FlowNudgeVariant
  /** Default alert style ("sensitivity") for new sessions */
  flowDefaultAlertStyle: FlowAlertStyle
  /** Default session length in minutes; 0 = open-ended */
  flowDefaultMinutes: number
  /** Show nudges as Windows notifications instead of the on-screen creature */
  flowUseNotifications: boolean
}

export type FlowEntryKind = 'focused' | 'distracted' | 'break'

export interface FlowTimelineEntry {
  id: string
  title: string
  kind: FlowEntryKind
  /** ISO-8601 */
  startedAt: string
  endedAt: string
  iconURL?: string
  completedTasks?: string[]
  category?: string
  site?: string
}

export interface FlowSessionSummary {
  id: string
  startedAt: number
  endedAt: number
  plannedMinutes: number | null
  alertStyle: FlowAlertStyle
  goals: string[]
  completedGoals: string[]
  entries: FlowTimelineEntry[]
  focusedSeconds: number
  distractedSeconds: number
  breakSeconds: number
  nudges: number
}

export type FlowOverlayPresentation =
  | { kind: 'hidden' }
  | { kind: 'toast'; message: string }
  | { kind: 'nudge'; message: string; escalated: boolean; variant: FlowNudgeVariant }
  | { kind: 'onBreak'; breakEndsAt: number | null }
  | { kind: 'sessionEnded' }

export type FlowOverlayAction =
  | { action: 'backToWork' }
  | { action: 'snooze'; minutes: number }
  | { action: 'correctMistake' }
  | { action: 'startNew' }
  | { action: 'done' }
  | { action: 'dismiss' }

export interface FlowTranscriptLine {
  at: number
  text: string
}

/** Everything the Flow page needs; pushed on `flow:state`. */
export interface FlowState {
  snapshot: FlowNativeSnapshot
  /** Goals checked off this session (by the agent or by hand) */
  completedGoals: FlowGoalTask[]
  isDistracted: boolean
  snoozeUntil: number | null
  agentStatus: string
  agentRunning: boolean
  /** Provider label, e.g. "Claude haiku" */
  agentEngine: string | null
  timeline: FlowTimelineEntry[]
  /** Summary of the session that just ended (phase 'ended') */
  lastSummary: FlowSessionSummary | null
  recordingPaused: boolean
  transcript: FlowTranscriptLine[]
  nudges: number
}

export interface FlowStartRequest {
  goals: string[]
  /** null = open-ended */
  minutes: number | null
  alertStyle: FlowAlertStyle
}
