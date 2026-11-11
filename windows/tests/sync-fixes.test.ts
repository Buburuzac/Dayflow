// Regression tests for the sync fixes shared with the macOS client (S1–S9).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncChange } from '../src/shared/sync-types.ts'
import type { Category, Settings } from '../src/shared/types.ts'
import { Store } from '../src/main/db.ts'
import type { ActivityCardData } from '../src/main/llm/types.ts'
import { SyncRepo } from '../src/main/sync/repo.ts'
import { buildBatch, commitAccepted, matchRejections, requeueObservations, rescopeCards } from '../src/main/sync/outbox.ts'
import { RemoteApplier } from '../src/main/sync/apply.ts'
import { makeDocSources, type DocSources } from '../src/main/sync/docs.ts'
import { DEFAULT_SYNC_POLICY, OUT_OF_SCOPE_LABEL } from '../src/main/sync/scope.ts'
import { SyncService } from '../src/main/sync/service.ts'
import { detectCategoryRenames, mergeCategoryLists, toggleExcluded, withRenamedExclusions } from '../src/shared/sync-categories.ts'

const noDocs: DocSources = { read: () => null, write: () => {} }
const t9 = Math.floor(new Date(2026, 10, 8, 9, 0).getTime() / 1000)

function card(start: string, end: string, title: string, category = 'Work'): ActivityCardData {
  return { startTime: start, endTime: end, category, subcategory: 'dev', title, summary: `${title} summary`, detailedSummary: 'details' }
}

function withStore(fn: (store: Store, repo: SyncRepo, dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dayflow-fixes-'))
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      store.setSyncEnabled(true)
      store.syncPolicy = { ...DEFAULT_SYNC_POLICY }
      await fn(store, new SyncRepo(store), dir)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Builds and "pushes" everything queued, the server accepting it all. */
function flush(store: Store, repo: SyncRepo, docs: DocSources = noDocs): SyncChange[] {
  const batch = buildBatch(store, repo, docs, 'user-1', repo.pending(1000))
  commitAccepted(batch, () => true)
  repo.markPushed(batch.used)
  repo.markPushed(batch.dropped)
  return batch.changes
}

const title = (c: SyncChange) => (c.data as { title: string }).title

// ---- S1 ----

test(
  'S1: deleted is always a boolean; a card leaving "excluded" is sent with deleted: false',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 3600, [])
    store.replaceCardsInRange(t9, t9 + 3600, [card('9:00 AM', '9:30 AM', 'Work'), card('9:30 AM', '10:00 AM', 'Dentist', 'Personal')], b)
    const first = flush(store, repo).filter((c) => c.entity === 'card')
    assert.equal(first.length, 2)
    assert.ok(first.every((c) => typeof c.deleted === 'boolean'))
    assert.equal(first.find((c) => c.fieldHlc && title(c) === OUT_OF_SCOPE_LABEL && c.deleted === false) !== undefined, true)
    const personal = first.filter((c) => c.deleted === true)
    assert.equal(personal.length, 1)

    store.syncPolicy = { ...store.syncPolicy, excludedCategories: [] }
    store.scopeDirty = true
    assert.equal(rescopeCards(store), 1)
    const again = flush(store, repo).filter((c) => c.entity === 'card')
    assert.equal(again.length, 1)
    assert.equal(again[0].id, personal[0].id)
    assert.equal(again[0].deleted, false, 'explicitly undeleted')
    assert.ok(again[0].fieldHlc!.deleted > personal[0].fieldHlc!.deleted, 'with a newer deleted clock')
  }),
)

// ---- S2 ----

