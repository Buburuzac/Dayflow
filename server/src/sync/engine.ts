import type { Auth } from '../context'
import { nextSeq, withSeqTx, type Db, type Tx } from '../db'
import { roleAtLeast } from '../access'
import type { PullResponse, PushResponse, SyncChange, SyncEntity, WorkspaceRole } from '../shared'
import { parseHlc } from '../shared'
import { checkHlc, maxHlc } from './hlc'
import { projectsOfCards, recomputeProjection } from './projection'
import {
  CardDataZ,
  CardProjectDataZ,
  ChangeZ,
  DayDocDataZ,
  ObservationDataZ,
  ProjectDataZ,
  ProjectMemberDataZ,
  UserDocDataZ,
} from './schemas'

export const MAX_PUSH = 1000
export const MAX_PULL = 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

class Reject extends Error {
  constructor(public readonly reason: string) {
    super(reason)
  }
}

/** Side effects collected while applying a batch; processed once before commit. */
export interface Effects {
  /** users whose devices must pull */
  notifyUsers: Set<string>
  /** cards whose projection must be rebuilt */
  cards: Set<string>
  /** projects whose projection must be rebuilt entirely */
  projects: Set<string>
  /** (project, user) pairs to rebuild */
  projectUsers: Map<string, Set<string>>
  /** workspaces whose members must pull (project / project_member changes) */
  workspaces: Set<string>
  /** projects whose team feed changed (SSE `feed` event to workspace members) */
  feedProjects: Set<string>
}

export const newEffects = (): Effects => ({
  notifyUsers: new Set(),
  cards: new Set(),
  projects: new Set(),
  projectUsers: new Map(),
  workspaces: new Set(),
  feedProjects: new Set(),
})

interface ApplyCtx {
  tx: Tx
  auth: Auth
  now: number
  fx: Effects
  roles: Map<string, WorkspaceRole | null>
}

async function roleIn(c: ApplyCtx, workspaceId: string): Promise<WorkspaceRole | null> {
  if (!c.roles.has(workspaceId)) {
    const r = await c.tx.query(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, c.auth.userId])
    c.roles.set(workspaceId, r.rows[0]?.role ?? null)
  }
  return c.roles.get(workspaceId)!
}

const ORDER: Record<SyncEntity, number> = {
  project: 0,
  project_member: 1,
  card: 2,
  card_project: 3,
  observation: 4,
  standup: 5,
  day_goal: 6,
  user_doc: 7,
}

// ------------------------------------------------------------------------------------------------
// push
// ------------------------------------------------------------------------------------------------

export async function push(
  db: Db,
  auth: Auth,
  rawChanges: unknown[],
  now: number,
): Promise<{ response: PushResponse; effects: Effects }> {
  const rejected: { id: string; reason: string }[] = []
  const valid: SyncChange[] = []
  for (const raw of rawChanges) {
    const p = ChangeZ.safeParse(raw)
    const id = typeof (raw as { id?: unknown })?.id === 'string' ? String((raw as { id: string }).id).slice(0, 200) : ''
    if (!p.success) {
      rejected.push({ id, reason: 'invalid_change' })
      continue
    }
    const reason = precheck(p.data, auth, now)
    if (reason) rejected.push({ id: p.data.id, reason })
    else valid.push(p.data)
  }
  // Parents before children (project → member, card → card_project); stable within an entity.
  const ordered = valid.map((ch, i) => ({ ch, i })).sort((a, b) => ORDER[a.ch.entity] - ORDER[b.ch.entity] || a.i - b.i)

  const fx = newEffects()
  let accepted = 0
  await withSeqTx(db, async (tx) => {
    const c: ApplyCtx = { tx, auth, now, fx, roles: new Map() }
    for (const { ch } of ordered) {
      await tx.query('SAVEPOINT ch')
      try {
        await apply(c, ch)
        await tx.query('RELEASE SAVEPOINT ch')
        accepted++
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT ch')
        rejected.push({ id: ch.id, reason: err instanceof Reject ? err.reason : 'error' })
        // log the entity and the SQLSTATE only: messages may echo record values
        if (!(err instanceof Reject)) console.error('sync apply failed', ch.entity, (err as { code?: string }).code ?? 'unknown')
      }
    }
    await processEffects(tx, fx)
  })
  return { response: { accepted, rejected, serverTime: now }, effects: fx }
}

