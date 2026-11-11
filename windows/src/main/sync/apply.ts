// Applies pulled changes with the contract's conflict rules (sync-server-design.md):
// - HLC string order, last writer wins per record;
// - cards: the generating device owns analysis fields; title/category/subcategory/deleted/private
//   merge per field via fieldHlc;
// - card_projects / projects / project_members / docs: LWW per record.
// Cards and observations from other devices keep their origin device_id, so this device's
// analysis never replaces them.

import type { Store } from '../db.ts'
import { parseJsonObject } from '../db.ts'
import type { AssignmentSource, ShareLevel, SyncChange } from '../../shared/sync-types.ts'
import { formatClock, logicalDay } from '../time.ts'
import type { DocSources } from './docs.ts'
import type { DocEntity } from './hooks.ts'
import { SHARE_LEVELS } from './repo.ts'
import type { SyncRepo } from './repo.ts'
import { splitPair } from './outbox.ts'
import { mergeCategoryLists } from '../../shared/sync-categories.ts'

export interface ApplyResult {
  applied: number
  skipped: number
  cards: boolean
  projects: boolean
  docs: DocEntity[]
}

const str = (v: unknown, max = 100_000): string => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max))
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

function cleanMetadata(m: unknown): Record<string, unknown> {
  const o = m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  if (Array.isArray(o.distractions)) {
    out.distractions = o.distractions
      .filter((d) => d && typeof d === 'object')
      .slice(0, 50)
      .map((d) => {
        const x = d as Record<string, unknown>
        return { startTime: str(x.startTime, 20), endTime: str(x.endTime, 20), title: str(x.title, 500), summary: str(x.summary, 2000) }
      })
  }
  if (o.appSites && typeof o.appSites === 'object') {
    const a = o.appSites as Record<string, unknown>
    out.appSites = { primary: a.primary ? str(a.primary, 200) : null, secondary: a.secondary ? str(a.secondary, 200) : null }
  }
  if (o.private === true) out.private = true
  if (o.detailProjects && typeof o.detailProjects === 'object' && !Array.isArray(o.detailProjects)) {
    out.detailProjects = Object.fromEntries(Object.entries(o.detailProjects as Record<string, unknown>)
      .filter(([key, value]) => /^(detail|distraction):\d{1,4}$/.test(key) && Array.isArray(value))
      .slice(0, 1000)
      .map(([key, value]) => [key, (value as unknown[]).filter((ref) => ref && typeof ref === 'object')
        .slice(0, 20).map((ref) => {
          const p = ref as Record<string, unknown>
          return { projectId: str(p.projectId, 100), share: Math.max(0, Math.min(1, finite(p.share) ?? 0)),
            source: p.source === 'rule' || p.source === 'llm' ? p.source : 'manual',
            confidence: Math.max(0, Math.min(1, finite(p.confidence) ?? 1)), confirmed: p.confirmed === true }
        })]))
  }
  if (Array.isArray(o.windowApps)) out.windowApps = o.windowApps.filter((x) => typeof x === 'string').slice(0, 20)
  return out
}

export class RemoteApplier {
  private readonly store: Store
  private readonly repo: SyncRepo
  private readonly docs: DocSources
  private readonly userId: () => string | null

  constructor(store: Store, repo: SyncRepo, docs: DocSources, userId: () => string | null) {
    this.store = store
    this.repo = repo
    this.docs = docs
    this.userId = userId
  }

  apply(changes: SyncChange[]): ApplyResult {
    const res: ApplyResult = { applied: 0, skipped: 0, cards: false, projects: false, docs: [] }
    const docChanges: SyncChange[] = []
    this.store.transaction(() => {
      for (const c of changes) {
        if (!c || typeof c.id !== 'string' || typeof c.hlc !== 'string') {
          res.skipped++
          continue
        }
        this.store.observeHlc(c.hlc)
        if (c.entity === 'standup' || c.entity === 'day_goal' || c.entity === 'user_doc') {
          docChanges.push(c)
          continue
        }
        let ok = false
        try {
          ok = this.applyOne(c, res)
        } catch (err) {
          console.error('[sync] could not apply change', c.entity, err)
        }
        if (ok) res.applied++
        else res.skipped++
      }
    })
    // Daily tables use their own transactions, so docs are applied outside the batch.
    for (const c of docChanges) {
      let ok = false
      try {
        ok = this.applyDoc(c)
      } catch (err) {
        console.error('[sync] could not apply change', c.entity, err)
      }
      if (ok) {
        res.applied++
        if (!res.docs.includes(c.entity as DocEntity)) res.docs.push(c.entity as DocEntity)
      } else res.skipped++
    }
    return res
  }

