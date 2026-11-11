// Turns outbox entries into wire changes. Records are read in their current state at push time
// (so several edits of one card upload once); deleted observations carry a tombstone payload.

import type { Store } from '../db.ts'
import { CARD_USER_FIELDS, ERROR_CATEGORY, parseJsonObject } from '../db.ts'
import type {
  CardData,
  CardProjectData,
  DayGoalData,
  ObservationData,
  ProjectData,
  ProjectMemberData,
  StandupData,
  SyncChange,
  UserDocData,
} from '../../shared/sync-types.ts'
import type { DocSources } from './docs.ts'
import { cardScope, redactCard, type CardScope } from './scope.ts'
import type { OutboxEntry, SyncRepo } from './repo.ts'

export interface BuiltBatch {
  /** Entries that produced the changes, index-aligned with `changes` */
  used: OutboxEntry[]
  changes: SyncChange[]
  /** Bookkeeping per change, index-aligned with `changes`: run for the ones the server accepted */
  commits: (() => void)[][]
  /** Entries with nothing to send (row gone, error card, …) — safe to drop */
  dropped: OutboxEntry[]
}

/** Splits "<a>:<b>" composite ids (uuids contain no ':'). */
export function splitPair(id: string): [string, string] | null {
  const i = id.indexOf(':')
  return i > 0 && i < id.length - 1 ? [id.slice(0, i), id.slice(i + 1)] : null
}

/** Distinct process names seen in this device's frames for a card (metadata.windowApps). */
function windowApps(store: Store, startTs: number, endTs: number): string[] {
  const apps = new Set<string>()
  for (const s of store.liveScreenshotsInRange(startTs, endTs)) {
    if (!s.windowLabel) continue
    const p = s.windowLabel.split(' — ')[0].trim()
    if (p) apps.add(p)
  }
  return [...apps].slice(0, 20)
}

/** True when this card has a confirmed assignment to a project that is neither deleted nor archived. */
function hasConfirmedLiveProject(store: Store, cardUuid: string): boolean {
  const r = store.db
    .prepare(
      `SELECT 1 FROM card_projects cp JOIN projects p ON p.id = cp.project_id
        WHERE cp.card_uuid = ? AND cp.confirmed = 1 AND cp.deleted = 0 AND p.deleted = 0 AND p.archived = 0 LIMIT 1`,
    )
    .get(cardUuid)
  return r !== undefined
}

/** Scope a local card should have now under the device's sync policy. */
export function currentCardScope(store: Store, row: Record<string, unknown>): CardScope {
  const meta = parseJsonObject(row.metadata)
  return cardScope(
    { category: String(row.category ?? ''), private: meta.private === true },
    hasConfirmedLiveProject(store, String(row.uuid)),
    store.syncPolicy,
  )
}

function maxHlc(values: unknown[]): string {
  let m = ''
  for (const v of values) if (typeof v === 'string' && v > m) m = v
  return m
}

/**
 * Local bookkeeping to run only once the server has accepted a change (what it now holds for a card,
 * whether an observation is on the server). Never run for failed or rejected pushes.
 */
export type OnSent = (commit: () => void) => void

