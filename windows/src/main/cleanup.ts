// Storage cleanup, like StorageManager+Maintenance.swift: drop frames past the retention
// period, then purge the oldest frames until the total is under the disk budget.

import { readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from './db.ts'
import type { SettingsStore } from './settings.ts'

async function deleteFiles(store: Store, rows: { id: number; filePath: string; fileSize: number }[]): Promise<void> {
  for (const r of rows) await unlink(r.filePath).catch(() => {})
  store.markScreenshotsDeleted(rows)
}

export async function runCleanup(store: Store, settings: SettingsStore, recordingsDir: string): Promise<void> {
  const cfg = settings.get()
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, cfg.retentionDays) * 86400
  for (;;) {
    const old = store.screenshotsOlderThan(cutoff, 500)
    if (old.length === 0) break
    await deleteFiles(store, old)
  }
  const budget = Math.max(0.5, cfg.storageLimitGB) * 1024 ** 3
  let total = store.totalScreenshotBytes()
  while (total > budget) {
    // Never purge frames still waiting for analysis (pending batches or the last 24 h).
    const oldest = store.purgeableScreenshots(Math.floor(Date.now() / 1000) - 24 * 3600, 200)
    if (oldest.length === 0) break
    await deleteFiles(store, oldest)
    total -= oldest.reduce((s, r) => s + r.fileSize, 0)
  }
  store.pruneCallLog(14)
  // Remove empty day folders.
  try {
    for (const d of await readdir(recordingsDir)) {
      const p = join(recordingsDir, d)
      const entries = await readdir(p).catch(() => null)
      if (entries && entries.length === 0) await rmdir(p).catch(() => {})
    }
  } catch {
    /* folder may not exist yet */
  }
}
