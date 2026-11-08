// Daily page: standup / recap, Daily Brief, and Day goals (spec: docs/spec-daily.md).
// Registers the `daily:*` and `goals:*` IPC channels and the 5-minute scheduler.
//
// Events sent to the renderer (window.dayflow.on):
//   daily:standup-changed (day: string)
//   daily:brief-state     (state: BriefViewState)
//   daily:brief-ready     (day: string)          automatic brief finished while not on screen
//   daily:open            (day: string)          a Daily notification was clicked
//   goals:changed         (day: string)

import { app, BrowserWindow, clipboard, ipcMain, Notification } from 'electron'
import { readFileSync } from 'node:fs'
import type {
  BriefAction,
  BriefPart,
  BriefSectionKey,
  DailySettings,
  DailyStandupDraft,
  DayGoalCategorySnapshot,
  DayGoalPlan,
  FeedbackAction,
  SummaryRange,
} from '../../shared/daily-types.ts'
import { BriefService } from '../daily/brief.ts'
import { isSummaryRange } from '../daily/brief-logic.ts'
import { BriefFileStore } from '../daily/brief-store.ts'
import { GoalsService } from '../daily/goals-service.ts'
import { RecapService } from '../daily/recap.ts'
import { standupClipboardText } from '../daily/standup.ts'
import { DailyStore } from '../daily/store.ts'
import type { FeatureContext } from './context.ts'

const CHECK_INTERVAL_MS = 5 * 60_000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function assertDay(day: unknown): string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) throw new Error('Invalid day')
  return day
}

function assertRange(range: unknown): SummaryRange {
  if (!isSummaryRange(range)) throw new Error('Invalid range')
  return range
}

function dataUrl(path: string | null): string | null {
  if (!path) return null
  try {
    return `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`
  } catch {
    return null
  }
}

