import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Hlc, formatHlc, parseHlc } from '../src/shared/sync-types.ts'
import type { SyncChange } from '../src/shared/sync-types.ts'
import { Store } from '../src/main/db.ts'
import type { ActivityCardData } from '../src/main/llm/types.ts'
import { SyncRepo } from '../src/main/sync/repo.ts'
import { buildBatch } from '../src/main/sync/outbox.ts'
import type { SyncPolicy } from '../src/main/sync/scope.ts'

const SHARE_ALL: SyncPolicy = { excludedCategories: [], outOfScope: false, observations: true }
import { RemoteApplier } from '../src/main/sync/apply.ts'
import type { DocSources } from '../src/main/sync/docs.ts'
import { llmAssignments, matchRules, assignProjects } from '../src/main/sync/assign.ts'
import { coerceCards, coerceProjectGuesses } from '../src/main/llm/validate.ts'
import { cardsPrompt } from '../src/main/llm/prompts.ts'

const cats = [
  { name: 'Work', color: '#000', description: '' },
  { name: 'Idle', color: '#111', description: '', isIdle: true },
]

function card(start: string, end: string, title: string, extra: Partial<ActivityCardData> = {}): ActivityCardData {
  return { startTime: start, endTime: end, category: 'Work', subcategory: '', title, summary: `${title} summary`, detailedSummary: '', ...extra }
}

const noDocs: DocSources = { read: () => null, write: () => {} }

