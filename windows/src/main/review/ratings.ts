// Timeline review ratings, stored by time range in timeline_review_ratings so they survive
// card regeneration (StorageManager+TimelineReview.swift). No Electron imports.

import type { DatabaseSync } from 'node:sqlite'
import type { ReviewRating, ReviewSegment } from '../../shared/review-types.ts'
import { REVIEW_COVERAGE_THRESHOLD, REVIEW_RATINGS } from '../../shared/review-types.ts'

export function ensureReviewSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_review_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      rating TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_ratings_time ON timeline_review_ratings(start_ts, end_ts);
  `)
}

export function isRating(v: unknown): v is ReviewRating {
  return typeof v === 'string' && (REVIEW_RATINGS as string[]).includes(v)
}

/**
 * Pure core of applyReviewRating: which overlapping rows go, and what is inserted (the
 * non-overlapping head/tail fragments with their old rating, then the new row).
 */
export function planRating(
  overlapping: ReviewSegment[],
  startTs: number,
  endTs: number,
  rating: ReviewRating,
): ReviewSegment[] {
  if (endTs <= startTs) return []
  const out: ReviewSegment[] = []
  for (const e of overlapping) {
    const headEnd = Math.min(startTs, e.endTs)
    if (e.startTs < headEnd) out.push({ startTs: e.startTs, endTs: headEnd, rating: e.rating })
    const tailStart = Math.max(endTs, e.startTs)
    if (tailStart < e.endTs) out.push({ startTs: tailStart, endTs: e.endTs, rating: e.rating })
  }
  out.push({ startTs, endTs, rating })
  return out
}

/** Applies a rating to [startTs, endTs) in one transaction. No-op when end ≤ start. */
export function applyReviewRating(db: DatabaseSync, startTs: number, endTs: number, rating: ReviewRating): void {
  if (endTs <= startTs || !isRating(rating)) return
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db
      .prepare('SELECT id, start_ts, end_ts, rating FROM timeline_review_ratings WHERE NOT (end_ts <= ? OR start_ts >= ?)')
      .all(startTs, endTs) as Array<{ id: number; start_ts: number; end_ts: number; rating: string }>
    const del = db.prepare('DELETE FROM timeline_review_ratings WHERE id = ?')
    for (const r of rows) del.run(r.id)
    const existing: ReviewSegment[] = rows.map((r) => ({
      startTs: Number(r.start_ts),
      endTs: Number(r.end_ts),
      rating: isRating(r.rating) ? r.rating : 'neutral',
    }))
    const ins = db.prepare('INSERT INTO timeline_review_ratings (start_ts, end_ts, rating) VALUES (?, ?, ?)')
    for (const s of planRating(existing, startTs, endTs, rating)) ins.run(s.startTs, s.endTs, s.rating)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function fetchReviewSegments(db: DatabaseSync, startTs: number, endTs: number): ReviewSegment[] {
  return (
    db
      .prepare(
        'SELECT start_ts, end_ts, rating FROM timeline_review_ratings WHERE NOT (end_ts <= ? OR start_ts >= ?) ORDER BY start_ts ASC',
      )
      .all(startTs, endTs) as Array<{ start_ts: number; end_ts: number; rating: string }>
  )
    .filter((r) => isRating(r.rating))
    .map((r) => ({ startTs: Number(r.start_ts), endTs: Number(r.end_ts), rating: r.rating as ReviewRating }))
}

export function hasAnyReviewRating(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM timeline_review_ratings LIMIT 1').get() !== undefined
}

export function hasReviewRatingInRecentDays(db: DatabaseSync, days: number, now: number): boolean {
  const from = now - days * 24 * 3600
  return db.prepare('SELECT 1 FROM timeline_review_ratings WHERE end_ts > ? AND start_ts < ? LIMIT 1').get(from, now) !== undefined
}

/** Seconds of [start, end) covered by the segments (clipped, sorted, merged). */
export function coveredSeconds(segments: Array<{ startTs: number; endTs: number }>, start: number, end: number): number {
  const clipped = segments
    .map((s) => [Math.max(start, s.startTs), Math.min(end, s.endTs)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let total = 0
  let curA = -Infinity
  let curB = -Infinity
  for (const [a, b] of clipped) {
    if (a > curB) {
      if (curB > curA) total += curB - curA
      curA = a
      curB = b
    } else if (b > curB) curB = b
  }
  if (curB > curA) total += curB - curA
  return total
}

/** True when ratings cover less than the threshold of the card. Invalid cards count as unreviewed. */
export function isUnreviewed(
  card: { startTs: number; endTs: number },
  segments: Array<{ startTs: number; endTs: number }>,
  threshold = REVIEW_COVERAGE_THRESHOLD,
): boolean {
  const duration = card.endTs - card.startTs
  if (duration <= 0) return true
  return coveredSeconds(segments, card.startTs, card.endTs) / duration < threshold
}

/** Seconds per rating within [start, end). */
export function ratingTotals(segments: ReviewSegment[], start: number, end: number): Record<ReviewRating, number> {
  const t: Record<ReviewRating, number> = { distracted: 0, neutral: 0, focused: 0 }
  for (const s of segments) {
    const d = Math.min(end, s.endTs) - Math.max(start, s.startTs)
    if (d > 0) t[s.rating] += d
  }
  return t
}

export const isSystemCategory = (category: string) => category.trim().toLowerCase() === 'system'
