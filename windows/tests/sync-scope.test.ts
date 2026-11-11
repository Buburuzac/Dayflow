import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncChange } from '../src/shared/sync-types.ts'
import { Store } from '../src/main/db.ts'
import type { ActivityCardData } from '../src/main/llm/types.ts'
import { SyncRepo } from '../src/main/sync/repo.ts'
import { buildBatch, commitAccepted, requeueObservations, rescopeCards } from '../src/main/sync/outbox.ts'
import { RemoteApplier } from '../src/main/sync/apply.ts'
import type { DocSources } from '../src/main/sync/docs.ts'
import { DEFAULT_SYNC_POLICY, OUT_OF_SCOPE_LABEL, cardScope, redactCard } from '../src/main/sync/scope.ts'
import { formatClock, logicalDay } from '../src/main/time.ts'

const noDocs: DocSources = { read: () => null, write: () => {} }
const t9 = Math.floor(new Date(2026, 10, 8, 9, 0).getTime() / 1000)

function card(start: string, end: string, title: string, category = 'Work'): ActivityCardData {
  return { startTime: start, endTime: end, category, subcategory: 'dev', title, summary: `${title} summary`, detailedSummary: 'details' }
}

function withStore(fn: (store: Store, repo: SyncRepo) => void) {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'dayflow-scope-'))
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      store.setSyncEnabled(true)
      store.syncPolicy = { ...DEFAULT_SYNC_POLICY }
      fn(store, new SyncRepo(store))
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Builds and "pushes" everything queued; returns the card changes by title of the local row. */
function flush(store: Store, repo: SyncRepo): SyncChange[] {
  const batch = buildBatch(store, repo, noDocs, 'user-1', repo.pending(1000))
  // As the real push does: the server accepted everything, so record what it now holds.
  commitAccepted(batch, () => true)
  repo.markPushed(batch.used)
  repo.markPushed(batch.dropped)
  return batch.changes
}

const cardData = (c: SyncChange) => c.data as { title: string; summary: string; detailedSummary: string; category: string; metadata: Record<string, unknown> }

test('cardScope: personal and private cards are excluded, confirmed project work is full, the rest out of scope', () => {
  const p = DEFAULT_SYNC_POLICY
  assert.equal(cardScope({ category: 'personal', private: false }, true, p), 'excluded')
  assert.equal(cardScope({ category: 'Work', private: true }, true, p), 'excluded')
  assert.equal(cardScope({ category: 'Work', private: false }, true, p), 'full')
  assert.equal(cardScope({ category: 'Work', private: false }, false, p), 'out_of_scope')
  assert.equal(cardScope({ category: 'Work', private: false }, false, { ...p, outOfScope: false }), 'full')
})

test('unassigned idle time stays visibly idle while other unassigned time is out of scope', () => {
  const data = { userId: 'u', startTs: 0, endTs: 60, day: '2026-11-08', category: 'Idle', subcategory: '', title: 'Away', summary: 'secret', detailedSummary: 'secret', metadata: { distractions: [] }, isError: false }
  const idle = redactCard(data, 'out_of_scope')
  assert.equal(idle.category, 'Idle')
  assert.equal(idle.title, 'Idle')
  assert.equal(idle.summary, '')
  assert.equal(redactCard({ ...data, category: 'Work' }, 'out_of_scope').title, OUT_OF_SCOPE_LABEL)
})

test('a remote card uses the viewing computer\'s day and clock', withStore((store) => {
  const start = Math.floor(Date.UTC(2026, 10, 7, 20) / 1000)
  const localDay = logicalDay(start)
  const sourceDay = localDay === '2026-11-08' ? '2026-11-07' : '2026-11-08'
  store.db.prepare(`INSERT INTO timeline_cards
    (start, end, start_ts, end_ts, day, title, category, metadata, uuid, hlc, field_hlc, device_id)
    VALUES (?, ?, ?, ?, ?, 'Tokyo work', 'Work', '{}', ?, '1-0-remote', '{}', 'remote-device')`)
    .run('5:00 AM', '6:00 AM', start, start + 3600, sourceDay, 'remote-card')
  const remote = store.cardsForDay(localDay)[0]
  assert.equal(remote.day, localDay)
  assert.equal(remote.startTime, formatClock(start))
  assert.equal(remote.endTime, formatClock(start + 3600))
}))

