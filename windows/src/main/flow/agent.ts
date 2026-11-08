// FlowDistractionAgent.swift port (spec A.5/A.6). Every tick it shows the model the latest
// screenshot and asks for a verdict; nudge timing stays in nudge.ts.
//
// Windows providers are stateless one-shot calls, so the agent works like the macOS
// "Dayflow Pro" engine: each tick sends the briefing + the last 12 turns (text only) + this
// tick's message, plus the screenshot, and the timeline comes back inline.
// No Electron imports: capture, provider and callbacks are injected.

import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FlowAgentSettings, FlowGoalTask, FlowNativeSnapshot, FlowTranscriptLine } from '../../shared/flow-types.ts'
import type { Frame, LLMProvider } from '../llm/types.ts'
import { handleVerdict, initialNudgeState, jsonObjects, nudgeDue, parseVerdict, type NudgeState } from './nudge.ts'
import {
  buildBriefing,
  buildTickMessage,
  composeStatelessPrompt,
  goalsUpdatedNote,
  NOTES,
  REPLY_REMINDER,
  type HistoryTurn,
  type PromptCategory,
} from './prompts.ts'
import { timelineFromObjects, type FlowSessionTimeline } from './timeline.ts'

export const CAPTURE_BACKOFF = [30, 60, 120, 300]
export const HISTORY_TURNS = 12
const TRANSCRIPT_LIMIT = 200

export interface AgentShot {
  path: string
  /** "process — title" of the foreground window */
  label: string | null
  appName: string | null
  /** Delete after the tick */
  temporary: boolean
}

/** Thrown by `captureShot` when this tick should be skipped without counting a failure. */
export class SkipTick extends Error {}

export interface AgentDeps {
  settings: () => FlowAgentSettings
  /** Throws with a user-facing message when no provider is configured. */
  makeProvider: () => { provider: LLMProvider; label: string }
  categories: () => PromptCategory[]
  timeline: FlowSessionTimeline
  captureShot: (workDir: string, s: FlowAgentSettings) => Promise<AgentShot>
  isCaptureBlocked: () => boolean
  isScreenShared: (shot: AgentShot) => boolean
  onFocusChange: (distracted: boolean) => void
  onNudge: (message: string) => void
  onCompletedGoals: (tasks: FlowGoalTask[]) => void
  onChange: () => void
}

export interface SessionStats {
  checks: number
  onTask: number
  offTask: number
  turnFailures: number
  captureFailures: number
  unparseableReplies: number
  nudgesRequested: number
  nudgesSent: number
  nudgesHeldNotDue: number
  nudgesHeldScreenShare: number
  nudgesDueNotWritten: number
  skippedInFlight: number
  skippedCaptureBlocked: number
  skippedCaptureBackoff: number
  checkSeconds: number
  rebriefs: number
}

const emptyStats = (): SessionStats => ({
  checks: 0, onTask: 0, offTask: 0, turnFailures: 0, captureFailures: 0, unparseableReplies: 0,
  nudgesRequested: 0, nudgesSent: 0, nudgesHeldNotDue: 0, nudgesHeldScreenShare: 0, nudgesDueNotWritten: 0,
  skippedInFlight: 0, skippedCaptureBlocked: 0, skippedCaptureBackoff: 0, checkSeconds: 0, rebriefs: 0,
})

const DESCRIBE_PROMPT =
  'Describe this screenshot in two or three sentences: which app or website is in front, and what the user is doing in it.'

/**
 * Provider methods with the optional trailing AbortSignal (llm/cli.ts kills the CLI's process
 * tree on abort). Called through this shape so it also compiles against providers that don't
 * declare the parameter; they simply ignore the extra argument.
 */
interface AbortableProvider {
  generateWithImages?(prompt: string, frames: Frame[], operation: string, signal?: AbortSignal): Promise<string>
  describeFrame?(prompt: string, frame: Frame, signal?: AbortSignal): Promise<string>
  generateText(prompt: string, operation: string, expectJSON: boolean, signal?: AbortSignal): Promise<string>
}

