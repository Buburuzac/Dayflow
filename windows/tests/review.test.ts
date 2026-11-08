import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/db.ts'
import {
  applyReviewRating,
  coveredSeconds,
  ensureReviewSchema,
  fetchReviewSegments,
  hasAnyReviewRating,
  hasReviewRatingInRecentDays,
  isUnreviewed,
  planRating,
  ratingTotals,
} from '../src/main/review/ratings.ts'
import { ReviewService } from '../src/main/review/service.ts'
import { FAILURE_DEBOUNCE_SECONDS, planNotifications, DEFAULT_NOTIFICATION_SETTINGS } from '../src/main/review/notify-plan.ts'
import { dayRange } from '../src/main/time.ts'

function withStore(fn: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-review-'))
  const store = new Store(join(dir, 'test.sqlite'))
  try {
    ensureReviewSchema(store.db)
    fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const rows = (store: Store) => fetchReviewSegments(store.db, 0, 1e12).map((s) => [s.startTs, s.endTs, s.rating])

test('planRating keeps head and tail fragments of overlapping rows', () => {
  const plan = planRating([{ startTs: 0, endTs: 100, rating: 'focused' }], 40, 60, 'distracted')
  assert.deepEqual(plan, [
    { startTs: 0, endTs: 40, rating: 'focused' },
    { startTs: 60, endTs: 100, rating: 'focused' },
    { startTs: 40, endTs: 60, rating: 'distracted' },
  ])
  assert.deepEqual(planRating([], 10, 10, 'neutral'), [])
})

test('applyReviewRating splits, overwrites and survives repeated ratings', () => {
  withStore((store) => {
    applyReviewRating(store.db, 100, 200, 'focused')
    applyReviewRating(store.db, 300, 400, 'neutral')
    assert.deepEqual(rows(store), [
      [100, 200, 'focused'],
      [300, 400, 'neutral'],
    ])
    // Spans the end of the first and the start of the second.
    applyReviewRating(store.db, 150, 350, 'distracted')
    assert.deepEqual(rows(store), [
      [100, 150, 'focused'],
      [150, 350, 'distracted'],
      [350, 400, 'neutral'],
    ])
    // Fully inside one row.
    applyReviewRating(store.db, 200, 250, 'focused')
    assert.deepEqual(rows(store), [
      [100, 150, 'focused'],
      [150, 200, 'distracted'],
      [200, 250, 'focused'],
      [250, 350, 'distracted'],
      [350, 400, 'neutral'],
    ])
    // Covers everything: one row left.
    applyReviewRating(store.db, 0, 1000, 'neutral')
    assert.deepEqual(rows(store), [[0, 1000, 'neutral']])
    // Touching ranges do not overlap.
    applyReviewRating(store.db, 1000, 1100, 'focused')
    assert.deepEqual(rows(store), [
      [0, 1000, 'neutral'],
      [1000, 1100, 'focused'],
    ])
    // Empty range is a no-op.
    applyReviewRating(store.db, 500, 500, 'distracted')
    assert.equal(rows(store).length, 2)
  })
})

test('coverage merges overlapping segments and clips to the card', () => {
  const segs = [
    { startTs: 0, endTs: 50 },
    { startTs: 40, endTs: 70 },
    { startTs: 90, endTs: 200 },
  ]
  assert.equal(coveredSeconds(segs, 0, 100), 80)
  assert.equal(coveredSeconds(segs, 60, 95), 15)
  assert.equal(coveredSeconds([], 0, 100), 0)
  assert.equal(isUnreviewed({ startTs: 0, endTs: 100 }, segs), false, '80% counts as reviewed')
  assert.equal(isUnreviewed({ startTs: 0, endTs: 95 }, segs), true, '75 of 95 s is under 80%')
  assert.equal(isUnreviewed({ startTs: 10, endTs: 10 }, segs), true, 'invalid cards are unreviewed')
  assert.deepEqual(
    ratingTotals(
      [
        { startTs: 0, endTs: 100, rating: 'focused' },
        { startTs: 100, endTs: 150, rating: 'distracted' },
      ],
      50,
      120,
    ),
    { focused: 50, distracted: 20, neutral: 0 },
  )
})

test('recent-rating checks', () => {
  withStore((store) => {
    const now = 10_000_000
    assert.equal(hasAnyReviewRating(store.db), false)
    applyReviewRating(store.db, now - 8 * 86400, now - 8 * 86400 + 60, 'focused')
    assert.equal(hasAnyReviewRating(store.db), true)
    assert.equal(hasReviewRatingInRecentDays(store.db, 7, now), false)
    applyReviewRating(store.db, now - 3600, now - 3000, 'neutral')
    assert.equal(hasReviewRatingInRecentDays(store.db, 7, now), true)
  })
})

test('review service: unreviewed cards, prompt count and summary for a day', () => {
  withStore((store, dir) => {
    const day = '2026-11-05'
    const { start } = dayRange(day)
    const at = (h: number, m = 0) => start + (h - 4) * 3600 + m * 60
    const batch = store.createBatch(at(9), at(12), [])
    const mk = (s: string, e: string, title: string, category = 'Work') => ({
      startTime: s, endTime: e, category, subcategory: '', title, summary: '', detailedSummary: '',
    })
    store.replaceCardsInRange(at(9), at(12), [
      mk('9:00 AM', '10:00 AM', 'A'),
      mk('10:00 AM', '11:00 AM', 'B'),
      mk('11:00 AM', '11:30 AM', 'Failed', 'System'),
    ], batch)
    const svc = new ReviewService(store, dir)
    assert.deepEqual(svc.dayData(day).cards.map((c) => c.title), ['A', 'B'], 'System cards are excluded')
    // Rating 50 of 60 minutes of A (83%) marks it reviewed; 40 of 60 of B (67%) does not.
    svc.rate(day, at(9), at(9, 50), 'focused')
    const s = svc.rate(day, at(10), at(10, 40), 'distracted')
    assert.deepEqual(svc.unreviewedCards(day).map((c) => c.title), ['B'])
    assert.equal(s.focused, 50 * 60)
    assert.equal(s.distracted, 40 * 60)
    assert.equal(s.unreviewed, 1)
    assert.ok(s.lastReviewedAt && s.lastReviewedAt > 0)
    // The ratings are 2026 timestamps; "now" eight days later → lapsed user, no prompt.
    assert.equal(svc.promptCount(day, at(12) + 8 * 86400), 0)
    assert.equal(svc.promptCount(day, at(12) + 3600), 1)
  })
})

test('notification plan: first cards, once-a-day timeline, debounced failures', () => {
  const st = DEFAULT_NOTIFICATION_SETTINGS
  let r = planNotifications({}, { today: 'd1', todayCards: 0, anyCardsEver: false, failedIds: [], now: 1000 }, st)
  assert.deepEqual(r.notes, [])
  r = planNotifications(r.next, { today: 'd1', todayCards: 2, anyCardsEver: true, failedIds: [], now: 1000 }, st)
  assert.deepEqual(r.notes, [{ kind: 'firstCards' }])
  r = planNotifications(r.next, { today: 'd1', todayCards: 3, anyCardsEver: true, failedIds: [], now: 1100 }, st)
  assert.deepEqual(r.notes, [], 'once per day')
  r = planNotifications(r.next, { today: 'd2', todayCards: 1, anyCardsEver: true, failedIds: [5, 6], now: 90_000 }, st)
  assert.deepEqual(r.notes, [{ kind: 'timelineReady' }, { kind: 'failures', count: 2 }])
  assert.equal(r.next.lastFailedBatchId, 6)
  r = planNotifications(r.next, { today: 'd2', todayCards: 1, anyCardsEver: true, failedIds: [7], now: 90_060 }, st)
  assert.deepEqual(r.notes, [], 'debounced')
  assert.equal(r.next.lastFailedBatchId, 6, 'kept pending')
  r = planNotifications(r.next, { today: 'd2', todayCards: 1, anyCardsEver: true, failedIds: [7, 8], now: 90_000 + FAILURE_DEBOUNCE_SECONDS }, st)
  assert.deepEqual(r.notes, [{ kind: 'failures', count: 2 }])
  const off = planNotifications({ firstCardsNotified: true }, { today: 'd3', todayCards: 1, anyCardsEver: true, failedIds: [9], now: 1 }, {
    timelineReady: false,
    batchFailures: false,
  })
  assert.deepEqual(off.notes, [])
  assert.equal(off.next.lastFailedBatchId, 9)
  assert.equal(off.next.lastTimelineReadyDay, 'd3')
})
