// Sync engine and account operations, independent of Electron (features/sync.ts wires it to
// IPC, safeStorage and the browser). Push loop with batching and backoff, pull loop with a
// cursor, and an SSE stream that triggers pulls.

import type { Store } from '../db.ts'
import { formatHlc } from '../../shared/sync-types.ts'
import type {
  AuthResponse,
  MeResponse,
  ProjectEntry,
  ProjectReport,
  ShareLevel,
  TimesheetSubmitRequest,
  TimesheetSubmitResult,
} from '../../shared/sync-types.ts'
import type { AuthConfigStatus, MeView, ProjectDraft, ProjectView, SyncStatus, TimesheetProposalsView } from '../../shared/sync-ui.ts'
import { detailProjectShares, initialDetailProjects } from '../../shared/detail-projects.ts'
import { RemoteApplier } from './apply.ts'
import type { ApplyResult } from './apply.ts'
import { loopbackAuthorize } from './auth.ts'
import { HttpError, SyncClient, normalizeServerUrl } from './client.ts'
import type { FetchLike } from './client.ts'
import type { DocSources } from './docs.ts'
import type { DocEntity } from './hooks.ts'
import { buildBatch, commitAccepted, matchRejections, requeueObservations, rescopeCards } from './outbox.ts'
import { samePolicy, type SyncPolicy } from './scope.ts'
import { SHARE_LEVELS, SyncRepo } from './repo.ts'

export interface TokenStore {
  get(): string
  set(token: string): void
}

export interface SyncServiceDeps {
  store: Store
  docs: DocSources
  token: TokenStore
  deviceName: string
  platform: string
  openBrowser?: (url: string) => unknown
  onCardsChanged?: () => void
  onProjectsChanged?: () => void
  onDocsChanged?: (entities: DocEntity[]) => void
  onStatus?: () => void
  fetchImpl?: FetchLike
  /** Days of existing cards/observations uploaded after the first sign-in (default 30) */
  backfillDays?: number
  /** Background timers, push debounce and the SSE stream (off in unit tests) */
  background?: boolean
  pushDebounceMs?: number
}

const MAX_BACKOFF = 5 * 60_000

/** Thrown inside a sync cycle once the session it started in has ended (sign-out, sign-in). */
class SessionChanged extends Error {
  constructor() {
    super('The sync session changed')
  }
}
const SAFE_TEXT = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '')

export class SyncService {
  readonly repo: SyncRepo
  private readonly deps: SyncServiceDeps
  private readonly applier: RemoteApplier
  private running: Promise<void> | null = null
  private again = false
  private failures = 0
  private syncing = false
  private streamConnected = false
  private streamAbort: AbortController | null = null
  private streaming = false
  private timers: NodeJS.Timeout[] = []
  private retryTimer: NodeJS.Timeout | null = null
  private pushTimer: NodeJS.Timeout | null = null
  private pullTimer: NodeJS.Timeout | null = null
  private rejectNote: string | null = null
  private needsDocBackfill = false
  /**
   * Session generation, incremented on sign-in and sign-out. A cycle remembers the generation it
   * started in and checks it after every await, before writing anything.
   */
  private session = 0
  /** Aborts the requests of the running cycle. */
  private cycleAbort: AbortController | null = null

  constructor(deps: SyncServiceDeps) {
    this.deps = deps
    this.repo = new SyncRepo(deps.store)
    this.applier = new RemoteApplier(deps.store, this.repo, deps.docs, () => this.repo.state().userId)
    deps.store.onOutbox = () => this.nudge()
  }

  private get store(): Store {
    return this.deps.store
  }

  signedIn(): boolean {
    return !!this.deps.token.get() && !!this.repo.state().userId
  }

  private client(withToken = true, signal?: AbortSignal): SyncClient {
    return new SyncClient(this.repo.state().serverUrl, withToken ? this.deps.token.get() || null : null, this.deps.fetchImpl, signal)
  }

