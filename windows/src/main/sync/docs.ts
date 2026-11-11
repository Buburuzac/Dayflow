// Synced records that live outside db.ts: standups and day goals (DailyStore tables) and the
// categories user doc (settings.json). Reads give the current payload (null = gone); writes
// apply a pulled payload without echoing it back to the outbox.

import type { DatabaseSync } from 'node:sqlite'
import type { Category, Settings } from '../../shared/types.ts'
import type { DayGoalPlan } from '../../shared/daily-types.ts'
import { DailyStore } from '../daily/store.ts'
import { sanitizeSettingsPatch } from '../settings-schema.ts'
import { detectCategoryRenames, withRenamedExclusions } from '../../shared/sync-categories.ts'
import type { DocEntity } from './hooks.ts'
import { withSyncMuted } from './hooks.ts'

export interface DocSources {
  read(entity: DocEntity, id: string): unknown | null
  write(entity: DocEntity, id: string, payload: unknown | null): void
}

export interface SettingsLike {
  get(): Settings
  update(patch: Partial<Settings>): unknown
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function makeDocSources(db: DatabaseSync, settings: SettingsLike | null): DocSources {
  const daily = new DailyStore(db)
  return {
    read(entity, id) {
      if (entity === 'standup') {
        const json = daily.fetchStandup(id)
        if (json == null) return null
        try {
          return JSON.parse(json) as unknown
        } catch {
          return null
        }
      }
      if (entity === 'day_goal') return daily.fetchDayGoalPlan(id)
      if (entity === 'user_doc' && id === 'categories') return settings?.get().categories ?? null
      return null
    },
    write(entity, id, payload) {
      withSyncMuted(() => {
        if (entity === 'standup' && DAY_RE.test(id)) {
          if (payload == null) db.prepare('DELETE FROM daily_standup_entries WHERE standup_day = ?').run(id)
          else daily.saveStandup(id, JSON.stringify(payload))
        } else if (entity === 'day_goal' && DAY_RE.test(id)) {
          if (payload == null) {
            db.prepare('DELETE FROM day_goals WHERE day = ?').run(id)
            db.prepare('DELETE FROM day_goal_categories WHERE day = ?').run(id)
          } else if (payload && typeof payload === 'object') {
            const p = payload as DayGoalPlan
            daily.saveDayGoalPlan({
              ...p,
              day: id,
              focusCategories: Array.isArray(p.focusCategories) ? p.focusCategories : [],
              distractionCategories: Array.isArray(p.distractionCategories) ? p.distractionCategories : [],
            })
          }
        } else if (entity === 'user_doc' && id === 'categories' && settings && Array.isArray(payload)) {
          // Validated like a renderer patch: a bad payload from the server is ignored.
          const clean = sanitizeSettingsPatch({ categories: payload as Category[] }, () => false)
          if (clean.categories) {
            // A category renamed on another device keeps its "never upload" mark: the new name is
            // added and the old one kept (existing cards still carry the old name).
            const cur = settings.get()
            const prevNames = (cur.categories ?? []).map((c) => c.name)
            const nextNames = clean.categories.map((c) => c.name)
            const excluded = cur.syncExcludedCategories ?? ['Personal']
            const next = withRenamedExclusions(excluded, detectCategoryRenames(prevNames, nextNames), nextNames)
            const changed = next.length !== excluded.length || next.some((n, i) => n !== excluded[i])
            settings.update(changed ? { categories: clean.categories, syncExcludedCategories: next } : { categories: clean.categories })
          }
        }
      })
    },
  }
}
