// Pure notification planning (what to notify about after a poll). No Electron imports.

import type { NotificationSettings } from '../../shared/review-types.ts'

export const FAILURE_DEBOUNCE_SECONDS = 30 * 60
export interface NotifyState {
  settings?: Partial<NotificationSettings>
  firstCardsNotified?: boolean
  lastTimelineReadyDay?: string
  lastFailedBatchId?: number
  lastFailureNotifiedAt?: number
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { timelineReady: true, batchFailures: true }

/** What to notify about, given the poll's observations. Pure, for tests. */
export function planNotifications(
  s: NotifyState,
  obs: { today: string; todayCards: number; anyCardsEver: boolean; failedIds: number[]; now: number },
  settings: NotificationSettings,
): { notes: Array<{ kind: 'firstCards' | 'timelineReady' | 'failures'; count?: number }>; next: NotifyState } {
  const next: NotifyState = { ...s }
  const notes: Array<{ kind: 'firstCards' | 'timelineReady' | 'failures'; count?: number }> = []
  if (obs.todayCards > 0 && s.lastTimelineReadyDay !== obs.today) {
    next.lastTimelineReadyDay = obs.today
    if (settings.timelineReady) notes.push({ kind: s.firstCardsNotified ? 'timelineReady' : 'firstCards' })
    next.firstCardsNotified = true
  } else if (obs.anyCardsEver && !s.firstCardsNotified) {
    next.firstCardsNotified = true
  }
  const fresh = obs.failedIds.filter((id) => id > (s.lastFailedBatchId ?? 0))
  if (fresh.length) {
    const since = obs.now - (s.lastFailureNotifiedAt ?? 0)
    if (!settings.batchFailures) next.lastFailedBatchId = Math.max(...fresh)
    else if (since >= FAILURE_DEBOUNCE_SECONDS) {
      notes.push({ kind: 'failures', count: fresh.length })
      next.lastFailedBatchId = Math.max(...fresh)
      next.lastFailureNotifiedAt = obs.now
    }
    // Inside the debounce window the ids stay pending and are reported together later.
  }
  return { notes, next }
}
