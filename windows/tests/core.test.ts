import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatClock, logicalDay, parseClock, parseVideoTimestamp, resolveCardRange, dayRange } from '../src/main/time.ts'
import { extractArray, extractJson } from '../src/main/llm/json.ts'
import { coerceCards, normalizeCategory, validateDurations, validateTimeCoverage } from '../src/main/llm/validate.ts'
import { sampleEvenly } from '../src/main/llm/pipeline.ts'
import { buildBatches, isIdleBatch } from '../src/main/analysis.ts'
import { Store } from '../src/main/db.ts'
import type { ScreenshotRow } from '../src/main/db.ts'

const cats = [
  { name: 'Work', color: '#000', description: '' },
  { name: 'Idle', color: '#111', description: '', isIdle: true },
]

test('parseClock handles 12h variants', () => {
  assert.equal(parseClock('1:12 AM'), 72)
  assert.equal(parseClock('12:05 AM'), 5)
  assert.equal(parseClock('12:30 PM'), 750)
  assert.equal(parseClock('11:59pm'), 23 * 60 + 59)
  assert.equal(parseClock('14:20'), 14 * 60 + 20)
  assert.equal(parseClock('nope'), null)
  assert.equal(parseClock('13:00 PM'), null)
})

test('formatClock round-trips', () => {
  const ts = Math.floor(new Date(2026, 10, 8, 15, 7).getTime() / 1000)
  assert.equal(formatClock(ts), '3:07 PM')
  assert.equal(parseClock(formatClock(ts)), 15 * 60 + 7)
})

test('logical day uses 4 AM boundary', () => {
  const early = Math.floor(new Date(2026, 10, 8, 3, 30).getTime() / 1000)
  const late = Math.floor(new Date(2026, 10, 8, 4, 30).getTime() / 1000)
  assert.equal(logicalDay(early), '2026-11-07')
  assert.equal(logicalDay(late), '2026-11-08')
  const r = dayRange('2026-11-08')
  assert.ok(late >= r.start && late < r.end)
  assert.ok(early < r.start)
})

test('resolveCardRange picks nearest day and handles midnight', () => {
  const anchor = Math.floor(new Date(2026, 10, 8, 0, 10).getTime() / 1000)
  const r = resolveCardRange('11:50 PM', '12:20 AM', anchor)!
  assert.equal(r.endTs - r.startTs, 30 * 60)
  assert.equal(new Date(r.startTs * 1000).getDate(), 7)
})

test('parseVideoTimestamp', () => {
  assert.equal(parseVideoTimestamp('03:20'), 200)
  assert.equal(parseVideoTimestamp('1:00:05'), 3605)
  assert.equal(parseVideoTimestamp('x'), 0)
})

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('```json\n[{"a":1}]\n```'), [{ a: 1 }])
  assert.deepEqual(extractJson('Sure! Here it is: {"segments":[1]} hope that helps'), { segments: [1] })
  assert.deepEqual(extractArray('{"reasoning":"x","segments":[{"d":1}]}', 'segments'), [{ d: 1 }])
  assert.throws(() => extractJson('no json'))
})

const card = (s: string, e: string, title = 't') => ({
  startTime: s,
  endTime: e,
  category: 'Work',
  subcategory: '',
  title,
  summary: 's',
  detailedSummary: 'd',
})

test('coverage and duration validation', () => {
  const existing = [card('9:00 AM', '9:30 AM'), card('9:30 AM', '10:00 AM')]
  assert.equal(validateTimeCoverage(existing, [card('9:00 AM', '10:15 AM')]), null)
  assert.match(validateTimeCoverage(existing, [card('9:00 AM', '9:20 AM')])!, /Missing coverage/)
  assert.match(validateDurations([card('9:00 AM', '9:05 AM'), card('9:05 AM', '9:40 AM')])!, /^Card 1/)
  assert.equal(validateDurations([card('9:00 AM', '9:30 AM'), card('9:30 AM', '9:33 AM')]), null)
})

test('category normalization and coercion', () => {
  assert.equal(normalizeCategory('work', cats), 'Work')
  assert.equal(normalizeCategory('idle time', cats), 'Idle')
  assert.equal(normalizeCategory('Gaming', cats), 'Work')
  const cards = coerceCards(
    [{ startTime: '9:00 AM', endTime: '9:30 AM', title: 'X', category: 'IDLE' }, { startTime: 'bad' }],
    cats,
  )
  assert.equal(cards.length, 1)
  assert.equal(cards[0].category, 'Idle')
})

test('sampleEvenly keeps ends', () => {
  const s = sampleEvenly([...Array(100).keys()], 5)
  assert.equal(s.length, 5)
  assert.equal(s[0], 0)
  assert.equal(s[4], 99)
})

function shots(start: number, count: number, step: number, idle: number | null = 0, idOffset = 0): ScreenshotRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: idOffset + i + 1,
    capturedAt: start + i * step,
    filePath: '',
    fileSize: 0,
    idleSeconds: idle,
    windowLabel: null,
  }))
}