export function buildChange(
  store: Store,
  repo: SyncRepo,
  docs: DocSources,
  userId: string,
  e: OutboxEntry,
  onSent: OnSent = () => {},
): SyncChange | null {
  const me = store.deviceId
  switch (e.entity) {
    case 'card': {
      const r = store.db.prepare('SELECT * FROM timeline_cards WHERE uuid = ?').get(e.entityId) as Record<string, unknown> | undefined
      if (!r) return null
      const meta = parseJsonObject(r.metadata)
      if (r.category === ERROR_CATEGORY || meta.isError === true) return null
      const local = r.device_id == null || r.device_id === me
      const startTs = Number(r.start_ts)
      const endTs = Number(r.end_ts)
      const metadata: Record<string, unknown> = {
        distractions: Array.isArray(meta.distractions) ? meta.distractions : [],
        appSites: meta.appSites ?? null,
      }
      // Always a boolean: the server ignores a missing value, so un-marking would never reach it.
      metadata.private = meta.private === true
      if (meta.detailProjects && typeof meta.detailProjects === 'object') metadata.detailProjects = meta.detailProjects
      if (local) metadata.windowApps = windowApps(store, startTs, endTs)
      else if (Array.isArray(meta.windowApps)) metadata.windowApps = meta.windowApps
      let data: CardData = {
        userId,
        startTs,
        endTs,
        day: String(r.day),
        title: String(r.title),
        summary: String(r.summary ?? ''),
        detailedSummary: String(r.detailed_summary ?? ''),
        category: String(r.category),
        subcategory: String(r.subcategory ?? ''),
        metadata,
        isError: false,
        originDeviceId: local ? me : String(r.device_id),
      }
      // The record HLC is the card's creation (analysis never edits a card in place). Every
      // user-editable field gets an explicit HLC (its last edit, else creation), and the change's
      // HLC is the newest of them, so receivers and the server can merge field by field.
      let recordHlc = local ? store.localHlc(String(r.hlc)) : String(r.hlc)
      const stored = parseJsonObject(r.field_hlc)
      const fieldHlc: Record<string, string> = {}
      for (const f of CARD_USER_FIELDS) fieldHlc[f] = typeof stored[f] === 'string' ? (stored[f] as string) : recordHlc

      // Sync scope (sync/scope.ts): only for cards this device generated — other devices' cards
      // arrive already scoped by the device that made them.
      let scope: CardScope = 'full'
      if (local) {
        scope = currentCardScope(store, r)
        let scopeHlc = typeof r.scope_hlc === 'string' ? store.localHlc(r.scope_hlc) : ''
        // A card never sent under a scope was uploaded as-is before this feature (or not yet at all).
        const sent: CardScope = typeof r.sync_scope === 'string' ? (r.sync_scope as CardScope) : 'full'
        const changed = scope !== sent
        if (changed) scopeHlc = store.tick() // must beat the copy the server already holds
        const uuid = e.entityId
        const recorded = scopeHlc
        // Fields whose clock the scope bumped, with the clock sent for each.
        const sentClocks: Record<string, string> = {}
        if (scopeHlc) {
          // Analysis fields (summaries, metadata) must replace the server's copy.
          if (scopeHlc > recordHlc) recordHlc = scopeHlc
          // Only the fields the scope rewrites get the newer clock, so edits made on other devices
          // to anything else keep their place in the per-field merge.
          const bumped: string[] = ['title', 'category', 'subcategory']
          if (scope === 'excluded' || (changed && sent === 'excluded')) bumped.push('deleted')
          for (const f of bumped) {
            if (scopeHlc > fieldHlc[f]) fieldHlc[f] = scopeHlc
            sentClocks[f] = fieldHlc[f]
          }
        }
        // Recorded only once the server has accepted this upload. The bumped field clocks are
        // recorded locally too (local = max(local, sent)): after a sign-out → sign-in this device
        // gets a new id, and our own scoped echoes (clocked with the old id) must not look newer
        // than the real local title/category/deleted flag.
        onSent(() => {
          const cur = store.db.prepare('SELECT field_hlc FROM timeline_cards WHERE uuid = ?').get(uuid) as
            | { field_hlc: string | null }
            | undefined
          if (!cur) return
          const fh = parseJsonObject(cur.field_hlc)
          for (const [f, h] of Object.entries(sentClocks)) {
            const local = typeof fh[f] === 'string' ? (fh[f] as string) : ''
            if (h > local) fh[f] = h
          }
          store.db
            .prepare('UPDATE timeline_cards SET sync_scope = ?, scope_hlc = ?, field_hlc = ? WHERE uuid = ?')
            .run(scope, recorded || null, JSON.stringify(fh), uuid)
        })
        data = redactCard(data, scope)
      }
      // The server requires the change clock to carry this device's id: for our own card that is
      // the record clock; for another device's card it is our newest edit of it.
      const mine = Object.values(fieldHlc).filter((h) => h.endsWith(`-${me}`))
      const hlc = local ? recordHlc : maxHlc(mine) || store.tick()
      const ch: SyncChange = { entity: 'card', id: e.entityId, deviceId: me, hlc, data: data as unknown as Record<string, unknown>, fieldHlc }
      // Always a boolean: the server skips an absent value, so a card leaving the "excluded" scope
      // would otherwise stay deleted there forever.
      ch.deleted = Number(r.is_deleted) === 1 || scope === 'excluded'
      return ch
    }
    case 'observation': {
      const r = store.db.prepare('SELECT * FROM observations WHERE uuid = ?').get(e.entityId) as Record<string, unknown> | undefined
      const t = parseJsonObject(e.payload)
      // Tombstones win even if the row still exists locally (observation upload switched off).
      if (t.deleted === true && typeof t.hlc === 'string') {
        const uuid = e.entityId
        onSent(() => store.db.prepare('UPDATE observations SET uploaded = 0 WHERE uuid = ?').run(uuid))
        return { entity: 'observation', id: e.entityId, deviceId: me, hlc: store.localHlc(t.hlc), deleted: true }
      }
      if (!r) return null
      if (r.device_id != null && r.device_id !== me) return null
      if (!store.syncPolicy.observations) return null
      // Re-sent after upload was switched back on: a fresh clock beats the earlier tombstone.
      const reviveHlc = typeof t.revive === 'string' ? t.revive : null
      const data: ObservationData = { userId, startTs: Number(r.start_ts), endTs: Number(r.end_ts), text: String(r.observation) }
      const uuid = e.entityId
      onSent(() => {
        store.db.prepare('UPDATE observations SET uploaded = 1 WHERE uuid = ?').run(uuid)
        // Upload was switched off while this push was in flight: the switch-off tombstones missed
        // it (it was not uploaded yet), so remove the text from the server right away.
        if (!store.syncPolicy.observations) store.enqueue('observation', uuid, JSON.stringify({ deleted: true, hlc: store.tick() }))
      })
      return {
        entity: 'observation',
        id: e.entityId,
        deviceId: me,
        hlc: reviveHlc ? store.localHlc(reviveHlc) : store.localHlc(String(r.hlc)),
        data: data as unknown as Record<string, unknown>,
      }
    }
    case 'card_project': {
      const pair = splitPair(e.entityId)
      if (!pair) return null
      const row = repo.cardProject(pair[0], pair[1])
      if (!row) return null
      const card = store.db.prepare('SELECT * FROM timeline_cards WHERE uuid = ?').get(pair[0]) as Record<string, unknown> | undefined
      if (!card || card.category === ERROR_CATEGORY || parseJsonObject(card.metadata).isError === true) return null
      // A personal card's project links stay on this PC along with the card.
      const localCard = card.device_id == null || card.device_id === me
      if (localCard && currentCardScope(store, card) === 'excluded') return null
      const data: CardProjectData = {
        cardId: row.cardUuid,
        projectId: row.projectId,
        share: row.share,
        source: row.source,
        confidence: row.confidence,
        confirmed: row.confirmed,
      }
      const ch: SyncChange = { entity: 'card_project', id: e.entityId, deviceId: me, hlc: store.localHlc(row.hlc), data: data as unknown as Record<string, unknown> }
      if (row.deleted) ch.deleted = true
      return ch
    }
    case 'project': {
      const p = repo.project(e.entityId)
      if (!p) return null
      const data: ProjectData = {
        workspaceId: p.workspaceId,
        name: p.name,
        color: p.color,
        icon: p.icon ?? '',
        description: p.description,
        rules: p.rules,
        defaultShare: p.defaultShare,
        odoo: p.odoo,
        archived: p.archived,
      }
      const ch: SyncChange = { entity: 'project', id: p.id, deviceId: me, hlc: p.hlc, data: data as unknown as Record<string, unknown> }
      if (p.deleted) ch.deleted = true
      return ch
    }
    case 'project_member': {
      const pair = splitPair(e.entityId)
      if (!pair) return null
      const m = repo.memberRow(pair[0], pair[1])
      if (!m) return null
      const data: ProjectMemberData = { projectId: pair[0], userId: pair[1], shareLevel: m.shareLevel }
      const ch: SyncChange = { entity: 'project_member', id: e.entityId, deviceId: me, hlc: m.hlc, data: data as unknown as Record<string, unknown> }
      if (m.deleted) ch.deleted = true
      return ch
    }
    case 'standup':
    case 'day_goal':
    case 'user_doc': {
      const hlc = repo.metaHlc(`${e.entity}:${e.entityId}`)
      if (!hlc) return null
      const payload = docs.read(e.entity, e.entityId)
      const id = `${userId}:${e.entityId}`
      if (payload == null) return { entity: e.entity, id, deviceId: me, hlc, deleted: true }
      const data: StandupData | DayGoalData | UserDocData =
        e.entity === 'user_doc' ? { userId, kind: e.entityId, payload } : { userId, day: e.entityId, payload }
      return { entity: e.entity, id, deviceId: me, hlc, data: data as unknown as Record<string, unknown> }
    }
  }
  return null
}