/** Device, clock and shape checks that need no database access. */
function precheck(ch: SyncChange, auth: Auth, now: number): string | null {
  if (ch.deviceId !== auth.deviceId) return 'foreign_device'
  const h = checkHlc(ch.hlc, now)
  if (h === 'invalid') return 'invalid_hlc'
  if (h === 'future') return 'hlc_in_future'
  if (parseHlc(ch.hlc)!.deviceId !== ch.deviceId) return 'hlc_device_mismatch'
  if (ch.fieldHlc) {
    if (ch.entity !== 'card') return 'field_hlc_not_allowed'
    for (const v of Object.values(ch.fieldHlc)) {
      const f = checkHlc(v, now)
      if (f === 'invalid') return 'invalid_hlc'
      if (f === 'future') return 'hlc_in_future'
    }
  }
  if (!ch.deleted && !ch.data) return 'missing_data'
  return null
}

async function apply(c: ApplyCtx, ch: SyncChange): Promise<void> {
  switch (ch.entity) {
    case 'card':
      return applyCard(c, ch)
    case 'card_project':
      return applyCardProject(c, ch)
    case 'observation':
      return applyObservation(c, ch)
    case 'standup':
    case 'day_goal':
      return applyDayDoc(c, ch, ch.entity === 'standup' ? 'standups' : 'day_goals')
    case 'user_doc':
      return applyUserDoc(c, ch)
    case 'project':
      return applyProject(c, ch)
    case 'project_member':
      return applyProjectMember(c, ch)
  }
}

function parseData<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, data: unknown): T {
  const r = schema.safeParse(data ?? {})
  if (!r.success) throw new Reject('invalid_data')
  return r.data as T
}

function checkUserField(c: ApplyCtx, data: Record<string, unknown> | undefined) {
  if (data && data.userId !== undefined && data.userId !== c.auth.userId) throw new Reject('user_mismatch')
}

// ---- cards: analysis fields owned by the generating device, user fields merged per field ----

/** User-editable card fields; each carries its own clock in field_hlc. `private` lives in metadata.private. */
export const CARD_USER_FIELDS = ['title', 'category', 'subcategory', 'deleted', 'private', 'detailProjects'] as const
type UserField = (typeof CARD_USER_FIELDS)[number]

interface CardRow {
  id: string
  user_id: string
  device_id: string
  start_ts: number
  end_ts: number
  day: string
  title: string
  summary: string
  detailed_summary: string
  category: string
  subcategory: string
  metadata: Record<string, unknown>
  is_error: boolean
  private: boolean
  deleted: boolean
  hlc: string
  analysis_hlc: string
  field_hlc: Record<string, string>
}

function userFieldValue(ch: SyncChange, f: UserField): unknown {
  if (f === 'deleted') return ch.deleted
  const d = ch.data
  if (!d) return undefined
  if (f === 'private') {
    const m = d.metadata as Record<string, unknown> | undefined
    return m && typeof m.private === 'boolean' ? m.private : undefined
  }
  if (f === 'detailProjects') {
    const m = d.metadata as Record<string, unknown> | undefined
    return m?.detailProjects && typeof m.detailProjects === 'object' ? m.detailProjects : undefined
  }
  return typeof d[f] === 'string' ? d[f] : undefined
}

