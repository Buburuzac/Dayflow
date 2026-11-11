// Local tables for sync: sync_state, outbox, projects, project_members, card_projects, sync_meta.
// Pure module on top of Store (no Electron), so tests can drive it directly.

import { randomUUID } from 'node:crypto'
import type { Store } from '../db.ts'
import { parseJsonObject } from '../db.ts'
import type { CardProjectInfo, TimelineCard } from '../../shared/types.ts'
import type {
  AssignmentSource,
  OdooMapping,
  ProjectRules,
  ShareLevel,
  SyncEntity,
  UserInfo,
  WorkspaceInfo,
} from '../../shared/sync-types.ts'
import type { ProjectDraft, ProjectView } from '../../shared/sync-ui.ts'

export interface SyncStateRow {
  deviceId: string
  deviceName: string
  serverUrl: string
  enabled: boolean
  userId: string | null
  user: UserInfo | null
  workspaces: WorkspaceInfo[]
  cursor: number
  lastPushAt: number | null
  lastPullAt: number | null
  lastSyncAt: number | null
  lastError: string | null
}

export interface OutboxEntry {
  seq: number
  entity: SyncEntity
  entityId: string
  payload: string | null
  rev: number
  attempts: number
}

export interface ProjectRow {
  id: string
  workspaceId: string
  name: string
  color: string
  icon?: string
  description: string
  rules: ProjectRules
  defaultShare: ShareLevel
  odoo: OdooMapping
  archived: boolean
  deleted: boolean
  hlc: string
}

export interface CardProjectRow {
  cardUuid: string
  projectId: string
  share: number
  source: AssignmentSource
  confidence: number
  confirmed: boolean
  deleted: boolean
  hlc: string
}

export const SHARE_LEVELS: ShareLevel[] = ['time', 'cards', 'detailed']