test(
  'outbox: unassigned work uploads as a time-only "Out of scope" block; confirming a project uploads it in full with a newer clock',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 1800, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Fixed the Biosun invoice import')], b)
    const local = store.cardsForDay('2026-11-08')[0] as { uuid?: string }
    const uuid = local.uuid!

    const first = flush(store, repo).find((c) => c.entity === 'card' && !c.deleted)!
    assert.equal(cardData(first).title, OUT_OF_SCOPE_LABEL)
    assert.equal(cardData(first).summary, '')
    assert.equal(cardData(first).detailedSummary, '')
    assert.equal(cardData(first).category, OUT_OF_SCOPE_LABEL)
    assert.deepEqual(cardData(first).metadata, { distractions: [], appSites: null, private: false })
    assert.ok((first.data as { startTs: number }).startTs > 0, 'times are kept')

    // The local card keeps its real content.
    assert.equal(store.cardsForDay('2026-11-08')[0].title, 'Fixed the Biosun invoice import')

    const project = repo.saveProject({
      workspaceId: 'ws',
      name: 'Biosun',
      color: '#336699',
      description: '',
      rules: {},
      defaultShare: 'cards',
      odoo: {},
    })
    repo.setManualProject(uuid, project.id)
    assert.ok(rescopeCards(store) >= 1, 'the card is re-queued once its scope changes')
    const second = flush(store, repo).find((c) => c.entity === 'card' && !c.deleted)!
    assert.equal(cardData(second).title, 'Fixed the Biosun invoice import')
    assert.equal(cardData(second).summary, 'Fixed the Biosun invoice import summary')
    assert.ok(second.hlc > first.hlc, 'record clock beats the redacted copy on the server')
    assert.ok(second.fieldHlc!.title > first.fieldHlc!.title, 'title clock beats the redacted title')

    // Archiving the project puts it back out of scope, again with a newer clock.
    repo.putProject({ ...repo.project(project.id)!, archived: true, hlc: store.tick() })
    assert.ok(rescopeCards(store) >= 1)
    const third = flush(store, repo).find((c) => c.entity === 'card' && !c.deleted)!
    assert.equal(cardData(third).title, OUT_OF_SCOPE_LABEL)
    assert.ok(third.fieldHlc!.title > second.fieldHlc!.title)
    assert.equal(rescopeCards(store), 0, 'nothing left to re-scope')
  }),
)

test(
  'outbox: personal cards are wiped and deleted on the server, and their project links stay local',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 1800, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Booked the dentist', 'Personal')], b)
    const uuid = (store.cardsForDay('2026-11-08')[0] as { uuid?: string }).uuid!
    const project = repo.saveProject({ workspaceId: 'ws', name: 'P', color: '#000000', description: '', rules: {}, defaultShare: 'time', odoo: {} })
    repo.setManualProject(uuid, project.id)
    const changes = flush(store, repo)
    const c = changes.find((x) => x.entity === 'card')!
    assert.equal(c.deleted, true)
    assert.equal(cardData(c).title, OUT_OF_SCOPE_LABEL)
    assert.equal(cardData(c).summary, '')
    assert.ok(!changes.some((x) => x.entity === 'card_project'), 'no project link for a personal card')
  }),
)

test(
  'apply: our own echo never overwrites the full local card',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 1800, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Real title')], b)
    const echo = flush(store, repo).find((c) => c.entity === 'card' && !c.deleted)!
    assert.equal(cardData(echo).title, OUT_OF_SCOPE_LABEL)
    const applier = new RemoteApplier(store, repo, noDocs, () => 'user-1')
    applier.applyCard(echo)
    assert.equal(store.cardsForDay('2026-11-08')[0].title, 'Real title')
  }),
)

