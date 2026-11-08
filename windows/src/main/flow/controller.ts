// FlowSessionMirror.swift port: owns the session snapshot, deadline timer, overlay and agent.
// The session UI is the native React page (features/Flow.tsx) instead of the hosted web app.

import { desktopCapturer, Notification, powerMonitor, screen } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  FlowAgentSettings,
  FlowGoalTask,
  FlowNativeSnapshot,
  FlowOverlayAction,
  FlowOverlayPresentation,
  FlowSessionSummary,
  FlowStartRequest,
  FlowState,
} from '../../shared/flow-types.ts'
import type { FeatureContext } from '../features/context.ts'
import { ForegroundProbe } from '../foreground.ts'
import { ClaudeCliProvider, CodexCliProvider } from '../llm/cli.ts'
import type { LLMCallLog, LLMProvider } from '../llm/types.ts'
import { FlowDistractionAgent, SkipTick, type AgentShot } from './agent.ts'
import { showMainWindow } from './app-windows.ts'
import { looksLikeScreenShare } from './nudge.ts'
import { FlowOverlayWindow } from './overlay.ts'
import { NOTES } from './prompts.ts'
import {
  breakSnapshot,
  deadlineDelayMs,
  extendSnapshot,
  handleDeadline,
  IDLE_SNAPSHOT,
  nearestDeadline,
  restoreSnapshot,
  startSnapshot,
  tasksFromTitles,
  transitionEffects,
  upsertSummary,
  withGoals,
  type FlowEffect,
} from './session.ts'
import { FlowSettingsStore } from './settings.ts'
import { FlowSessionTimeline } from './timeline.ts'

interface PersistedState {
  flowNativeSnapshot?: FlowNativeSnapshot
  completedGoals?: FlowGoalTask[]
  lastSummary?: FlowSessionSummary | null
  nudges?: number
}

const MAX_SESSIONS = 100

const nowSec = () => Math.floor(Date.now() / 1000)

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, file)
  } catch (err) {
    console.error(`[flow] could not write ${file}`, err)
  }
}

/** "chrome — Inbox - Gmail" → { process: "chrome", title: "Inbox - Gmail" } */
export function splitLabel(label: string | null): { process: string; title: string } {
  if (!label) return { process: '', title: '' }
  const i = label.indexOf(' — ')
  return i >= 0 ? { process: label.slice(0, i), title: label.slice(i + 3) } : { process: label, title: '' }
}

export class FlowController {
  readonly settings: FlowSettingsStore
  readonly timeline: FlowSessionTimeline
  readonly agent: FlowDistractionAgent
  readonly overlay = new FlowOverlayWindow((p) => {
    // The overlay window is unavailable: nudges and the session end become notifications.
    if (p.kind === 'nudge') this.notify('Flow', p.message)
    else if (p.kind === 'sessionEnded') this.notify('Flow session complete', "Time's up! Great work.")
  })
  private readonly ctx: FeatureContext
  private readonly stateFile: string
  private readonly sessionsFile: string
  private snapshot: FlowNativeSnapshot
  private completedGoals: FlowGoalTask[] = []
  private lastSummary: FlowSessionSummary | null = null
  private isDistracted = false
  private snoozeUntil: number | null = null
  private nudgeStreak = 0
  private nudges = 0
  private locked = false
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private breakOverlayTimer: ReturnType<typeof setTimeout> | null = null
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null
  private probe: ForegroundProbe | null = null

