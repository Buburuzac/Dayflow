// SQLite storage using Node's built-in node:sqlite (bundled with Electron 45 / Node 24),
// so there is no native module to rebuild. Schema follows StorageManager.swift, trimmed to
// the tables the Windows port uses.

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { BatchInfo, DetailProjectRef, ScreenshotInfo, TimelineCard } from '../shared/types.ts'
import { Hlc, formatHlc, parseHlc } from '../shared/sync-types.ts'
import type { SyncEntity } from '../shared/sync-types.ts'
import { DEFAULT_SYNC_SERVER_URL } from '../shared/sync-ui.ts'
import { DEFAULT_SYNC_POLICY, type SyncPolicy } from './sync/scope.ts'
import type { ActivityCardData, LLMCallLog, Observation } from './llm/types.ts'
import { formatClock, logicalDay, dayRange, resolveCardRange } from './time.ts'

/** A card the analysis just inserted, with the model output it came from (for project assignment). */
export interface InsertedCard {
  id: number
  uuid: string
  startTs: number
  endTs: number
  card: ActivityCardData
  /** A manual project assignment was carried over from the card this one replaced. */
  inheritedManual: boolean
}

/** User-editable card fields that merge per field across devices (sync-server-design.md). */
export const CARD_USER_FIELDS = ['title', 'category', 'subcategory', 'deleted', 'private', 'detailProjects'] as const
export type CardUserField = (typeof CARD_USER_FIELDS)[number]