async function applyCard(c: ApplyCtx, ch: SyncChange): Promise<void> {
  if (!UUID_RE.test(ch.id)) throw new Reject('invalid_id')
  checkUserField(c, ch.data)
  const data = ch.data ? parseData(CardDataZ, ch.data) : undefined
  const cur = (await c.tx.query<CardRow>(`SELECT * FROM cards WHERE id = $1 FOR UPDATE`, [ch.id])).rows[0]
  if (cur && cur.user_id !== c.auth.userId) throw new Reject('not_owner')

  if (!cur) {
    const fieldHlc: Record<string, string> = {}
    for (const f of CARD_USER_FIELDS) if (ch.fieldHlc?.[f]) fieldHlc[f] = ch.fieldHlc[f]
    const meta = { ...(data?.metadata ?? {}) }
    const priv = meta.private === true
    delete meta.private
    let generator = ch.deviceId
    const origin = (ch.data as Record<string, unknown> | undefined)?.originDeviceId
    if (typeof origin === 'string' && origin !== ch.deviceId && UUID_RE.test(origin)) {
      const own = await c.tx.query(`SELECT 1 FROM devices WHERE id = $1 AND user_id = $2`, [origin, c.auth.userId])
      if (own.rowCount) generator = origin
    }
    const seq = await nextSeq(c.tx)
    await c.tx.query(
      `INSERT INTO cards(id, user_id, device_id, start_ts, end_ts, day, title, summary, detailed_summary, category,
                         subcategory, metadata, is_error, private, deleted, hlc, analysis_hlc, field_hlc, last_device_id, server_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$20,$19)`,
      [
        ch.id,
        c.auth.userId,
        generator,
        data?.startTs ?? 0,
        data?.endTs ?? 0,
        data?.day ?? '',
        data?.title ?? '',
        data?.summary ?? '',
        data?.detailedSummary ?? '',
        data?.category ?? '',
        data?.subcategory ?? '',
        JSON.stringify(meta),
        data?.isError ?? false,
        priv,
        ch.deleted ?? false,
        maxHlc(ch.hlc, ...Object.values(fieldHlc)),
        ch.hlc,
        JSON.stringify(fieldHlc),
        seq,
        ch.deviceId,
      ],
    )
    c.fx.cards.add(ch.id)
    c.fx.notifyUsers.add(c.auth.userId)
    return
  }

  const isGenerator = cur.device_id === ch.deviceId
  const sets: string[] = []
  const vals: unknown[] = []
  const set = (col: string, v: unknown) => {
    vals.push(v)
    sets.push(`${col} = $${vals.length}`)
  }
  const fieldHlc = { ...cur.field_hlc }
  let analysisHlc = cur.analysis_hlc
  const appliedClocks: string[] = []

  // 1. analysis fields: generating device only, record-level LWW
  const analysisNewer = isGenerator && ch.hlc > cur.analysis_hlc
  let metadataWrite: Record<string, unknown> | null = null
  if (analysisNewer && data) {
    if (data.startTs !== undefined) set('start_ts', data.startTs)
    if (data.endTs !== undefined) set('end_ts', data.endTs)
    if (data.day !== undefined) set('day', data.day)
    if (data.summary !== undefined) set('summary', data.summary)
    if (data.detailedSummary !== undefined) set('detailed_summary', data.detailedSummary)
    if (data.isError !== undefined) set('is_error', data.isError)
    if (data.metadata !== undefined) {
      const meta = { ...data.metadata }
      delete meta.private
      if (fieldHlc.detailProjects && cur.metadata?.detailProjects) meta.detailProjects = cur.metadata.detailProjects
      metadataWrite = meta
    }
  }
  if (analysisNewer) {
    analysisHlc = ch.hlc
    set('analysis_hlc', ch.hlc)
    appliedClocks.push(ch.hlc)
  }

  // 2. user-editable fields, per-field LWW
  const current: Record<UserField, unknown> = {
    title: cur.title,
    category: cur.category,
    subcategory: cur.subcategory,
    deleted: cur.deleted,
    private: cur.private,
    detailProjects: cur.metadata?.detailProjects,
  }
  for (const f of CARD_USER_FIELDS) {
    const v = userFieldValue(ch, f)
    if (v === undefined) continue
    const explicit = ch.fieldHlc?.[f]
    let clock: string | null = null
    if (explicit) {
      // an explicit user edit beats analysis rewrites; among user edits the later clock wins
      if (explicit > (fieldHlc[f] ?? '')) clock = explicit
    } else if (isGenerator) {
      // analysis output: only while the field was never edited by the user
      if (!fieldHlc[f] && analysisNewer) clock = ''
    } else if (!ch.fieldHlc && v !== current[f] && ch.hlc > (fieldHlc[f] ?? '')) {
      // a non-generating device that sends no fieldHlc at all: any differing value is a user edit
      clock = ch.hlc
    }
    if (clock === null) continue
    if (f === 'detailProjects') metadataWrite = { ...(metadataWrite ?? cur.metadata), detailProjects: v }
    else if (v !== current[f]) set(f === 'private' ? 'private' : f, v)
    if (clock) {
      fieldHlc[f] = clock
      appliedClocks.push(clock)
    }
  }

  if (metadataWrite) set('metadata', JSON.stringify(metadataWrite))

  if (sets.length === 0 && appliedClocks.length === 0) return // stale or duplicate: accepted, nothing to do
  set('field_hlc', JSON.stringify(fieldHlc))
  set('hlc', maxHlc(cur.hlc, analysisHlc, ...appliedClocks))
  set('last_device_id', ch.deviceId)
  set('server_seq', await nextSeq(c.tx))
  sets.push('updated_at = now()')
  vals.push(ch.id)
  await c.tx.query(`UPDATE cards SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals)
  c.fx.cards.add(ch.id)
  c.fx.notifyUsers.add(c.auth.userId)
}

// ---- card_projects: LWW per (card_id, project_id) ----

async function applyCardProject(c: ApplyCtx, ch: SyncChange): Promise<void> {
  checkUserField(c, ch.data)
  let cardId: string, projectId: string
  let data: ReturnType<typeof CardProjectDataZ.parse> | undefined
  if (ch.data) {
    data = parseData(CardProjectDataZ, ch.data)
    cardId = data.cardId
    projectId = data.projectId
  } else {
    const byId = (await c.tx.query(`SELECT card_id, project_id FROM card_projects WHERE id = $1`, [ch.id])).rows[0]
    const [a, b] = ch.id.split(':')
    if (byId) {
      cardId = byId.card_id
      projectId = byId.project_id
    } else if (UUID_RE.test(a ?? '') && UUID_RE.test(b ?? '')) {
      cardId = a
      projectId = b
    } else throw new Reject('missing_data')
  }
  const card = (await c.tx.query(`SELECT user_id FROM cards WHERE id = $1`, [cardId])).rows[0]
  if (card && card.user_id !== c.auth.userId) throw new Reject('not_owner')
  const cur = (
    await c.tx.query(`SELECT user_id, hlc, project_id FROM card_projects WHERE card_id = $1 AND project_id = $2 FOR UPDATE`, [
      cardId,
      projectId,
    ])
  ).rows[0]
  if (cur && cur.user_id !== c.auth.userId) throw new Reject('not_owner')

  if (!ch.deleted) {
    // assigning time to a project requires write access to its workspace
    const p = (await c.tx.query(`SELECT workspace_id, deleted FROM projects WHERE id = $1`, [projectId])).rows[0]
    if (!p || p.deleted) throw new Reject('unknown_project')
    if (!roleAtLeast(await roleIn(c, p.workspace_id), 'member')) throw new Reject('forbidden_project')
  }
  if (cur && ch.hlc <= cur.hlc) return
  if (!cur && !data) {
    // deleting something that never reached the server: nothing to store
    return
  }
  const seq = await nextSeq(c.tx)
  if (!cur) {
    const idTaken = (await c.tx.query(`SELECT 1 FROM card_projects WHERE id = $1`, [ch.id])).rowCount
    await c.tx.query(
      `INSERT INTO card_projects(id, card_id, project_id, user_id, device_id, share, source, confidence, confirmed, deleted, hlc, server_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        idTaken ? `${cardId}:${projectId}` : ch.id,
        cardId,
        projectId,
        c.auth.userId,
        ch.deviceId,
        data!.share,
        data!.source,
        data!.confidence,
        data!.confirmed,
        ch.deleted ?? false,
        ch.hlc,
        seq,
      ],
    )
  } else if (data) {
    await c.tx.query(
      `UPDATE card_projects SET device_id=$3, share=$4, source=$5, confidence=$6, confirmed=$7, deleted=$8, hlc=$9, server_seq=$10
        WHERE card_id=$1 AND project_id=$2`,
      [cardId, projectId, ch.deviceId, data.share, data.source, data.confidence, data.confirmed, ch.deleted ?? false, ch.hlc, seq],
    )
  } else {
    await c.tx.query(`UPDATE card_projects SET device_id=$3, deleted=true, hlc=$4, server_seq=$5 WHERE card_id=$1 AND project_id=$2`, [
      cardId,
      projectId,
      ch.deviceId,
      ch.hlc,
      seq,
    ])
  }
  c.fx.cards.add(cardId)
  c.fx.feedProjects.add(projectId)
  c.fx.notifyUsers.add(c.auth.userId)
}