test(
  'S2: after a device id change, re-pulling our own scoped echoes leaves the local cards intact',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 3600, [])
    store.replaceCardsInRange(t9, t9 + 3600, [card('9:00 AM', '9:30 AM', 'Real title'), card('9:30 AM', '10:00 AM', 'Dentist', 'Personal')], b)
    const echoes = flush(store, repo).filter((c) => c.entity === 'card')
    assert.equal(echoes.length, 2)
    assert.ok(echoes.every((c) => title(c) === OUT_OF_SCOPE_LABEL))
    // Local field clocks now carry the scope clocks that were sent.
    const row = store.db.prepare('SELECT field_hlc FROM timeline_cards WHERE uuid = ?').get(echoes[0].id) as { field_hlc: string }
    assert.equal(JSON.parse(row.field_hlc).title, echoes[0].fieldHlc!.title)

    // Sign-out → sign-in: a new device id, the cursor restarts and the same echoes come back.
    store.setDeviceId('device-after-sign-in')
    const applier = new RemoteApplier(store, repo, noDocs, () => 'user-1')
    for (const e of echoes) applier.applyCard(e)
    const cards = store.cardsForDay('2026-11-08')
    assert.deepEqual(cards.map((c) => [c.title, c.category]).sort(), [
      ['Dentist', 'Personal'],
      ['Real title', 'Work'],
    ])
  }),
)

// ---- S6 ----

test(
  'S6: observations switched off while an upload is in flight get a tombstone right after it is accepted',
  withStore((store, repo) => {
    store.syncPolicy = { ...store.syncPolicy, observations: true }
    const now = Math.floor(Date.now() / 1000)
    const b = store.createBatch(now, now + 900, [])
    store.saveObservations(b, [{ startTs: now, endTs: now + 60, observation: 'private chat' }], 'm')
    const batch = buildBatch(store, repo, noDocs, 'user-1', repo.pending(1000))
    const up = batch.changes.find((c) => c.entity === 'observation')!
    assert.equal((up.data as { text: string }).text, 'private chat')
    // The user switches upload off now: nothing is uploaded yet, so the switch-off sends no tombstone.
    store.syncPolicy = { ...store.syncPolicy, observations: false }
    assert.equal(requeueObservations(store, false), 0)
    // The server accepts the in-flight upload.
    commitAccepted(batch, () => true)
    repo.markPushed(batch.used)
    const next = flush(store, repo).filter((c) => c.entity === 'observation')
    assert.equal(next.length, 1)
    assert.equal(next[0].id, up.id)
    assert.equal(next[0].deleted, true)
    assert.equal(next[0].data, undefined)
    assert.ok(next[0].hlc > up.hlc)
  }),
)

// ---- S7 ----

test('S7: a rejection matches one change; two changes with one id never share a batch', async () => {
  const ch = (entity: SyncChange['entity'], id: string): SyncChange => ({ entity, id, deviceId: 'd', hlc: 'h' })
  assert.deepEqual(matchRejections([ch('standup', 'u:1'), ch('day_goal', 'u:1'), ch('card', 'x')], [{ id: 'u:1', reason: 'bad' }]), [
    'bad',
    undefined,
    undefined,
  ])
  assert.deepEqual(matchRejections([ch('card', 'x')], [{ id: 'nope', reason: 'bad' }]), [undefined])

  await withStore((store, repo) => {
    const docs: DocSources = { read: (e, id) => ({ kind: e, id }), write: () => {} }
    repo.recordDoc('standup', '2026-11-07')
    repo.recordDoc('day_goal', '2026-11-07')
    repo.recordDoc('standup', '2026-11-08')
    const batch = buildBatch(store, repo, docs, 'user-1', repo.pending(1000))
    assert.deepEqual(batch.changes.map((c) => `${c.entity}:${c.id}`), ['standup:user-1:2026-11-07', 'standup:user-1:2026-11-08'])
    repo.markPushed(batch.used)
    const second = buildBatch(store, repo, docs, 'user-1', repo.pending(1000))
    assert.deepEqual(second.changes.map((c) => `${c.entity}:${c.id}`), ['day_goal:user-1:2026-11-07'])
  })()
})

// ---- S8 ----

test(
  'S8: old cards are only re-checked when the scope is dirty',
  withStore((store, repo) => {
    const old = Math.floor(Date.now() / 1000) - 60 * 86400
    const b = store.createBatch(old, old + 1800, [])
    store.replaceCardsInRange(old, old + 1800, [card('9:00 AM', '9:30 AM', 'Old work')], b)
    flush(store, repo)
    assert.equal(rescopeCards(store), 0)
    store.syncPolicy = { ...store.syncPolicy, outOfScope: false }
    assert.equal(store.scopeDirty, false)
    assert.equal(rescopeCards(store), 0, 'not dirty: only the last 31 days are scanned')
    store.scopeDirty = true
    assert.equal(rescopeCards(store), 1, 'dirty: the old card sent before is re-checked')
    assert.equal(store.scopeDirty, false)
    // Local edits that decide a scope set the flag.
    const id = (store.db.prepare('SELECT id FROM timeline_cards WHERE is_deleted = 0').get() as { id: number }).id
    store.setCardPrivate(id, true)
    assert.equal(store.scopeDirty, true)
  }),
)