/** Builds up to `maxChanges` changes / `maxBytes` of JSON from the head of the outbox. */
export function buildBatch(
  store: Store,
  repo: SyncRepo,
  docs: DocSources,
  userId: string,
  entries: OutboxEntry[],
  maxChanges = 1000,
  maxBytes = 4_500_000,
): BuiltBatch {
  const out: BuiltBatch = { used: [], changes: [], dropped: [], commits: [] }
  let bytes = 20
  // The server reports rejections by id only, and a standup and a day goal of one day share their
  // id ("<user>:<day>"). Two changes with the same id never go in one batch: the later one stays
  // queued for the next batch, so every rejection matches exactly one change.
  const ids = new Set<string>()
  for (const e of entries) {
    if (out.changes.length >= maxChanges) break
    let ch: SyncChange | null = null
    const commits: (() => void)[] = []
    try {
      ch = buildChange(store, repo, docs, userId, e, (fn) => commits.push(fn))
    } catch (err) {
      console.error('[sync] could not build change', e.entity, err)
    }
    if (!ch) {
      out.dropped.push(e)
      continue
    }
    if (ids.has(ch.id)) continue
    const size = JSON.stringify(ch).length + 1
    if (out.changes.length > 0 && bytes + size > maxBytes) break
    bytes += size
    ids.add(ch.id)
    out.used.push(e)
    out.changes.push(ch)
    out.commits.push(commits)
  }
  return out
}