// ---- simple personal records: LWW per record ----

async function lwwGuard(c: ApplyCtx, table: string, id: string, hlc: string): Promise<'insert' | 'update' | 'stale'> {
  const cur = (await c.tx.query(`SELECT user_id, hlc FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0]
  if (!cur) return 'insert'
  if (cur.user_id !== c.auth.userId) throw new Reject('not_owner')
  return hlc > cur.hlc ? 'update' : 'stale'
}

async function applyObservation(c: ApplyCtx, ch: SyncChange): Promise<void> {
  if (!UUID_RE.test(ch.id)) throw new Reject('invalid_id')
  checkUserField(c, ch.data)
  const mode = await lwwGuard(c, 'observations', ch.id, ch.hlc)
  if (mode === 'stale') return
  const d = ch.data ? parseData(ObservationDataZ, ch.data) : undefined
  const seq = await nextSeq(c.tx)
  if (mode === 'insert') {
    await c.tx.query(
      `INSERT INTO observations(id, user_id, device_id, start_ts, end_ts, text, deleted, hlc, server_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ch.id, c.auth.userId, ch.deviceId, d?.startTs ?? 0, d?.endTs ?? 0, d?.text ?? '', ch.deleted ?? false, ch.hlc, seq],
    )
  } else if (d) {
    await c.tx.query(
      `UPDATE observations SET device_id=$2, start_ts=$3, end_ts=$4, text=$5, deleted=$6, hlc=$7, server_seq=$8 WHERE id=$1`,
      [ch.id, ch.deviceId, d.startTs, d.endTs, d.text, ch.deleted ?? false, ch.hlc, seq],
    )
  } else {
    // A deleted observation keeps no text: clients delete them when the user stops sharing observations.
    await c.tx.query(`UPDATE observations SET device_id=$2, deleted=true, text='', hlc=$3, server_seq=$4 WHERE id=$1`, [ch.id, ch.deviceId, ch.hlc, seq])
  }
  c.fx.notifyUsers.add(c.auth.userId)
}

