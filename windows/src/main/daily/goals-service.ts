// Day goals service (spec-daily.md §6): plan resolution, progress, setup reference stats and the
// once-per-day goal prompt conditions.

import type {
  DayGoalPlan,
  DayGoalProgress,
  DayGoalPromptState,
  DayGoalReference,
  DayGoalCategorySnapshot,
} from '../../shared/daily-types.ts'
import type { Category, TimelineCard } from '../../shared/types.ts'
import { dayRange, logicalDay, shiftDay } from '../time.ts'
import { carriedForwardPlan, computeProgress, minutesForCategories, normalizePlan } from './goals.ts'
import type { DailyStore } from './store.ts'

export interface GoalsDeps {
  daily: DailyStore
  cardsForDay: (day: string) => TimelineCard[]
  categories: () => Category[]
  /** Users who get the Daily Brief do not get the goal pop-up. */
  briefEnabled: () => boolean
  changed: (day: string) => void
}

export class GoalsService {
  private readonly d: GoalsDeps

  constructor(deps: GoalsDeps) {
    this.d = deps
  }

  plan(day: string): { plan: DayGoalPlan; isExplicit: boolean } {
    const explicit = this.d.daily.fetchDayGoalPlan(day)
    const saved = explicit ?? this.d.daily.fetchMostRecentDayGoalPlan(day)
    return { plan: carriedForwardPlan(saved, day, this.d.categories()), isExplicit: !!explicit }
  }

  save(plan: DayGoalPlan): DayGoalProgress {
    const normalized = normalizePlan(plan, this.d.categories())
    this.d.daily.saveDayGoalPlan(normalized)
    this.d.changed(plan.day)
    return this.progress(plan.day)
  }

  skip(day: string): DayGoalProgress {
    const { plan } = this.plan(day)
    return this.save({ ...plan, isSkipped: true })
  }

  progress(day: string): DayGoalProgress {
    const { plan, isExplicit } = this.plan(day)
    return computeProgress(plan, isExplicit, this.d.cardsForDay(day), dayRange(day).start, this.d.categories())
  }

  reference(day: string, focus: DayGoalCategorySnapshot[], distraction: DayGoalCategorySnapshot[]): DayGoalReference {
    const cats = this.d.categories()
    const minutes = (d: string, snaps: DayGoalCategorySnapshot[]) =>
      minutesForCategories(this.d.cardsForDay(d), dayRange(d).start, snaps, cats)
    let wf = 0
    let wd = 0
    for (let i = 1; i <= 7; i++) {
      const d = shiftDay(day, -i)
      const cards = this.d.cardsForDay(d)
      wf += minutesForCategories(cards, dayRange(d).start, focus, cats)
      wd += minutesForCategories(cards, dayRange(d).start, distraction, cats)
    }
    const y = shiftDay(day, -1)
    return {
      yesterdayFocus: minutes(y, focus),
      weekAverageFocus: wf / 7,
      yesterdayDistraction: minutes(y, distraction),
      weekAverageDistraction: wd / 7,
    }
  }

  /** requestDailyGoalPromptIfNeeded conditions, for today only. */
  promptState(day: string, showPopups: boolean): DayGoalPromptState {
    const none: DayGoalPromptState = { show: false, startOn: 'setup', review: null }
    const t = logicalDay(Math.floor(Date.now() / 1000))
    if (day !== t) return none
    if (this.d.briefEnabled()) return none
    if (!showPopups) return none
    if (this.d.daily.getKV<string>('dailyGoalPromptHandledDay', '') === day) return none
    if (this.d.daily.fetchDayGoalPlan(day)) {
      this.markHandled(day)
      return none
    }
    if (this.d.daily.countDistinctTimelineDays(day) < 3) return none
    if (this.d.daily.consecutiveSkippedDayGoalCount(day, 5) >= 5) return none
    const yesterday = shiftDay(day, -1)
    const yPlan = this.d.daily.fetchDayGoalPlan(yesterday)
    const reviewShown = this.d.daily.getKV<string>('dayGoalReviewShownTimelineDay', '') === day
    if (yPlan && !yPlan.isSkipped && !reviewShown) {
      return { show: true, startOn: 'review', review: this.progress(yesterday) }
    }
    return { show: true, startOn: 'setup', review: null }
  }

  markHandled(day: string): void {
    this.d.daily.setKV('dailyGoalPromptHandledDay', day)
  }

  markReviewShown(day: string): void {
    this.d.daily.setKV('dayGoalReviewShownTimelineDay', day)
  }
}
