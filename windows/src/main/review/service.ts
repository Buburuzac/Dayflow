// Day-level review queries: cards still to review, summary and the prompt count.
// No Electron imports.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../db.ts'
import { dayRange } from '../time.ts'
import type { ReviewDayData, ReviewRating, ReviewSummary } from '../../shared/review-types.ts'
import type { TimelineCard } from '../../shared/types.ts'
import {
  applyReviewRating,
  ensureReviewSchema,
  fetchReviewSegments,
  hasAnyReviewRating,
  hasReviewRatingInRecentDays,
  isSystemCategory,
  isUnreviewed,
  ratingTotals,
} from './ratings.ts'

interface ReviewState {
  lastReviewedAt?: number
}

export class ReviewService {
  private readonly store: Store
  private readonly stateFile: string

  constructor(store: Store, dataDir: string) {
    this.store = store
    this.stateFile = join(dataDir, 'review-state.json')
    ensureReviewSchema(store.db)
  }

  private readState(): ReviewState {
    try {
      return existsSync(this.stateFile) ? (JSON.parse(readFileSync(this.stateFile, 'utf8')) as ReviewState) : {}
    } catch {
      return {}
    }
  }

  private writeState(s: ReviewState): void {
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, this.stateFile)
  }

  /** Cards whose start falls in the day, excluding System, sorted by start. */
  dayCards(day: string): TimelineCard[] {
    return this.store
      .cardsForDay(day)
      .filter((c) => !isSystemCategory(c.category))
      .sort((a, b) => a.startTs - b.startTs)
  }

  unreviewedCards(day: string): TimelineCard[] {
    const { start, end } = dayRange(day)
    const segs = fetchReviewSegments(this.store.db, start, end)
    return this.dayCards(day).filter((c) => isUnreviewed(c, segs))
  }

  promptCount(day: string, now = Math.floor(Date.now() / 1000)): number {
    const db = this.store.db
    // Stop nagging lapsed users: only when they rated in the last 7 days, or never rated.
    if (hasAnyReviewRating(db) && !hasReviewRatingInRecentDays(db, 7, now)) return 0
    return this.unreviewedCards(day).length
  }

  summary(day: string): ReviewSummary {
    const { start, end } = dayRange(day)
    const segs = fetchReviewSegments(this.store.db, start, end)
    const totals = ratingTotals(segs, start, end)
    const unreviewed = this.dayCards(day).filter((c) => isUnreviewed(c, segs)).length
    return {
      day,
      ...totals,
      lastReviewedAt: this.readState().lastReviewedAt ?? null,
      unreviewed,
      promptCount: this.promptCount(day),
    }
  }

  dayData(day: string): ReviewDayData {
    // Invalid cards (end ≤ start) count as unreviewed but cannot be rated, so the deck skips them.
    return {
      day,
      totalCards: this.dayCards(day).length,
      cards: this.unreviewedCards(day).filter((c) => c.endTs > c.startTs),
      summary: this.summary(day),
    }
  }

  rate(day: string, startTs: number, endTs: number, rating: ReviewRating): ReviewSummary {
    applyReviewRating(this.store.db, startTs, endTs, rating)
    this.writeState({ ...this.readState(), lastReviewedAt: Math.floor(Date.now() / 1000) })
    return this.summary(day)
  }
}