function splitComposite(id: string): [string, string] | null {
  const i = id.indexOf(':')
  if (i < 0) return null
  return [id.slice(0, i), id.slice(i + 1)]
}

/** `data.payload` (client contract: StandupData / DayGoalData / UserDocData); falls back to the flat object. */
function payloadOf(data: Record<string, unknown> | undefined): string {
  let p: unknown
  if (data && 'payload' in data) p = data.payload ?? {}
  else {
    const rest = { ...(data ?? {}) }
    delete rest.userId
    delete rest.day
    delete rest.kind
    p = rest
  }
  const s = JSON.stringify(p)
  if (s.length > 1_000_000) throw new Reject('too_large')
  return s
}

async function applyDayDoc(c: ApplyCtx, ch: SyncChange, table: 'standups' | 'day_goals'): Promise<void> {
  const parts = splitComposite(ch.id)
  if (!parts || !DAY_RE.test(parts[1])) throw new Reject('invalid_id')
  if (parts[0] !== c.auth.userId) throw new Reject('not_owner')
  checkUserField(c, ch.data)
  if (ch.data) {
    const d = parseData(DayDocDataZ, ch.data)
    if (d.day && d.day !== parts[1]) throw new Reject('invalid_data')
  }
  const mode = await lwwGuard(c, table, ch.id, ch.hlc)
  if (mode === 'stale') return
  const seq = await nextSeq(c.tx)
  const payload = ch.data ? payloadOf(ch.data) : null
  if (mode === 'insert') {
    await c.tx.query(
      `INSERT INTO ${table}(id, user_id, device_id, day, payload, deleted, hlc, server_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ch.id, c.auth.userId, ch.deviceId, parts[1], payload ?? '{}', ch.deleted ?? false, ch.hlc, seq],
    )
  } else {
    await c.tx.query(
      `UPDATE ${table} SET device_id=$2, payload=COALESCE($3, payload), deleted=$4, hlc=$5, server_seq=$6 WHERE id=$1`,
      [ch.id, ch.deviceId, payload, ch.deleted ?? false, ch.hlc, seq],
    )
  }
  c.fx.notifyUsers.add(c.auth.userId)
}

async function applyUserDoc(c: ApplyCtx, ch: SyncChange): Promise<void> {
  const parts = splitComposite(ch.id)
  if (!parts || !/^[a-z0-9_.-]{1,64}$/i.test(parts[1])) throw new Reject('invalid_id')
  if (parts[0] !== c.auth.userId) throw new Reject('not_owner')
  checkUserField(c, ch.data)
  if (ch.data) {
    const d = parseData(UserDocDataZ, ch.data)
    if (d.kind && d.kind !== parts[1]) throw new Reject('invalid_data')
  }
  const mode = await lwwGuard(c, 'user_docs', ch.id, ch.hlc)
  if (mode === 'stale') return
  const seq = await nextSeq(c.tx)
  const payload = ch.data ? payloadOf(ch.data) : null
  if (mode === 'insert') {
    await c.tx.query(
      `INSERT INTO user_docs(id, user_id, device_id, kind, payload, deleted, hlc, server_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ch.id, c.auth.userId, ch.deviceId, parts[1], payload ?? '{}', ch.deleted ?? false, ch.hlc, seq],
    )
  } else {
    await c.tx.query(
      `UPDATE user_docs SET device_id=$2, payload=COALESCE($3, payload), deleted=$4, hlc=$5, server_seq=$6 WHERE id=$1`,
      [ch.id, ch.deviceId, payload, ch.deleted ?? false, ch.hlc, seq],
    )
  }
  c.fx.notifyUsers.add(c.auth.userId)
}