// ---- S9 ----

test(
  'S9: "Reprocess day" keeps the private flag and manual projects of the regenerated cards',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 3600, [])
    store.replaceCardsInRange(t9, t9 + 3600, [card('9:00 AM', '9:30 AM', 'Private thing'), card('9:30 AM', '10:00 AM', 'Biosun work')], b)
    const before = store.cardsForDay('2026-11-08')
    const priv = before.find((c) => c.title === 'Private thing')!
    const work = before.find((c) => c.title === 'Biosun work')!
    store.setCardPrivate(priv.id, true)
    const project = repo.saveProject({ workspaceId: 'ws', name: 'Biosun', color: '#336699', description: '', rules: {}, defaultShare: 'cards', odoo: {} })
    repo.setManualProject(work.uuid!, project.id)

    store.resetDay('2026-11-08', [{ start: t9, end: t9 + 3600 }])
    assert.equal(store.cardsForDay('2026-11-08').length, 0)
    const nb = store.createBatch(t9, t9 + 3600, [])
    store.replaceCardsInRange(t9, t9 + 3600, [card('9:00 AM', '9:28 AM', 'Private thing v2'), card('9:28 AM', '10:00 AM', 'Biosun work v2')], nb)
    const after = repo.attachProjects(store.cardsForDay('2026-11-08'))
    const p2 = after.find((c) => c.title === 'Private thing v2')!
    const w2 = after.find((c) => c.title === 'Biosun work v2')!
    assert.notEqual(p2.uuid, priv.uuid)
    assert.equal(p2.private, true, 'private flag carried over')
    assert.equal(w2.private, false)
    assert.deepEqual(w2.projects?.map((p) => [p.name, p.source, p.confirmed]), [['Biosun', 'manual', true]])
    assert.deepEqual(p2.projects ?? [], [])
  }),
)

// ---- S4 / S5 ----

test('S4/S5: renames keep the old exclusion and add the new name; toggling keeps old names', () => {
  assert.deepEqual(detectCategoryRenames(['Work', 'Personal', 'Idle'], ['Work', 'Private life', 'Idle']), [['Personal', 'Private life']])
  assert.deepEqual(detectCategoryRenames(['Work', 'Personal'], ['Work', 'Personal', 'New']), [])
  assert.deepEqual(detectCategoryRenames(['A', 'B'], ['B', 'A']), [], 'a reorder is not a rename')
  assert.deepEqual(withRenamedExclusions(['Personal'], [['Personal', 'Private life']]), ['Personal', 'Private life'])
  assert.deepEqual(withRenamedExclusions(['Personal'], [['Work', 'Job']]), ['Personal'])
  assert.deepEqual(toggleExcluded(['Personal', 'Private life'], 'Work', true), ['Personal', 'Private life', 'Work'])
  assert.deepEqual(toggleExcluded(['Personal', 'Private life', 'Work'], 'work', false), ['Personal', 'Private life'])
  const many = Array.from({ length: 30 }, (_, i) => `Old ${i}`)
  const capped = withRenamedExclusions([...many.slice(0, 29), 'Personal'], [['Personal', 'Private']], ['Private'])
  assert.equal(capped.length, 30)
  assert.ok(capped.includes('Private') && capped.includes('Personal'))
  assert.deepEqual(
    mergeCategoryLists(
      [{ name: 'Work' }, { name: 'Idle', isIdle: true }],
      [{ name: 'work' }, { name: 'Personal' }, { name: 'Away', isIdle: true }],
    ).map((c) => c.name),
    ['Work', 'Idle', 'Personal'],
  )
})

function settingsStub(categories: Category[], excluded: string[]) {
  const st = { categories, syncExcludedCategories: excluded } as unknown as Settings
  const patches: Partial<Settings>[] = []
  return {
    st,
    patches,
    like: {
      get: () => st,
      update: (p: Partial<Settings>) => {
        patches.push(p)
        Object.assign(st, p)
      },
    },
  }
}

