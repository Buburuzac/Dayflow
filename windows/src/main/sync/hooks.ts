// Tiny bridge so stores outside db.ts (Daily standups/day goals, settings categories) can report
// local writes to the sync module without depending on it. The sync feature installs `record`;
// while remote changes are being applied `muted` is set so they are not echoed back.

export type DocEntity = 'standup' | 'day_goal' | 'user_doc'

export const syncHooks: {
  record: ((entity: DocEntity, id: string) => void) | null
  muted: boolean
} = { record: null, muted: false }

export function notifySync(entity: DocEntity, id: string): void {
  if (syncHooks.muted || !syncHooks.record) return
  try {
    syncHooks.record(entity, id)
  } catch (err) {
    console.error('[sync] could not record change', err)
  }
}

/** Runs `fn` without recording its writes (used when applying pulled changes). */
export function withSyncMuted<T>(fn: () => T): T {
  const prev = syncHooks.muted
  syncHooks.muted = true
  try {
    return fn()
  } finally {
    syncHooks.muted = prev
  }
}