// ---- team records: need admin/owner of the workspace ----

async function applyProject(c: ApplyCtx, ch: SyncChange): Promise<void> {
  if (!UUID_RE.test(ch.id)) throw new Reject('invalid_id')
  const cur = (await c.tx.query(`SELECT workspace_id, hlc FROM projects WHERE id = $1 FOR UPDATE`, [ch.id])).rows[0]
  const d = ch.data ? parseData(ProjectDataZ, ch.data) : undefined
  const workspaceId: string | undefined = cur?.workspace_id ?? d?.workspaceId
  if (!workspaceId) throw new Reject('missing_data')
  if (cur && d && d.workspaceId !== cur.workspace_id) throw new Reject('workspace_change')
  if (!roleAtLeast(await roleIn(c, workspaceId), 'admin')) throw new Reject('forbidden')
  if (!cur && !d) return
  if (cur && ch.hlc <= cur.hlc) return
  await writeProject(c.tx, ch.id, workspaceId, d, ch.deleted ?? false, ch.hlc, ch.deviceId, !cur)
  c.fx.workspaces.add(workspaceId)
  c.fx.projects.add(ch.id)
  c.fx.feedProjects.add(ch.id)
}

export async function writeProject(
  tx: Tx,
  id: string,
  workspaceId: string,
  d: ReturnType<typeof ProjectDataZ.parse> | undefined,
  deleted: boolean,
  hlc: string,
  deviceId: string,
  insert: boolean,
): Promise<void> {
  const seq = await nextSeq(tx)
  if (insert) {
    await tx.query(
      `INSERT INTO projects(id, workspace_id, name, color, icon, description, rules, default_share, odoo, archived, deleted, device_id, hlc, server_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        workspaceId,
        d!.name,
        d!.color,
        d!.icon ?? '',
        d!.description,
        JSON.stringify(d!.rules),
        d!.defaultShare,
        d!.odoo ? JSON.stringify(d!.odoo) : null,
        d!.archived,
        deleted,
        deviceId,
        hlc,
        seq,
      ],
    )
  } else if (d) {
    await tx.query(
      `UPDATE projects SET name=$2, color=$3, icon=COALESCE($4, icon), description=$5, rules=$6, default_share=$7, odoo=$8, archived=$9, deleted=$10,
              device_id=$11, hlc=$12, server_seq=$13, updated_at=now() WHERE id=$1`,
      [
        id,
        d.name,
        d.color,
        d.icon ?? null,
        d.description,
        JSON.stringify(d.rules),
        d.defaultShare,
        d.odoo ? JSON.stringify(d.odoo) : null,
        d.archived,
        deleted,
        deviceId,
        hlc,
        seq,
      ],
    )
  } else {
    await tx.query(`UPDATE projects SET deleted=$2, device_id=$3, hlc=$4, server_seq=$5, updated_at=now() WHERE id=$1`, [
      id,
      deleted,
      deviceId,
      hlc,
      seq,
    ])
  }
}

async function applyProjectMember(c: ApplyCtx, ch: SyncChange): Promise<void> {
  let projectId: string, userId: string
  const d = ch.data ? parseData(ProjectMemberDataZ, ch.data) : undefined
  if (d) {
    projectId = d.projectId
    userId = d.userId
  } else {
    const byId = (await c.tx.query(`SELECT project_id, user_id FROM project_members WHERE id = $1`, [ch.id])).rows[0]
    if (!byId) return // deleting an unknown row
    projectId = byId.project_id
    userId = byId.user_id
  }
  const p = (await c.tx.query(`SELECT workspace_id FROM projects WHERE id = $1`, [projectId])).rows[0]
  if (!p) throw new Reject('unknown_project')
  const role = await roleIn(c, p.workspace_id)
  // admins manage every member; a member may set their own share level ("each person decides what leaves")
  if (!roleAtLeast(role, 'admin') && !(role && userId === c.auth.userId)) throw new Reject('forbidden')
  const target = (await c.tx.query(`SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [p.workspace_id, userId])).rowCount
  if (!target && !ch.deleted) throw new Reject('not_a_member')
  const cur = (await c.tx.query(`SELECT hlc FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE`, [projectId, userId]))
    .rows[0]
  if (cur && ch.hlc <= cur.hlc) return
  await writeProjectMember(c.tx, ch.id, projectId, userId, d?.shareLevel ?? null, ch.deleted ?? false, ch.hlc, ch.deviceId, !cur)
  c.fx.workspaces.add(p.workspace_id)
  addProjectUser(c.fx, projectId, userId)
  c.fx.feedProjects.add(projectId)
}