function withStore(fn: (store: Store, dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dayflow-sync-'))
    const store = new Store(join(dir, 'db.sqlite'))
    // These tests cover the sync mechanics, so everything is shared (see sync-scope.test.ts for the policy).
    store.syncPolicy = SHARE_ALL
    try {
      await fn(store, dir)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const t9 = Math.floor(new Date(2026, 10, 8, 9, 0).getTime() / 1000)

// ---- HLC ----

test('hlc: monotonic ticks, string order, observe advances past remote clocks', () => {
  let now = 1_700_000_000_000
  const a = new Hlc('dev-a', () => now)
  const h1 = a.tick()
  const h2 = a.tick()
  assert.ok(h2 > h1, 'same ms → counter increments')
  now += 5
  const h3 = a.tick()
  assert.ok(h3 > h2)
  assert.deepEqual(parseHlc(h3), { ms: now, counter: 0, deviceId: 'dev-a' })
  // A remote clock 10 s ahead: our next tick must sort after it.
  const remote = formatHlc(now + 10_000, 3, 'dev-b')
  a.observe(remote)
  const h4 = a.tick()
  assert.ok(h4 > remote, `${h4} > ${remote}`)
  // Clock going backwards never produces a smaller HLC.
  now -= 60_000
  assert.ok(a.tick() > h4)
  assert.equal(parseHlc('garbage'), null)
  assert.ok(formatHlc(5, 0, 'x') < formatHlc(10, 0, 'x'), 'zero-padded so string order = time order')
})

// ---- migration ----

test('migration: an old-schema database upgrades in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-sync-'))
  const path = join(dir, 'old.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE analysis_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_start_ts INTEGER NOT NULL, batch_end_ts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', reason TEXT, llm_metadata TEXT, detailed_transcription TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE timeline_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
        start TEXT NOT NULL, end TEXT NOT NULL, start_ts INTEGER, end_ts INTEGER, day DATE NOT NULL, title TEXT NOT NULL, summary TEXT,
        category TEXT NOT NULL, subcategory TEXT, detailed_summary TEXT, metadata TEXT, video_summary_url TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
        start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, observation TEXT NOT NULL, metadata TEXT, llm_model TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO analysis_batches (batch_start_ts, batch_end_ts, status) VALUES (${t9}, ${t9 + 900}, 'analyzed');
      INSERT INTO timeline_cards (batch_id, start, end, start_ts, end_ts, day, title, category, metadata)
        VALUES (1, '9:00 AM', '9:30 AM', ${t9}, ${t9 + 1800}, '2026-11-08', 'Old card', 'Work', '{"distractions":[]}');
      INSERT INTO observations (batch_id, start_ts, end_ts, observation) VALUES (1, ${t9}, ${t9 + 60}, 'typing');
    `)
    old.close()

    const store = new Store(path)
    const cols = (t: string) => store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[]
    assert.ok(['uuid', 'hlc', 'field_hlc', 'device_id'].every((c) => cols('timeline_cards').some((x) => x.name === c)))
    assert.equal(cols('observations').find((c) => c.name === 'batch_id')?.notnull, 0, 'batch_id became nullable')
    const c = store.cardsForDay('2026-11-08')
    assert.equal(c.length, 1)
    assert.equal(c[0].title, 'Old card')
    assert.match(c[0].uuid ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(c[0].deviceId, store.deviceId)
    assert.equal(c[0].remote, false)
    assert.equal(store.observationsInRange(t9, t9 + 900).length, 1)
    for (const t of ['projects', 'card_projects', 'sync_state', 'outbox', 'project_members', 'sync_meta']) {
      assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t)
    }
    const deviceId = store.deviceId
    const uuid = c[0].uuid
    store.close()
    // Re-opening is a no-op: same device id and uuids.
    const again = new Store(path)
    assert.equal(again.deviceId, deviceId)
    assert.equal(again.cardsForDay('2026-11-08')[0].uuid, uuid)
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- outbox recording ----

test(
  'outbox: nothing is queued until sync is enabled; cards, edits and observations are queued after',
  withStore((store) => {
    const b1 = store.createBatch(t9, t9 + 900, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Before sign-in')], b1)
    const repo = new SyncRepo(store)
    assert.equal(repo.pendingCount(), 0)

    store.setSyncEnabled(true)
    const b2 = store.createBatch(t9 + 900, t9 + 1800, [])
    store.replaceCardsInRange(t9, t9 + 2700, [card('9:00 AM', '9:45 AM', 'A')], b2)
    store.saveObservations(b2, [{ startTs: t9, endTs: t9 + 60, observation: 'coding' }], 'm')
    // The old card's deletion + the new card + one observation.
    assert.equal(repo.pendingCount(), 3)
    const cardA = store.cardsForDay('2026-11-08')[0]
    store.updateCardTitle(cardA.id, 'Renamed')
    assert.equal(repo.pendingCount(), 3, 'edits coalesce into the queued entry')
    store.saveObservations(b2, [{ startTs: t9, endTs: t9 + 120, observation: 'coding more' }], 'm')
    assert.equal(repo.pendingCount(), 4, 'old observation tombstone + new observation')

    // Error cards never enter the outbox.
    const b3 = store.createBatch(t9 + 3600, t9 + 4500, [])
    const before = repo.pendingCount()
    store.insertErrorCard(b3, t9 + 3600, t9 + 4500, 'boom')
    assert.equal(repo.pendingCount(), before)

    const batch = buildBatch(store, repo, noDocs, 'user-1', repo.pending(100))
    const cardChanges = batch.changes.filter((c) => c.entity === 'card')
    const live = cardChanges.find((c) => !c.deleted)!
    assert.equal((live.data as { title: string }).title, 'Renamed')
    assert.ok(live.fieldHlc?.title, 'title edit carries a field HLC')
    assert.equal((live.data as { originDeviceId: string }).originDeviceId, store.deviceId)
    assert.equal(live.deviceId, store.deviceId)
    assert.ok(cardChanges.some((c) => c.deleted), 'replaced card is a tombstone')
    const obs = batch.changes.filter((c) => c.entity === 'observation')
    assert.equal(obs.filter((o) => o.deleted).length, 1)
    assert.equal((obs.find((o) => !o.deleted)!.data as { text: string }).text, 'coding more')
    assert.ok(batch.changes.every((c) => !(c.entity === 'card' && (c.data as { isError: boolean }).isError)))

    // Pushed entries disappear unless re-queued while in flight.
    store.updateCardCategory(cardA.id, 'Idle')
    repo.markPushed(batch.used)
    assert.equal(repo.pendingCount(), 1, 'the card edited after the build stays queued')
  }),
)

test(
  'device id remap: rows written before sign-in become the server-assigned device',
  withStore((store) => {
    const b = store.createBatch(t9, t9 + 900, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Mine')], b)
    store.setDeviceId('server-device-1')
    const c = store.cardsForDay('2026-11-08')[0]
    assert.equal(c.deviceId, 'server-device-1')
    assert.equal(c.remote, false)
    store.setSyncEnabled(true)
    store.updateCardTitle(c.id, 'X')
    const repo = new SyncRepo(store)
    const ch = buildBatch(store, repo, noDocs, 'u', repo.pending(10)).changes[0]
    assert.equal(parseHlc(ch.hlc)?.deviceId, 'server-device-1')
  }),
)

// ---- apply remote ----

function remoteCard(id: string, deviceId: string, hlc: string, over: Record<string, unknown> = {}, extra: Partial<SyncChange> = {}): SyncChange {
  return {
    entity: 'card',
    id,
    deviceId,
    hlc,
    data: {
      userId: 'u',
      startTs: t9,
      endTs: t9 + 1800,
      day: '2026-11-08',
      title: 'Remote work',
      summary: 'on the laptop',
      detailedSummary: '',
      category: 'Work',
      subcategory: '',
      metadata: { distractions: [] },
      isError: false,
      ...over,
    },
    ...extra,
  }
}

test(
  'apply: pulled cards keep their origin device and survive local analysis',
  withStore((store) => {
    const repo = new SyncRepo(store)
    const applier = new RemoteApplier(store, repo, noDocs, () => 'u')
    const uuid = '11111111-1111-4111-8111-111111111111'
    const res = applier.apply([remoteCard(uuid, 'laptop', formatHlc(Date.now(), 0, 'laptop'))])
    assert.equal(res.cards, true)
    let day = store.cardsForDay('2026-11-08')
    assert.equal(day.length, 1)
    assert.equal(day[0].remote, true)
    assert.equal(day[0].deviceId, 'laptop')

    // Local analysis over the same window replaces only this device's cards.
    const b = store.createBatch(t9, t9 + 900, [])
    store.replaceCardsInRange(t9, t9 + 2700, [card('9:00 AM', '9:30 AM', 'Desktop work')], b)
    store.replaceCardsInRange(t9, t9 + 2700, [card('9:00 AM', '9:40 AM', 'Desktop work v2')], b)
    day = store.cardsForDay('2026-11-08')
    assert.deepEqual(day.map((c) => c.title).sort(), ['Desktop work v2', 'Remote work'])
    assert.equal(store.cardsInRange(t9, t9 + 2700, true).length, 1, 'analysis input excludes other devices')
    store.resetDay('2026-11-08', [{ start: t9 - 60, end: t9 + 3600 }])
    assert.deepEqual(store.cardsForDay('2026-11-08').map((c) => c.title), ['Remote work'])

    // Remote observations are stored but are not analysis input.
    applier.apply([{ entity: 'observation', id: '22222222-2222-4222-8222-222222222222', deviceId: 'laptop', hlc: formatHlc(Date.now(), 1, 'laptop'), data: { userId: 'u', startTs: t9, endTs: t9 + 60, text: 'laptop typing' } }])
    assert.equal(store.observationsInRange(t9, t9 + 900).length, 0)
    assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n), 1)
    // Error cards are never accepted.
    assert.equal(applier.apply([remoteCard('33333333-3333-4333-8333-333333333333', 'laptop', formatHlc(Date.now(), 2, 'laptop'), { isError: true })]).applied, 0)
  }),
)

test(
  'apply: per-field LWW — a rename on one PC and a category change on another both survive',
  withStore((store) => {
    const repo = new SyncRepo(store)
    const applier = new RemoteApplier(store, repo, noDocs, () => 'u')
    const b = store.createBatch(t9, t9 + 900, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Original')], b)
    const local = store.cardsForDay('2026-11-08')[0]

    // Laptop renames our card...
    const tRename = formatHlc(Date.now() + 1000, 0, 'laptop')
    applier.apply([
      remoteCard(local.uuid!, 'laptop', tRename, { title: 'Renamed on laptop', category: 'Work', summary: 'stale laptop copy', originDeviceId: store.deviceId }, { fieldHlc: { title: tRename } }),
    ])
    // ...while we change the category here afterwards.
    store.updateCardCategory(local.id, 'Idle')
    let c = store.getCard(local.id)!
    assert.equal(c.title, 'Renamed on laptop')
    assert.equal(c.category, 'Idle')
    assert.equal(c.summary, 'Original summary', 'another device never rewrites our analysis fields')

    // An older category edit from the laptop loses; an older rename does not resurrect.
    const older = formatHlc(Date.now() - 100_000, 0, 'laptop')
    applier.apply([remoteCard(local.uuid!, 'laptop', older, { title: 'Old', category: 'Work', originDeviceId: store.deviceId }, { fieldHlc: { title: older, category: older } })])
    c = store.getCard(local.id)!
    assert.equal(c.title, 'Renamed on laptop')
    assert.equal(c.category, 'Idle')

    // A laptop card: its analysis fields follow the laptop, user edits merge per field.
    const lap = '44444444-4444-4444-8444-444444444444'
    const h1 = formatHlc(Date.now(), 0, 'laptop')
    applier.apply([remoteCard(lap, 'laptop', h1)])
    const lapRow = store.cardsForDay('2026-11-08').find((x) => x.uuid === lap)!
    store.updateCardTitle(lapRow.id, 'My title here')
    const h2 = formatHlc(Date.now() + 5000, 0, 'laptop')
    // The laptop re-sends its card with a newer record clock but its title field is still from h1.
    const f1 = { title: h1, category: h1, subcategory: h1, deleted: h1, private: h1 }
    applier.apply([remoteCard(lap, 'laptop', h2, { summary: 'updated by laptop', title: 'Laptop title' }, { fieldHlc: f1 })])
    let merged = store.getCard(lapRow.id)!
    assert.equal(merged.summary, 'updated by laptop', 'origin device owns analysis fields')
    assert.equal(merged.title, 'My title here', 'our later rename survives')
    // A later rename on the laptop wins.
    const h3 = formatHlc(Date.now() + 60_000, 0, 'laptop')
    applier.apply([remoteCard(lap, 'laptop', h3, { title: 'Laptop rename' }, { fieldHlc: { ...f1, title: h3 } })])
    merged = store.getCard(lapRow.id)!
    assert.equal(merged.title, 'Laptop rename')
  }),
)

test(
  'apply: deletes, private flag and LWW for projects / card_projects / docs',
  withStore((store) => {
    const repo = new SyncRepo(store)
    const written: [string, string, unknown][] = []
    const docs: DocSources = { read: () => null, write: (e, id, p) => void written.push([e, id, p]) }
    const applier = new RemoteApplier(store, repo, docs, () => 'u')
    const lap = '55555555-5555-4555-8555-555555555555'
    const base = Date.now()
    const h = (d: number, dev = 'laptop') => formatHlc(base + d, 0, dev)
    applier.apply([remoteCard(lap, 'laptop', h(0), { metadata: { private: true } })])
    const row = store.cardsForDay('2026-11-08')[0]
    assert.equal(row.private, true)
    applier.apply([remoteCard(lap, 'laptop', h(10), {}, { deleted: true, fieldHlc: { deleted: h(10) } })])
    assert.equal(store.cardsForDay('2026-11-08').length, 0)

    const pid = '66666666-6666-4666-8666-666666666666'
    const proj = (hlc: string, name: string): SyncChange => ({
      entity: 'project',
      id: pid,
      deviceId: 'laptop',
      hlc,
      data: { workspaceId: 'w', name, color: '#123456', description: '', rules: { apps: ['code'] }, defaultShare: 'cards', archived: false },
    })
    applier.apply([proj(h(20), 'Newer')])
    applier.apply([proj(h(5), 'Older')])
    assert.equal(repo.project(pid)?.name, 'Newer')
    assert.deepEqual(repo.project(pid)?.rules.apps, ['code'])

    applier.apply([{ entity: 'card_project', id: `${lap}:${pid}`, deviceId: 'laptop', hlc: h(30), data: { cardId: lap, projectId: pid, share: 0.5, source: 'llm', confidence: 0.6, confirmed: false } }])
    assert.equal(repo.cardProject(lap, pid)?.share, 0.5)
    applier.apply([{ entity: 'card_project', id: `${lap}:${pid}`, deviceId: 'laptop', hlc: h(25), deleted: true }])
    assert.equal(repo.cardProject(lap, pid)?.deleted, false, 'older tombstone loses')

    applier.apply([{ entity: 'standup', id: 'u:2026-11-08', deviceId: 'laptop', hlc: h(40), data: { userId: 'u', day: '2026-11-08', payload: { done: 1 } } }])
    applier.apply([{ entity: 'standup', id: 'other-user:2026-11-08', deviceId: 'x', hlc: h(50), data: { userId: 'other-user', day: '2026-11-08', payload: {} } }])
    assert.deepEqual(written, [['standup', '2026-11-08', { done: 1 }]])
  }),
)

// ---- rules + LLM ----

test('rules: apps, domains, title keywords and repos; shares scaled to ≤ 1', () => {
  const projects = [
    { id: 'p1', archived: false, rules: { apps: ['Code'], repos: ['github.com/acme/dayflow'] } },
    { id: 'p2', archived: false, rules: { domains: ['velesagro.pl'] } },
    { id: 'p3', archived: false, rules: { titleKeywords: ['invoice'] } },
    { id: 'p4', archived: true, rules: { apps: ['code'] } },
    { id: 'p5', archived: false, rules: {} },
  ]
  const labels = ['Code — db.ts - dayflow', 'Code — sync.ts - dayflow', 'chrome — Orders - erp.velesagro.pl', 'chrome — YouTube']
  const m = matchRules(projects, { labels, appSites: null, title: 'Sync work', summary: '' })
  assert.deepEqual(m, [
    { projectId: 'p1', share: 0.5 },
    { projectId: 'p2', share: 0.25 },
  ])
  // appSites / title keywords match the whole card (share 1) and everything is scaled.
  const m2 = matchRules(projects, { labels: [], appSites: { primary: 'odoo.velesagro.pl' }, title: 'Invoice run', summary: '' })
  assert.deepEqual(
    m2.map((x) => [x.projectId, x.share]),
    [
      ['p2', 0.5],
      ['p3', 0.5],
    ],
  )
  assert.deepEqual(matchRules(projects, { labels: ['notepad — notes'], appSites: null, title: 'x', summary: 'y' }), [])
  // "velesagro.pl" must not match "notvelesagro.pl".
  assert.deepEqual(matchRules(projects, { labels: ['chrome — notvelesagro.pl'], appSites: null, title: '', summary: '' }), [])

  const llm = llmAssignments(
    [
      { id: 'p1', name: 'Dayflow', archived: false },
      { id: 'p2', name: 'ERP', archived: false },
    ],
    [
      { name: 'dayflow', share: 0.7, confidence: 0.9 },
      { name: 'ERP', share: 0.3, confidence: 0.5 },
      { name: 'Invented', share: 1, confidence: 1 },
    ],
  )
  assert.deepEqual(llm, [
    { projectId: 'p1', share: 0.7, confidence: 0.9, confirmed: true },
    { projectId: 'p2', share: 0.3, confidence: 0.5, confirmed: false },
  ])
})

test(
  'assignment pipeline: manual is kept across rewrites, rules beat the LLM, LLM confirms at ≥ 0.8',
  withStore((store) => {
    const repo = new SyncRepo(store)
    repo.putProject({ id: 'p-code', workspaceId: 'w', name: 'Dayflow', color: '#111111', description: '', rules: { apps: ['code'] }, defaultShare: 'time', odoo: {}, archived: false, deleted: false, hlc: store.tick() })
    repo.putProject({ id: 'p-erp', workspaceId: 'w', name: 'ERP', color: '#222222', description: '', rules: {}, defaultShare: 'cards', odoo: {}, archived: false, deleted: false, hlc: store.tick() })
    for (let i = 0; i < 10; i++) store.insertScreenshot(t9 + i * 60, `f${i}.jpg`, 1, 0, 'Code — repo')
    const b = store.createBatch(t9, t9 + 900, [])
    let ins = store.replaceCardsDetailed(t9, t9 + 3600, [
      card('9:00 AM', '9:20 AM', 'Coding', { projects: [{ name: 'ERP', share: 1, confidence: 0.95 }] }),
      card('9:30 AM', '9:50 AM', 'Meeting', { projects: [{ name: 'ERP', share: 1, confidence: 0.6 }] }),
    ], b)
    assignProjects(store, ins)
    const coding = repo.cardProjects(ins[0].uuid)
    assert.deepEqual(coding.map((c) => [c.projectId, c.source, c.confirmed]), [['p-code', 'rule', true]])
    const meeting = repo.cardProjects(ins[1].uuid)
    assert.deepEqual(meeting.map((c) => [c.projectId, c.source, c.confirmed]), [['p-erp', 'llm', false]])

    // User fixes the meeting manually; the next rewrite of the window keeps it.
    repo.setManualProject(ins[1].uuid, 'p-code')
    ins = store.replaceCardsDetailed(t9, t9 + 3600, [card('9:00 AM', '9:20 AM', 'Coding'), card('9:30 AM', '9:55 AM', 'Meeting (longer)')], b)
    assert.equal(ins[1].inheritedManual, true)
    assignProjects(store, ins)
    assert.deepEqual(repo.cardProjects(ins[1].uuid).map((c) => [c.projectId, c.source]), [['p-code', 'manual']])
    const cards = repo.attachProjects(store.cardsForDay('2026-11-08'))
    assert.equal(cards.find((c) => c.title === 'Meeting (longer)')?.projects?.[0].name, 'Dayflow')
  }),
)

test('LLM: project guesses are parsed from card output and the prompt lists projects', () => {
  const cards = coerceCards(
    [
      {
        startTime: '9:00 AM',
        endTime: '9:30 AM',
        category: 'Work',
        title: 'A',
        summary: '',
        projects: [
          { name: 'Dayflow', share: 0.6, confidence: 0.9 },
          { name: 'ERP', share: '80%', confidence: '0.4' },
          { share: 1 },
          'Loose name',
        ],
      },
      { startTime: '9:30 AM', endTime: '9:45 AM', category: 'Work', title: 'B', summary: '' },
    ],
    cats,
  )
  assert.equal(cards.length, 2)
  const p = cards[0].projects!
  assert.deepEqual(p.map((x) => x.name), ['Dayflow', 'ERP', 'Loose name'])
  assert.ok(p.reduce((s, x) => s + x.share, 0) <= 1.0001, 'shares sum ≤ 1')
  assert.equal(p[1].confidence, 0.4)
  assert.equal(cards[1].projects, undefined)
  assert.deepEqual(coerceProjectGuesses('nope'), [])

  const base = { existingCards: [], transcript: 't', categories: cats, lang: '' }
  const without = cardsPrompt(base)
  assert.ok(!without.includes('## Projects'))
  assert.ok(!without.includes('"projects"'))
  const withP = cardsPrompt({ ...base, projects: [{ name: 'Dayflow', description: 'the desktop app' }] })
  assert.ok(withP.includes('## Projects'))
  assert.ok(withP.includes('"Dayflow": the desktop app'))
  assert.ok(withP.includes('"projects": ['))
})