export function parseJsonObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || !v) return {}
  try {
    const o = JSON.parse(v) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface ScreenshotRow {
  id: number
  capturedAt: number
  filePath: string
  fileSize: number
  idleSeconds: number | null
  windowLabel: string | null
}

interface CardMetadata {
  distractions?: ActivityCardData['distractions']
  appSites?: ActivityCardData['appSites']
  isError?: boolean
  private?: boolean
  detailProjects?: Record<string, DetailProjectRef[]>
}

export const ERROR_CATEGORY = 'System'

export class Store {
  readonly db: DatabaseSync
  /** Running total of live screenshot bytes; computed once, then kept in step with inserts/purges. */
  private liveBytes: number | null = null
  /** This installation's sync device id (server-assigned after sign-in, a local uuid before). */
  deviceId = ''
  private clock: Hlc = new Hlc('pending')
  private lastHlc = ''
  /** When false (not signed in to a sync server) nothing is queued in the outbox. */
  syncEnabled = false
  /** What may leave this PC (Settings → Sync & team); applied when changes are built for upload. */
  syncPolicy: SyncPolicy = { ...DEFAULT_SYNC_POLICY }
  /** Called after something was queued in the outbox (the sync engine debounces a push). */
  onOutbox: (() => void) | null = null
  /**
   * Something that decides card scopes changed (policy, projects, assignments, a private/category
   * edit): the next rescope re-checks every card sent before, not just the recent window.
   */
  scopeDirty = true

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
    this.migrateSync()
  }

  // ---- Sync bookkeeping ----

  /** Next HLC for a local write. */
  tick(): string {
    this.lastHlc = this.clock.tick()
    return this.lastHlc
  }

  /** Advances the local clock past a remote HLC (pulled changes, server time). */
  observeHlc(remote: string): void {
    this.clock.observe(remote)
  }

  /** SQL predicate for rows that belong to this device (legacy rows have no device_id). */
  private get localSql(): string {
    return '(device_id IS NULL OR device_id = ?)'
  }

  /**
   * Adopts the server-assigned device id: rows written under the provisional id are re-labelled
   * so they stay "this device's" rows. HLC suffixes are rewritten when changes are built.
   */
  setDeviceId(id: string): void {
    if (!id || id === this.deviceId) return
    const old = this.deviceId
    this.transaction(() => {
      this.db.prepare('UPDATE timeline_cards SET device_id = ? WHERE device_id = ? OR device_id IS NULL').run(id, old)
      this.db.prepare('UPDATE observations SET device_id = ? WHERE device_id = ? OR device_id IS NULL').run(id, old)
      this.db.prepare('UPDATE sync_state SET device_id = ? WHERE id = 1').run(id)
    })
    this.deviceId = id
    const prev = this.lastHlc
    this.clock = new Hlc(id)
    if (prev) this.clock.observe(prev)
  }

  setSyncEnabled(on: boolean): void {
    this.syncEnabled = on
    this.db.prepare('UPDATE sync_state SET enabled = ? WHERE id = 1').run(on ? 1 : 0)
  }

  /** Queues a change for upload; `payload` is kept for rows that no longer exist (tombstones). */
  enqueue(entity: SyncEntity, entityId: string, payload: string | null = null): void {
    if (!this.syncEnabled || !entityId) return
    this.db
      .prepare(
        `INSERT INTO outbox (entity, entity_id, payload, queued_at, rev) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(entity, entity_id) DO UPDATE SET payload = excluded.payload, queued_at = excluded.queued_at,
           rev = outbox.rev + 1, attempts = 0, last_error = NULL`,
      )
      .run(entity, entityId, payload, Date.now())
    this.onOutbox?.()
  }

  private migrateSync(): void {
    const columns = (t: string) =>
      this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[]
    const addMissing = (t: string, cols: [string, string][]) => {
      const have = new Set(columns(t).map((c) => c.name))
      for (const [c, def] of cols) if (!have.has(c)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`)
    }
    addMissing('timeline_cards', [
      ['uuid', 'TEXT'],
      ['hlc', 'TEXT'],
      ['field_hlc', 'TEXT'],
      ['device_id', 'TEXT'],
      // What the server last received for this card (sync/scope.ts) and the clock of that change.
      ['sync_scope', 'TEXT'],
      ['scope_hlc', 'TEXT'],
    ])
    // Observations pulled from other devices have no local batch, so batch_id must be nullable.
    // Older installs created it NOT NULL: rebuild the table once (nothing references it).
    if (columns('observations').find((c) => c.name === 'batch_id')?.notnull) {
      addMissing('observations', [
        ['uuid', 'TEXT'],
        ['hlc', 'TEXT'],
        ['device_id', 'TEXT'],
      ])
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE observations_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
            start_ts INTEGER NOT NULL,
            end_ts INTEGER NOT NULL,
            observation TEXT NOT NULL,
            metadata TEXT,
            llm_model TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            uuid TEXT,
            hlc TEXT,
            device_id TEXT
          );
          INSERT INTO observations_new (id, batch_id, start_ts, end_ts, observation, metadata, llm_model, created_at, uuid, hlc, device_id)
            SELECT id, batch_id, start_ts, end_ts, observation, metadata, llm_model, created_at, uuid, hlc, device_id FROM observations;
          DROP TABLE observations;
          ALTER TABLE observations_new RENAME TO observations;
          CREATE INDEX IF NOT EXISTS idx_observations_time_range ON observations(start_ts, end_ts);
        `)
      })
    }
    addMissing('observations', [
      ['uuid', 'TEXT'],
      ['hlc', 'TEXT'],
      ['device_id', 'TEXT'],
      // 1 once the server has accepted this observation, 0 after its tombstone was accepted.
      ['uploaded', 'INTEGER'],
    ])

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        device_id TEXT NOT NULL,
        device_name TEXT,
        server_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        user_id TEXT,
        user_json TEXT,
        workspaces_json TEXT,
        cursor INTEGER NOT NULL DEFAULT 0,
        last_push_at INTEGER,
        last_pull_at INTEGER,
        last_sync_at INTEGER,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT,
        queued_at INTEGER NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        UNIQUE (entity, entity_id)
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#7BC47F',
        icon TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        rules TEXT NOT NULL DEFAULT '{}',
        default_share TEXT NOT NULL DEFAULT 'time',
        odoo TEXT NOT NULL DEFAULT '{}',
        archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        hlc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        share_level TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        hlc TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS card_projects (
        card_uuid TEXT NOT NULL,
        project_id TEXT NOT NULL,
        share REAL NOT NULL DEFAULT 1,
        source TEXT NOT NULL CHECK (source IN ('manual', 'rule', 'llm')),
        confidence REAL NOT NULL DEFAULT 1,
        confirmed INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        hlc TEXT NOT NULL,
        PRIMARY KEY (card_uuid, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_card_projects_project ON card_projects(project_id) WHERE deleted = 0;

      -- HLCs of synced records that live in other tables (standups, day goals, user docs).
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        hlc TEXT NOT NULL
      );

      -- "Reprocess day": user choices (private flag, manual projects) of the removed cards, keyed by
      -- time range, re-applied to the regenerated cards that mostly overlap them.
      CREATE TABLE IF NOT EXISTS card_carryover (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        private INTEGER NOT NULL DEFAULT 0,
        projects TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
    `)

    addMissing('projects', [['icon', "TEXT NOT NULL DEFAULT ''"]])

    let state = this.db.prepare('SELECT device_id, enabled FROM sync_state WHERE id = 1').get() as
      | { device_id: string; enabled: number }
      | undefined
    if (!state) {
      this.db
        .prepare('INSERT INTO sync_state (id, device_id, server_url) VALUES (1, ?, ?)')
        .run(randomUUID(), DEFAULT_SYNC_SERVER_URL)
      state = this.db.prepare('SELECT device_id, enabled FROM sync_state WHERE id = 1').get() as {
        device_id: string
        enabled: number
      }
    }
    this.deviceId = state.device_id
    this.syncEnabled = Number(state.enabled) === 1
    this.clock = new Hlc(this.deviceId)

    // Stable ids for rows written before sync existed. Their HLC is their start time, so any
    // later edit (here or on another device) wins over them.
    const legacyCards = this.db.prepare('SELECT id, start_ts FROM timeline_cards WHERE uuid IS NULL').all() as {
      id: number
      start_ts: number | null
    }[]
    const legacyObs = this.db.prepare('SELECT id, start_ts FROM observations WHERE uuid IS NULL').all() as {
      id: number
      start_ts: number
    }[]
    if (legacyCards.length || legacyObs.length) {
      this.transaction(() => {
        const uc = this.db.prepare(
          "UPDATE timeline_cards SET uuid = ?, hlc = ?, field_hlc = COALESCE(field_hlc, '{}'), device_id = COALESCE(device_id, ?) WHERE id = ?",
        )
        for (const r of legacyCards) uc.run(randomUUID(), formatHlc(Number(r.start_ts ?? 0) * 1000, 0, this.deviceId), this.deviceId, r.id)
        const uo = this.db.prepare('UPDATE observations SET uuid = ?, hlc = ?, device_id = COALESCE(device_id, ?) WHERE id = ?')
        for (const r of legacyObs) uo.run(randomUUID(), formatHlc(Number(r.start_ts) * 1000, 0, this.deviceId), this.deviceId, r.id)
      })
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_cards_uuid ON timeline_cards(uuid);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_uuid ON observations(uuid);
    `)
    const maxHlc = this.db.prepare('SELECT MAX(hlc) AS h FROM timeline_cards').get() as { h: string | null }
    if (maxHlc?.h) this.clock.observe(maxHlc.h)
  }

  /** Rewrites a local row's HLC to the current device id (rows stamped before sign-in). */
  localHlc(hlc: string): string {
    const p = parseHlc(hlc)
    if (!p || p.deviceId === this.deviceId) return hlc
    return formatHlc(p.ms, p.counter, this.deviceId)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_start_ts INTEGER NOT NULL,
        batch_end_ts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        llm_metadata TEXT,
        detailed_transcription TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_batches_status ON analysis_batches(status);

      CREATE TABLE IF NOT EXISTS timeline_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        start_ts INTEGER,
        end_ts INTEGER,
        day DATE NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        category TEXT NOT NULL,
        subcategory TEXT,
        detailed_summary TEXT,
        metadata TEXT,
        video_summary_url TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_cards_day ON timeline_cards(day);
      CREATE INDEX IF NOT EXISTS idx_timeline_cards_active_start_ts ON timeline_cards(start_ts) WHERE is_deleted = 0;

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        observation TEXT NOT NULL,
        metadata TEXT,
        llm_model TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        uuid TEXT,
        hlc TEXT,
        device_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_observations_time_range ON observations(start_ts, end_ts);

      CREATE TABLE IF NOT EXISTS screenshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        idle_seconds_at_capture INTEGER,
        window_label TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at ON screenshots(captured_at);
      -- Purged rows stay as tombstones; queries over live frames use this partial index.
      CREATE INDEX IF NOT EXISTS idx_screenshots_live ON screenshots(captured_at) WHERE is_deleted = 0;

      CREATE TABLE IF NOT EXISTS batch_screenshots (
        batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
        screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE RESTRICT,
        PRIMARY KEY (batch_id, screenshot_id)
      );
      CREATE INDEX IF NOT EXISTS idx_batch_screenshots_screenshot ON batch_screenshots(screenshot_id);

      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        batch_id INTEGER NULL,
        provider TEXT NOT NULL,
        model TEXT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success','failure')),
        latency_ms INTEGER NULL,
        request_body TEXT NULL,
        response_body TEXT NULL,
        error_message TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at DESC);
    `)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ---- Screenshots ----

  insertScreenshot(capturedAt: number, filePath: string, fileSize: number, idleSeconds: number | null, windowLabel: string | null): number {
    const r = this.db
      .prepare(
        'INSERT INTO screenshots (captured_at, file_path, file_size, idle_seconds_at_capture, window_label) VALUES (?, ?, ?, ?, ?)',
      )
      .run(capturedAt, filePath, fileSize, idleSeconds, windowLabel)
    if (this.liveBytes !== null) this.liveBytes += fileSize
    return Number(r.lastInsertRowid)
  }

  private static mapShot(r: Record<string, unknown>): ScreenshotRow {
    return {
      id: Number(r.id),
      capturedAt: Number(r.captured_at),
      filePath: String(r.file_path),
      fileSize: Number(r.file_size ?? 0),
      idleSeconds: r.idle_seconds_at_capture == null ? null : Number(r.idle_seconds_at_capture),
      windowLabel: r.window_label == null ? null : String(r.window_label),
    }
  }

  /** Screenshots not yet assigned to any batch, newer than `since`. */
  unbatchedScreenshots(since: number): ScreenshotRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM screenshots s
         WHERE s.captured_at >= ? AND s.is_deleted = 0
           AND NOT EXISTS (SELECT 1 FROM batch_screenshots bs WHERE bs.screenshot_id = s.id)
         ORDER BY s.captured_at ASC`,
      )
      .all(since)
      .map((r) => Store.mapShot(r as Record<string, unknown>))
  }

  countUnbatched(since: number): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM screenshots s WHERE s.captured_at >= ? AND s.is_deleted = 0
         AND NOT EXISTS (SELECT 1 FROM batch_screenshots bs WHERE bs.screenshot_id = s.id)`,
      )
      .get(since) as { n: number }
    return Number(r.n)
  }

  screenshotsForBatch(batchId: number): ScreenshotRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM screenshots s JOIN batch_screenshots bs ON bs.screenshot_id = s.id
         WHERE bs.batch_id = ? AND s.is_deleted = 0 ORDER BY s.captured_at ASC`,
      )
      .all(batchId)
      .map((r) => Store.mapShot(r as Record<string, unknown>))
  }

  screenshotsInRange(from: number, to: number): ScreenshotInfo[] {
    return this.db
      .prepare(
        'SELECT id, captured_at, file_path FROM screenshots WHERE captured_at >= ? AND captured_at <= ? AND is_deleted = 0 ORDER BY captured_at ASC',
      )
      .all(from, to)
      .map((r) => {
        const row = r as Record<string, unknown>
        return { id: Number(row.id), capturedAt: Number(row.captured_at), filePath: String(row.file_path) }
      })
  }

  totalScreenshotBytes(): number {
    if (this.liveBytes === null) {
      const r = this.db.prepare('SELECT COALESCE(SUM(file_size), 0) AS n FROM screenshots WHERE is_deleted = 0').get() as {
        n: number
      }
      this.liveBytes = Number(r.n)
    }
    return this.liveBytes
  }

  /** Oldest live screenshots first, for purging. */
  oldestScreenshots(limit: number): ScreenshotRow[] {
    return this.db
      .prepare('SELECT * FROM screenshots WHERE is_deleted = 0 ORDER BY captured_at ASC LIMIT ?')
      .all(limit)
      .map((r) => Store.mapShot(r as Record<string, unknown>))
  }

  screenshotsOlderThan(ts: number, limit: number): ScreenshotRow[] {
    return this.db
      .prepare('SELECT * FROM screenshots WHERE is_deleted = 0 AND captured_at < ? ORDER BY captured_at ASC LIMIT ?')
      .all(ts, limit)
      .map((r) => Store.mapShot(r as Record<string, unknown>))
  }

  markScreenshotsDeleted(rows: { id: number; fileSize: number }[]): void {
    const stmt = this.db.prepare('UPDATE screenshots SET is_deleted = 1 WHERE id = ? AND is_deleted = 0')
    let freed = 0
    this.transaction(() => {
      for (const r of rows) if (Number(stmt.run(r.id).changes) > 0) freed += r.fileSize
    })
    if (this.liveBytes !== null) this.liveBytes = Math.max(0, this.liveBytes - freed)
  }

  /**
   * Oldest live screenshots that are safe to purge for the disk budget: not part of a batch that
   * is still waiting for or in analysis, and older than `before`.
   */
  purgeableScreenshots(before: number, limit: number): ScreenshotRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM screenshots s
         WHERE s.is_deleted = 0 AND s.captured_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM batch_screenshots bs JOIN analysis_batches b ON b.id = bs.batch_id
             WHERE bs.screenshot_id = s.id AND b.status IN ('pending', 'processing'))
         ORDER BY s.captured_at ASC LIMIT ?`,
      )
      .all(before, limit)
      .map((r) => Store.mapShot(r as Record<string, unknown>))
  }

  /** Live screenshots in [from, to), whether or not they already belong to a batch. */
  liveScreenshotsInRange(from: number, to: number): ScreenshotRow[] {
    return this.db
      .prepare('SELECT * FROM screenshots WHERE is_deleted = 0 AND captured_at >= ? AND captured_at < ? ORDER BY captured_at ASC')
      .all(from, to)
      .map((r) => Store.mapShot(r as Record<string, unknown>))
  }

  // ---- Batches ----

  createBatch(startTs: number, endTs: number, screenshotIds: number[]): number {
    return this.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO analysis_batches (batch_start_ts, batch_end_ts, status) VALUES (?, ?, ?)')
        .run(startTs, endTs, 'pending')
      const id = Number(r.lastInsertRowid)
      const link = this.db.prepare('INSERT INTO batch_screenshots (batch_id, screenshot_id) VALUES (?, ?)')
      for (const s of screenshotIds) link.run(id, s)
      return id
    })
  }

  getBatch(id: number): BatchInfo | null {
    const r = this.db.prepare('SELECT * FROM analysis_batches WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? Store.mapBatch(r) : null
  }

  private static mapBatch(r: Record<string, unknown>): BatchInfo {
    return {
      id: Number(r.id),
      startTs: Number(r.batch_start_ts),
      endTs: Number(r.batch_end_ts),
      status: String(r.status),
      reason: r.reason == null ? null : String(r.reason),
    }
  }

  batchesWithStatus(statuses: string[], since: number): BatchInfo[] {
    const placeholders = statuses.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT * FROM analysis_batches WHERE status IN (${placeholders}) AND batch_end_ts >= ? ORDER BY batch_start_ts ASC`,
      )
      .all(...statuses, since)
      .map((r) => Store.mapBatch(r as Record<string, unknown>))
  }

  batchesInRange(from: number, to: number): BatchInfo[] {
    return this.db
      .prepare('SELECT * FROM analysis_batches WHERE batch_start_ts < ? AND batch_end_ts > ? ORDER BY batch_start_ts ASC')
      .all(to, from)
      .map((r) => Store.mapBatch(r as Record<string, unknown>))
  }

  updateBatch(id: number, status: string, reason: string | null = null): void {
    this.db.prepare('UPDATE analysis_batches SET status = ?, reason = ? WHERE id = ?').run(status, reason, id)
  }

  /** Marks batches left "processing" by a crash as pending again. */
  resetInterruptedBatches(): void {
    this.db.prepare("UPDATE analysis_batches SET status = 'pending' WHERE status = 'processing'").run()
  }

  // ---- Observations ----

  saveObservations(batchId: number, obs: Observation[], model: string | null): void {
    const stmt = this.db.prepare(
      'INSERT INTO observations (batch_id, start_ts, end_ts, observation, llm_model, uuid, hlc, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.transaction(() => {
      this.deleteBatchObservations(batchId)
      for (const o of obs) {
        const uuid = randomUUID()
        stmt.run(batchId, o.startTs, o.endTs, o.observation, model, uuid, this.tick(), this.deviceId)
        this.enqueue('observation', uuid)
      }
    })
  }

  /** Deletes a batch's observations, queueing tombstones for the ones other devices have. */
  private deleteBatchObservations(batchId: number): void {
    const old = this.db.prepare('SELECT uuid FROM observations WHERE batch_id = ? AND uuid IS NOT NULL').all(batchId) as {
      uuid: string
    }[]
    this.db.prepare('DELETE FROM observations WHERE batch_id = ?').run(batchId)
    for (const r of old) this.enqueue('observation', r.uuid, JSON.stringify({ deleted: true, hlc: this.tick() }))
  }

  /** This device's observations only: they are the analysis input, other devices' are not. */
  observationsInRange(from: number, to: number): Observation[] {
    return this.db
      .prepare(
        `SELECT start_ts, end_ts, observation FROM observations WHERE end_ts > ? AND start_ts < ? AND ${this.localSql} ORDER BY start_ts ASC`,
      )
      .all(from, to, this.deviceId)
      .map((r) => {
        const row = r as Record<string, unknown>
        return { startTs: Number(row.start_ts), endTs: Number(row.end_ts), observation: String(row.observation) }
      })
  }

  // ---- Timeline cards ----

  private static mapCard(r: Record<string, unknown>, localDevice: string): TimelineCard {
    let meta: CardMetadata = {}
    try {
      meta = r.metadata ? (JSON.parse(String(r.metadata)) as CardMetadata) : {}
    } catch {
      /* ignore */
    }
    const deviceId = r.device_id == null ? null : String(r.device_id)
    const remote = deviceId !== null && deviceId !== localDevice
    const startTs = Number(r.start_ts)
    const endTs = Number(r.end_ts)
    return {
      id: Number(r.id),
      batchId: r.batch_id == null ? null : Number(r.batch_id),
      startTs,
      endTs,
      startTime: remote ? formatClock(startTs) : String(r.start),
      endTime: remote ? formatClock(endTs) : String(r.end),
      day: remote ? logicalDay(startTs) : String(r.day),
      title: String(r.title),
      summary: String(r.summary ?? ''),
      detailedSummary: String(r.detailed_summary ?? ''),
      category: String(r.category),
      subcategory: String(r.subcategory ?? ''),
      distractions: meta.distractions ?? [],
      appSites: meta.appSites ?? null,
      isError: Boolean(meta.isError) || r.category === ERROR_CATEGORY,
      uuid: r.uuid == null ? undefined : String(r.uuid),
      deviceId,
      remote,
      private: meta.private === true,
      detailProjects: meta.detailProjects,
    }
  }

  private mapCards(rows: unknown[]): TimelineCard[] {
    return rows.map((r) => Store.mapCard(r as Record<string, unknown>, this.deviceId))
  }

  /** Cards for the day. Timeline can restrict this to the current device. */
  cardsForDay(day: string, localOnly = false): TimelineCard[] {
    const { start, end } = dayRange(day)
    const local = localOnly ? ` AND ${this.localSql}` : ''
    return this.mapCards(
      this.db
        .prepare(`SELECT * FROM timeline_cards WHERE is_deleted = 0 AND start_ts >= ? AND start_ts < ?${local} ORDER BY start_ts ASC`)
        .all(...(localOnly ? [start, end, this.deviceId] : [start, end])),
    )
  }

  /** Cards overlapping [from, to); `localOnly` restricts to this device's cards (analysis input). */
  cardsInRange(from: number, to: number, localOnly = false): TimelineCard[] {
    const local = localOnly ? ` AND ${this.localSql}` : ''
    const params: (number | string)[] = [to, from, from, to]
    if (localOnly) params.push(this.deviceId)
    return this.mapCards(
      this.db
        .prepare(
          `SELECT * FROM timeline_cards WHERE is_deleted = 0
           AND ((start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?))${local}
           ORDER BY start_ts ASC`,
        )
        .all(...params),
    )
  }

  getCard(id: number): TimelineCard | null {
    const r = this.db.prepare('SELECT * FROM timeline_cards WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? Store.mapCard(r, this.deviceId) : null
  }

  getCardByUuid(uuid: string): TimelineCard | null {
    const r = this.db.prepare('SELECT * FROM timeline_cards WHERE uuid = ?').get(uuid) as Record<string, unknown> | undefined
    return r ? Store.mapCard(r, this.deviceId) : null
  }

  /** True when a live non-error card of this device ends within `maxGap` seconds before `ts`. */
  hasCardEndingNear(ts: number, maxGap: number): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 FROM timeline_cards WHERE is_deleted = 0 AND category != ? AND end_ts >= ? AND end_ts <= ? AND ${this.localSql} LIMIT 1`,
      )
      .get(ERROR_CATEGORY, ts - maxGap, ts + 60, this.deviceId)
    return r !== undefined
  }

  /** Queues a card for upload unless it is an error card (those never leave the device). */
  private enqueueCard(uuid: unknown, category: unknown, metadata: unknown): void {
    if (typeof uuid !== 'string' || !uuid) return
    if (category === ERROR_CATEGORY || parseJsonObject(metadata).isError === true) return
    this.enqueue('card', uuid)
  }

  /**
   * Soft-deletes cards overlapping [from, to) and inserts the new ones.
   * Error cards from other batches survive, as in StorageManager.replaceTimelineCardsInRange.
   * Only this device's cards are replaced: cards pulled from other devices are shown, never rewritten.
   */
  replaceCardsInRange(from: number, to: number, cards: ActivityCardData[], batchId: number, isError = false): number[] {
    return this.replaceCardsDetailed(from, to, cards, batchId, isError).map((c) => c.id)
  }

  replaceCardsDetailed(from: number, to: number, cards: ActivityCardData[], batchId: number, isError = false): InsertedCard[] {
    const anchor = Math.floor((from + to) / 2)
    return this.transaction(() => {
      const old = this.db
        .prepare(
          `SELECT id, uuid, start_ts, end_ts, category, metadata, field_hlc FROM timeline_cards
           WHERE ((start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?))
             AND is_deleted = 0 AND (category != ? OR batch_id = ?) AND ${this.localSql}`,
        )
        .all(to, from, from, to, ERROR_CATEGORY, batchId, this.deviceId) as Record<string, unknown>[]
      const del = this.db.prepare('UPDATE timeline_cards SET is_deleted = 1, field_hlc = ? WHERE id = ?')
      for (const o of old) {
        const h = this.tick()
        const fh = parseJsonObject(o.field_hlc)
        fh.deleted = h
        del.run(JSON.stringify(fh), Number(o.id))
        this.enqueueCard(o.uuid, o.category, o.metadata)
      }
      const insert = this.db.prepare(
        `INSERT INTO timeline_cards (batch_id, start, end, start_ts, end_ts, day, title, summary, category, subcategory, detailed_summary, metadata, uuid, hlc, field_hlc, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
      )
      const out: InsertedCard[] = []
      for (const c of cards) {
        const range = resolveCardRange(c.startTime, c.endTime, anchor)
        if (!range) continue
        // The card this one mostly overlaps keeps its user choices: private flag and manual projects.
        const prev = isError ? null : Store.bestOverlap(old, range.startTs, range.endTs)
        const prevMeta = prev ? (parseJsonObject(prev.metadata) as CardMetadata) : {}
        // No live card here: a "Reprocess day" may have left the removed cards' choices behind.
        const carried = !isError && !prev ? this.carryoverFor(range.startTs, range.endTs) : null
        const meta: CardMetadata = { distractions: c.distractions ?? [], appSites: c.appSites, isError }
        if (prevMeta.private || carried?.private) meta.private = true
        const uuid = randomUUID()
        const r = insert.run(
          batchId,
          c.startTime,
          c.endTime,
          range.startTs,
          range.endTs,
          logicalDay(range.startTs),
          c.title,
          c.summary,
          c.category,
          c.subcategory,
          c.detailedSummary,
          JSON.stringify(meta),
          uuid,
          this.tick(),
          this.deviceId,
        )
        let inheritedManual = false
        if (prev && typeof prev.uuid === 'string') inheritedManual = this.copyManualProjects(prev.uuid, uuid)
        else if (carried) inheritedManual = this.insertManualProjects(uuid, carried.projects)
        if (!isError) this.enqueueCard(uuid, c.category, null)
        out.push({ id: Number(r.lastInsertRowid), uuid, startTs: range.startTs, endTs: range.endTs, card: c, inheritedManual })
      }
      return out
    })
  }

  /** The old card covering at least half of [start, end), if any (error cards excluded). */
  private static bestOverlap(old: Record<string, unknown>[], start: number, end: number): Record<string, unknown> | null {
    let best: Record<string, unknown> | null = null
    let bestOverlap = 0
    for (const o of old) {
      if (o.category === ERROR_CATEGORY) continue
      const ov = Math.min(end, Number(o.end_ts)) - Math.max(start, Number(o.start_ts))
      if (ov > bestOverlap) {
        best = o
        bestOverlap = ov
      }
    }
    return best && bestOverlap * 2 >= Math.max(1, end - start) ? best : null
  }

  private manualProjects(cardUuid: string): { project_id: string; share: number }[] {
    return this.db
      .prepare("SELECT project_id, share FROM card_projects WHERE card_uuid = ? AND source = 'manual' AND deleted = 0")
      .all(cardUuid) as { project_id: string; share: number }[]
  }

  private copyManualProjects(fromUuid: string, toUuid: string): boolean {
    return this.insertManualProjects(toUuid, this.manualProjects(fromUuid))
  }

  private insertManualProjects(toUuid: string, rows: { project_id: string; share: number }[]): boolean {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO card_projects (card_uuid, project_id, share, source, confidence, confirmed, deleted, hlc)
       VALUES (?, ?, ?, 'manual', 1, 1, 0, ?)`,
    )
    for (const r of rows) {
      ins.run(toUuid, r.project_id, Number(r.share), this.tick())
      this.enqueue('card_project', `${toUuid}:${r.project_id}`)
    }
    return rows.length > 0
  }

  /** The carried-over choices of a removed card covering at least half of [start, end), if any. */
  private carryoverFor(start: number, end: number): { private: boolean; projects: { project_id: string; share: number }[] } | null {
    const rows = this.db
      .prepare('SELECT start_ts, end_ts, private, projects FROM card_carryover WHERE start_ts < ? AND end_ts > ?')
      .all(end, start) as { start_ts: number; end_ts: number; private: number; projects: string }[]
    let best: (typeof rows)[number] | null = null
    let bestOverlap = 0
    for (const r of rows) {
      const ov = Math.min(end, Number(r.end_ts)) - Math.max(start, Number(r.start_ts))
      if (ov > bestOverlap) {
        best = r
        bestOverlap = ov
      }
    }
    if (!best || bestOverlap * 2 < Math.max(1, end - start)) return null
    let projects: { project_id: string; share: number }[] = []
    try {
      const v = JSON.parse(best.projects) as unknown
      if (Array.isArray(v)) {
        projects = (v as { project_id?: unknown; share?: unknown }[])
          .filter((x) => !!x && typeof x.project_id === 'string')
          .map((x) => ({ project_id: String(x.project_id), share: Number.isFinite(Number(x.share)) ? Number(x.share) : 1 }))
      }
    } catch {
      /* ignore a bad row */
    }
    return { private: Number(best.private) === 1, projects }
  }

  insertErrorCard(batchId: number, startTs: number, endTs: number, message: string): void {
    this.replaceCardsInRange(
      startTs,
      endTs,
      [
        {
          startTime: formatClock(startTs),
          endTime: formatClock(endTs),
          category: ERROR_CATEGORY,
          subcategory: 'Error',
          title: 'Processing failed',
          summary: message,
          detailedSummary: message,
        },
      ],
      batchId,
      true,
    )
  }

  /**
   * A user edit of a card's user-editable fields (any device's card). Each changed field gets a
   * fresh HLC so concurrent edits on different devices merge per field.
   */
  editCard(id: number, patch: { title?: string; category?: string; subcategory?: string; deleted?: boolean; private?: boolean; detailProjects?: Record<string, DetailProjectRef[]> }): void {
    this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM timeline_cards WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!r) return
      const fh = parseJsonObject(r.field_hlc)
      const meta = parseJsonObject(r.metadata)
      const sets: string[] = []
      const vals: (string | number)[] = []
      const h = this.tick()
      for (const k of ['title', 'category', 'subcategory'] as const) {
        const v = patch[k]
        if (v === undefined) continue
        sets.push(`${k} = ?`)
        vals.push(v)
        fh[k] = h
      }
      if (patch.deleted !== undefined) {
        sets.push('is_deleted = ?')
        vals.push(patch.deleted ? 1 : 0)
        fh.deleted = h
      }
      if (patch.private !== undefined) {
        if (patch.private) meta.private = true
        else delete meta.private
        sets.push('metadata = ?')
        vals.push(JSON.stringify(meta))
        fh.private = h
      }
      if (patch.detailProjects !== undefined) {
        meta.detailProjects = patch.detailProjects
        if (!sets.includes('metadata = ?')) { sets.push('metadata = ?'); vals.push(JSON.stringify(meta)) }
        else vals[sets.indexOf('metadata = ?')] = JSON.stringify(meta)
        fh.detailProjects = h
      }
      if (sets.length === 0) return
      sets.push('field_hlc = ?')
      vals.push(JSON.stringify(fh))
      this.db.prepare(`UPDATE timeline_cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
      if (patch.category !== undefined || patch.private !== undefined) this.scopeDirty = true
      this.enqueueCard(r.uuid, patch.category ?? r.category, r.metadata)
    })
  }

  deleteCard(id: number): void {
    this.editCard(id, { deleted: true })
  }

  updateCardTitle(id: number, title: string): void {
    this.editCard(id, { title })
  }

  updateCardCategory(id: number, category: string): void {
    this.editCard(id, { category })
  }

  setCardPrivate(id: number, isPrivate: boolean): void {
    this.editCard(id, { private: isPrivate })
  }

  /**
   * Prepares a day for re-analysis: supersedes its batches and frees their screenshots so they
   * can be re-batched. Only this device's cards inside `coveredRanges` (spans that still have
   * screenshots) are removed, so time whose frames were already purged keeps its cards.
   */
  resetDay(day: string, coveredRanges: { start: number; end: number }[]): void {
    const { start, end } = dayRange(day)
    this.transaction(() => {
      const ids = this.db
        .prepare('SELECT id FROM analysis_batches WHERE batch_start_ts >= ? AND batch_start_ts < ?')
        .all(start, end)
        .map((r) => Number((r as { id: number }).id))
      const pick = this.db.prepare(
        `SELECT id, uuid, start_ts, end_ts, category, metadata, field_hlc FROM timeline_cards
         WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ? AND start_ts >= ? AND start_ts < ? AND ${this.localSql}`,
      )
      const del = this.db.prepare('UPDATE timeline_cards SET is_deleted = 1, field_hlc = ? WHERE id = ?')
      // The regenerated cards get new uuids: keep the user's choices (private flag, manual
      // projects) by time range so replaceCardsDetailed re-applies them. A previous reprocess of
      // this day is superseded; leftovers older than a week are dropped.
      this.db
        .prepare('DELETE FROM card_carryover WHERE (start_ts < ? AND end_ts > ?) OR created_at < ?')
        .run(end, start, Date.now() - 7 * 86400_000)
      const keep = this.db.prepare('INSERT INTO card_carryover (start_ts, end_ts, private, projects, created_at) VALUES (?, ?, ?, ?, ?)')
      for (const r of coveredRanges) {
        for (const c of pick.all(r.end, r.start, start, end, this.deviceId) as Record<string, unknown>[]) {
          const isPrivate = parseJsonObject(c.metadata).private === true
          const manual = typeof c.uuid === 'string' ? this.manualProjects(c.uuid) : []
          if (isPrivate || manual.length) {
            keep.run(Number(c.start_ts), Number(c.end_ts), isPrivate ? 1 : 0, JSON.stringify(manual), Date.now())
          }
          const h = this.tick()
          const fh = parseJsonObject(c.field_hlc)
          fh.deleted = h
          del.run(JSON.stringify(fh), Number(c.id))
          this.enqueueCard(c.uuid, c.category, c.metadata)
        }
      }
      for (const id of ids) {
        this.db.prepare('DELETE FROM batch_screenshots WHERE batch_id = ?').run(id)
        this.deleteBatchObservations(id)
        this.db.prepare("UPDATE analysis_batches SET status = 'superseded' WHERE id = ?").run(id)
      }
    })
  }

  // ---- LLM call log ----

  logCall(batchId: number | null, log: LLMCallLog): void {
    const cap = (s?: string) => (s && s.length > 200_000 ? s.slice(0, 200_000) : s ?? null)
    this.db
      .prepare(
        `INSERT INTO llm_calls (batch_id, provider, model, operation, status, latency_ms, request_body, response_body, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(batchId, log.provider, log.model, log.operation, log.status, log.latencyMs, cap(log.requestBody), cap(log.responseBody), cap(log.errorMessage))
  }

  pruneCallLog(olderThanDays: number): void {
    this.db.prepare(`DELETE FROM llm_calls WHERE created_at < datetime('now', ?)`).run(`-${olderThanDays} days`)
  }
}