export function addProjectUser(fx: Effects, projectId: string, userId: string) {
  let s = fx.projectUsers.get(projectId)
  if (!s) fx.projectUsers.set(projectId, (s = new Set()))
  s.add(userId)
}

export async function writeProjectMember(
  tx: Tx,
  id: string,
  projectId: string,
  userId: string,
  shareLevel: string | null,
  deleted: boolean,
  hlc: string,
  deviceId: string,
  insert: boolean,
): Promise<void> {
  const seq = await nextSeq(tx)
  if (insert) {
    const idTaken = (await tx.query(`SELECT 1 FROM project_members WHERE id = $1`, [id])).rowCount
    await tx.query(
      `INSERT INTO project_members(id, project_id, user_id, share_level, deleted, device_id, hlc, server_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [idTaken ? `${projectId}:${userId}` : id, projectId, userId, shareLevel, deleted, deviceId, hlc, seq],
    )
  } else {
    await tx.query(
      `UPDATE project_members SET share_level=$3, deleted=$4, device_id=$5, hlc=$6, server_seq=$7 WHERE project_id=$1 AND user_id=$2`,
      [projectId, userId, shareLevel, deleted, deviceId, hlc, seq],
    )
  }
}

/** Rebuilds the projection and resolves notification targets. Runs inside the write transaction. */
export async function processEffects(tx: Tx, fx: Effects): Promise<void> {
  if (fx.cards.size) {
    const ids = [...fx.cards]
    for (const p of await projectsOfCards(tx, ids)) fx.feedProjects.add(p)
    await recomputeProjection(tx, { cardIds: ids })
  }
  for (const p of fx.projects) await recomputeProjection(tx, { projectId: p })
  for (const [p, users] of fx.projectUsers) {
    if (fx.projects.has(p)) continue
    for (const u of users) await recomputeProjection(tx, { projectId: p, userId: u })
  }
  if (fx.workspaces.size) {
    const r = await tx.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM memberships WHERE workspace_id = ANY($1::uuid[])`, [
      [...fx.workspaces],
    ])
    for (const row of r.rows) fx.notifyUsers.add(row.user_id)
  }
}

/** Members of the workspaces owning `projectIds` (receivers of the SSE `feed` event). */
export async function feedAudience(db: Db, projectIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (projectIds.length === 0) return out
  const r = await db.query<{ user_id: string; project_id: string }>(
    `SELECT m.user_id, p.id AS project_id FROM projects p JOIN memberships m ON m.workspace_id = p.workspace_id
      WHERE p.id = ANY($1::uuid[])`,
    [projectIds],
  )
  for (const row of r.rows) {
    const list = out.get(row.user_id) ?? []
    list.push(row.project_id)
    out.set(row.user_id, list)
  }
  return out
}

