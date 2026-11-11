// Full client loop against a small in-process mock of the Dayflow Sync Server
// (config / dev auth / push / pull / SSE stream / me / devices / web-link).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SyncChange } from '../src/shared/sync-types.ts'
import { Store } from '../src/main/db.ts'
import type { ActivityCardData } from '../src/main/llm/types.ts'
import { makeDocSources } from '../src/main/sync/docs.ts'
import { syncHooks } from '../src/main/sync/hooks.ts'
import { SyncService } from '../src/main/sync/service.ts'
import { DailyStore } from '../src/main/daily/store.ts'

interface MockRecord {
  change: SyncChange
  seq: number
  userId: string
}

/** Server-side card merge per the contract: origin owns analysis fields, user fields merge by fieldHlc. */
function mergeCard(cur: SyncChange, next: SyncChange): SyncChange {
  const cd = { ...(cur.data ?? {}) } as Record<string, unknown>
  const nd = (next.data ?? {}) as Record<string, unknown>
  const origin = String(cd.originDeviceId ?? cur.deviceId)
  if (next.deviceId === origin) {
    for (const k of ['startTs', 'endTs', 'day', 'summary', 'detailedSummary', 'isError']) cd[k] = nd[k]
    cd.metadata = { ...(nd.metadata as object), private: (cd.metadata as { private?: boolean } | undefined)?.private }
  }
  const fh = { ...(cur.fieldHlc ?? {}) }
  let deleted = cur.deleted
  for (const f of ['title', 'category', 'subcategory', 'deleted', 'private']) {
    const h = next.fieldHlc?.[f]
    if (!h || h <= (fh[f] ?? '')) continue
    // Like the real server (engine.ts userFieldValue): an absent value is skipped, clock included.
    if (f === 'deleted' && typeof next.deleted !== 'boolean') continue
    fh[f] = h
    if (f === 'deleted') deleted = next.deleted
    else if (f === 'private') cd.metadata = { ...(cd.metadata as object), private: (nd.metadata as { private?: boolean } | undefined)?.private }
    else cd[f] = nd[f]
  }
  const hlc = next.hlc > cur.hlc ? next.hlc : cur.hlc
  return { entity: 'card', id: cur.id, deviceId: next.deviceId, hlc, data: cd, fieldHlc: fh, ...(deleted ? { deleted: true } : {}) }
}