  /** Throws when the session a cycle started in is over: nothing it received may be written. */
  private alive(gen: number): void {
    if (gen !== this.session) throw new SessionChanged()
  }

  /** Ends the current session: stops timers, cancels the running cycle and waits for it. */
  private async endSession(): Promise<void> {
    this.session++
    this.again = false
    this.stopTimers()
    this.cycleAbort?.abort()
    const running = this.running
    if (running) await running.catch(() => {})
  }

  status(): SyncStatus {
    const s = this.repo.state()
    return {
      serverUrl: s.serverUrl,
      signedIn: this.signedIn(),
      user: s.user,
      deviceId: s.deviceId,
      deviceName: s.deviceName || this.deps.deviceName,
      workspaces: s.workspaces,
      lastSyncAt: s.lastSyncAt,
      lastPushAt: s.lastPushAt,
      lastPullAt: s.lastPullAt,
      pending: this.repo.pendingCount(),
      lastError: s.lastError,
      syncing: this.syncing,
      streamConnected: this.streamConnected,
    }
  }

  private emitStatus(): void {
    this.deps.onStatus?.()
  }

  setServerUrl(raw: string): SyncStatus {
    if (this.signedIn()) throw new Error('Sign out before changing the server.')
    this.repo.updateState({ serverUrl: normalizeServerUrl(raw), lastError: null })
    this.emitStatus()
    return this.status()
  }