/** Rejects after `ms` and aborts `ac`, so the provider stops its request / CLI child too. */
export function withTimeout<T>(p: Promise<T>, ms: number, ac?: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`no reply within ${Math.round(ms / 1000)}s`)
      ac?.abort(err)
      reject(err)
    }, ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export class FlowDistractionAgent {
  status = 'Not running'
  engineLabel: string | null = null
  transcript: FlowTranscriptLine[] = []
  stats: SessionStats = emptyStats()
  private readonly deps: AgentDeps
  private running = false
  private paused = false
  private tickInFlight = false
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerSeconds = 0
  /** Bumped by schedule()/stop() so a superseded tick loop doesn't re-arm itself. */
  private loopId = 0
  private currentTick: Promise<void> | null = null
  private tickAbort: AbortController | null = null
  private workDir: string | null = null
  private provider: LLMProvider | null = null
  private briefing = ''
  private history: HistoryTurn[] = []
  private pendingNotes: string[] = []
  private goalTasks: FlowGoalTask[] = []
  private snapshot: FlowNativeSnapshot | null = null
  private nudge: NudgeState = initialNudgeState()
  private consecutiveFailures = 0
  private captureFailureCount = 0
  private captureBackoffUntil = 0
  private forceTimelineUpdate = false

  constructor(deps: AgentDeps) {
    this.deps = deps
  }

  get isRunning(): boolean {
    return this.running
  }

  start(snapshot: FlowNativeSnapshot, rebrief = false): void {
    const rebriefs = this.stats.rebriefs
    this.stop()
    if (rebrief) this.stats.rebriefs = rebriefs + 1
    const s = this.deps.settings()
    const started = snapshot.sessionStartedAt ?? Math.floor(Date.now() / 1000)
    this.deps.timeline.begin(started)
    if (!s.flowAgentEnabled) {
      this.status = 'Disabled'
      this.deps.onChange()
      return
    }
    if (!rebrief) {
      this.stats = emptyStats()
      this.transcript = []
      this.nudge = initialNudgeState()
    }
    this.snapshot = snapshot
    this.goalTasks = snapshot.goalTasks ?? (snapshot.goals ?? []).map((title, i) => ({ id: `goal-${i}`, title }))
    try {
      const { provider, label } = this.deps.makeProvider()
      this.provider = provider
      this.engineLabel = label
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.append(`Couldn't start the agent: ${msg}`)
      this.status = 'Failed to start'
      this.deps.onChange()
      return
    }
    const dir = join(tmpdir(), `DayflowFlowAgent-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    this.workDir = dir
    this.briefing = this.makeBriefing(snapshot)
    this.history = []
    this.running = true
    this.paused = snapshot.phase === 'break'
    this.generation++
    this.status = `Watching (${this.engineLabel})`
    this.append(rebrief ? `Re-briefed ${this.engineLabel}.` : `Briefed ${this.engineLabel}.`)
    this.schedule()
    this.deps.onChange()
  }

  stop(): void {
    this.generation++
    this.loopId++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // Kill the model call (and the CLI child) of a tick still in flight.
    this.tickAbort?.abort(new Error('Flow agent stopped'))
    this.tickAbort = null
    this.currentTick = null
    this.running = false
    this.paused = false
    this.tickInFlight = false
    this.provider = null
    this.history = []
    this.pendingNotes = []
    this.captureBackoffUntil = 0
    this.captureFailureCount = 0
    this.consecutiveFailures = 0
    if (this.workDir) rmSync(this.workDir, { recursive: true, force: true })
    this.workDir = null
    if (this.status !== 'Disabled' && !this.status.startsWith('Stopped') && this.status !== 'Failed to start') {
      this.status = 'Not running'
    }
  }

  pause(): void {
    this.paused = true
    this.deps.timeline.beginBreak()
    this.noteUserEvent(NOTES.breakStarted)
  }

  resume(): void {
    this.paused = false
    this.deps.timeline.endBreak()
    this.noteUserEvent(NOTES.breakEnded)
  }

  goalsChanged(snapshot: FlowNativeSnapshot): void {
    if (!this.running) return
    this.snapshot = snapshot
    const next = snapshot.goalTasks ?? []
    const same = next.length === this.goalTasks.length && next.every((t, i) => t.id === this.goalTasks[i].id && t.title === this.goalTasks[i].title)
    if (same) return
    const finished = this.goalTasks.filter((o) => !next.some((n) => n.id === o.id))
    const added = next.filter((n) => !this.goalTasks.some((o) => o.id === n.id))
    this.goalTasks = next
    // The briefing numbers the goals [g1]…[gN] and verdicts resolve gN against goalTasks,
    // so both must use the new list.
    this.briefing = this.makeBriefing(snapshot)
    this.pendingNotes.push(goalsUpdatedNote(next, finished, added))
  }

  /** Stops the agent and kills any model call in flight (app quit). */
  dispose(): void {
    this.stop()
  }

  /** Session end time / style changed (extend). Rebuilds the briefing for the next tick. */
  sessionChanged(snapshot: FlowNativeSnapshot): void {
    if (!this.running) return
    this.snapshot = snapshot
    this.briefing = this.makeBriefing(snapshot)
  }

  noteUserEvent(note: string, markRefocused = false): void {
    if (!this.running) return
    this.pendingNotes.push(note)
    if (markRefocused) this.nudge = { ...this.nudge, lastReportedOffTask: false }
  }

  /** Re-reads tickSeconds (call after settings change). */
  reschedule(): void {
    if (!this.running || Math.max(5, this.deps.settings().flowAgentTickSeconds) === this.timerSeconds) return
    this.schedule()
    // The briefing states the check cadence; keep it truthful.
    if (this.snapshot) this.briefing = this.makeBriefing(this.snapshot)
  }

  tickNow(forceTimeline = false): void {
    if (forceTimeline) this.forceTimelineUpdate = true
    void this.runTick()
  }

  /** Runs one tick, or joins the one already in flight. */
  private runTick(): Promise<void> {
    if (this.currentTick) {
      this.stats.skippedInFlight++
      return this.currentTick
    }
    const p = this.tick().finally(() => {
      if (this.currentTick === p) this.currentTick = null
    })
    this.currentTick = p
    return p
  }

  private makeBriefing(snapshot: FlowNativeSnapshot): string {
    const s = this.deps.settings()
    return buildBriefing({
      tickSeconds: Math.max(5, s.flowAgentTickSeconds),
      startedAt: snapshot.sessionStartedAt ?? Math.floor(Date.now() / 1000),
      endsAt: snapshot.alwaysOn ? null : (snapshot.sessionEndsAt ?? null),
      style: snapshot.alertStyle,
      goalTasks: this.goalTasks,
      categories: this.deps.categories(),
      template: s.flowAgentBriefing,
      extra: s.flowAgentExtra,
      inlineTimeline: true,
    })
  }

  /**
   * Self-scheduling loop: each check starts `tickSeconds` after the previous one started, or
   * right away when a check took longer than that (a fixed interval would skip those ticks).
   */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const loop = ++this.loopId
    this.timerSeconds = Math.max(5, this.deps.settings().flowAgentTickSeconds)
    const arm = (delayMs: number) => {
      this.timer = setTimeout(async () => {
        this.timer = null
        const started = Date.now()
        try {
          await this.runTick()
        } catch (err) {
          console.error('[flow] agent tick failed', err)
        }
        if (loop !== this.loopId || !this.running) return
        arm(Math.max(0, this.timerSeconds * 1000 - (Date.now() - started)))
      }, delayMs)
    }
    arm(this.timerSeconds * 1000)
  }

  private append(text: string): void {
    this.transcript.push({ at: Math.floor(Date.now() / 1000), text })
    if (this.transcript.length > TRANSCRIPT_LIMIT) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_LIMIT)
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.workDir || !this.provider || !this.snapshot) return
    if (this.paused) return
    if (!this.deps.settings().flowAgentEnabled) return
    if (this.tickInFlight) {
      this.stats.skippedInFlight++
      return
    }
    if (this.deps.isCaptureBlocked()) {
      this.stats.skippedCaptureBlocked++
      return
    }
    if (Date.now() < this.captureBackoffUntil) {
      this.stats.skippedCaptureBackoff++
      return
    }
    const s = this.deps.settings()
    const gen = this.generation
    const provider = this.provider
    const snapshot = this.snapshot
    const workDir = this.workDir
    this.tickInFlight = true
    const startedAt = Date.now()
    const now = Math.floor(startedAt / 1000)
    const timeline = this.deps.timeline
    const forced = this.forceTimelineUpdate
    const askTimeline = forced || timeline.wantsUpdate(s.flowAgentTimelineSeconds)
    this.forceTimelineUpdate = false
    const tickSeconds = Math.max(5, s.flowAgentTickSeconds)
    const due = nudgeDue(this.nudge, snapshot.alertStyle, tickSeconds, now)
    const message = buildTickMessage({
      now,
      startedAt: snapshot.sessionStartedAt ?? now,
      endsAt: snapshot.alwaysOn ? null : (snapshot.sessionEndsAt ?? null),
      nudgeDueDriftMinutes: due && this.nudge.offTaskSince != null ? (now - this.nudge.offTaskSince) / 60 : null,
      notes: this.pendingNotes,
      timeline: askTimeline
        ? {
            timelineJSON: timeline.promptTimelineJSON(),
            observations: timeline.promptObservations(timeline.lastModelUpdateAt),
            breaks: timeline.promptBreaks(),
          }
        : null,
    })
    const notes = this.pendingNotes
    this.pendingNotes = []
    // Notes that never reached the model go back to the front of the queue.
    const requeue = () => {
      this.pendingNotes = [...notes, ...this.pendingNotes]
      if (forced) this.forceTimelineUpdate = true
    }
    const ac = new AbortController()
    this.tickAbort = ac

    let shot: AgentShot | null = null
    try {
      try {
        shot = await this.deps.captureShot(workDir, s)
      } catch (err) {
        if (gen !== this.generation) return
        requeue()
        if (err instanceof SkipTick) return
        this.stats.captureFailures++
        this.captureFailureCount++
        const delay = CAPTURE_BACKOFF[Math.min(this.captureFailureCount - 1, CAPTURE_BACKOFF.length - 1)]
        this.captureBackoffUntil = Date.now() + delay * 1000
        this.append(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}. Trying again in ${delay}s.`)
        return
      }
      this.captureFailureCount = 0
      this.captureBackoffUntil = 0
      this.stats.checks++

      const turnPrompt = message + '\n' + REPLY_REMINDER
      let reply: string | null = null
      let error: string | null = null
      try {
        reply = await withTimeout(this.runModel(provider, turnPrompt, shot, ac.signal), s.flowAgentTickTimeout * 1000, ac)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      if (gen !== this.generation) return
      if (reply == null) requeue()
      this.finishTick(turnPrompt, reply, error, (Date.now() - startedAt) / 1000, shot, askTimeline, snapshot, tickSeconds)
    } finally {
      if (shot?.temporary) rmSync(shot.path, { force: true })
      if (this.tickAbort === ac) this.tickAbort = null
      if (gen === this.generation) this.tickInFlight = false
      if (gen === this.generation) this.deps.onChange()
    }
  }

  private async runModel(llm: LLMProvider, turnPrompt: string, shot: AgentShot, signal: AbortSignal): Promise<string> {
    const provider = llm as AbortableProvider
    const frame: Frame = { path: shot.path, offsetSeconds: 0, label: shot.label ?? undefined }
    if (provider.generateWithImages) {
      return provider.generateWithImages(composeStatelessPrompt(this.briefing, this.history, turnPrompt), [frame], 'flow_check', signal)
    }
    if (provider.describeFrame) {
      const description = await provider.describeFrame(DESCRIBE_PROMPT, frame, signal)
      signal.throwIfAborted()
      const withDescription = turnPrompt.replace(
        REPLY_REMINDER,
        `Screenshot (described by a vision model): ${description.trim()}${shot.label ? `\nForeground window: ${shot.label}` : ''}\n${REPLY_REMINDER}`,
      )
      return provider.generateText(composeStatelessPrompt(this.briefing, this.history, withDescription), 'flow_check', true, signal)
    }
    throw new Error('This provider cannot look at screenshots.')
  }

  private finishTick(
    prompt: string,
    reply: string | null,
    error: string | null,
    seconds: number,
    shot: AgentShot,
    askedTimeline: boolean,
    snapshot: FlowNativeSnapshot,
    tickSeconds: number,
  ): void {
    const s = this.deps.settings()
    if (reply == null) {
      this.stats.turnFailures++
      this.consecutiveFailures++
      this.append(`Turn failed: ${error ?? 'unknown'}`)
      if (this.consecutiveFailures >= s.flowAgentMaxFailures) {
        const n = this.consecutiveFailures
        this.append(`Agent stopped after ${n} consecutive failures.`)
        this.stop()
        this.status = `Stopped after ${n} failures`
        // stop() bumped the generation, so tick()'s finally won't broadcast this.
        this.deps.onChange()
      }
      return
    }
    this.consecutiveFailures = 0
    this.stats.checkSeconds += seconds
    this.append(reply.trim())
    this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: reply.trim() })
    const limit = HISTORY_TURNS * 2
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit)

    const objects = jsonObjects(reply)
    const verdict = parseVerdict(objects)
    if (!verdict) {
      this.stats.unparseableReplies++
      return
    }
    const r = handleVerdict(this.nudge, verdict, {
      style: snapshot.alertStyle,
      tickSeconds,
      goalTasks: this.goalTasks,
      screenShared: this.deps.isScreenShared(shot),
      now: Math.floor(Date.now() / 1000),
    })
    this.nudge = r.state
    if (r.offTask) this.stats.offTask++
    else this.stats.onTask++
    if (r.focusChange != null) this.deps.onFocusChange(r.focusChange)
    if (r.completed.length) this.deps.onCompletedGoals(r.completed)
    if (verdict.action === 'nudge') this.stats.nudgesRequested++
    if (r.nudge === 'sent' && r.nudgeMessage) {
      this.stats.nudgesSent++
      this.deps.onNudge(r.nudgeMessage)
    } else if (r.nudge === 'heldNotDue') this.stats.nudgesHeldNotDue++
    else if (r.nudge === 'heldScreenShare') this.stats.nudgesHeldScreenShare++
    else if (r.nudge === 'dueNotWritten') this.stats.nudgesDueNotWritten++

    this.deps.timeline.observe(r.offTask, shot.appName ?? undefined, verdict.reason ?? verdict.seeing)
    if (askedTimeline) {
      const items = timelineFromObjects(objects.slice(1))
      if (!items || !this.deps.timeline.apply(items)) {
        this.append("Timeline update: the model didn't leave a usable timeline.")
      }
    }
  }
}
