// Timeline review (ratings) and app notifications: IPC channels (review:*).
// Logic in src/main/review/.

import { app, ipcMain } from 'electron'
import type { FeatureContext } from './context.ts'
import type { NotificationSettings } from '../../shared/review-types.ts'
import { ReviewService } from '../review/service.ts'
import { isRating } from '../review/ratings.ts'
import { Notifier } from '../review/notifications.ts'

export function register(ctx: FeatureContext): void {
  const svc = new ReviewService(ctx.store, ctx.dataDir)
  const day = (v: unknown) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Invalid day')
    return v
  }
  const num = (v: unknown) => {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error('Invalid timestamp')
    return Math.floor(n)
  }

  ipcMain.handle('review:day', (_e, d: unknown) => svc.dayData(day(d)))
  ipcMain.handle('review:summary', (_e, d: unknown) => svc.summary(day(d)))
  ipcMain.handle('review:promptCount', (_e, d: unknown) => svc.promptCount(day(d)))
  ipcMain.handle('review:rate', (_e, d: unknown, startTs: unknown, endTs: unknown, rating: unknown) => {
    if (!isRating(rating)) throw new Error('Invalid rating')
    const summary = svc.rate(day(d), num(startTs), num(endTs), rating)
    ctx.broadcast('review:changed', summary)
    return summary
  })

  const notifier = new Notifier(ctx.store, ctx.dataDir)
  notifier.start()
  ipcMain.handle('review:notificationSettings', () => notifier.settings())
  ipcMain.handle('review:setNotificationSettings', (_e, patch: Partial<NotificationSettings>) => notifier.setSettings(patch ?? {}))
  app.on('before-quit', () => notifier.stop())
}
