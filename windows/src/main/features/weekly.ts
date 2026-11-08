// Weekly review page: IPC channels (weekly:*). The computation lives in weekly-builder.ts.

import { BrowserWindow, Notification, app, dialog, ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeatureContext } from './context.ts'
import type { WeeklyAccessState, WeeklyDashboardSnapshot, WeeklyPageData } from '../../shared/weekly-types.ts'
import { WEEKLY_RECORDED_MINUTES_GATE } from '../../shared/weekly-types.ts'
import {
  accessProgress,
  buildDashboard,
  buildPreviewDashboard,
  shiftWeek,
  toUnix,
  weekContaining,
  weekFromDay,
  ymd,
  type WeekRange,
} from './weekly-builder.ts'

interface WeeklyState {
  /** Hidden flag that forces the locked view (weeklyAccessManuallyLocked in the macOS app) */
  manuallyLocked?: boolean
}

export function register(ctx: FeatureContext): void {
  const stateFile = join(ctx.dataDir, 'weekly-state.json')
  const readState = (): WeeklyState => {
    try {
      return existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as WeeklyState) : {}
    } catch {
      return {}
    }
  }

  const completedBatchCount = (): number => {
    const r = ctx.store.db
      .prepare("SELECT COUNT(*) AS n FROM analysis_batches WHERE status IN ('completed','analyzed')")
      .get() as { n: number }
    return Number(r.n)
  }

  const recordedMinutes = (range: WeekRange): number => {
    const r = ctx.store.db
      .prepare(
        `SELECT COALESCE(SUM(end_ts - start_ts), 0) AS s FROM timeline_cards
         WHERE start_ts >= ? AND start_ts < ? AND is_deleted = 0 AND category != 'System'`,
      )
      .get(toUnix(range.start), toUnix(range.end)) as { s: number }
    return Math.floor(Number(r.s) / 60)
  }

  let notifyTimer: ReturnType<typeof setInterval> | null = null

  const access = (): WeeklyAccessState => {
    const p = accessProgress(completedBatchCount(), Math.floor(Date.now() / 1000))
    const manuallyLocked = !!readState().manuallyLocked
    return { ...p, manuallyLocked, unlocked: p.isComplete && !manuallyLocked, notificationScheduled: notifyTimer !== null }
  }

  ipcMain.handle('weekly:access', (): WeeklyAccessState => access())

  ipcMain.handle('weekly:setManualLock', (_e, locked: unknown): WeeklyAccessState => {
    const s = readState()
    s.manuallyLocked = !!locked
    writeFileSync(stateFile, JSON.stringify(s, null, 2))
    return access()
  })

  /** Newest week (within 52) with >= 15 h, else newest with any data, else the current week. */
  ipcMain.handle('weekly:defaultWeek', (): string => {
    const current = weekContaining(new Date())
    let firstWithData: WeekRange | null = null
    for (let i = 0; i < 52; i++) {
      const w = shiftWeek(current, -i)
      const m = recordedMinutes(w)
      if (m >= WEEKLY_RECORDED_MINUTES_GATE) return ymd(w.start)
      if (m > 0 && !firstWithData) firstWithData = w
    }
    return ymd((firstWithData ?? current).start)
  })

  ipcMain.handle('weekly:snapshot', (_e, weekStartDay?: unknown): WeeklyPageData => {
    const range = typeof weekStartDay === 'string' && weekStartDay ? weekFromDay(weekStartDay) : weekContaining(new Date())
    const prev = shiftWeek(range, -1)
    const categories = ctx.settings.get().categories
    const cards = ctx.store.cardsInRange(toUnix(range.start), toUnix(range.end))
    const prevCards = ctx.store.cardsInRange(toUnix(prev.start), toUnix(prev.end))
    const locale = app.getLocale() || undefined
    return {
      weekStart: toUnix(range.start),
      weekEnd: toUnix(range.end),
      weekStartDay: ymd(range.start),
      canNavigateForward: range.start.getTime() < weekContaining(new Date()).start.getTime(),
      recordedMinutes: recordedMinutes(range),
      snapshot: buildDashboard(cards, prevCards, categories, range, locale),
    }
  })

  let preview: WeeklyDashboardSnapshot | null = null
  ipcMain.handle('weekly:preview', (): WeeklyDashboardSnapshot => (preview ??= buildPreviewDashboard(app.getLocale() || undefined)))

  /**
   * Notifies once Weekly unlocks. Polls the batch count every 5 minutes (in memory; lost on restart).
   * Returns 'scheduled' | 'unsupported' | 'ready'.
   */
  ipcMain.handle('weekly:notifyWhenReady', (): 'scheduled' | 'unsupported' | 'ready' => {
    if (!Notification.isSupported()) return 'unsupported'
    if (access().isComplete) return 'ready'
    if (notifyTimer) return 'scheduled'
    notifyTimer = setInterval(() => {
      if (!access().isComplete) return
      if (notifyTimer) clearInterval(notifyTimer)
      notifyTimer = null
      new Notification({ title: 'Weekly is ready', body: 'Your weekly review in Dayflow is unlocked.' }).show()
    }, 5 * 60_000)
    return 'scheduled'
  })

  /**
   * Captures a region of the sender's page (CSS pixels) and asks where to save it as PNG.
   * Returns the saved path, or null when cancelled.
   */
  ipcMain.handle('weekly:savePng', async (e, defaultName: unknown, rect: unknown): Promise<string | null> => {
    const r = rect as Record<string, unknown> | null
    const fields = ['x', 'y', 'width', 'height'] as const
    if (!r || typeof r !== 'object' || fields.some((k) => typeof r[k] !== 'number' || !Number.isFinite(r[k] as number))) {
      throw new Error('Invalid capture area')
    }
    const rr = r as { x: number; y: number; width: number; height: number }
    const area = {
      x: Math.max(0, Math.floor(rr.x)),
      y: Math.max(0, Math.floor(rr.y)),
      width: Math.min(10_000, Math.max(1, Math.ceil(rr.width))),
      height: Math.min(10_000, Math.max(1, Math.ceil(rr.height))),
    }
    const image = await e.sender.capturePage(area)
    const win = BrowserWindow.fromWebContents(e.sender)
    // Only a file name is accepted; the folder is always Downloads (the dialog lets the user change it).
    const cleaned = typeof defaultName === 'string' ? defaultName.replace(/[\\/:*?"<>|]/g, '').slice(0, 120) : ''
    const name = cleaned.toLowerCase().endsWith('.png') ? cleaned : 'dayflow-weekly.png'
    const opts = { defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'PNG image', extensions: ['png'] }] }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, image.toPNG())
    return res.filePath
  })
}