  async authConfig(): Promise<AuthConfigStatus> {
    try {
      const c = await this.client(false).googleConfig()
      return { reachable: true, googleConfigured: !!c?.clientId, devAuth: c?.devAuth === true, error: null }
    } catch (err) {
      return { reachable: false, googleConfigured: false, devAuth: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---- sign-in ----

  private deviceInfo() {
    return { name: this.deps.deviceName, platform: this.deps.platform, id: this.store.deviceId }
  }

  async signInGoogle(signal?: AbortSignal): Promise<SyncStatus> {
    const client = this.client(false)
    const cfg = await client.googleConfig()
    if (!cfg?.clientId) throw new Error('Google sign-in is not configured on this server yet (no client id).')
    if (!this.deps.openBrowser) throw new Error('No browser available for sign-in.')
    const r = await loopbackAuthorize({ clientId: cfg.clientId, openBrowser: this.deps.openBrowser, signal })
    const auth = await client.googleExchange({ code: r.code, codeVerifier: r.codeVerifier, redirectUri: r.redirectUri, device: this.deviceInfo() })
    return this.completeSignIn(auth)
  }

  async signInDev(email: string): Promise<SyncStatus> {
    const client = this.client(false)
    const cfg = await client.googleConfig().catch(() => null)
    if (cfg && cfg.devAuth !== true) throw new Error('Dev sign-in is disabled on this server.')
    const e = SAFE_TEXT(email, 200)
    if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new Error('Enter an email address.')
    const auth = await client.devAuth({ email: e, deviceName: this.deps.deviceName, platform: this.deps.platform, deviceId: this.store.deviceId })
    return this.completeSignIn(auth)
  }

  async completeSignIn(auth: AuthResponse): Promise<SyncStatus> {
    if (!auth?.deviceToken || !auth.user?.id) throw new Error('The server returned an incomplete sign-in response.')
    // A new session: a cycle of an earlier one (e.g. after the device was revoked) must not write.
    await this.endSession()
    const prev = this.repo.state()
    if (prev.userId !== auth.user.id && (prev.userId || prev.cursor !== 0 || this.repo.hasRemoteRows())) {
      // Another account (or leftovers of an unfinished sign-out): nothing from it may stay.
      this.repo.purgeRemote()
      this.repo.updateState({ cursor: 0 })
    }
    this.deps.token.set(auth.deviceToken)
    if (auth.device?.id) this.store.setDeviceId(auth.device.id)
    this.repo.updateState({
      userId: auth.user.id,
      user: auth.user,
      deviceName: auth.device?.name || this.deps.deviceName,
      lastError: null,
    })
    this.store.setSyncEnabled(true)
    this.repo.backfill(this.deps.backfillDays ?? 30)
    // Observation upload may have been switched off while signed out: remove what an earlier
    // session left on the server.
    if (!this.store.syncPolicy.observations) requeueObservations(this.store, false)
    this.needsDocBackfill = true
    this.failures = 0
    try {
      await this.me()
    } catch {
      /* workspaces load on the next status refresh */
    }
    this.start()
    await this.run()
    return this.status()
  }

  async signOut(): Promise<SyncStatus> {
    const wasSignedIn = this.signedIn()
    const revokeClient = wasSignedIn ? this.client() : null
    const deviceId = this.store.deviceId
    // No new cycle may start (no token), nothing more is queued; then cancel the running cycle and
    // wait for it, so nothing it pulls or pushes lands after the purge.
    this.stop()
    this.deps.token.set('')
    this.store.setSyncEnabled(false)
    await this.endSession()
    if (revokeClient) {
      try {
        await revokeClient.revokeDevice(deviceId)
      } catch {
        /* offline or already revoked: the local sign-out still happens */
      }
    }
    this.repo.purgeRemote()
    this.repo.updateState({ userId: null, user: null, workspaces: [], cursor: 0, lastError: null, lastSyncAt: null, lastPullAt: null, lastPushAt: null })
    this.deps.onCardsChanged?.()
    this.deps.onProjectsChanged?.()
    this.emitStatus()
    return this.status()
  }

  /** The server no longer accepts our token (device revoked): stop syncing, keep local data. */
  private authLost(): void {
    this.session++
    this.stop()
    this.deps.token.set('')
    this.store.setSyncEnabled(false)
    this.repo.updateState({ lastError: 'The server rejected this device (signed out or revoked). Sign in again to resume syncing.' })
    this.emitStatus()
  }

  // ---- loops ----

  start(): void {
    if (!this.signedIn()) return
    if (!this.deps.background) return
    this.stopTimers()
    this.timers.push(setInterval(() => void this.run(), 60_000))
    if (!this.streaming) {
      this.streaming = true
      void this.streamLoop()
    }
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const t of [this.retryTimer, this.pushTimer, this.pullTimer]) if (t) clearTimeout(t)
    this.retryTimer = this.pushTimer = this.pullTimer = null
  }

  stop(): void {
    this.stopTimers()
    this.streaming = false
    this.streamAbort?.abort()
    this.streamAbort = null
    this.streamConnected = false
  }

  /** Something was queued: push soon (debounced). */
  /**
   * Applies Settings → Sync & team → "What leaves this PC". Cards are re-checked on the next cycle;
   * switching observation upload off sends tombstones so the server drops their text.
   */
  setPolicy(policy: SyncPolicy): void {
    const prev = this.store.syncPolicy
    if (samePolicy(prev, policy)) return
    this.store.syncPolicy = { ...policy, excludedCategories: [...policy.excludedCategories] }
    this.store.scopeDirty = true
    if (this.signedIn() && prev.observations !== policy.observations) requeueObservations(this.store, policy.observations)
    this.nudge()
  }

  nudge(): void {
    if (!this.deps.background || !this.signedIn()) return
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.run()
    }, this.deps.pushDebounceMs ?? 3000)
  }