test('buildBatches splits on duration and drops the incomplete tail', () => {
  const now = Math.floor(Date.now() / 1000)
  // 40 minutes of frames every 10 s ending now → two full 15-min batches, tail still growing
  const b = buildBatches(shots(now - 2400 + 10, 240, 10))
  assert.equal(b.length, 2)
  assert.ok(b.every((x) => x.end - x.start <= 15 * 60))
})

test('buildBatches closes on gaps and keeps an old short tail', () => {
  const old = Math.floor(Date.now() / 1000) - 7200
  const withGap = [...shots(old, 30, 10), ...shots(old + 600, 30, 10, 0, 100)]
  assert.equal(buildBatches(withGap).length, 2)
})

test('idle batch detection', () => {
  assert.equal(isIdleBatch(shots(0, 90, 10, 300)), true)
  assert.equal(isIdleBatch(shots(0, 90, 10, 2)), false)
  assert.equal(isIdleBatch(shots(0, 30, 10, 300)), false)
})

test('store: batches, card replacement, error card preservation, reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-test-'))
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const t0 = Math.floor(new Date(2026, 10, 8, 9, 0).getTime() / 1000)
    const ids = [0, 1, 2].map((i) => store.insertScreenshot(t0 + i * 10, `f${i}.jpg`, 100, 0, 'code — x'))
    assert.equal(store.unbatchedScreenshots(0).length, 3)
    const b1 = store.createBatch(t0, t0 + 20, ids)
    assert.equal(store.unbatchedScreenshots(0).length, 0)
    assert.equal(store.screenshotsForBatch(b1)[0].windowLabel, 'code — x')

    const withDistraction = { ...card('9:00 AM', '9:30 AM', 'A'), distractions: [{ startTime: '9:10 AM', endTime: '9:12 AM', title: 'X', summary: '' }] }
    store.replaceCardsInRange(t0, t0 + 1800, [withDistraction], b1)
    const b2 = store.createBatch(t0 + 1800, t0 + 2700, [])
    store.insertErrorCard(b2, t0 + 1800, t0 + 2700, 'boom')
    let day = store.cardsForDay('2026-11-08')
    assert.deepEqual(day.map((c) => c.title), ['A', 'Processing failed'])
    assert.equal(day[0].distractions.length, 1)
    assert.equal(day[1].isError, true)

    // A later rewrite of the window replaces A but keeps the other batch's error card.
    const b3 = store.createBatch(t0, t0 + 1800, [])
    store.replaceCardsInRange(t0, t0 + 2700, [card('9:00 AM', '9:25 AM', 'A2'), card('9:25 AM', '9:30 AM', 'B')], b3)
    day = store.cardsForDay('2026-11-08')
    assert.deepEqual(day.map((c) => c.title), ['A2', 'B', 'Processing failed'])

    store.resetDay('2026-11-08', [{ start: t0 - 60, end: t0 + 3600 }])
    assert.equal(store.cardsForDay('2026-11-08').length, 0)
    assert.equal(store.unbatchedScreenshots(0).length, 3)
    assert.equal(store.totalScreenshotBytes(), 300)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reprocessDay refuses days without screenshots and keeps cards outside covered spans', async () => {
  const { AnalysisManager } = await import('../src/main/analysis.ts')
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-test-'))
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const mgr = new AnalysisManager({
      store,
      makeProvider: () => {
        throw new Error('no provider in tests')
      },
      categories: () => cats,
      language: () => '',
      onChange: () => {},
    })
    assert.throws(() => mgr.reprocessDay('2026-10-01'), /already been deleted/)

    const t9 = Math.floor(new Date(2026, 9, 1, 9, 0).getTime() / 1000)
    const t14 = Math.floor(new Date(2026, 9, 1, 14, 0).getTime() / 1000)
    const old = store.createBatch(t9, t14 + 1800, [])
    store.replaceCardsInRange(t9, t14 + 3600, [card('9:00 AM', '9:30 AM', 'Morning'), card('2:00 PM', '2:30 PM', 'Afternoon')], old)
    // Only the afternoon still has screenshots (the morning's were purged).
    for (let i = 0; i < 100; i++) store.insertScreenshot(t14 + i * 10, `f${i}.jpg`, 10, 0, null)
    mgr.reprocessDay('2026-10-01')
    assert.equal(store.getBatch(old)?.status, 'superseded')
    // 100 frames x 10 s = 990 s: one full 15-minute batch plus the final short tail.
    assert.equal(store.batchesInRange(t14, t14 + 3600).filter((b) => b.status !== 'superseded').length, 2)
    // Let the queued batches run (they fail without a provider and leave error cards).
    await (mgr as unknown as { queue: Promise<void> }).queue
    const titles = store.cardsForDay('2026-10-01').filter((c) => !c.isError).map((c) => c.title)
    assert.deepEqual(titles, ['Morning'])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runCli: a missing command with a large stdin rejects cleanly instead of crashing', async () => {
  const { runCli } = await import('../src/main/llm/cli.ts')
  const big = 'x'.repeat(20 * 1024 * 1024)
  await assert.rejects(runCli('dayflow-no-such-cli', ['-p'], big, tmpdir()), /was not found/)
})