const cat = (name: string, isIdle = false): Category => ({ name, color: '#336699', description: '', ...(isIdle ? { isIdle: true } : {}) })

test(
  'S5: a category renamed on another device keeps its exclusion under both names',
  withStore((store, repo) => {
    const s = settingsStub([cat('Work'), cat('Personal'), cat('Idle', true)], ['Personal'])
    const applier = new RemoteApplier(store, repo, makeDocSources(store.db, s.like), () => 'user-1')
    repo.setMetaHlc('user_doc:categories', store.tick()) // not the first pull
    const ok = applier.applyDoc({
      entity: 'user_doc',
      id: 'user-1:categories',
      deviceId: 'other',
      hlc: store.tick(),
      data: { userId: 'user-1', kind: 'categories', payload: [cat('Work'), cat('Private life'), cat('Idle', true)] },
    })
    assert.equal(ok, true)
    assert.deepEqual(s.st.categories.map((c) => c.name), ['Work', 'Private life', 'Idle'])
    assert.deepEqual(s.st.syncExcludedCategories, ['Personal', 'Private life'])
    assert.equal(repo.pendingCount(), 0, 'a pulled list is not echoed back')
  }),
)

test(
  'S5: the first categories pull after sign-in merges instead of deleting local categories, and uploads the merge',
  withStore((store, repo) => {
    const s = settingsStub([cat('Work'), cat('Personal'), cat('Gym'), cat('Idle', true)], ['Personal'])
    const docs = makeDocSources(store.db, s.like)
    const applier = new RemoteApplier(store, repo, docs, () => 'user-1')
    const serverHlc = store.tick()
    applier.applyDoc({
      entity: 'user_doc',
      id: 'user-1:categories',
      deviceId: 'other',
      hlc: serverHlc,
      data: { userId: 'user-1', kind: 'categories', payload: [cat('Work'), cat('Meetings'), cat('Idle', true)] },
    })
    assert.deepEqual(s.st.categories.map((c) => c.name), ['Work', 'Meetings', 'Idle', 'Personal', 'Gym'])
    assert.deepEqual(s.st.syncExcludedCategories, ['Personal'], 'no rename detected on a merge')
    const up = flush(store, repo, docs).filter((c) => c.entity === 'user_doc')
    assert.equal(up.length, 1)
    assert.ok(up[0].hlc > serverHlc)
    assert.deepEqual(((up[0].data as { payload: Category[] }).payload).map((c) => c.name), ['Work', 'Meetings', 'Idle', 'Personal', 'Gym'])
    // Later pulls are plain last-writer-wins.
    applier.applyDoc({
      entity: 'user_doc',
      id: 'user-1:categories',
      deviceId: 'other',
      hlc: store.tick(),
      data: { userId: 'user-1', kind: 'categories', payload: [cat('Work'), cat('Idle', true)] },
    })
    assert.deepEqual(s.st.categories.map((c) => c.name), ['Work', 'Idle'])
  }),
)

// ---- S3 (and S7 through the service) ----

interface FakeServer {
  fetch: typeof fetch
  pullGate: { wait: Promise<void>; open: () => void } | null
  pulls: number
  pushes: SyncChange[][]
  reject: (c: SyncChange) => boolean
  pullChanges: SyncChange[]
}

function fakeServer(): FakeServer {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const srv: FakeServer = {
    pullGate: null,
    pulls: 0,
    pushes: [],
    reject: () => false,
    pullChanges: [],
    // Ignores abort signals on purpose: the response may still arrive after a cancel.
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input))
      if (u.pathname === '/api/me') return json({ user: { id: 'user-1', email: 'a@b.c', name: 'a' }, devices: [], workspaces: [] })
      if (u.pathname === '/api/sync/pull') {
        srv.pulls++
        const gate = srv.pullGate
        if (gate) await gate.wait
        const changes = gate ? srv.pullChanges : []
        return json({ changes, cursor: gate ? 50 : 0, more: false })
      }
      if (u.pathname === '/api/sync/push') {
        const b = JSON.parse(String(init?.body)) as { changes: SyncChange[] }
        srv.pushes.push(b.changes)
        const rejected = b.changes.filter((c) => srv.reject(c)).map((c) => ({ id: c.id, reason: 'nope' }))
        return json({ accepted: b.changes.length - rejected.length, rejected, serverTime: Date.now() })
      }
      if (u.pathname.startsWith('/api/devices/')) return json({ ok: true })
      return new Response('{}', { status: 404 })
    }) as typeof fetch,
  }
  return srv
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {}
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}