function num(v: unknown): number | null {
  return v == null ? null : Number(v)
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export class SyncRepo {
  readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  private get db() {
    return this.store.db
  }

  // ---- sync_state ----

  state(): SyncStateRow {
    const r = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as Record<string, unknown>
    return {
      deviceId: String(r.device_id),
      deviceName: String(r.device_name ?? ''),
      serverUrl: String(r.server_url),
      enabled: Number(r.enabled) === 1,
      userId: r.user_id == null ? null : String(r.user_id),
      user: parseJson<UserInfo | null>(r.user_json, null),
      workspaces: parseJson<WorkspaceInfo[]>(r.workspaces_json, []),
      cursor: Number(r.cursor ?? 0),
      lastPushAt: num(r.last_push_at),
      lastPullAt: num(r.last_pull_at),
      lastSyncAt: num(r.last_sync_at),
      lastError: r.last_error == null ? null : String(r.last_error),
    }
  }

  updateState(
    patch: Partial<{
      deviceName: string
      serverUrl: string
      userId: string | null
      user: UserInfo | null
      workspaces: WorkspaceInfo[]
      cursor: number
      lastPushAt: number | null
      lastPullAt: number | null
      lastSyncAt: number | null
      lastError: string | null
    }>,
  ): void {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      deviceName: ['device_name', (v) => v],
      serverUrl: ['server_url', (v) => v],
      userId: ['user_id', (v) => v],
      user: ['user_json', (v) => (v == null ? null : JSON.stringify(v))],
      workspaces: ['workspaces_json', (v) => JSON.stringify(v ?? [])],
      cursor: ['cursor', (v) => v],
      lastPushAt: ['last_push_at', (v) => v],
      lastPullAt: ['last_pull_at', (v) => v],
      lastSyncAt: ['last_sync_at', (v) => v],
      lastError: ['last_error', (v) => (v == null ? null : String(v).slice(0, 1000))],
    }
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k]
      if (!m || v === undefined) continue
      sets.push(`${m[0]} = ?`)
      vals.push(m[1](v) as string | number | null)
    }
    if (sets.length) this.db.prepare(`UPDATE sync_state SET ${sets.join(', ')} WHERE id = 1`).run(...vals)
  }

  // ---- outbox ----

  pendingCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n)
  }

  pending(limit: number): OutboxEntry[] {
    return (this.db.prepare('SELECT * FROM outbox ORDER BY seq ASC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => ({
      seq: Number(r.seq),
      entity: String(r.entity) as SyncEntity,
      entityId: String(r.entity_id),
      payload: r.payload == null ? null : String(r.payload),
      rev: Number(r.rev),
      attempts: Number(r.attempts),
    }))
  }

  /** Removes pushed entries, unless they were re-queued (newer rev) while the push was in flight. */
  markPushed(entries: OutboxEntry[]): void {
    const del = this.db.prepare('DELETE FROM outbox WHERE seq = ? AND rev = ?')
    this.store.transaction(() => {
      for (const e of entries) del.run(e.seq, e.rev)
    })
  }

  markRejected(entries: { entry: OutboxEntry; reason: string }[]): void {
    // Rejected changes would be rejected again; drop them but keep the reason for the status line.
    const del = this.db.prepare('DELETE FROM outbox WHERE seq = ? AND rev = ?')
    this.store.transaction(() => {
      for (const e of entries) del.run(e.entry.seq, e.entry.rev)
    })
  }

  markFailed(entries: OutboxEntry[], error: string): void {
    const up = this.db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?')
    this.store.transaction(() => {
      for (const e of entries) up.run(error.slice(0, 500), e.seq)
    })
  }

  clearOutbox(): void {
    this.db.exec('DELETE FROM outbox')
  }

  /** Queues this device's existing records after sign-in (cards and observations of the last `days`). */
  backfill(days: number, nowSec = Math.floor(Date.now() / 1000)): number {
    const since = nowSec - days * 86400
    this.store.scopeDirty = true
    const dev = this.store.deviceId
    let n = 0
    this.store.transaction(() => {
      const cards = this.db
        .prepare(
          `SELECT uuid, category, metadata FROM timeline_cards
           WHERE start_ts >= ? AND uuid IS NOT NULL AND (device_id IS NULL OR device_id = ?) AND is_deleted = 0`,
        )
        .all(since, dev) as { uuid: string; category: string; metadata: string | null }[]
      for (const c of cards) {
        if (c.category === 'System' || parseJsonObject(c.metadata).isError === true) continue
        this.store.enqueue('card', c.uuid)
        n++
      }
      const obs = this.db
        .prepare('SELECT uuid FROM observations WHERE start_ts >= ? AND uuid IS NOT NULL AND (device_id IS NULL OR device_id = ?)')
        .all(since, dev) as { uuid: string }[]
      for (const o of obs) {
        this.store.enqueue('observation', o.uuid)
        n++
      }
      const cps = this.db
        .prepare(
          `SELECT cp.card_uuid, cp.project_id FROM card_projects cp JOIN timeline_cards c ON c.uuid = cp.card_uuid
           WHERE c.start_ts >= ? AND cp.deleted = 0`,
        )
        .all(since) as { card_uuid: string; project_id: string }[]
      for (const cp of cps) {
        this.store.enqueue('card_project', `${cp.card_uuid}:${cp.project_id}`)
        n++
      }
    })
    return n
  }

  /** True when rows from the account are stored: other devices' cards/observations, projects, docs clocks. */
  hasRemoteRows(): boolean {
    const dev = this.store.deviceId
    const q = (sql: string, ...args: string[]) => this.db.prepare(sql).get(...args) !== undefined
    return (
      q('SELECT 1 FROM timeline_cards WHERE device_id IS NOT NULL AND device_id != ? LIMIT 1', dev) ||
      q('SELECT 1 FROM observations WHERE device_id IS NOT NULL AND device_id != ? LIMIT 1', dev) ||
      q('SELECT 1 FROM projects LIMIT 1') ||
      q('SELECT 1 FROM project_members LIMIT 1') ||
      q('SELECT 1 FROM sync_meta LIMIT 1')
    )
  }

  /** Signing out: drop everything that came from the account (other devices' rows, projects). */
  purgeRemote(): void {
    const dev = this.store.deviceId
    this.store.transaction(() => {
      this.db
        .prepare('DELETE FROM card_projects WHERE card_uuid IN (SELECT uuid FROM timeline_cards WHERE device_id IS NOT NULL AND device_id != ?)')
        .run(dev)
      this.db.prepare('DELETE FROM timeline_cards WHERE device_id IS NOT NULL AND device_id != ?').run(dev)
      this.db.prepare('DELETE FROM observations WHERE device_id IS NOT NULL AND device_id != ?').run(dev)
      this.db.exec('DELETE FROM projects; DELETE FROM project_members; DELETE FROM outbox; DELETE FROM sync_meta;')
      // Assignments to projects that no longer exist locally are meaningless.
      this.db.exec('DELETE FROM card_projects')
    })
    this.store.scopeDirty = true
  }

  // ---- sync_meta (HLCs of records stored elsewhere) ----

  metaHlc(key: string): string {
    const r = this.db.prepare('SELECT hlc FROM sync_meta WHERE key = ?').get(key) as { hlc: string } | undefined
    return r?.hlc ?? ''
  }

  setMetaHlc(key: string, hlc: string): void {
    this.db.prepare('INSERT INTO sync_meta (key, hlc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET hlc = excluded.hlc').run(key, hlc)
  }

  /** A local write to a standup / day goal / user doc: new HLC + queued upload. */
  recordDoc(entity: 'standup' | 'day_goal' | 'user_doc', id: string): void {
    // Before sign-in nothing is tracked; the first sync uploads what the server lacks.
    if (!this.store.syncEnabled) return
    this.setMetaHlc(`${entity}:${id}`, this.store.tick())
    this.store.enqueue(entity, id)
  }

  // ---- projects ----

  private static mapProject(r: Record<string, unknown>): ProjectRow {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      color: String(r.color),
      icon: String(r.icon ?? ''),
      description: String(r.description ?? ''),
      rules: parseJson<ProjectRules>(r.rules, {}),
      defaultShare: (SHARE_LEVELS.includes(r.default_share as ShareLevel) ? r.default_share : 'time') as ShareLevel,
      odoo: parseJson<OdooMapping>(r.odoo, {}),
      archived: Number(r.archived) === 1,
      deleted: Number(r.deleted) === 1,
      hlc: String(r.hlc),
    }
  }

  projects(includeArchived = false): ProjectRow[] {
    const where = includeArchived ? 'deleted = 0' : 'deleted = 0 AND archived = 0'
    return (this.db.prepare(`SELECT * FROM projects WHERE ${where} ORDER BY name COLLATE NOCASE`).all() as Record<string, unknown>[]).map(
      SyncRepo.mapProject,
    )
  }

  project(id: string): ProjectRow | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? SyncRepo.mapProject(r) : null
  }

  /** Writes a project row as-is (remote apply and local saves). */
  putProject(p: ProjectRow): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, color, icon, description, rules, default_share, odoo, archived, deleted, hlc, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, name = excluded.name, color = excluded.color,
           icon = excluded.icon, description = excluded.description, rules = excluded.rules, default_share = excluded.default_share,
           odoo = excluded.odoo, archived = excluded.archived, deleted = excluded.deleted, hlc = excluded.hlc,
           updated_at = excluded.updated_at`,
      )
      .run(
        p.id,
        p.workspaceId,
        p.name,
        p.color,
        p.icon ?? '',
        p.description,
        JSON.stringify(p.rules ?? {}),
        p.defaultShare,
        JSON.stringify(p.odoo ?? {}),
        p.archived ? 1 : 0,
        p.deleted ? 1 : 0,
        p.hlc,
        Date.now(),
      )
  }

  /** Admin edit from this device; the server rejects it for non-admins. */
  saveProject(d: ProjectDraft): ProjectRow {
    const row: ProjectRow = {
      id: d.id || randomUUID(),
      workspaceId: d.workspaceId,
      name: d.name,
      color: d.color,
      icon: d.icon ?? '',
      description: d.description,
      rules: d.rules,
      defaultShare: d.defaultShare,
      odoo: d.odoo,
      archived: d.archived ?? false,
      deleted: false,
      hlc: this.store.tick(),
    }
    this.putProject(row)
    this.store.enqueue('project', row.id)
    this.store.scopeDirty = true
    return row
  }

  memberShare(projectId: string, userId: string): ShareLevel | null {
    const r = this.db
      .prepare('SELECT share_level FROM project_members WHERE project_id = ? AND user_id = ? AND deleted = 0')
      .get(projectId, userId) as { share_level: string | null } | undefined
    return r?.share_level && SHARE_LEVELS.includes(r.share_level as ShareLevel) ? (r.share_level as ShareLevel) : null
  }

  memberRow(projectId: string, userId: string): { shareLevel: ShareLevel | null; deleted: boolean; hlc: string } | null {
    const r = this.db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) as
      | Record<string, unknown>
      | undefined
    if (!r) return null
    return {
      shareLevel: r.share_level == null ? null : (String(r.share_level) as ShareLevel),
      deleted: Number(r.deleted) === 1,
      hlc: String(r.hlc),
    }
  }

  putMember(projectId: string, userId: string, shareLevel: ShareLevel | null, deleted: boolean, hlc: string): void {
    this.db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, share_level, deleted, hlc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET share_level = excluded.share_level, deleted = excluded.deleted, hlc = excluded.hlc`,
      )
      .run(projectId, userId, shareLevel, deleted ? 1 : 0, hlc)
  }

  setMyShare(projectId: string, userId: string, level: ShareLevel | null): void {
    this.putMember(projectId, userId, level, false, this.store.tick())
    this.store.enqueue('project_member', `${projectId}:${userId}`)
    this.store.scopeDirty = true
  }

  projectViews(userId: string | null, includeArchived = true): ProjectView[] {
    return this.projects(includeArchived).map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      color: p.color,
      icon: p.icon ?? '',
      description: p.description,
      rules: p.rules,
      defaultShare: p.defaultShare,
      odoo: p.odoo,
      archived: p.archived,
      myShare: userId ? this.memberShare(p.id, userId) : null,
    }))
  }

  // ---- card_projects ----

  private static mapCardProject(r: Record<string, unknown>): CardProjectRow {
    return {
      cardUuid: String(r.card_uuid),
      projectId: String(r.project_id),
      share: Number(r.share),
      source: String(r.source) as AssignmentSource,
      confidence: Number(r.confidence),
      confirmed: Number(r.confirmed) === 1,
      deleted: Number(r.deleted) === 1,
      hlc: String(r.hlc),
    }
  }

  cardProject(cardUuid: string, projectId: string): CardProjectRow | null {
    const r = this.db.prepare('SELECT * FROM card_projects WHERE card_uuid = ? AND project_id = ?').get(cardUuid, projectId) as
      | Record<string, unknown>
      | undefined
    return r ? SyncRepo.mapCardProject(r) : null
  }

  cardProjects(cardUuid: string): CardProjectRow[] {
    return (
      this.db.prepare('SELECT * FROM card_projects WHERE card_uuid = ? AND deleted = 0').all(cardUuid) as Record<string, unknown>[]
    ).map(SyncRepo.mapCardProject)
  }

  putCardProject(r: CardProjectRow): void {
    this.db
      .prepare(
        `INSERT INTO card_projects (card_uuid, project_id, share, source, confidence, confirmed, deleted, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(card_uuid, project_id) DO UPDATE SET share = excluded.share, source = excluded.source,
           confidence = excluded.confidence, confirmed = excluded.confirmed, deleted = excluded.deleted, hlc = excluded.hlc`,
      )
      .run(r.cardUuid, r.projectId, r.share, r.source, r.confidence, r.confirmed ? 1 : 0, r.deleted ? 1 : 0, r.hlc)
  }

  /**
   * Replaces a card's assignments with `next` (one source); removed ones become tombstones.
   * Shares are scaled so they sum to at most 1.
   */
  setAssignments(
    cardUuid: string,
    next: { projectId: string; share: number; source: AssignmentSource; confidence: number; confirmed: boolean }[],
  ): void {
    const total = next.reduce((s, a) => s + Math.max(0, a.share), 0)
    const scale = total > 1 ? 1 / total : 1
    this.store.transaction(() => {
      const keep = new Set(next.map((a) => a.projectId))
      for (const cur of this.cardProjects(cardUuid)) {
        if (keep.has(cur.projectId)) continue
        this.putCardProject({ ...cur, deleted: true, hlc: this.store.tick() })
        this.store.enqueue('card_project', `${cardUuid}:${cur.projectId}`)
      }
      for (const a of next) {
        this.putCardProject({
          cardUuid,
          projectId: a.projectId,
          share: Math.round(Math.max(0, Math.min(1, a.share * scale)) * 1000) / 1000,
          source: a.source,
          confidence: Math.max(0, Math.min(1, a.confidence)),
          confirmed: a.confirmed,
          deleted: false,
          hlc: this.store.tick(),
        })
        this.store.enqueue('card_project', `${cardUuid}:${a.projectId}`)
      }
    })
  }

  /** Manual choice in the timeline: one project (share 1) or none. */
  setManualProject(cardUuid: string, projectId: string | null): void {
    this.setAssignments(cardUuid, projectId ? [{ projectId, share: 1, source: 'manual', confidence: 1, confirmed: true }] : [])
    this.store.scopeDirty = true
  }

  confirmProject(cardUuid: string, projectId: string): void {
    const cur = this.cardProject(cardUuid, projectId)
    if (!cur || cur.deleted) return
    this.putCardProject({ ...cur, confirmed: true, source: 'manual', confidence: 1, hlc: this.store.tick() })
    this.store.enqueue('card_project', `${cardUuid}:${projectId}`)
    this.store.scopeDirty = true
  }

  /** Adds project chips to cards for the timeline. */
  attachProjects(cards: TimelineCard[]): TimelineCard[] {
    const uuids = cards.map((c) => c.uuid).filter((u): u is string => !!u)
    if (uuids.length === 0) return cards
    const byCard = new Map<string, CardProjectInfo[]>()
    const ph = uuids.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT cp.*, p.name, p.color, p.icon FROM card_projects cp JOIN projects p ON p.id = cp.project_id
         WHERE cp.deleted = 0 AND p.deleted = 0 AND cp.card_uuid IN (${ph}) ORDER BY cp.share DESC`,
      )
      .all(...uuids) as Record<string, unknown>[]
    for (const r of rows) {
      const list = byCard.get(String(r.card_uuid)) ?? []
      list.push({
        projectId: String(r.project_id),
        name: String(r.name),
        color: String(r.color),
        icon: String(r.icon ?? ''),
        share: Number(r.share),
        source: String(r.source) as AssignmentSource,
        confidence: Number(r.confidence),
        confirmed: Number(r.confirmed) === 1,
      })
      byCard.set(String(r.card_uuid), list)
    }
    return cards.map((c) => ({ ...c, projects: (c.uuid && byCard.get(c.uuid)) || [] }))
  }
}