/**
 * Matches the server's rejections ({id, reason}, no entity) to the batch's changes, one rejection per
 * change: a rejected id marks the first not yet matched change with that id. Returns the reason per
 * change index (undefined = accepted).
 */
export function matchRejections(changes: SyncChange[], rejected: { id: string; reason: string }[]): (string | undefined)[] {
  const out: (string | undefined)[] = changes.map(() => undefined)
  for (const r of rejected) {
    if (!r || typeof r.id !== 'string') continue
    const i = changes.findIndex((c, j) => c.id === r.id && out[j] === undefined)
    if (i >= 0) out[i] = typeof r.reason === 'string' ? r.reason : 'rejected'
  }
  return out
}

/** Runs the bookkeeping of the accepted changes (see OnSent). */
export function commitAccepted(batch: BuiltBatch, accepted: (index: number) => boolean): void {
  for (let i = 0; i < batch.changes.length; i++) {
    if (!accepted(i)) continue
    for (const fn of batch.commits[i]) fn()
  }
}

/** How far back scope changes are re-checked (the first upload covers the last 30 days). */
const RESCOPE_WINDOW_DAYS = 31

/**
 * Queues every local card whose scope differs from what the server last received — after a project
 * was confirmed, archived or deleted, a category edit, or a change of the sync policy. Returns the
 * number of cards queued. Cards outside the window are only re-checked if they were sent before.
 */
export function rescopeCards(store: Store, nowSec = Math.floor(Date.now() / 1000)): number {
  const since = nowSec - RESCOPE_WINDOW_DAYS * 86400
  // Older cards sent before are only re-checked when something that decides a scope changed
  // (Store.scopeDirty: policy, projects, assignments, private/category edits); otherwise only the
  // window, where new cards appear.
  const full = store.scopeDirty
  store.scopeDirty = false
  // One query: the per-card project check runs inside SQLite, not as a query per card.
  const rows = store.db
    .prepare(
      `SELECT c.uuid, c.category, c.metadata, c.sync_scope,
              EXISTS (SELECT 1 FROM card_projects cp JOIN projects p ON p.id = cp.project_id
                       WHERE cp.card_uuid = c.uuid AND cp.confirmed = 1 AND cp.deleted = 0
                         AND p.deleted = 0 AND p.archived = 0) AS has_project
         FROM timeline_cards c
        WHERE c.uuid IS NOT NULL AND (c.device_id IS NULL OR c.device_id = ?) AND c.category != ?
          AND (c.start_ts >= ? OR (? = 1 AND c.sync_scope IS NOT NULL))`,
    )
    .all(store.deviceId, ERROR_CATEGORY, since, full ? 1 : 0) as Record<string, unknown>[]
  let n = 0
  for (const r of rows) {
    const meta = parseJsonObject(r.metadata)
    if (meta.isError === true) continue
    const scope = cardScope(
      { category: String(r.category ?? ''), private: meta.private === true },
      Number(r.has_project) === 1,
      store.syncPolicy,
    )
    const sent = typeof r.sync_scope === 'string' ? r.sync_scope : 'full'
    if (scope !== sent) {
      store.enqueue('card', String(r.uuid))
      n++
    }
  }
  return n
}

/**
 * Observation upload switched off: tombstones for every observation the server holds (no time
 * window; the server wipes their text). Switched on: re-sends the recent ones with a clock newer
 * than those tombstones.
 */
export function requeueObservations(store: Store, upload: boolean, nowSec = Math.floor(Date.now() / 1000)): number {
  const own = 'uuid IS NOT NULL AND (device_id IS NULL OR device_id = ?)'
  const rows = (
    upload
      ? store.db
          .prepare(`SELECT uuid FROM observations WHERE ${own} AND start_ts >= ?`)
          .all(store.deviceId, nowSec - RESCOPE_WINDOW_DAYS * 86400)
      : store.db.prepare(`SELECT uuid FROM observations WHERE ${own} AND uploaded = 1`).all(store.deviceId)
  ) as { uuid: string }[]
  for (const r of rows) {
    const payload = upload ? { revive: store.tick() } : { deleted: true, hlc: store.tick() }
    store.enqueue('observation', r.uuid, JSON.stringify(payload))
  }
  return rows.length
}
