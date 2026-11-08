// Minimal NotificationService (spec D.1) using Electron's Notification (the AppUserModelID is
// set in index.ts): first cards / today's timeline is ready, and debounced batch failures.
// Polls the database every minute, so it needs no hooks in the analysis pipeline.

import { Notification } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NotificationSettings } from '../../shared/review-types.ts'
import type { Store } from '../db.ts'
import { dayRange, logicalDay } from '../time.ts'
import { showMainWindow } from '../flow/app-windows.ts'
import { DEFAULT_NOTIFICATION_SETTINGS, planNotifications, type NotifyState } from './notify-plan.ts'

const POLL_MS = 60_000

export class Notifier {
  private readonly store: Store
  private readonly file: string
  private state: NotifyState
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(store: Store, dataDir: string) {
    this.store = store
    this.file = join(dataDir, 'notifications-state.json')
    this.state = this.read()
    // First run: don't report history (old failures, or today's cards that already exist).
    const now = Math.floor(Date.now() / 1000)
    if (this.state.lastFailedBatchId == null) this.state.lastFailedBatchId = this.maxFailedId()
    if (this.state.lastTimelineReadyDay == null && this.todayCards(now) > 0) this.state.lastTimelineReadyDay = logicalDay(now)
    if (this.state.firstCardsNotified == null) this.state.firstCardsNotified = this.anyCards()
    this.write()
  }

  settings(): NotificationSettings {
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(this.state.settings ?? {}) }
  }

  setSettings(patch: Partial<NotificationSettings>): NotificationSettings {
    const cur = this.settings()
    this.state.settings = {
      timelineReady: typeof patch.timelineReady === 'boolean' ? patch.timelineReady : cur.timelineReady,
      batchFailures: typeof patch.batchFailures === 'boolean' ? patch.batchFailures : cur.batchFailures,
    }
    this.write()
    return this.settings()
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  poll(): void {
    try {
      const now = Math.floor(Date.now() / 1000)
      const failedIds = (
        this.store.db
          .prepare("SELECT id FROM analysis_batches WHERE status = 'failed' AND id > ? ORDER BY id")
          .all(this.state.lastFailedBatchId ?? 0) as Array<{ id: number }>
      ).map((r) => Number(r.id))
      const { notes, next } = planNotifications(
        this.state,
        { today: logicalDay(now), todayCards: this.todayCards(now), anyCardsEver: this.anyCards(), failedIds, now },
        this.settings(),
      )
      this.state = next
      this.write()
      for (const n of notes) {
        if (n.kind === 'firstCards') {
          this.show(
            'Your first Dayflow cards are ready',
            'Take a look at what Dayflow picked up from your last few minutes of work.',
          )
        } else if (n.kind === 'timelineReady') {
          this.show("Today's timeline is ready", 'Dayflow turned the start of your day into timeline cards.')
        } else {
          this.show(
            n.count === 1 ? "Dayflow couldn't analyze a batch" : `Dayflow couldn't analyze ${n.count} batches`,
            'Open Dayflow to see the error and retry.',
          )
        }
      }
    } catch (err) {
      console.error('[notifications] poll failed', err)
    }
  }

  private show(title: string, body: string): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    n.on('click', () => showMainWindow('timeline'))
    n.show()
  }

  private todayCards(now: number): number {
    const { start, end } = dayRange(logicalDay(now))
    const r = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM timeline_cards WHERE is_deleted = 0 AND start_ts >= ? AND start_ts < ? AND LOWER(category) != 'system'",
      )
      .get(start, end) as { n: number }
    return Number(r.n)
  }

  private anyCards(): boolean {
    return (
      this.store.db.prepare("SELECT 1 FROM timeline_cards WHERE is_deleted = 0 AND LOWER(category) != 'system' LIMIT 1").get() !==
      undefined
    )
  }

  private maxFailedId(): number {
    const r = this.store.db.prepare("SELECT MAX(id) AS m FROM analysis_batches WHERE status = 'failed'").get() as { m: number | null }
    return Number(r.m ?? 0)
  }

  private read(): NotifyState {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as NotifyState) : {}
    } catch {
      return {}
    }
  }

  private write(): void {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[notifications] could not save state', err)
    }
  }
}