function mockServer(opts: { devAuth: boolean; clientId?: string }) {
  let seq = 0
  const records = new Map<string, MockRecord>()
  const tokens = new Map<string, { userId: string; deviceId: string }>()
  const users = new Map<string, { id: string; email: string; name: string }>()
  const devices = new Map<string, { id: string; userId: string; name: string; revoked: boolean }>()
  const streams = new Set<ServerResponse>()
  const pushes: SyncChange[][] = []

  const body = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let s = ''
      req.on('data', (c) => (s += c))
      req.on('end', () => resolve(s ? JSON.parse(s) : null))
    })
  const send = (res: ServerResponse, status: number, json: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(json))
  }
  const auth = (req: IncomingMessage) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const a = t ? tokens.get(t) : undefined
    if (!a || devices.get(a.deviceId)?.revoked) return null
    return a
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    if (p === '/api/auth/google/config') return send(res, 200, { clientId: opts.clientId ?? '', devAuth: opts.devAuth })
    if (p === '/api/auth/dev' && req.method === 'POST') {
      if (!opts.devAuth) return send(res, 404, { error: 'disabled' })
      const b = (await body(req)) as { email: string; deviceName: string; deviceId?: string }
      let user = [...users.values()].find((u) => u.email === b.email)
      if (!user) {
        user = { id: `user-${users.size + 1}`, email: b.email, name: b.email.split('@')[0] }
        users.set(user.id, user)
      }
      const deviceId = `srv-${devices.size + 1}`
      devices.set(deviceId, { id: deviceId, userId: user.id, name: b.deviceName, revoked: false })
      const token = randomBytes(16).toString('hex')
      tokens.set(token, { userId: user.id, deviceId })
      return send(res, 200, {
        deviceToken: token,
        user: { ...user, avatarUrl: null },
        device: { id: deviceId, name: b.deviceName, platform: 'windows', lastSeenAt: null, revoked: false },
      })
    }
    const a = auth(req)
    if (!a) return send(res, 401, { error: 'unauthorized' })
    if (p === '/api/me') {
      return send(res, 200, {
        user: { ...users.get(a.userId)!, avatarUrl: null },
        devices: [...devices.values()].filter((d) => d.userId === a.userId).map((d) => ({ ...d, platform: 'windows', lastSeenAt: null })),
        workspaces: [{ id: 'ws-1', name: 'Veles', role: 'owner' }],
      })
    }
    if (p.startsWith('/api/devices/') && req.method === 'DELETE') {
      const d = devices.get(decodeURIComponent(p.slice('/api/devices/'.length)))
      if (d && d.userId === a.userId) d.revoked = true
      return send(res, 200, { ok: true })
    }
    if (p === '/api/auth/web-link') return send(res, 200, { url: 'http://dashboard.local/link?code=abc' })
    if (p === '/api/sync/push' && req.method === 'POST') {
      const b = (await body(req)) as { changes: SyncChange[] }
      pushes.push(b.changes)
      const rejected: { id: string; reason: string }[] = []
      let accepted = 0
      for (const c of b.changes) {
        if (c.deviceId !== a.deviceId) {
          rejected.push({ id: c.id, reason: 'foreign_device' })
          continue
        }
        // Like the real server: the change clock must carry the caller's device id.
        if (!c.hlc.endsWith(`-${a.deviceId}`)) {
          rejected.push({ id: c.id, reason: 'hlc_device_mismatch' })
          continue
        }
        const key = `${c.entity}:${c.id}`
        const cur = records.get(key)
        if (cur && c.entity === 'card') {
          records.set(key, { change: mergeCard(cur.change, c), seq: ++seq, userId: a.userId })
          accepted++
          continue
        }
        if (cur && cur.change.hlc >= c.hlc) continue
        records.set(key, { change: c, seq: ++seq, userId: a.userId })
        accepted++
      }
      for (const s of streams) s.write('event: changed\ndata: {}\n\n')
      return send(res, 200, { accepted, rejected, serverTime: Date.now() })
    }
    if (p === '/api/sync/pull') {
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 1000)
      const visible = [...records.values()]
        .filter((r) => r.seq > cursor && (r.userId === a.userId || r.change.entity === 'project'))
        .sort((x, y) => x.seq - y.seq)
      const page = visible.slice(0, limit)
      return send(res, 200, { changes: page.map((r) => r.change), cursor: page.length ? page[page.length - 1].seq : cursor, more: visible.length > limit })
    }
    if (p === '/api/sync/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(': hello\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    send(res, 404, { error: 'not found' })
  })
  return {
    server,
    records,
    pushes,
    devices,
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    },
    close() {
      for (const s of streams) s.destroy()
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    },
  }
}

function card(start: string, end: string, title: string, extra: Partial<ActivityCardData> = {}): ActivityCardData {
  return { startTime: start, endTime: end, category: 'Work', subcategory: '', title, summary: `${title} summary`, detailedSummary: '', ...extra }
}

const t9 = Math.floor(new Date(2026, 10, 8, 9, 0).getTime() / 1000)

/**
 * Set DAYFLOW_SYNC_E2E_URL to a real Dayflow Sync Server started with DEV_AUTH=1 (e.g. the temporary
 * `dayflow-e2e` stack behind an SSH tunnel) to run the sync-loop tests against it instead of the mock.
 */
const REAL_SERVER = process.env.DAYFLOW_SYNC_E2E_URL ?? ''

