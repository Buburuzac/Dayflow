// SQLite tables for the Daily page and Day goals (spec-daily.md §2a), created on the shared
// connection. Also a small key/value table for Daily settings and attempt budgets, which the
// macOS app kept in UserDefaults.

import type { DatabaseSync } from 'node:sqlite'
import type { DailySettings, DayGoalCategorySnapshot, DayGoalPlan } from '../../shared/daily-types.ts'
import { dayRange } from '../time.ts'
import { notifySync } from '../sync/hooks.ts'

export const DEFAULT_DAILY_SETTINGS: DailySettings = {
  recapEnabled: true,
  isDailyUnlocked: false,
  briefEnabled: false,
  briefModel: 'opus',
  briefOverrideInstructions: '',
  briefPromptOverrideDocket: '',
  briefPromptOverrideExtras: '',
  docketAgent: 'claude',
  docketHandoffMethod: 'terminal',
  docketShowsList: false,
  docketPickedFolders: [],
  showDailyGoalPopups: true,
}

export class DailyStore {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_standup_entries (
        standup_day TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_daily_standup_entries_created_at ON daily_standup_entries(created_at DESC);

      CREATE TABLE IF NOT EXISTS day_goals (
        day TEXT NOT NULL PRIMARY KEY,
        focus_target_minutes INTEGER NOT NULL,
        distraction_limit_minutes INTEGER NOT NULL,
        is_skipped INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_day_goals_updated_at ON day_goals(updated_at DESC);

      CREATE TABLE IF NOT EXISTS day_goal_categories (
        day TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('focus', 'distraction')),
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        category_color_hex TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (day, kind, category_id)
      );
      CREATE INDEX IF NOT EXISTS idx_day_goal_categories_day_kind ON day_goal_categories(day, kind, sort_order);

      CREATE TABLE IF NOT EXISTS daily_kv (
        key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `)
    const cols = this.db.prepare('PRAGMA table_info(day_goals)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'is_skipped')) {
      this.db.exec('ALTER TABLE day_goals ADD COLUMN is_skipped INTEGER NOT NULL DEFAULT 0')
    }
  }

  private tx<T>(fn: () => T): T {
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

  // ---- key/value ----

  getKV<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM daily_kv WHERE key = ?').get(key) as { value_json: string } | undefined
    if (!r) return fallback
    try {
      return JSON.parse(r.value_json) as T
    } catch {
      return fallback
    }
  }

  setKV(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO daily_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(key, JSON.stringify(value))
  }

  settings(): DailySettings {
    return { ...DEFAULT_DAILY_SETTINGS, ...this.getKV<Partial<DailySettings>>('settings', {}) }
  }

  updateSettings(patch: Partial<DailySettings>): DailySettings {
    const next = { ...this.settings(), ...patch }
    this.setKV('settings', next)
    return next
  }

  // ---- daily_standup_entries ----

  saveStandup(day: string, json: string): void {
    this.db
      .prepare(
        `INSERT INTO daily_standup_entries (standup_day, payload_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(standup_day) DO UPDATE SET payload_json = excluded.payload_json, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(day, json)
    notifySync('standup', day)
  }

  fetchStandup(day: string): string | null {
    const r = this.db.prepare('SELECT payload_json FROM daily_standup_entries WHERE standup_day = ?').get(day) as
      | { payload_json: string }
      | undefined
    return r ? r.payload_json : null
  }

  fetchRecentStandups(limit: number, excludingDay: string): { day: string; json: string }[] {
    return (
      this.db
        .prepare('SELECT standup_day, payload_json FROM daily_standup_entries WHERE standup_day != ? ORDER BY updated_at DESC LIMIT ?')
        .all(excludingDay, limit) as { standup_day: string; payload_json: string }[]
    ).map((r) => ({ day: r.standup_day, json: r.payload_json }))
  }

  fetchAllStandups(excludingDay: string): { day: string; json: string }[] {
    return (
      this.db
        .prepare('SELECT standup_day, payload_json FROM daily_standup_entries WHERE standup_day != ? ORDER BY standup_day DESC')
        .all(excludingDay) as { standup_day: string; payload_json: string }[]
    ).map((r) => ({ day: r.standup_day, json: r.payload_json }))
  }

  /** Every generation.sourceDay used by stored standups other than `targetDay`. */
  consumedSourceDays(targetDay: string): Set<string> {
    const out = new Set<string>()
    for (const r of this.fetchAllStandups(targetDay)) {
      try {
        const sd = (JSON.parse(r.json) as { generation?: { sourceDay?: string } }).generation?.sourceDay
        if (sd) out.add(sd)
      } catch {
        /* undecodable rows consume nothing */
      }
    }
    return out
  }

  // ---- timeline helpers ----

  /** hasMinimumTimelineActivity's sum: includes System cards. */
  activityMinutes(day: string): number {
    const { start, end } = dayRange(day)
    const r = this.db
      .prepare(
        'SELECT COALESCE(SUM(end_ts - start_ts), 0) AS s FROM timeline_cards WHERE start_ts >= ? AND start_ts < ? AND is_deleted = 0',
      )
      .get(start, end) as { s: number }
    return Number(r.s) / 60
  }

  /** fetchTotalMinutesTracked: non-System minutes. */
  trackedMinutes(day: string): number {
    const { start, end } = dayRange(day)
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(end_ts - start_ts), 0) AS s FROM timeline_cards WHERE start_ts >= ? AND start_ts < ? AND is_deleted = 0 AND category != 'System'",
      )
      .get(start, end) as { s: number }
    return Number(r.s) / 60
  }

  analyzedBatchCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM analysis_batches WHERE status = 'analyzed'").get() as { n: number }
    return Number(r.n)
  }

  countDistinctTimelineDays(excludingDay: string): number {
    const r = this.db
      .prepare('SELECT COUNT(DISTINCT day) AS n FROM timeline_cards WHERE is_deleted = 0 AND day != ?')
      .get(excludingDay) as { n: number }
    return Number(r.n)
  }

  // ---- day goals ----

  saveDayGoalPlan(plan: DayGoalPlan): void {
    const now = Math.floor(Date.now() / 1000)
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO day_goals (day, focus_target_minutes, distraction_limit_minutes, is_skipped, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET focus_target_minutes = excluded.focus_target_minutes,
             distraction_limit_minutes = excluded.distraction_limit_minutes, is_skipped = excluded.is_skipped,
             updated_at = excluded.updated_at`,
        )
        .run(
          plan.day,
          Math.round(plan.focusTargetMinutes),
          Math.round(plan.distractionLimitMinutes),
          plan.isSkipped ? 1 : 0,
          plan.createdAt > 0 ? plan.createdAt : now,
          now,
        )
      this.db.prepare('DELETE FROM day_goal_categories WHERE day = ?').run(plan.day)
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO day_goal_categories (day, kind, category_id, category_name, category_color_hex, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      plan.focusCategories.forEach((c, i) => ins.run(plan.day, 'focus', c.categoryID, c.name, c.colorHex, i))
      plan.distractionCategories.forEach((c, i) => ins.run(plan.day, 'distraction', c.categoryID, c.name, c.colorHex, i))
    })
    notifySync('day_goal', plan.day)
  }

  private planFromRow(r: Record<string, unknown>): DayGoalPlan {
    const day = String(r.day)
    const cats = this.db
      .prepare('SELECT * FROM day_goal_categories WHERE day = ? ORDER BY kind, sort_order')
      .all(day) as Record<string, unknown>[]
    const snap = (c: Record<string, unknown>): DayGoalCategorySnapshot => ({
      categoryID: String(c.category_id),
      name: String(c.category_name),
      colorHex: String(c.category_color_hex),
      sortOrder: Number(c.sort_order),
    })
    return {
      day,
      focusTargetMinutes: Number(r.focus_target_minutes),
      distractionLimitMinutes: Number(r.distraction_limit_minutes),
      focusCategories: cats.filter((c) => c.kind === 'focus').map(snap),
      distractionCategories: cats.filter((c) => c.kind === 'distraction').map(snap),
      isSkipped: Number(r.is_skipped) === 1,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }
  }

  fetchDayGoalPlan(day: string): DayGoalPlan | null {
    const r = this.db.prepare('SELECT * FROM day_goals WHERE day = ?').get(day) as Record<string, unknown> | undefined
    return r ? this.planFromRow(r) : null
  }

  fetchMostRecentDayGoalPlan(beforeOrOn: string): DayGoalPlan | null {
    const r = this.db.prepare('SELECT * FROM day_goals WHERE day <= ? ORDER BY day DESC LIMIT 1').get(beforeOrOn) as
      | Record<string, unknown>
      | undefined
    return r ? this.planFromRow(r) : null
  }

  consecutiveSkippedDayGoalCount(before: string, limit: number): number {
    const rows = this.db
      .prepare('SELECT is_skipped FROM day_goals WHERE day < ? ORDER BY day DESC LIMIT ?')
      .all(before, limit) as { is_skipped: number }[]
    let n = 0
    for (const r of rows) {
      if (Number(r.is_skipped) !== 1) break
      n++
    }
    return n
  }
}