  private schedulePull(): void {
    if (this.pullTimer) return
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null
      void this.run()
    }, 300)
  }

  /** One push + pull cycle; concurrent calls coalesce into one more cycle. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.cycle()
      } while (this.again && this.signedIn())
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  syncNow(): Promise<void> {
    return this.run()
  }

  private async cycle(): Promise<void> {
    if (!this.signedIn()) return
    const gen = this.session
    const abort = new AbortController()
    this.cycleAbort = abort
    this.syncing = true
    this.emitStatus()
    try {
      this.rejectNote = null
      // Pull first: edits from the user's other devices are merged locally before this device
      // re-sends any card, so a scope change never overrides an edit it hasn't seen yet.
      await this.pull(gen, abort.signal)
      this.alive(gen)
      // Scopes may have changed (project confirmed, archived or deleted, a category edit, policy).
      rescopeCards(this.store)
      await this.push(gen, abort.signal)
      if (this.needsDocBackfill) {
        this.needsDocBackfill = false
        this.backfillDocs()
        await this.push(gen, abort.signal)
      }
      this.alive(gen)
      this.failures = 0
      this.repo.updateState({ lastSyncAt: Date.now(), lastError: this.rejectNote })
    } catch (err) {
      // The session ended while this cycle ran (sign-out / sign-in): drop the cycle silently.
      if (err instanceof SessionChanged || gen !== this.session) return
      if (err instanceof HttpError && err.status === 401) {
        this.authLost()
        return
      }
      this.failures++
      this.repo.updateState({ lastError: err instanceof Error ? err.message : String(err) })
      if (this.deps.background && this.signedIn()) {
        const delay = Math.min(MAX_BACKOFF, 5000 * 2 ** (this.failures - 1))
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.run()
        }, delay)
      }
    } finally {
      if (this.cycleAbort === abort) this.cycleAbort = null
      this.syncing = false
      this.emitStatus()
    }
  }

  private async push(gen: number, signal?: AbortSignal): Promise<void> {
    const userId = this.repo.state().userId
    if (!userId) return
    const client = this.client(true, signal)
    for (let guard = 0; guard < 200; guard++) {
      this.alive(gen)
      const entries = this.repo.pending(1000)
      if (entries.length === 0) return
      const batch = buildBatch(this.store, this.repo, this.deps.docs, userId, entries)
      if (batch.dropped.length) this.repo.markPushed(batch.dropped)
      if (batch.changes.length === 0) continue
      let res
      try {
        res = await client.push(batch.changes)
      } catch (err) {
        this.alive(gen)
        this.repo.markFailed(batch.used, err instanceof Error ? err.message : String(err))
        throw err
      }
      this.alive(gen)
      if (typeof res?.serverTime === 'number') this.store.observeHlc(formatHlc(res.serverTime, 0, 'server'))
      // Rejections carry only an id; a batch never holds two changes with one id (buildBatch), and
      // each rejection is matched to one change (keyed per change, not per id).
      const reasons = matchRejections(batch.changes, Array.isArray(res?.rejected) ? res.rejected : [])
      const ok = []
      const bad = []
      for (let i = 0; i < batch.used.length; i++) {
        const reason = reasons[i]
        if (reason === undefined) ok.push(batch.used[i])
        else bad.push({ entry: batch.used[i], reason })
      }
      // Remember what the server now holds (card scope, observation uploaded) for accepted changes only.
      commitAccepted(batch, (i) => reasons[i] === undefined)
      this.repo.markPushed(ok)
      if (bad.length) {
        this.repo.markRejected(bad)
        this.rejectNote = `${bad.length} change${bad.length > 1 ? 's were' : ' was'} rejected by the server: ${bad[0].reason}`
      }
      this.repo.updateState({ lastPushAt: Date.now() })
    }
  }

  private async pull(gen: number, signal?: AbortSignal): Promise<void> {
    const client = this.client(true, signal)
    let cursor = this.repo.state().cursor
    const total: ApplyResult = { applied: 0, skipped: 0, cards: false, projects: false, docs: [] }
    for (let guard = 0; guard < 1000; guard++) {
      this.alive(gen)
      const r = await client.pull(cursor, 1000)
      this.alive(gen)
      const changes = Array.isArray(r?.changes) ? r.changes : []
      const res = this.applier.apply(changes)
      total.applied += res.applied
      total.skipped += res.skipped
      total.cards ||= res.cards
      total.projects ||= res.projects
      for (const d of res.docs) if (!total.docs.includes(d)) total.docs.push(d)
      if (typeof r?.cursor === 'number' && r.cursor >= cursor) cursor = r.cursor
      this.repo.updateState({ cursor, lastPullAt: Date.now() })
      if (!r?.more || changes.length === 0) break
    }
    if (total.cards) this.deps.onCardsChanged?.()
    if (total.projects) this.deps.onProjectsChanged?.()
    if (total.docs.length) this.deps.onDocsChanged?.(total.docs)
  }

  /** After the first pull: upload local standups/day goals/categories the server has no newer copy of. */
  private backfillDocs(): void {
    const since = new Date(Date.now() - (this.deps.backfillDays ?? 30) * 86400_000).toISOString().slice(0, 10)
    const db = this.store.db
    try {
      for (const r of db.prepare('SELECT standup_day AS d FROM daily_standup_entries WHERE standup_day >= ?').all(since) as { d: string }[]) {
        if (!this.repo.metaHlc(`standup:${r.d}`)) this.repo.recordDoc('standup', r.d)
      }
      for (const r of db.prepare('SELECT day AS d FROM day_goals WHERE day >= ?').all(since) as { d: string }[]) {
        if (!this.repo.metaHlc(`day_goal:${r.d}`)) this.repo.recordDoc('day_goal', r.d)
      }
    } catch {
      /* Daily tables not created yet */
    }
    if (!this.repo.metaHlc('user_doc:categories') && this.deps.docs.read('user_doc', 'categories') != null) {
      this.repo.recordDoc('user_doc', 'categories')
    }
  }

  private async streamLoop(): Promise<void> {
    let delay = 2000
    while (this.streaming && this.signedIn()) {
      const ac = new AbortController()
      this.streamAbort = ac
      let watchdog: NodeJS.Timeout | null = null
      const feed = () => {
        if (watchdog) clearTimeout(watchdog)
        // The server sends a heartbeat every 25 s; silence for 70 s means a dead connection.
        watchdog = setTimeout(() => ac.abort(), 70_000)
      }
      try {
        feed()
        await this.client().stream(
          (event) => {
            if (event === 'changed') this.schedulePull()
          },
          ac.signal,
          () => {
            this.streamConnected = true
            delay = 2000
            this.emitStatus()
            void this.run()
          },
          feed,
        )
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) {
          if (watchdog) clearTimeout(watchdog)
          this.streamConnected = false
          this.authLost()
          return
        }
      }
      if (watchdog) clearTimeout(watchdog)
      if (this.streamConnected) {
        this.streamConnected = false
        this.emitStatus()
      }
      if (!this.streaming) break
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(60_000, delay * 2)
    }
  }

  // ---- account ----

  async me(): Promise<MeView> {
    const r: MeResponse = await this.client().me()
    this.repo.updateState({ user: r.user, workspaces: r.workspaces ?? [] })
    this.emitStatus()
    return {
      user: r.user,
      workspaces: r.workspaces ?? [],
      devices: (r.devices ?? []).map((d) => ({ ...d, current: d.current ?? d.id === this.store.deviceId })),
    }
  }

  async revokeDevice(id: string): Promise<MeView> {
    if (id === this.store.deviceId) {
      await this.signOut()
      throw new Error('This device was signed out.')
    }
    await this.client().revokeDevice(id)
    return this.me()
  }

  async webLink(): Promise<string> {
    const r = await this.client().webLink()
    if (!r?.url || !/^https?:\/\//.test(r.url)) throw new Error('The server did not return a dashboard link.')
    return r.url
  }

  // ---- projects ----

  isAdmin(workspaceId: string): boolean {
    const w = this.repo.state().workspaces.find((x) => x.id === workspaceId)
    return w?.role === 'owner' || w?.role === 'admin'
  }

  listProjects(): ProjectView[] {
    return this.repo.projectViews(this.repo.state().userId)
  }

  saveProject(raw: ProjectDraft): ProjectView {
    if (!this.signedIn()) throw new Error('Sign in to a sync server first.')
    const d = sanitizeProjectDraft(raw)
    if (!this.isAdmin(d.workspaceId)) throw new Error('Only workspace owners and admins can edit projects.')
    if (d.id) {
      const cur = this.repo.project(d.id)
      if (cur && cur.workspaceId !== d.workspaceId) throw new Error('A project cannot move to another workspace.')
    }
    const row = this.repo.saveProject(d)
    this.deps.onProjectsChanged?.()
    return this.listProjects().find((p) => p.id === row.id)!
  }

  setMyShare(projectId: string, level: ShareLevel | null): void {
    const uid = this.repo.state().userId
    if (!uid) throw new Error('Sign in to a sync server first.')
    if (level !== null && !SHARE_LEVELS.includes(level)) throw new Error('Unknown share level')
    if (!this.repo.project(projectId)) throw new Error('Unknown project')
    this.repo.setMyShare(projectId, uid, level)
    this.deps.onProjectsChanged?.()
  }

  assignCard(cardId: number, projectId: string | null): void {
    const card = this.store.getCard(cardId)
    if (!card?.uuid) throw new Error('Card not found')
    if (card.isError) throw new Error('Error cards cannot be assigned to projects.')
    if (projectId && !this.repo.project(projectId)) throw new Error('Unknown project')
    this.repo.setManualProject(card.uuid, projectId)
    if (card.detailProjects) this.store.editCard(cardId, { detailProjects: {} })
    this.deps.onCardsChanged?.()
  }

  editDetailProject(cardId: number, key: string, projectId: string, action: 'add' | 'remove' | 'confirm'): void {
    const stored = this.store.getCard(cardId)
    if (!stored) throw new Error('Card not found')
    const card = this.repo.attachProjects([stored])[0]
    if (!card?.uuid || card.isError) throw new Error('Card not found')
    const project = this.repo.project(projectId)
    if (!project || (action === 'add' && project.archived)) throw new Error('Project is not available')
    const rows = initialDetailProjects(card)
    if (!(key in rows)) throw new Error('Unknown detail line')
    const current = rows[key]
    if (action === 'add' && !current.some((p) => p.projectId === projectId)) {
      current.push({ projectId, share: 1, source: 'manual', confidence: 1, confirmed: true })
      for (const p of current) p.share = 1 / current.length
    }
    if (action === 'remove') {
      rows[key] = current.filter((p) => p.projectId !== projectId)
      const remaining = rows[key]
      const total = remaining.reduce((sum, p) => sum + Math.max(0, p.share), 0)
      if (total > 0) for (const p of remaining) p.share /= total
    }
    if (action === 'confirm') {
      const p = current.find((p) => p.projectId === projectId)
      if (p) { p.confirmed = true; p.source = 'manual'; p.confidence = 1 }
    }
    this.store.editCard(cardId, { detailProjects: rows })
    this.repo.setAssignments(card.uuid, detailProjectShares(card, rows))
    this.store.scopeDirty = true
    this.deps.onCardsChanged?.()
  }

  confirmCard(cardId: number, projectId: string): void {
    const card = this.store.getCard(cardId)
    if (!card?.uuid) throw new Error('Card not found')
    if (card.detailProjects && Object.keys(card.detailProjects).length) {
      const rows = initialDetailProjects(this.repo.attachProjects([card])[0])
      for (const refs of Object.values(rows)) for (const ref of refs) if (ref.projectId === projectId) {
        ref.confirmed = true
        ref.source = 'manual'
        ref.confidence = 1
      }
      this.store.editCard(cardId, { detailProjects: rows })
      this.repo.setAssignments(card.uuid, detailProjectShares(card, rows))
      this.store.scopeDirty = true
      this.deps.onCardsChanged?.()
      return
    }
    this.repo.confirmProject(card.uuid, projectId)
    this.deps.onCardsChanged?.()
  }

  // ---- team ----

  async feed(projectId: string, from: string, to: string): Promise<ProjectEntry[]> {
    checkRange(from, to)
    const r = await this.client().projectFeed(projectId, from, to)
    return Array.isArray(r) ? r : (r?.entries ?? [])
  }

  async report(projectId: string, from: string, to: string): Promise<ProjectReport> {
    checkRange(from, to)
    return this.client().projectReport(projectId, from, to)
  }

  async proposals(from: string, to: string, workspaceId: string): Promise<TimesheetProposalsView> {
    checkRange(from, to)
    const r = await this.client().timesheetProposals(from, to, workspaceId)
    if (Array.isArray(r)) return { proposals: r, odooConfigured: true, employeeMapped: true }
    return { proposals: r?.proposals ?? [], odooConfigured: r?.odooConfigured !== false, employeeMapped: r?.employeeMapped !== false }
  }

  async submitTimesheets(req: TimesheetSubmitRequest): Promise<TimesheetSubmitResult> {
    return this.client().timesheetSubmit(sanitizeSubmit(req))
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function checkRange(from: string, to: string): void {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) throw new Error('Invalid date range')
}

function cleanList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = [...new Set(v.map((x) => SAFE_TEXT(x, 200)).filter(Boolean))].slice(0, 100)
  return out.length ? out : undefined
}