  constructor(ctx: FeatureContext) {
    this.ctx = ctx
    this.settings = new FlowSettingsStore(ctx.dataDir)
    this.stateFile = join(ctx.dataDir, 'flow-state.json')
    this.sessionsFile = join(ctx.dataDir, 'flow-sessions.json')
    this.timeline = new FlowSessionTimeline(join(ctx.dataDir, 'flow-session-timeline.json'), () => this.categoryNames())
    this.agent = new FlowDistractionAgent({
      settings: () => this.settings.get(),
      makeProvider: () => this.makeProvider(),
      categories: () =>
        this.ctx.settings
          .get()
          .categories.filter((c) => !c.isIdle && c.name.trim())
          .map((c) => ({ name: c.name, details: c.description })),
      timeline: this.timeline,
      captureShot: (dir, s) => this.captureShot(dir, s),
      isCaptureBlocked: () => this.locked,
      isScreenShared: (shot) => looksLikeScreenShare([splitLabel(shot.label)]),
      onFocusChange: (d) => this.agentReportedFocusChange(d),
      onNudge: (m) => this.agentNudge(m),
      onCompletedGoals: (t) => this.agentCompletedGoals(t),
      onChange: () => this.changed(),
    })

    const saved = readJson<PersistedState>(this.stateFile, {})
    this.snapshot = restoreSnapshot(saved.flowNativeSnapshot, nowSec())
    this.completedGoals = this.snapshot.phase === 'idle' ? [] : (saved.completedGoals ?? [])
    this.lastSummary = this.snapshot.phase === 'ended' ? (saved.lastSummary ?? null) : null
    this.nudges = this.snapshot.phase === 'idle' ? 0 : (saved.nudges ?? 0)

    powerMonitor.on('lock-screen', () => (this.locked = true))
    powerMonitor.on('unlock-screen', () => (this.locked = false))
    powerMonitor.on('suspend', () => (this.locked = true))
    powerMonitor.on('resume', () => (this.locked = false))

    // A restored active session gets a fresh agent conversation right away.
    if (this.snapshot.phase === 'active' || this.snapshot.phase === 'break') {
      this.agent.start(this.snapshot)
      if (this.snapshot.phase === 'break') this.agent.pause()
    }
    this.persist()
    this.armDeadline()
  }

  dispose(): void {
    this.agent.dispose()
    this.overlay.destroy()
    this.probe?.dispose()
    for (const t of [this.deadlineTimer, this.toastTimer, this.breakOverlayTimer, this.broadcastTimer]) if (t) clearTimeout(t)
  }

  // ---- State ----

  state(): FlowState {
    return {
      snapshot: this.snapshot,
      completedGoals: this.completedGoals,
      isDistracted: this.isDistracted,
      snoozeUntil: this.snoozeUntil,
      agentStatus: this.agent.status,
      agentRunning: this.agent.isRunning,
      agentEngine: this.agent.engineLabel,
      timeline: this.snapshot.phase === 'idle' ? [] : this.timeline.publicEntries(),
      lastSummary: this.lastSummary,
      recordingPaused: this.recordingLooksPaused(),
      transcript: this.agent.transcript.slice(-60),
      nudges: this.nudges,
    }
  }

  sessions(): FlowSessionSummary[] {
    return readJson<FlowSessionSummary[]>(this.sessionsFile, [])
  }