function device(dir: string, name: string, url: string, background = false) {
  const store = new Store(join(dir, `${name}.sqlite`))
  // The loop tests exchange full cards; the upload policy has its own tests (sync-scope.test.ts).
  store.syncPolicy = { excludedCategories: [], outOfScope: false, observations: true }
  let token = ''
  let cardsChanged = 0
  const settings = {
    categories: [
      { name: 'Work', color: '#B984FF', description: '' },
      { name: 'Idle', color: '#A0AEC0', description: '', isIdle: true },
    ],
  }
  const svc = new SyncService({
    store,
    docs: makeDocSources(store.db, {
      get: () => settings as never,
      update: (p) => Object.assign(settings, p),
    }),
    token: { get: () => token, set: (t) => (token = t) },
    deviceName: name,
    platform: 'windows',
    background,
    pushDebounceMs: 50,
    onCardsChanged: () => cardsChanged++,
  })
  svc.setServerUrl(url)
  return { store, svc, settings, cardsChanged: () => cardsChanged }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('sync loop: two devices of one user exchange cards, edits, projects and docs through the server', async () => {
  const mock = mockServer({ devAuth: true })
  const url = REAL_SERVER || (await mock.listen())
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-sync-int-'))
  const A = device(dir, 'desktop', url)
  const B = device(dir, 'laptop', url)
  try {
    // A had cards before signing in: they are backfilled on sign-in.
    const b1 = A.store.createBatch(t9, t9 + 900, [])
    A.store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Desktop: sync design')], b1)
    const provisional = A.store.deviceId

    const cfg = await A.svc.authConfig()
    assert.deepEqual(cfg, { reachable: true, googleConfigured: false, devAuth: true, error: null })
    await assert.rejects(A.svc.signInGoogle(), /not configured/)

    // Daily docs written before sign-in are uploaded after the first pull.
    const daily = new DailyStore(A.store.db)
    syncHooks.record = (entity, id) => A.svc.repo.recordDoc(entity, id)
    daily.saveStandup('2026-11-07', JSON.stringify({ done: ['shipped'] }))

    const st = await A.svc.signInDev('max@velesagro.pl')
    assert.equal(st.signedIn, true)
    assert.equal(st.user?.email, 'max@velesagro.pl')
    assert.equal(st.pending, 0)
    // The mock assigns a new device id; the real server keeps the client's proposed uuid. Either way the
    // local rows must carry the id the server registered.
    assert.equal(A.store.deviceId, st.deviceId ?? A.store.deviceId)
    if (!REAL_SERVER) assert.notEqual(A.store.deviceId, provisional, 'server-assigned device id adopted')
    assert.equal(A.store.cardsForDay('2026-11-08')[0].deviceId, A.store.deviceId)
    assert.deepEqual(st.workspaces.map((w) => w.role), ['owner'])

    await B.svc.signInDev('max@velesagro.pl')
    let onB = B.store.cardsForDay('2026-11-08')
    assert.deepEqual(onB.map((c) => c.title), ['Desktop: sync design'])
    assert.equal(onB[0].remote, true)
    assert.equal(onB[0].deviceId, A.store.deviceId)
    assert.equal(new DailyStore(B.store.db).fetchStandup('2026-11-07'), JSON.stringify({ done: ['shipped'] }))
    assert.ok(B.cardsChanged() > 0)

    // B renames A's card; A changes its category. Both edits survive on both devices.
    B.store.updateCardTitle(onB[0].id, 'Sync design (renamed on laptop)')
    const aCard = A.store.cardsForDay('2026-11-08')[0]
    A.store.updateCardCategory(aCard.id, 'Idle')
    await B.svc.syncNow()
    await A.svc.syncNow()
    await B.svc.syncNow()
    const a1 = A.store.getCard(aCard.id)!
    assert.equal(a1.title, 'Sync design (renamed on laptop)')
    assert.equal(a1.category, 'Idle')
    onB = B.store.cardsForDay('2026-11-08')
    assert.equal(onB[0].title, 'Sync design (renamed on laptop)')
    assert.equal(onB[0].category, 'Idle')

    // B analyses its own overlapping time: A's card on B stays; A's analysis doesn't touch B's card.
    const bb = B.store.createBatch(t9, t9 + 900, [])
    B.store.replaceCardsInRange(t9, t9 + 2700, [card('9:00 AM', '9:20 AM', 'Laptop: email')], bb)
    await B.svc.syncNow()
    await A.svc.syncNow()
    const ab = A.store.createBatch(t9 + 900, t9 + 1800, [])
    A.store.replaceCardsInRange(t9, t9 + 2700, [card('9:00 AM', '9:40 AM', 'Desktop: sync design v2')], ab)
    assert.deepEqual(A.store.cardsForDay('2026-11-08').map((c) => c.title).sort(), ['Desktop: sync design v2', 'Laptop: email'])
    await A.svc.syncNow()
    await B.svc.syncNow()
    assert.deepEqual(B.store.cardsForDay('2026-11-08').map((c) => c.title).sort(), ['Desktop: sync design v2', 'Laptop: email'])
    assert.deepEqual(A.store.cardsForDay('2026-11-08', true).map((c) => c.title), ['Desktop: sync design v2'])
    assert.deepEqual(B.store.cardsForDay('2026-11-08', true).map((c) => c.title), ['Laptop: email'])

    // Admin creates a project on A; B receives it. Manual assignment + private flag sync too.
    const wsId = REAL_SERVER ? (await A.svc.me()).workspaces[0].id : 'ws-1'
    const proj = A.svc.saveProject({
      workspaceId: wsId,
      name: 'Dayflow',
      color: '#336699',
      description: 'desktop app',
      rules: { apps: ['code'] },
      defaultShare: 'cards',
      odoo: { projectId: 12, taskId: 34, projectName: 'Internal', taskName: 'Dayflow' },
    })
    const v2 = A.store.cardsForDay('2026-11-08').find((c) => c.title === 'Desktop: sync design v2')!
    A.svc.assignCard(v2.id, proj.id)
    A.store.setCardPrivate(v2.id, true)
    A.svc.setMyShare(proj.id, 'time')
    await A.svc.syncNow()
    await B.svc.syncNow()
    assert.deepEqual(B.svc.listProjects().map((p) => [p.name, p.defaultShare, p.odoo.taskId, p.myShare]), [['Dayflow', 'cards', 34, 'time']])
    assert.equal(A.svc.status().lastError, null, 'no change was rejected')
    assert.equal(B.svc.status().lastError, null, 'no change was rejected')
    // A private card never leaves its PC: the copy B already had is removed, and on A it stays intact.
    const onB2 = B.svc.repo.attachProjects(B.store.cardsForDay('2026-11-08')).find((c) => c.uuid === v2.uuid)
    assert.equal(onB2, undefined)
    const onA2 = A.svc.repo.attachProjects(A.store.cardsForDay('2026-11-08')).find((c) => c.uuid === v2.uuid)!
    assert.equal(onA2.private, true)
    assert.equal(onA2.title, 'Desktop: sync design v2')
    assert.deepEqual(onA2.projects?.map((p) => [p.name, p.source, p.confirmed]), [['Dayflow', 'manual', true]])

    // Nothing but non-error, non-chat records went up; every change came from the caller's device.
    const all = REAL_SERVER ? [] : mock.pushes.flat()
    assert.ok(all.every((c) => ['card', 'observation', 'card_project', 'standup', 'day_goal', 'user_doc', 'project', 'project_member'].includes(c.entity)))
    assert.ok(all.every((c) => c.entity !== 'card' || (c.data as { isError?: boolean } | undefined)?.isError !== true))

    // Web dashboard link, device list, revoke.
    assert.match(await A.svc.webLink(), REAL_SERVER ? /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/web-link\// : /^http:\/\/dashboard\.local/)
    const me = await A.svc.me()
    assert.equal(me.devices.length, 2)
    assert.equal(me.devices.find((d) => d.current)?.id, A.store.deviceId)
    await A.svc.revokeDevice(B.store.deviceId)
    await B.svc.syncNow()
    assert.equal(B.svc.status().signedIn, false, 'revoked device stops syncing')
    assert.match(B.svc.status().lastError ?? '', /rejected this device/)

    // Signing out removes other devices' cards and projects, keeps own cards.
    await A.svc.signOut()
    assert.deepEqual(A.store.cardsForDay('2026-11-08').map((c) => c.title), ['Desktop: sync design v2'])
    assert.equal(A.svc.listProjects().length, 0)
    assert.equal(A.svc.status().pending, 0)
  } finally {
    syncHooks.record = null
    A.svc.stop()
    B.svc.stop()
    A.store.close()
    B.store.close()
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sync loop: SSE "changed" events trigger a pull; writes are pushed after a debounce', async () => {
  const mock = mockServer({ devAuth: true })
  const url = REAL_SERVER || (await mock.listen())
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-sync-int-'))
  const A = device(dir, 'desktop', url, true)
  const B = device(dir, 'laptop', url, true)
  try {
    await A.svc.signInDev('team@velesagro.pl')
    await B.svc.signInDev('team@velesagro.pl')
    await waitFor(() => B.svc.status().streamConnected)
    // A analyses a batch: the outbox nudge pushes it, the server notifies B's stream, B pulls.
    const b = A.store.createBatch(t9, t9 + 900, [])
    A.store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Pushed live')], b)
    await waitFor(() => B.store.cardsForDay('2026-11-08').some((c) => c.title === 'Pushed live'))
    assert.equal(A.svc.status().pending, 0)
  } finally {
    A.svc.stop()
    B.svc.stop()
    await mock.close()
    A.store.close()
    B.store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sign-in: dev auth is refused when the server does not offer it', async () => {
  const mock = mockServer({ devAuth: false })
  const url = await mock.listen()
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-sync-int-'))
  const A = device(dir, 'desktop', url)
  try {
    assert.deepEqual(await A.svc.authConfig(), { reachable: true, googleConfigured: false, devAuth: false, error: null })
    await assert.rejects(A.svc.signInDev('a@b.c'), /disabled/)
    assert.equal(A.svc.status().signedIn, false)
    const unreachable = device(dir, 'other', 'http://127.0.0.1:9')
    const cfg = await unreachable.svc.authConfig()
    assert.equal(cfg.reachable, false)
    unreachable.store.close()
  } finally {
    A.store.close()
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('upload policy: out-of-scope and personal cards across two devices (DAYFLOW_SYNC_E2E_URL)', { skip: !REAL_SERVER }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-scope-e2e-'))
  const A = device(dir, 'desktop', REAL_SERVER)
  const B = device(dir, 'laptop', REAL_SERVER)
  // A uses the default policy: Personal never leaves, unassigned work is "Out of scope", no observations.
  A.store.syncPolicy = { excludedCategories: ['Personal'], outOfScope: true, observations: false }
  try {
    await A.svc.signInDev('scope@velesagro.pl')
    await B.svc.signInDev('scope@velesagro.pl')
    const b1 = A.store.createBatch(t9, t9 + 3600, [])
    A.store.replaceCardsInRange(t9, t9 + 3600, [
      card('9:00 AM', '9:30 AM', 'Biosun invoice import'),
      card('9:30 AM', '10:00 AM', 'Booked the dentist', { category: 'Personal' }),
    ], b1)
    A.store.saveObservations(b1, [{ startTs: t9, endTs: t9 + 60, observation: 'reading private messages' }], 'm')
    await A.svc.syncNow()
    await B.svc.syncNow()
    let onB = B.store.cardsForDay('2026-11-08').map((c) => c.title).sort()
    assert.deepEqual(onB, ['Out of scope'], 'work arrives without content; the personal card not at all')
    assert.equal((B.store.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, 0, 'no observations uploaded')

    // Confirming a project publishes the card in full; the server accepts it over the redacted copy.
    const wsId = (await A.svc.me()).workspaces[0]?.id
    if (wsId) {
      const proj = A.svc.saveProject({ workspaceId: wsId, name: 'Biosun', color: '#336699', description: '', rules: {}, defaultShare: 'cards', odoo: {} })
      const work = A.store.cardsForDay('2026-11-08').find((c) => c.title === 'Biosun invoice import')!
      A.svc.assignCard(work.id, proj.id)
      await A.svc.syncNow()
      await B.svc.syncNow()
      onB = B.store.cardsForDay('2026-11-08').map((c) => c.title).sort()
      assert.deepEqual(onB, ['Biosun invoice import'])
    }
    // A's own cards are untouched by the redacted echoes.
    assert.deepEqual(A.store.cardsForDay('2026-11-08').map((c) => c.title).sort(), ['Biosun invoice import', 'Booked the dentist'])
  } finally {
    A.store.close()
    B.store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A fresh account per run, so a long-lived real server never mixes in cards of earlier runs. */
const freshEmail = (tag: string) => `${tag}-${randomBytes(4).toString('hex')}@velesagro.pl`

test('upload policy: a card leaving the "excluded" scope is restored on the other device (S1)', async () => {
  const mock = mockServer({ devAuth: true })
  const url = REAL_SERVER || (await mock.listen())
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-s1-'))
  const A = device(dir, 'desktop', url)
  const B = device(dir, 'laptop', url)
  A.store.syncPolicy = { excludedCategories: ['Personal'], outOfScope: false, observations: false }
  try {
    const email = freshEmail('s1')
    await A.svc.signInDev(email)
    await B.svc.signInDev(email)
    const b1 = A.store.createBatch(t9, t9 + 1800, [])
    A.store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Booked the dentist', { category: 'Personal' })], b1)
    await A.svc.syncNow()
    await B.svc.syncNow()
    assert.deepEqual(B.store.cardsForDay('2026-11-08').map((c) => c.title), [], 'excluded: nothing visible on B')

    // "Personal" is no longer excluded: the card goes up in full and must not stay deleted on the server.
    A.svc.setPolicy({ excludedCategories: [], outOfScope: false, observations: false })
    await A.svc.syncNow()
    await B.svc.syncNow()
    assert.deepEqual(B.store.cardsForDay('2026-11-08').map((c) => c.title), ['Booked the dentist'])
    assert.equal(A.svc.status().lastError, null)
    if (!REAL_SERVER) {
      const sent = mock.pushes.flat().filter((c) => c.entity === 'card')
      assert.ok(sent.every((c) => typeof c.deleted === 'boolean'), 'deleted is always sent as a boolean')
    }
  } finally {
    A.svc.stop()
    B.svc.stop()
    A.store.close()
    B.store.close()
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sign-out → sign-in: our own scoped echoes (old device id) leave the local cards intact (S2)', async () => {
  const mock = mockServer({ devAuth: true })
  const url = REAL_SERVER || (await mock.listen())
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-s2-'))
  const A = device(dir, 'desktop', url)
  A.store.syncPolicy = { excludedCategories: ['Personal'], outOfScope: true, observations: false }
  try {
    const email = freshEmail('s2')
    await A.svc.signInDev(email)
    const b1 = A.store.createBatch(t9, t9 + 3600, [])
    A.store.replaceCardsInRange(
      t9,
      t9 + 3600,
      [card('9:00 AM', '9:30 AM', 'Biosun invoice import'), card('9:30 AM', '10:00 AM', 'Booked the dentist', { category: 'Personal' })],
      b1,
    )
    await A.svc.syncNow()
    const firstId = A.store.deviceId
    await A.svc.signOut()
    await A.svc.signInDev(email)
    assert.notEqual(A.store.deviceId, firstId, 'a new device id after signing in again')
    await A.svc.syncNow()
    const cards = A.store.cardsForDay('2026-11-08')
    assert.deepEqual(cards.map((c) => [c.title, c.category]).sort(), [
      ['Biosun invoice import', 'Work'],
      ['Booked the dentist', 'Personal'],
    ])
    assert.equal(A.svc.status().lastError, null)
  } finally {
    A.svc.stop()
    A.store.close()
    await mock.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