function showWindow(): void {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

export function register(ctx: FeatureContext): void {
  const daily = new DailyStore(ctx.store.db)
  const files = new BriefFileStore(ctx.dataDir)
  const cardsForDay = (day: string) => ctx.store.cardsForDay(day)

  const recap = new RecapService({
    daily,
    cardsForDay,
    settings: () => ctx.settings.withSecrets(),
    makeProvider: () => ctx.makeProvider(null),
    changed: (day) => ctx.broadcast('daily:standup-changed', day),
    notify: (day) => {
      if (!Notification.isSupported()) return
      const n = new Notification({ title: 'Your daily recap for yesterday is ready', body: 'Click to open it in the Daily view.' })
      n.on('click', () => {
        showWindow()
        ctx.broadcast('daily:open', day)
      })
      n.show()
    },
  })

  const brief = new BriefService({
    store: ctx.store,
    daily,
    files,
    settings: () => ctx.settings.withSecrets(),
    makeProvider: () => ctx.makeProvider(null),
    broadcast: ctx.broadcast,
    showWindow,
  })

  const goals = new GoalsService({
    daily,
    cardsForDay,
    categories: () => ctx.settings.get().categories,
    briefEnabled: () => daily.settings().briefEnabled,
    changed: (day) => ctx.broadcast('goals:changed', day),
  })

  // ---- settings ----
  ipcMain.handle('daily:settings:get', () => daily.settings())
  ipcMain.handle('daily:settings:set', (_e, patch: Partial<DailySettings>) => {
    const next = daily.updateSettings(patch ?? {})
    ctx.broadcast('daily:brief-state', brief.state())
    if (patch?.briefEnabled) void brief.runIfNeeded('app_active')
    return next
  })
  ipcMain.handle('daily:unlock', () => daily.updateSettings({ isDailyUnlocked: true }))

  // ---- standup ----
  ipcMain.handle('daily:standup:get', (_e, day: string) => recap.view(assertDay(day)))
  ipcMain.handle('daily:standup:regenerate', (_e, day: string) => recap.regenerate(assertDay(day)))
  ipcMain.handle('daily:standup:cancel', (_e, day: string) => recap.cancel(assertDay(day)))
  ipcMain.handle('daily:standup:edit', (_e, day: string, draft: DailyStandupDraft) => recap.edit(assertDay(day), draft))
  ipcMain.handle('daily:standup:copy', (_e, day: string, draft?: DailyStandupDraft) => {
    const view = recap.view(assertDay(day))
    const text = standupClipboardText(draft ?? view.draft, view.titles)
    clipboard.writeText(text)
    return text
  })

  // ---- brief ----
  ipcMain.handle('daily:brief:get', () => brief.state())
  ipcMain.handle('daily:brief:generate', () => {
    void brief.retry()
    return brief.state()
  })
  ipcMain.handle('daily:brief:cancel', () => brief.cancel())
  ipcMain.handle('daily:brief:shown', (_e, day: string | null) => brief.setOnScreen(day ? assertDay(day) : null))
  ipcMain.handle('daily:brief:action', (_e, day: string, action: BriefAction) => brief.action(assertDay(day), action))
  ipcMain.handle('daily:brief:feedback', (_e, day: string, section: BriefSectionKey, title: string, action: FeedbackAction) =>
    brief.action(assertDay(day), { type: 'feedback', section, title, action }),
  )
  ipcMain.handle('daily:brief:image', (_e, day: string, rel: string) => dataUrl(files.imagePath(assertDay(day), String(rel))))
  ipcMain.handle('daily:brief:transcript', (_e, day: string, part: BriefPart) =>
    files.readTranscript(assertDay(day), part === 'docket' ? 'docket' : 'extras'),
  )
  ipcMain.handle('daily:brief:refreshRuns', (_e, day: string) => brief.refreshRuns(assertDay(day)))
  ipcMain.handle('daily:brief:pickFolder', () => brief.pickFolder())
  ipcMain.handle('daily:brief:recentFolders', () => brief.recentFolders())
  ipcMain.handle('daily:brief:completed', () => brief.completedHistory())
  ipcMain.handle('daily:brief:summary', (_e, range: SummaryRange) => files.summary(assertRange(range)))
  ipcMain.handle('daily:brief:summarize', (_e, range: SummaryRange) => brief.summarize(assertRange(range)))
  ipcMain.handle('daily:brief:defaultPrompt', (_e, part: BriefPart) => brief.defaultPrompt(part === 'docket' ? 'docket' : 'extras'))
  ipcMain.handle('daily:brief:saved', () => files.saved())
  ipcMain.handle('daily:brief:savedImage', (_e, file: string) => dataUrl(files.savedImagePath(String(file))))

  // ---- goals ----
  ipcMain.handle('goals:get', (_e, day: string) => goals.plan(assertDay(day)))
  ipcMain.handle('goals:set', (_e, plan: DayGoalPlan) => goals.save({ ...plan, day: assertDay(plan?.day) }))
  ipcMain.handle('goals:skip', (_e, day: string) => goals.skip(assertDay(day)))
  ipcMain.handle('goals:progress', (_e, day: string) => goals.progress(assertDay(day)))
  ipcMain.handle(
    'goals:reference',
    (_e, day: string, focus: DayGoalCategorySnapshot[], distraction: DayGoalCategorySnapshot[]) =>
      goals.reference(assertDay(day), focus ?? [], distraction ?? []),
  )
  ipcMain.handle('goals:prompt', (_e, day: string) => goals.promptState(assertDay(day), daily.settings().showDailyGoalPopups))
  ipcMain.handle('goals:promptHandled', (_e, day: string) => goals.markHandled(assertDay(day)))
  ipcMain.handle('goals:reviewShown', (_e, day: string) => goals.markReviewShown(assertDay(day)))

  // ---- scheduler (3a.1, 3b.1) ----
  // One recap check at startup, then every 5 minutes. The source-day activity threshold is unified
  // at 120 minutes for both the scheduler and the Daily view (macOS used 180 for the scheduler).
  const tick = (trigger: 'launch' | 'timer') => {
    void recap.schedulerCheck().catch((err) => console.error('[daily] recap check failed', err))
    void brief.runIfNeeded(trigger).catch((err) => console.error('[daily] brief check failed', err))
  }
  setTimeout(() => tick('launch'), 15_000)
  setInterval(() => tick('timer'), CHECK_INTERVAL_MS)
  let lastActive = 0
  app.on('browser-window-focus', () => {
    if (Date.now() - lastActive < 60_000) return
    lastActive = Date.now()
    void brief.runIfNeeded('app_active').catch((err) => console.error('[daily] brief check failed', err))
  })
}
