// Timeline review (swipe ratings, spec C): shared by src/main/review and features/Review.tsx.

import type { TimelineCard } from './types.ts'

export type ReviewRating = 'distracted' | 'neutral' | 'focused'
export const REVIEW_RATINGS: ReviewRating[] = ['distracted', 'neutral', 'focused']

/** A card counts as reviewed once ratings cover at least 80% of it. */
export const REVIEW_COVERAGE_THRESHOLD = 0.8

export interface ReviewSegment {
  startTs: number
  endTs: number
  rating: ReviewRating
}

export interface ReviewSummary {
  day: string
  /** Seconds per rating within the day */
  distracted: number
  neutral: number
  focused: number
  /** Unix seconds of the last rating made in this app, or null */
  lastReviewedAt: number | null
  /** Cards of the day still under 80% coverage */
  unreviewed: number
  /** Count to show on the "Review cards" button (0 when the user has lapsed for 7 days) */
  promptCount: number
}

export interface ReviewDayData {
  day: string
  /** Cards of the day (excluding System), sorted by start */
  totalCards: number
  /** Cards still to review, in order */
  cards: TimelineCard[]
  summary: ReviewSummary
}

export interface NotificationSettings {
  /** "Today's timeline is ready" once a day, plus the first-cards notification */
  timelineReady: boolean
  /** Debounced notice when analysis batches fail */
  batchFailures: boolean
}
