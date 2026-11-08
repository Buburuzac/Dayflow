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
import type { OutboxEntry, SyncRepo } from './repo.ts'

export interface BuiltBatch {
  /** Entries that produced the changes, index-aligned with `changes` */
  used: OutboxEntry[]
  changes: SyncChange[]
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

function maxHlc(values: unknown[]): string {
  let m = ''
  for (const v of values) if (typeof v === 'string' && v > m) m = v
  return m
}

export function buildChange(store: Store, repo: SyncRepo, docs: DocSources, userId: string, e: OutboxEntry): SyncChange | null {
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
      if (meta.private === true) metadata.private = true
      if (local) metadata.windowApps = windowApps(store, startTs, endTs)
      else if (Array.isArray(meta.windowApps)) metadata.windowApps = meta.windowApps
      const data: CardData = {
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
      const recordHlc = local ? store.localHlc(String(r.hlc)) : String(r.hlc)
      const stored = parseJsonObject(r.field_hlc)
      const fieldHlc: Record<string, string> = {}
      for (const f of CARD_USER_FIELDS) fieldHlc[f] = typeof stored[f] === 'string' ? (stored[f] as string) : recordHlc
      // The server requires the change clock to carry this device's id: for our own card that is
      // the record clock; for another device's card it is our newest edit of it.
      const mine = Object.values(fieldHlc).filter((h) => h.endsWith(`-${me}`))
      const hlc = local ? recordHlc : maxHlc(mine) || store.tick()
      const ch: SyncChange = { entity: 'card', id: e.entityId, deviceId: me, hlc, data: data as unknown as Record<string, unknown>, fieldHlc }
      if (Number(r.is_deleted) === 1) ch.deleted = true
      return ch
    }
    case 'observation': {
      const r = store.db.prepare('SELECT * FROM observations WHERE uuid = ?').get(e.entityId) as Record<string, unknown> | undefined
      if (!r) {
        const t = parseJsonObject(e.payload)
        if (t.deleted !== true || typeof t.hlc !== 'string') return null
        return { entity: 'observation', id: e.entityId, deviceId: me, hlc: store.localHlc(t.hlc), deleted: true }
      }
      if (r.device_id != null && r.device_id !== me) return null
      const data: ObservationData = { userId, startTs: Number(r.start_ts), endTs: Number(r.end_ts), text: String(r.observation) }
      return {
        entity: 'observation',
        id: e.entityId,
        deviceId: me,
        hlc: store.localHlc(String(r.hlc)),
        data: data as unknown as Record<string, unknown>,
      }
    }
    case 'card_project': {
      const pair = splitPair(e.entityId)
      if (!pair) return null
      const row = repo.cardProject(pair[0], pair[1])
      if (!row) return null
      const card = store.db.prepare('SELECT category, metadata FROM timeline_cards WHERE uuid = ?').get(pair[0]) as
        | { category: string; metadata: string | null }
        | undefined
      if (!card || card.category === ERROR_CATEGORY || parseJsonObject(card.metadata).isError === true) return null
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
  const out: BuiltBatch = { used: [], changes: [], dropped: [] }
  let bytes = 20
  for (const e of entries) {
    if (out.changes.length >= maxChanges) break
    let ch: SyncChange | null = null
    try {
      ch = buildChange(store, repo, docs, userId, e)
    } catch (err) {
      console.error('[sync] could not build change', e.entity, err)
    }
    if (!ch) {
      out.dropped.push(e)
      continue
    }
    const size = JSON.stringify(ch).length + 1
    if (out.changes.length > 0 && bytes + size > maxBytes) break
    bytes += size
    out.used.push(e)
    out.changes.push(ch)
  }
  return out
}
