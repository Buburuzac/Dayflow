// Mixed e2e, step 2: the real Windows sync client as the user's second device.
// Run between MixedE2ETests phases mac1 and mac2 (see MixedE2ETests.swift), from the repo root:
//   node --experimental-strip-types --no-warnings Dayflow/SyncCoreHarness/Scripts/windows-client-e2e.ts <serverUrl>
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../../windows/src/main/db.ts'
import { makeDocSources } from '../../../windows/src/main/sync/docs.ts'
import { syncHooks } from '../../../windows/src/main/sync/hooks.ts'
import { SyncService } from '../../../windows/src/main/sync/service.ts'
import { DailyStore } from '../../../windows/src/main/daily/store.ts'

const url = process.argv[2]
const DAY = '2026-11-09'
const dir = mkdtempSync(join(tmpdir(), 'dayflow-win-e2e-'))
const store = new Store(join(dir, 'win.sqlite'))
store.syncPolicy = { excludedCategories: ['Personal'], outOfScope: true, observations: false }
let token = ''
const settings: { categories: { name: string; color: string; description: string; isIdle?: boolean }[] } = {
  categories: [{ name: 'Work', color: '#B984FF', description: '' }],
}
const svc = new SyncService({
  store,
  docs: makeDocSources(store.db, { get: () => settings as never, update: (p) => Object.assign(settings, p) }),
  token: { get: () => token, set: (t) => (token = t) },
  deviceName: 'win-e2e',
  platform: 'windows',
  background: false,
})
syncHooks.record = (entity, id) => svc.repo.recordDoc(entity, id)
const out: Record<string, unknown> = {}
try {
  svc.setServerUrl(url)
  const st = await svc.signInDev('mac@velesagro.pl')
  assert.equal(st.signedIn, true)
  assert.equal(st.lastError, null)

  // What the Mac uploaded, as the Windows client sees it.
  const cards = svc.repo.attachProjects(store.cardsForDay(DAY)).filter((c) => c.remote)
  out.received = cards.map((c) => ({ title: c.title, summary: c.summary, category: c.category, projects: c.projects?.map((p) => [p.name, p.source, p.confirmed]) }))
  assert.deepEqual(cards.map((c) => c.title).sort(), ['Biosun invoice import', 'Out of scope'], 'project work in full, unassigned work time-only, the Personal card not at all')
  const biosun = cards.find((c) => c.title === 'Biosun invoice import')!
  assert.equal(biosun.summary, 'Biosun invoice import summary')
  assert.deepEqual(biosun.appSites, { primary: 'odoo.velesagro.pl', secondary: null })
  assert.deepEqual(biosun.projects?.map((p) => [p.name, p.source, p.confirmed]), [['Biosun e2e', 'manual', true]])
  const oos = cards.find((c) => c.title === 'Out of scope')!
  assert.equal(oos.summary, '')
  assert.equal(oos.category, 'Out of scope')
  assert.equal(oos.endTs - oos.startTs, 1800, 'times are kept')
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, 0, 'observations stay on the Mac by default')

  // Docs: Mac standup (Windows shape), day goal, categories.
  const daily = new DailyStore(store.db)
  const standup = JSON.parse(daily.fetchStandup('2026-11-08') ?? 'null')
  out.standup = standup
  assert.equal(standup.highlights[0].text, 'shipped')
  assert.equal(standup.generation.provider, 'claude')
  assert.equal(standup.generation.generatedAt, '2025-11-05T01:46:40.500Z', 'Mac reference-date seconds arrive as ISO-8601')
  const goal = daily.fetchDayGoalPlan(DAY)
  out.goal = goal
  assert.equal(goal?.focusTargetMinutes, 300)
  assert.equal(goal?.distractionLimitMinutes, 45)
  assert.deepEqual(goal?.focusCategories.map((c) => c.name), ['Work'])
  out.categories = settings.categories
  assert.deepEqual(settings.categories, [
    { name: 'Work', color: '#B984FF', description: 'Focused work' },
    { name: 'Personal', color: '#6AADFF', description: 'Life admin' },
    { name: 'Idle', color: '#A0AEC0', description: '', isIdle: true },
  ])

  // Edits from Windows: rename the Mac's card, add an own project card, a standup and a category.
  store.updateCardTitle(biosun.id, 'Biosun invoice import (renamed on Windows)')
  const project = svc.listProjects().find((p) => p.name === 'Biosun e2e')!
  const at = new Date(Date.UTC(2026, 10, 9, 15, 0)).getTime() / 1000
  const b = store.createBatch(at, at + 1800, [])
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const [own] = store.replaceCardsDetailed(at, at + 1800, [
    { startTime: fmt(at), endTime: fmt(at + 1800), category: 'Work', subcategory: '', title: 'Windows: Odoo timesheets', summary: 'timesheets', detailedSummary: '' },
  ], b)
  svc.assignCard(own.id, project.id)
  daily.saveStandup(DAY, JSON.stringify({
    highlightsTitle: "Yesterday's highlights",
    highlights: [{ id: 'B3E5C1D2-0000-4000-8000-000000000001', text: 'Windows highlight' }],
    tasksTitle: "Today's tasks", tasks: [], blockersTitle: 'Blockers', blockersBody: '',
    generation: { provider: 'gemini', runtime: 'gemini_direct', sourceDay: '2026-11-08', generatedAt: '2026-11-09T07:00:00.000Z' },
  }))
  settings.categories = [...settings.categories.slice(0, 2), { name: 'Deep work', color: '#123456', description: 'no meetings' }, settings.categories[2]]
  svc.repo.recordDoc('user_doc', 'categories')
  await svc.syncNow()
  assert.equal(svc.status().lastError, null, 'no change rejected')
  assert.equal(svc.status().pending, 0)
  out.ok = true
} finally {
  syncHooks.record = null
  await svc.signOut()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify(out, null, 1))
}