test(
  'observations: not uploaded by default; switching upload off sends tombstones, switching on revives with a newer clock',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 900, [])
    store.saveObservations(b, [{ startTs: Math.floor(Date.now() / 1000), endTs: Math.floor(Date.now() / 1000) + 60, observation: 'chatting on WhatsApp' }], 'm')
    assert.ok(!flush(store, repo).some((c) => c.entity === 'observation'), 'policy off: nothing uploaded')

    store.syncPolicy = { ...store.syncPolicy, observations: true }
    assert.equal(requeueObservations(store, true), 1)
    const revived = flush(store, repo).filter((c) => c.entity === 'observation')
    assert.equal(revived.length, 1)
    assert.equal((revived[0].data as { text: string }).text, 'chatting on WhatsApp')

    store.syncPolicy = { ...store.syncPolicy, observations: false }
    assert.equal(requeueObservations(store, false), 1)
    const tomb = flush(store, repo).filter((c) => c.entity === 'observation')
    assert.equal(tomb.length, 1)
    assert.equal(tomb[0].deleted, true)
    assert.equal(tomb[0].data, undefined, 'tombstones carry no text')
    assert.ok(tomb[0].hlc > revived[0].hlc)
  }),
)

test(
  'observations: switching upload off removes every uploaded observation, however old',
  withStore((store, repo) => {
    store.syncPolicy = { ...store.syncPolicy, observations: true }
    const old = Math.floor(Date.now() / 1000) - 120 * 86400 // four months ago, far outside any window
    const b = store.createBatch(old, old + 900, [])
    store.saveObservations(b, [{ startTs: old, endTs: old + 60, observation: 'an old private chat' }], 'm')
    assert.equal(flush(store, repo).filter((c) => c.entity === 'observation').length, 1)
    store.syncPolicy = { ...store.syncPolicy, observations: false }
    assert.equal(requeueObservations(store, false), 1, 'the old uploaded observation gets a tombstone')
    const tomb = flush(store, repo).filter((c) => c.entity === 'observation')
    assert.equal(tomb.length, 1)
    assert.equal(tomb[0].deleted, true)
    assert.equal(requeueObservations(store, false), 0, 'nothing left on the server to remove')
  }),
)

test(
  'scope bookkeeping: a rejected upload is not recorded, so the card is re-scoped and re-sent',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 1800, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Unassigned work')], b)
    const batch = buildBatch(store, repo, noDocs, 'user-1', repo.pending(1000))
    commitAccepted(batch, () => false) // the server rejected everything
    repo.markPushed(batch.used)
    assert.ok(rescopeCards(store) >= 1, 'still differs from what the server holds')
    flush(store, repo)
    assert.equal(rescopeCards(store), 0)
  }),
)

test(
  'scope change bumps only the fields it rewrites',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 1800, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Work')], b)
    const first = flush(store, repo).find((c) => c.entity === 'card' && !c.deleted)!
    // full → out_of_scope happened on first upload (never sent before = "full").
    assert.ok(first.fieldHlc!.title > first.fieldHlc!.private, 'title is re-clocked')
    assert.equal(first.fieldHlc!.private, first.fieldHlc!.deleted, 'private and deleted keep their clocks')
  }),
)

test(
  'private flag: un-marking a card sends private: false so the server clears it',
  withStore((store, repo) => {
    const b = store.createBatch(t9, t9 + 1800, [])
    store.replaceCardsInRange(t9, t9 + 1800, [card('9:00 AM', '9:30 AM', 'Client call')], b)
    const row = store.cardsForDay('2026-11-08')[0]
    store.setCardPrivate(row.id, true)
    const hidden = flush(store, repo).find((c) => c.entity === 'card')!
    assert.equal(cardData(hidden).metadata.private, true)
    store.setCardPrivate(row.id, false)
    rescopeCards(store)
    const shown = flush(store, repo).find((c) => c.entity === 'card')!
    assert.equal(cardData(shown).metadata.private, false, 'explicit false, not omitted')
    assert.equal(shown.deleted, false, 'and no longer deleted')
    assert.ok(shown.fieldHlc!.private > hidden.fieldHlc!.private, 'the newer private clock wins on the server')
  }),
)