  private changed(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.ctx.broadcast('flow:state', this.state())
    }, 100)
  }

  private persist(): void {
    writeJson(this.stateFile, {
      flowNativeSnapshot: this.snapshot,
      completedGoals: this.completedGoals,
      lastSummary: this.lastSummary,
      nudges: this.nudges,
    } satisfies PersistedState)
  }

  private categoryNames(): string[] {
    return this.ctx.settings
      .get()
      .categories.filter((c) => !c.isIdle && c.name.trim().toLowerCase() !== 'system')
      .map((c) => c.name.trim())
      .filter(Boolean)
  }

  private recordingLooksPaused(): boolean {
    try {
      const r = this.ctx.store.db.prepare('SELECT MAX(captured_at) AS t FROM screenshots WHERE is_deleted = 0').get() as
        | { t: number | null }
        | undefined
      return !r?.t || nowSec() - Number(r.t) > 120
    } catch {
      return false
    }
  }

  // ---- Apply (FlowSessionMirror.apply) ----

  apply(next: FlowNativeSnapshot): void {
    const prev = this.snapshot
    this.snapshot = next
    if (next.phase === 'ended' && prev.phase !== 'ended') this.timeline.finish()
    const effects = transitionEffects(prev, next)
    if ((prev.phase === 'idle' || prev.phase === 'ended') && next.phase === 'active') {
      if (prev.phase === 'idle' || next.sessionStartedAt !== prev.sessionStartedAt) {
        this.completedGoals = []
        this.nudges = 0
      }
      this.lastSummary = null
    }
    this.run(effects)
    if (next.phase === 'ended' && prev.phase !== 'ended') this.recordSummary()
    if (next.phase === 'idle') {
      this.completedGoals = []
      this.lastSummary = null
      this.nudges = 0
      this.timeline.clear()
    }
    // Extending changes the session end; the agent's briefing mentions it.
    if (prev.phase === next.phase && prev.sessionEndsAt !== next.sessionEndsAt) this.agent.sessionChanged(next)
    this.persist()
    this.armDeadline()
    this.changed()
  }

  private run(effects: FlowEffect[]): void {
    const s = this.settings.get()
    for (const fx of effects) {
      switch (fx.type) {
        case 'resetDistraction':
          this.isDistracted = false
          this.snoozeUntil = null
          this.nudgeStreak = 0
          break
        case 'toast':
          this.showToast(fx.message)
          break
        case 'agentStart':
          this.agent.start(this.snapshot)
          break
        case 'agentPause':
          this.agent.pause()
          break
        case 'agentResume':
          this.agent.resume()
          break
        case 'agentGoalsChanged':
          this.agent.goalsChanged(this.snapshot)
          break
        case 'agentStop':
          this.agent.stop()
          break
        case 'timelineFinish':
          this.timeline.finish()
          break
        case 'showBreak':
          this.clearToast()
          this.present({ kind: 'onBreak', breakEndsAt: this.snapshot.breakEndsAt ?? null })
          if (this.breakOverlayTimer) clearTimeout(this.breakOverlayTimer)
          this.breakOverlayTimer = setTimeout(() => {
            if (this.overlay.presentation.kind === 'onBreak') this.overlay.hide()
          }, s.flowBreakOverlaySeconds * 1000)
          break
        case 'cancelBreakOverlay':
          if (this.breakOverlayTimer) clearTimeout(this.breakOverlayTimer)
          this.breakOverlayTimer = null
          break
        case 'hideOverlay':
          this.overlay.hide()
          break
        case 'sessionEnded':
          break
        case 'nudge':
          this.showNudge(fx.message, fx.escalated)
          break
      }
    }
  }

  private armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
    const d = nearestDeadline(this.snapshot, this.snoozeUntil)
    if (d == null) return
    this.deadlineTimer = setTimeout(() => this.onDeadline(), deadlineDelayMs(d, Date.now()))
  }

  private onDeadline(): void {
    const r = handleDeadline({
      snapshot: this.snapshot,
      snoozeUntil: this.snoozeUntil,
      isDistracted: this.isDistracted,
      nudgeStreak: this.nudgeStreak,
      now: nowSec(),
    })
    this.snoozeUntil = r.snoozeUntil
    this.nudgeStreak = r.nudgeStreak
    this.run(r.effects.filter((e) => e.type === 'nudge'))
    if (r.snapshot !== this.snapshot) {
      const ended = r.snapshot.phase === 'ended' && this.snapshot.phase !== 'ended'
      this.apply(r.snapshot)
      if (ended) {
        this.present({ kind: 'sessionEnded' })
      }
    } else {
      this.armDeadline()
      this.changed()
    }
  }

  private recordSummary(): void {
    const snap = this.snapshot
    const started = snap.sessionStartedAt ?? nowSec()
    const entries = this.timeline.publicEntries()
    let focused = 0
    let distracted = 0
    let brk = 0
    for (const e of this.timeline.entries) {
      const d = e.endedAt - e.startedAt
      if (e.kind === 'focused') focused += d
      else if (e.kind === 'distracted') distracted += d
      else brk += d
    }
    const ended = nowSec()
    if (!entries.length) {
      // No timeline from the model: count the whole session minus breaks as focused.
      brk = this.timeline.breaks.reduce((a, b) => a + Math.max(0, (b.end ?? ended) - b.start), 0)
      focused = Math.max(0, ended - started - brk)
    }
    const summary: FlowSessionSummary = {
      id: randomUUID(),
      startedAt: started,
      endedAt: ended,
      plannedMinutes: snap.alwaysOn || snap.sessionEndsAt == null ? null : Math.round((snap.sessionEndsAt - started) / 60),
      alertStyle: snap.alertStyle,
      goals: [...this.completedGoals.map((g) => g.title), ...(snap.goalTasks ?? []).map((g) => g.title)],
      completedGoals: this.completedGoals.map((g) => g.title),
      entries,
      focusedSeconds: Math.round(focused),
      distractedSeconds: Math.round(distracted),
      breakSeconds: Math.round(brk),
      nudges: this.nudges,
    }
    const all = upsertSummary(this.sessions(), summary)
    this.lastSummary = all[0]
    writeJson(this.sessionsFile, all.slice(0, MAX_SESSIONS))
  }

  // ---- Session controls (the page and the overlay call these) ----

  start(req: FlowStartRequest): FlowState {
    if (this.snapshot.phase === 'active' || this.snapshot.phase === 'break') return this.state()
    this.apply(startSnapshot(req, nowSec()))
    return this.state()
  }

  end(): FlowState {
    if (this.snapshot.phase === 'active' || this.snapshot.phase === 'break') {
      this.apply({ ...this.snapshot, phase: 'ended', breakEndsAt: undefined })
      this.overlay.hide()
    }
    return this.state()
  }

  extend(minutes: number): FlowState {
    const next = extendSnapshot(this.snapshot, minutes, nowSec())
    if (next !== this.snapshot) {
      if (this.overlay.presentation.kind === 'sessionEnded') this.overlay.hide()
      this.apply(next)
    }
    return this.state()
  }

  takeBreak(minutes: number): FlowState {
    const next = breakSnapshot(this.snapshot, minutes, nowSec())
    if (next !== this.snapshot) this.apply(next)
    return this.state()
  }

  resumeFromBreak(): FlowState {
    if (this.snapshot.phase === 'break') this.apply({ ...this.snapshot, phase: 'active', breakEndsAt: undefined })
    return this.state()
  }

  /** Back to the setup screen after a session ended. */
  reset(): FlowState {
    if (this.snapshot.phase === 'ended') {
      this.overlay.hide()
      this.apply({ ...IDLE_SNAPSHOT, alertStyle: this.snapshot.alertStyle })
    }
    return this.state()
  }

  addGoal(title: string): FlowState {
    const tasks = tasksFromTitles([title])
    if (!tasks.length || this.snapshot.phase === 'idle') return this.state()
    this.apply(withGoals(this.snapshot, [...(this.snapshot.goalTasks ?? []), ...tasks]))
    return this.state()
  }

  removeGoal(id: string): FlowState {
    const open = this.snapshot.goalTasks ?? []
    if (!open.some((t) => t.id === id)) {
      this.completedGoals = this.completedGoals.filter((t) => t.id !== id)
      this.persist()
      this.changed()
      return this.state()
    }
    this.apply(withGoals(this.snapshot, open.filter((t) => t.id !== id)))
    return this.state()
  }

  /** Checks a goal off by hand (done = true) or reopens it. */
  setGoalDone(id: string, done: boolean): FlowState {
    const open = this.snapshot.goalTasks ?? []
    if (done) {
      const t = open.find((g) => g.id === id)
      if (!t) return this.state()
      this.completedGoals = [...this.completedGoals, t]
      this.apply(withGoals(this.snapshot, open.filter((g) => g.id !== id)))
    } else {
      const t = this.completedGoals.find((g) => g.id === id)
      if (!t) return this.state()
      this.completedGoals = this.completedGoals.filter((g) => g.id !== id)
      this.apply(withGoals(this.snapshot, [...open, t]))
    }
    return this.state()
  }

  setAlertStyle(style: FlowNativeSnapshot['alertStyle']): FlowState {
    if (!['quiet', 'friendly', 'feisty'].includes(style)) return this.state()
    const next = { ...this.snapshot, alertStyle: style }
    this.snapshot = next
    this.agent.sessionChanged(next)
    this.persist()
    this.changed()
    return this.state()
  }

  updateSettings(patch: Partial<FlowAgentSettings>): FlowAgentSettings {
    const before = this.settings.get()
    const after = this.settings.update(patch)
    if (before.flowAgentTickSeconds !== after.flowAgentTickSeconds) this.agent.reschedule()
    const live = this.snapshot.phase === 'active' || this.snapshot.phase === 'break'
    if (before.flowAgentEnabled !== after.flowAgentEnabled && live) {
      // start() comes up paused when the session is on a break.
      if (after.flowAgentEnabled) this.agent.start(this.snapshot)
      else {
        this.agent.stop()
        this.agent.status = 'Disabled'
      }
    }
    this.changed()
    return after
  }

  /** Debug: "Flow: Simulate Distraction". */
  simulateDistraction(): void {
    if (this.snapshot.phase !== 'active') return
    this.isDistracted = true
    this.nudgeStreak += 1
    this.nudges += 1
    this.showNudge("Psst... I think you're getting distracted!", this.nudgeStreak >= 2)
    this.changed()
  }

  // ---- Agent callbacks ----

  private agentReportedFocusChange(distracted: boolean): void {
    if (this.snapshot.phase !== 'active') return
    this.isDistracted = distracted
    if (!distracted) {
      this.nudgeStreak = 0
      if (this.overlay.presentation.kind === 'nudge') this.overlay.hide()
    }
    this.changed()
  }

  private agentNudge(message: string): void {
    if (this.snapshot.phase !== 'active' || this.snapshot.alertStyle === 'quiet') return
    if (this.snoozeUntil != null && this.snoozeUntil > nowSec()) return
    this.nudgeStreak += 1
    this.nudges += 1
    this.persist()
    this.showNudge(message, this.nudgeStreak >= 2)
    this.changed()
  }

  private agentCompletedGoals(tasks: FlowGoalTask[]): void {
    const open = this.snapshot.goalTasks ?? []
    const ids = new Set(tasks.map((t) => t.id))
    const done = open.filter((t) => ids.has(t.id))
    if (!done.length) return
    this.completedGoals = [...this.completedGoals, ...done]
    if (this.snapshot.alertStyle !== 'quiet' && this.overlay.presentation.kind !== 'nudge') {
      const msg = done.length === 1 ? `Checked off: ${done[0].title}` : `Checked off ${done.length} tasks, including ${done[0].title}`
      this.showToast(msg, this.settings.get().flowPraiseSeconds)
    }
    this.apply(withGoals(this.snapshot, open.filter((t) => !ids.has(t.id))))
  }

  // ---- Overlay ----

  overlayAction(a: FlowOverlayAction): void {
    switch (a.action) {
      case 'backToWork':
        this.isDistracted = false
        this.snoozeUntil = null
        this.nudgeStreak = 0
        this.agent.noteUserEvent(NOTES.backToWork, true)
        this.showToast('Nice! Keep at it')
        break
      case 'snooze': {
        const m = Math.max(1, Math.min(60, Math.floor(a.minutes)))
        this.snoozeUntil = nowSec() + m * 60
        this.agent.noteUserEvent(NOTES.snooze(m))
        this.overlay.hide()
        this.armDeadline()
        break
      }
      case 'correctMistake':
        this.isDistracted = false
        this.snoozeUntil = null
        this.nudgeStreak = 0
        this.agent.noteUserEvent(NOTES.correctMistake, true)
        this.overlay.hide()
        break
      case 'startNew':
        this.overlay.hide()
        if (this.snapshot.phase === 'ended') this.reset()
        showMainWindow('flow')
        break
      case 'done':
      case 'dismiss':
        this.overlay.hide()
        break
    }
    this.changed()
  }

  overlayPresentation(): FlowOverlayPresentation {
    return this.overlay.presentation
  }

  private present(p: FlowOverlayPresentation): void {
    if (!this.overlay.usable || this.settings.get().flowUseNotifications) {
      if (p.kind === 'nudge') this.notify('Flow', p.message)
      else if (p.kind === 'sessionEnded') this.notify('Flow session complete', "Time's up! Great work.")
      return
    }
    void this.overlay.show(p)
  }

  private clearToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = null
  }

  private showToast(message: string, seconds?: number): void {
    if (this.settings.get().flowUseNotifications || !this.overlay.usable) return
    this.present({ kind: 'toast', message })
    this.clearToast()
    this.toastTimer = setTimeout(
      () => {
        if (this.overlay.presentation.kind === 'toast') this.overlay.hide()
      },
      (seconds ?? this.settings.get().flowToastSeconds) * 1000,
    )
  }

  private showNudge(message: string, escalated: boolean): void {
    this.clearToast()
    const current = this.overlay.presentation
    const variant = current.kind === 'nudge' ? current.variant : this.settings.get().flowNudgeVariant
    this.present({ kind: 'nudge', message, escalated, variant })
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => showMainWindow('flow'))
    n.show()
  }

  // ---- Provider and screenshots ----

  private makeProvider(): { provider: LLMProvider; label: string } {
    const app = this.ctx.settings.get()
    const fs = this.settings.get()
    // Only failures go to the call log: a check every 15 s would flood it.
    const log = (l: LLMCallLog) => {
      if (l.status !== 'failure') return
      try {
        this.ctx.store.logCall(null, l)
      } catch {
        /* ignore */
      }
    }
    if (app.provider === 'claude_cli') {
      const model = fs.flowAgentModel || 'haiku'
      return { provider: new ClaudeCliProvider(app.claudeCommand, model, log), label: `Claude ${model}` }
    }
    if (app.provider === 'codex_cli') {
      const model = fs.flowAgentModel || app.cliModel
      return { provider: new CodexCliProvider(app.codexCommand, model, log), label: model ? `Codex, ${model}` : 'Codex' }
    }
    // Same rule for Gemini / OpenAI-compatible: only failures reach llm_calls. Called through a
    // widened type so this compiles before FeatureContext declares the options parameter.
    const make = this.ctx.makeProvider as (batchId: number | null, options?: { logSuccess?: boolean }) => LLMProvider
    const p = make.call(this.ctx, null, { logSuccess: false })
    const name = p.id === 'gemini' ? 'Gemini' : p.id === 'openai_compatible' ? 'Local model' : p.id
    return { provider: p, label: p.model ? `${name}, ${p.model}` : name }
  }

  private getProbe(): ForegroundProbe {
    return (this.probe ??= new ForegroundProbe())
  }

  /**
   * Prefers the recorder's latest frame (it carries the window label). When recording is
   * paused or the frame is stale, captures the display under the cursor itself.
   */
  private async captureShot(workDir: string, s: FlowAgentSettings): Promise<AgentShot> {
    const now = nowSec()
    const maxAge = Math.max(30, 2 * Math.max(5, s.flowAgentTickSeconds))
    const row = this.ctx.store.db
      .prepare('SELECT captured_at, file_path, window_label FROM screenshots WHERE is_deleted = 0 ORDER BY captured_at DESC LIMIT 1')
      .get() as { captured_at: number; file_path: string; window_label: string | null } | undefined
    if (row && now - Number(row.captured_at) <= maxAge && existsSync(String(row.file_path))) {
      const label = row.window_label == null ? null : String(row.window_label)
      return { path: String(row.file_path), label, appName: splitLabel(label).process || null, temporary: false }
    }

    const fg = await this.getProbe().query()
    if (fg?.locked) throw new SkipTick('locked')
    const excluded = this.ctx.settings.get().excludedApps
    if (fg && excluded.some((a) => a.trim() && a.trim().toLowerCase() === fg.process.toLowerCase())) throw new SkipTick('excluded')
    const label = fg && (fg.process || fg.title) ? `${fg.process}${fg.title ? ` — ${fg.title}` : ''}`.slice(0, 300) : null

    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { width, height } = display.size
    const targetH = Math.min(s.flowAgentShotHeight, Math.round(height * display.scaleFactor))
    const targetW = Math.round((width / height) * targetH)
    const quality = Math.round(Math.min(0.95, Math.max(0.3, s.flowAgentJpegQuality)) * 100)
    const file = join(workDir, `shot-${now}.jpg`)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: targetW, height: targetH } })
    const source = sources.find((x) => x.display_id === String(display.id)) ?? sources[0]
    if (source && !source.thumbnail.isEmpty()) {
      await writeFile(file, source.thumbnail.toJPEG(quality))
    } else {
      const phys = screen.dipToScreenPoint(cursor)
      await this.getProbe().capture(file, targetH, quality, phys.x, phys.y)
      await stat(file)
    }
    return { path: file, label, appName: fg?.process || null, temporary: true }
  }
}