  private applyOne(c: SyncChange, res: ApplyResult): boolean {
    switch (c.entity) {
      case 'card': {
        const ok = this.applyCard(c)
        if (ok) res.cards = true
        return ok
      }
      case 'observation':
        return this.applyObservation(c)
      // Assignments and projects decide card scopes: the next rescope checks every card.
      case 'card_project': {
        const ok = this.applyCardProject(c)
        if (ok) res.cards = this.store.scopeDirty = true
        return ok
      }
      case 'project': {
        const ok = this.applyProject(c)
        if (ok) res.projects = res.cards = this.store.scopeDirty = true
        return ok
      }
      case 'project_member': {
        const ok = this.applyMember(c)
        if (ok) res.projects = this.store.scopeDirty = true
        return ok
      }
    }
    return false
  }

  applyCard(c: SyncChange): boolean {
    const db = this.store.db
    const me = this.store.deviceId
    const d = (c.data ?? {}) as Record<string, unknown>
    const origin = typeof d.originDeviceId === 'string' && d.originDeviceId ? d.originDeviceId : c.deviceId
    const row = db.prepare('SELECT * FROM timeline_cards WHERE uuid = ?').get(c.id) as Record<string, unknown> | undefined
    if (!row) {
      // Never seen: store it as the origin device's card. Error cards are never synced.
      if (!c.data || d.isError === true || origin === me) return false
      const startTs = finite(d.startTs)
      const endTs = finite(d.endTs)
      if (startTs === null || endTs === null || endTs < startTs) return false
      const day = /^\d{4}-\d{2}-\d{2}$/.test(str(d.day)) ? str(d.day) : logicalDay(startTs)
      db.prepare(
        `INSERT INTO timeline_cards (batch_id, start, end, start_ts, end_ts, day, title, summary, category, subcategory,
           detailed_summary, metadata, is_deleted, uuid, hlc, field_hlc, device_id)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        formatClock(startTs),
        formatClock(endTs),
        startTs,
        endTs,
        day,
        str(d.title, 500),
        str(d.summary),
        str(d.category, 100) || 'Work',
        str(d.subcategory, 100),
        str(d.detailedSummary),
        JSON.stringify(cleanMetadata(d.metadata)),
        c.deleted ? 1 : 0,
        c.id,
        c.hlc,
        JSON.stringify(c.fieldHlc ?? {}),
        origin,
      )
      return true
    }

    const local = row.device_id == null || row.device_id === me
    const rowHlc = str(row.hlc)
    const fh = parseJsonObject(row.field_hlc)
    const meta = parseJsonObject(row.metadata)
    const sets: string[] = []
    const vals: (string | number)[] = []
    let metaChanged = false

    // Analysis fields: only from the device that generated the card, never onto our own cards.
    if (!local && c.data && origin === row.device_id && c.hlc > rowHlc) {
      const startTs = finite(d.startTs)
      const endTs = finite(d.endTs)
      if (startTs !== null && endTs !== null && endTs >= startTs) {
        sets.push('start = ?', 'end = ?', 'start_ts = ?', 'end_ts = ?', 'day = ?')
        vals.push(formatClock(startTs), formatClock(endTs), startTs, endTs, /^\d{4}-\d{2}-\d{2}$/.test(str(d.day)) ? str(d.day) : logicalDay(startTs))
      }
      sets.push('summary = ?', 'detailed_summary = ?', 'hlc = ?')
      vals.push(str(d.summary), str(d.detailedSummary), c.hlc)
      const m = cleanMetadata(d.metadata)
      for (const k of ['distractions', 'appSites', 'windowApps'] as const) {
        if (k in m) meta[k] = m[k]
        else delete meta[k]
      }
      metaChanged = true
    }

    // User-editable fields merge per field: newer field HLC wins. Without an explicit field HLC
    // only the origin device's record clock counts (its copy of the field is authoritative).
    const fromOrigin = origin === c.deviceId && !local
    // Field clocks stamped by this device are our own writes coming back. They may carry the scoped
    // upload form of the card ("Out of scope" / a wiped personal card) and must never replace the
    // full local copy; edits made on other devices carry their own clocks and still merge.
    const ownClock = (h: string) => h.endsWith(`-${me}`)
    const remoteField = (f: string) => {
      const h = c.fieldHlc?.[f] ?? (fromOrigin ? c.hlc : '')
      return h && !ownClock(h) ? h : ''
    }
    const localField = (f: string) => (typeof fh[f] === 'string' ? (fh[f] as string) : rowHlc)
    if (c.data) {
      for (const f of ['title', 'category', 'subcategory'] as const) {
        if (typeof d[f] !== 'string') continue
        if (remoteField(f) > localField(f)) {
          sets.push(`${f} = ?`)
          vals.push(str(d[f], f === 'title' ? 500 : 100))
          fh[f] = remoteField(f)
        }
      }
      const md = d.metadata && typeof d.metadata === 'object' ? (d.metadata as Record<string, unknown>) : {}
      if (remoteField('private') > localField('private')) {
        const p = md.private === true
        if (p !== (meta.private === true)) {
          if (p) meta.private = true
          else delete meta.private
          metaChanged = true
        }
        fh.private = remoteField('private')
      }
      if (remoteField('detailProjects') > localField('detailProjects')) {
        const detailProjects = cleanMetadata(md).detailProjects
        if (detailProjects) meta.detailProjects = detailProjects
        else delete meta.detailProjects
        metaChanged = true
        fh.detailProjects = remoteField('detailProjects')
      }
    }
    if (remoteField('deleted') > localField('deleted')) {
      const del = c.deleted ? 1 : 0
      if (del !== Number(row.is_deleted)) {
        sets.push('is_deleted = ?')
        vals.push(del)
      }
      fh.deleted = remoteField('deleted')
    }
    if (metaChanged) {
      sets.push('metadata = ?')
      vals.push(JSON.stringify(meta))
    }
    if (sets.length === 0) return false
    // Another device edited the category or private flag of one of our cards: its scope may change.
    if (local && sets.some((x) => x.startsWith('category') || x.startsWith('metadata'))) this.store.scopeDirty = true
    sets.push('field_hlc = ?')
    vals.push(JSON.stringify(fh))
    db.prepare(`UPDATE timeline_cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals, Number(row.id))
    return true
  }

  applyObservation(c: SyncChange): boolean {
    const db = this.store.db
    const me = this.store.deviceId
    const row = db.prepare('SELECT device_id, hlc FROM observations WHERE uuid = ?').get(c.id) as
      | { device_id: string | null; hlc: string | null }
      | undefined
    if (row && (row.device_id == null || row.device_id === me)) return false
    if (c.deviceId === me) return false
    if (c.deleted) {
      if (!row) return false
      db.prepare('DELETE FROM observations WHERE uuid = ?').run(c.id)
      return true
    }
    const d = (c.data ?? {}) as Record<string, unknown>
    const startTs = finite(d.startTs)
    const endTs = finite(d.endTs)
    if (startTs === null || endTs === null || typeof d.text !== 'string') return false
    if (row) {
      if (!(c.hlc > str(row.hlc))) return false
      db.prepare('UPDATE observations SET start_ts = ?, end_ts = ?, observation = ?, hlc = ? WHERE uuid = ?').run(
        startTs,
        endTs,
        str(d.text),
        c.hlc,
        c.id,
      )
      return true
    }
    db.prepare(
      'INSERT INTO observations (batch_id, start_ts, end_ts, observation, uuid, hlc, device_id) VALUES (NULL, ?, ?, ?, ?, ?, ?)',
    ).run(startTs, endTs, str(d.text), c.id, c.hlc, c.deviceId)
    return true
  }

  applyCardProject(c: SyncChange): boolean {
    const d = (c.data ?? {}) as Record<string, unknown>
    const pair = splitPair(c.id)
    const cardUuid = typeof d.cardId === 'string' ? d.cardId : pair?.[0]
    const projectId = typeof d.projectId === 'string' ? d.projectId : pair?.[1]
    if (!cardUuid || !projectId) return false
    const cur = this.repo.cardProject(cardUuid, projectId)
    if (cur && !(c.hlc > cur.hlc)) return false
    const source: AssignmentSource = d.source === 'manual' || d.source === 'rule' || d.source === 'llm' ? d.source : 'manual'
    this.repo.putCardProject({
      cardUuid,
      projectId,
      share: Math.max(0, Math.min(1, finite(d.share) ?? cur?.share ?? 1)),
      source: c.data ? source : (cur?.source ?? 'manual'),
      confidence: Math.max(0, Math.min(1, finite(d.confidence) ?? cur?.confidence ?? 1)),
      confirmed: c.data ? d.confirmed === true : (cur?.confirmed ?? false),
      deleted: c.deleted === true,
      hlc: c.hlc,
    })
    return true
  }

  applyProject(c: SyncChange): boolean {
    const cur = this.repo.project(c.id)
    if (cur && !(c.hlc > cur.hlc)) return false
    const d = (c.data ?? {}) as Record<string, unknown>
    if (!cur && (c.deleted || !c.data)) return false
    const rules = d.rules && typeof d.rules === 'object' ? (d.rules as Record<string, unknown>) : {}
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 100) : undefined)
    const odoo = d.odoo && typeof d.odoo === 'object' ? (d.odoo as Record<string, unknown>) : {}
    this.repo.putProject({
      id: c.id,
      workspaceId: str(d.workspaceId, 100) || cur?.workspaceId || '',
      name: str(d.name, 200) || cur?.name || 'Project',
      color: HEX_COLOR.test(str(d.color)) ? str(d.color) : (cur?.color ?? '#7BC47F'),
      // An empty icon is a deliberate removal; only a missing field keeps the local one.
      icon: typeof d.icon === 'string' ? str(d.icon, 16) : (cur?.icon ?? ''),
      description: str(d.description, 2000),
      rules: c.data
        ? { apps: list(rules.apps), domains: list(rules.domains), titleKeywords: list(rules.titleKeywords), repos: list(rules.repos) }
        : (cur?.rules ?? {}),
      defaultShare: SHARE_LEVELS.includes(d.defaultShare as ShareLevel) ? (d.defaultShare as ShareLevel) : (cur?.defaultShare ?? 'time'),
      odoo: c.data
        ? {
            projectId: finite(odoo.projectId) ?? undefined,
            taskId: finite(odoo.taskId) ?? undefined,
            projectName: typeof odoo.projectName === 'string' ? odoo.projectName : undefined,
            taskName: typeof odoo.taskName === 'string' ? odoo.taskName : undefined,
          }
        : (cur?.odoo ?? {}),
      archived: c.data ? d.archived === true : (cur?.archived ?? false),
      deleted: c.deleted === true,
      hlc: c.hlc,
    })
    return true
  }

  applyMember(c: SyncChange): boolean {
    const d = (c.data ?? {}) as Record<string, unknown>
    const pair = splitPair(c.id)
    const projectId = typeof d.projectId === 'string' ? d.projectId : pair?.[0]
    const userId = typeof d.userId === 'string' ? d.userId : pair?.[1]
    if (!projectId || !userId) return false
    const cur = this.repo.memberRow(projectId, userId)
    if (cur && !(c.hlc > cur.hlc)) return false
    const level = SHARE_LEVELS.includes(d.shareLevel as ShareLevel) ? (d.shareLevel as ShareLevel) : null
    this.repo.putMember(projectId, userId, level, c.deleted === true, c.hlc)
    return true
  }

  applyDoc(c: SyncChange): boolean {
    const uid = this.userId()
    if (!uid || !c.id.startsWith(`${uid}:`)) return false
    const localId = c.id.slice(uid.length + 1)
    const entity = c.entity as DocEntity
    const key = `${entity}:${localId}`
    if (!(c.hlc > this.repo.metaHlc(key))) return false
    const d = (c.data ?? {}) as Record<string, unknown>
    let payload: unknown = d.payload ?? null
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload) as unknown
      } catch {
        /* keep the string */
      }
    }
    // First categories pull after sign-in (no local clock yet): never drop local categories. Keep the
    // server's list, append the local ones it lacks, and upload the merged list.
    let pushMerged = false
    if (entity === 'user_doc' && localId === 'categories' && !this.repo.metaHlc(key) && !c.deleted && Array.isArray(payload)) {
      const local = this.docs.read('user_doc', 'categories')
      if (Array.isArray(local)) {
        const merged = mergeCategoryLists(payload as { name: string; isIdle?: boolean }[], local as { name: string; isIdle?: boolean }[])
        if (merged.length > payload.length) {
          payload = merged
          pushMerged = true
        }
      }
    }
    this.docs.write(entity, localId, c.deleted ? null : payload)
    this.repo.setMetaHlc(key, c.hlc)
    if (pushMerged) this.repo.recordDoc('user_doc', 'categories')
    return true
  }
}