// ------------------------------------------------------------------------------------------------
// pull
// ------------------------------------------------------------------------------------------------

type RowMapper = (r: any) => SyncChange

const cardChange: RowMapper = (r) => ({
  entity: 'card',
  id: r.id,
  deviceId: r.last_device_id,
  hlc: r.hlc,
  deleted: r.deleted,
  data: {
    userId: r.user_id,
    originDeviceId: r.device_id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    day: r.day,
    title: r.title,
    summary: r.summary,
    detailedSummary: r.detailed_summary,
    category: r.category,
    subcategory: r.subcategory,
    metadata: { ...r.metadata, ...(r.private ? { private: true } : {}) },
    isError: r.is_error,
  },
  fieldHlc: r.field_hlc,
})

const docChange =
  (entity: SyncEntity, key: 'day' | 'kind'): RowMapper =>
  (r) => ({
    entity,
    id: r.id,
    deviceId: r.device_id,
    hlc: r.hlc,
    deleted: r.deleted,
    data: { userId: r.user_id, [key]: r[key], payload: r.payload },
  })

const SOURCES: { sql: string; map: RowMapper }[] = [
  { sql: `SELECT * FROM cards WHERE user_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3`, map: cardChange },
  {
    sql: `SELECT * FROM card_projects WHERE user_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3`,
    map: (r) => ({
      entity: 'card_project',
      id: r.id,
      deviceId: r.device_id,
      hlc: r.hlc,
      deleted: r.deleted,
      data: { cardId: r.card_id, projectId: r.project_id, share: r.share, source: r.source, confidence: r.confidence, confirmed: r.confirmed },
    }),
  },
  {
    sql: `SELECT * FROM observations WHERE user_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3`,
    map: (r) => ({
      entity: 'observation',
      id: r.id,
      deviceId: r.device_id,
      hlc: r.hlc,
      deleted: r.deleted,
      data: { userId: r.user_id, startTs: r.start_ts, endTs: r.end_ts, text: r.text },
    }),
  },
  { sql: `SELECT * FROM standups WHERE user_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3`, map: docChange('standup', 'day') },
  { sql: `SELECT * FROM day_goals WHERE user_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3`, map: docChange('day_goal', 'day') },
  { sql: `SELECT * FROM user_docs WHERE user_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3`, map: docChange('user_doc', 'kind') },
  {
    sql: `SELECT p.* FROM projects p JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $1
           WHERE p.server_seq > $2 ORDER BY p.server_seq LIMIT $3`,
    map: (r) => ({
      entity: 'project',
      id: r.id,
      deviceId: r.device_id,
      hlc: r.hlc,
      deleted: r.deleted,
      data: {
        workspaceId: r.workspace_id,
        name: r.name,
        color: r.color,
        icon: r.icon,
        description: r.description,
        rules: r.rules,
        defaultShare: r.default_share,
        ...(r.odoo ? { odoo: r.odoo } : {}),
        archived: r.archived,
      },
    }),
  },
  {
    sql: `SELECT pm.* FROM project_members pm JOIN projects p ON p.id = pm.project_id
            JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $1
           WHERE pm.server_seq > $2 ORDER BY pm.server_seq LIMIT $3`,
    map: (r) => ({
      entity: 'project_member',
      id: r.id,
      deviceId: r.device_id,
      hlc: r.hlc,
      deleted: r.deleted,
      data: { projectId: r.project_id, userId: r.user_id, shareLevel: r.share_level },
    }),
  },
]

export async function pull(db: Db, userId: string, cursor: number, limit: number): Promise<PullResponse> {
  const n = Math.max(1, Math.min(MAX_PULL, limit))
  // Each source returns its n+1 smallest rows past the cursor; the global n smallest are among them.
  const rows: { seq: number; change: SyncChange }[] = []
  const results = await Promise.all(SOURCES.map((s) => db.query(s.sql, [userId, cursor, n + 1]).then((r) => ({ s, r }))))
  for (const { s, r } of results) for (const row of r.rows) rows.push({ seq: Number(row.server_seq), change: s.map(row) })
  rows.sort((a, b) => a.seq - b.seq)
  const page = rows.slice(0, n)
  return {
    changes: page.map((x) => x.change),
    cursor: page.length ? page[page.length - 1].seq : cursor,
    more: rows.length > n,
  }
}