function service(store: Store, srv: FakeServer, docs: DocSources = noDocs) {
  let token = ''
  const svc = new SyncService({
    store,
    docs,
    token: { get: () => token, set: (t) => (token = t) },
    deviceName: 'pc',
    platform: 'windows',
    fetchImpl: srv.fetch,
  })
  svc.setServerUrl('http://sync.test')
  return svc
}

const auth = (userId = 'user-1') => ({
  deviceToken: 'tok',
  user: { id: userId, email: `${userId}@b.c`, name: userId, avatarUrl: null },
  device: { id: 'dev-1', name: 'pc', platform: 'windows', lastSeenAt: null, revoked: false },
})

test(
  'S3: a slow pull that resolves after signOut() writes nothing',
  withStore(async (store) => {
    const srv = fakeServer()
    const svc = service(store, srv)
    await svc.completeSignIn(auth())
    assert.equal(svc.status().signedIn, true)

    srv.pullGate = gate()
    srv.pullChanges = [
      {
        entity: 'card',
        id: '11111111-1111-4111-8111-111111111111',
        deviceId: 'other-device',
        hlc: store.tick().replace(/-[^-]+$/, '-other-device'),
        data: { userId: 'user-1', startTs: t9, endTs: t9 + 600, day: '2026-11-08', title: 'Remote card', summary: '', detailedSummary: '', category: 'Work', subcategory: '', metadata: {}, isError: false, originDeviceId: 'other-device' },
        deleted: false,
      },
    ]
    const pulls = srv.pulls
    const cycle = svc.syncNow()
    while (srv.pulls === pulls) await new Promise((r) => setTimeout(r, 5))
    const out = svc.signOut()
    srv.pullGate.open()
    await out
    await cycle
    assert.equal(svc.status().signedIn, false)
    assert.equal(store.cardsForDay('2026-11-08').length, 0, 'the late pull wrote no card')
    assert.equal(svc.repo.state().cursor, 0, 'nor moved the cursor')
    assert.equal(svc.status().lastError, null)
  }),
)

test(
  'S3: signing in as another user purges the previous account first',
  withStore(async (store) => {
    const srv = fakeServer()
    const svc = service(store, srv)
    // Leftovers of an earlier account: a remote card, a project and a cursor.
    store.db
      .prepare(
        `INSERT INTO timeline_cards (start, end, start_ts, end_ts, day, title, category, uuid, hlc, field_hlc, device_id)
         VALUES ('9:00 AM', '9:10 AM', ?, ?, '2026-11-08', 'Old account card', 'Work', 'u-old', 'h', '{}', 'someone-else')`,
      )
      .run(t9, t9 + 600)
    svc.repo.updateState({ userId: 'user-old', cursor: 99 })
    await svc.completeSignIn(auth('user-2'))
    assert.equal(store.cardsForDay('2026-11-08').length, 0)
    assert.equal(svc.repo.state().cursor, 0)
    assert.equal(svc.repo.state().userId, 'user-2')
  }),
)

test(
  'S7: a rejected standup does not take the day goal with the same id down with it',
  withStore(async (store) => {
    const srv = fakeServer()
    const docs: DocSources = { read: (e, id) => ({ e, id }), write: () => {} }
    const svc = service(store, srv, docs)
    await svc.completeSignIn(auth())
    svc.repo.recordDoc('standup', '2026-11-07')
    svc.repo.recordDoc('day_goal', '2026-11-07')
    // The server rejects the standup; its response names only the id, which the day goal shares.
    srv.reject = (c) => c.entity === 'standup'
    srv.pushes.length = 0
    await svc.syncNow()
    const sent = srv.pushes.map((b) => b.map((c) => c.entity))
    assert.deepEqual(sent, [['standup'], ['day_goal']], 'one id per batch')
    assert.equal(svc.status().pending, 0)
    assert.match(svc.status().lastError ?? '', /^1 change was rejected/, 'only the standup counts as rejected')
  }),
)