export function sanitizeProjectDraft(raw: ProjectDraft): ProjectDraft {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid project')
  const name = SAFE_TEXT(raw.name, 120)
  if (!name) throw new Error('A project needs a name.')
  const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : '#7BC47F'
  const workspaceId = SAFE_TEXT(raw.workspaceId, 100)
  if (!workspaceId) throw new Error('Pick a workspace.')
  if (!SHARE_LEVELS.includes(raw.defaultShare)) throw new Error('Unknown share level')
  const r = (raw.rules ?? {}) as Record<string, unknown>
  const o = (raw.odoo ?? {}) as Record<string, unknown>
  const int = (v: unknown) => {
    const n = typeof v === 'string' && v.trim() ? Number(v) : v
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined
  }
  return {
    id: typeof raw.id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : undefined,
    workspaceId,
    name,
    color,
    icon: SAFE_TEXT(raw.icon, 16),
    description: SAFE_TEXT(raw.description, 2000),
    rules: {
      apps: cleanList(r.apps),
      domains: cleanList(r.domains),
      titleKeywords: cleanList(r.titleKeywords),
      repos: cleanList(r.repos),
    },
    defaultShare: raw.defaultShare,
    odoo: {
      projectId: int(o.projectId),
      taskId: int(o.taskId),
      projectName: SAFE_TEXT(o.projectName, 200) || undefined,
      taskName: SAFE_TEXT(o.taskName, 200) || undefined,
    },
    archived: raw.archived === true,
  }
}

export function sanitizeSubmit(req: TimesheetSubmitRequest): TimesheetSubmitRequest {
  if (!req || !Array.isArray(req.lines) || req.lines.length === 0) throw new Error('Nothing to submit')
  if (req.lines.length > 500) throw new Error('Too many lines')
  return {
    lines: req.lines.map((l) => {
      if (!DAY_RE.test(l.day)) throw new Error('Invalid day')
      const hours = Number(l.hours)
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error(`Invalid hours for ${l.day}`)
      return {
        day: l.day,
        projectId: SAFE_TEXT(l.projectId, 100),
        hours: Math.round(hours * 100) / 100,
        description: SAFE_TEXT(l.description, 2000),
        cardIds: Array.isArray(l.cardIds) ? l.cardIds.filter((x) => typeof x === 'string').slice(0, 1000) : [],
      }
    }),
  }
}
