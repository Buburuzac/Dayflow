// Batching and analysis loop, ported from AnalysisManager.swift + LLMService.processBatch.

import type { Category } from '../shared/types.ts'
import type { InsertedCard, ScreenshotRow, Store } from './db.ts'
import { ERROR_CATEGORY } from './db.ts'
import { generateCards, transcribe } from './llm/pipeline.ts'
import type { ActivityCardData, Frame, LLMProvider } from './llm/types.ts'
import { dayRange, formatClock } from './time.ts'

export const BATCHING = {
  /** 15-minute analysis batches */
  targetDuration: 15 * 60,
  /** Split batches if the gap between frames exceeds 2 minutes */
  maxGap: 2 * 60,
  /** Cards are rebuilt over a 45-minute lookback window */
  cardLookback: 45 * 60,
  /** Batches shorter than 5 minutes are skipped */
  minDuration: 5 * 60,
  /** Only look at the last 24 hours */
  maxLookback: 24 * 3600,
}

export interface Bucket {
  shots: ScreenshotRow[]
  start: number
  end: number
}

/** Groups screenshots into batches; drops the trailing batch until it is complete. */
export function buildBatches(
  shots: ScreenshotRow[],
  targetDuration = BATCHING.targetDuration,
  maxGap = BATCHING.maxGap,
  /** Keep the trailing batch even if short (e.g. re-analysing a past day). */
  final = false,
): Bucket[] {
  const ordered = [...shots].sort((a, b) => a.capturedAt - b.capturedAt)
  const batches: Bucket[] = []
  let bucket: ScreenshotRow[] = []
  const flush = () => {
    if (bucket.length) batches.push({ shots: bucket, start: bucket[0].capturedAt, end: bucket[bucket.length - 1].capturedAt })
  }
  for (const s of ordered) {
    if (bucket.length === 0) {
      bucket.push(s)
      continue
    }
    const gap = s.capturedAt - bucket[bucket.length - 1].capturedAt
    const duration = s.capturedAt - bucket[0].capturedAt
    if (gap > maxGap || duration > targetDuration) {
      flush()
      bucket = [s]
    } else bucket.push(s)
  }
  flush()
  const last = batches[batches.length - 1]
  if (!final && last && last.end - last.start < targetDuration) {
    // Not enough data yet — unless the user stopped and the batch is final (gap since last frame).
    const sinceLast = Math.floor(Date.now() / 1000) - last.end
    if (sinceLast <= maxGap) batches.pop()
  }
  return batches
}

/** True when the batch is long enough and the user was idle (>=60 s) at >=90% of the frames. */
export function isIdleBatch(shots: ScreenshotRow[]): boolean {
  if (shots.length < 2) return false
  const duration = shots[shots.length - 1].capturedAt - shots[0].capturedAt
  if (duration < 12 * 60) return false
  const withIdle = shots.filter((s) => s.idleSeconds != null)
  if (withIdle.length / shots.length < 0.9) return false
  const idle = withIdle.filter((s) => (s.idleSeconds ?? 0) >= 60)
  return idle.length / withIdle.length >= 0.9
}

export interface AnalysisDeps {
  store: Store
  /** Returns a configured provider, or throws with a user-facing message. */
  makeProvider: (batchId: number) => LLMProvider
  categories: () => Category[]
  language: () => string
  onChange: () => void
  /** Condensed accessibility log for a batch, when that recorder is enabled. */
  accessibilityLog?: (startTs: number, endTs: number, batchId: number) => Promise<string | null>
  /** Workspace projects for the cards prompt (empty = no projects section). */
  projects?: () => { name: string; description: string }[]
  /** Called with the cards an analysis just wrote (project assignment). */
  afterCards?: (cards: InsertedCard[]) => void
}

export class AnalysisManager {
  private timer: NodeJS.Timeout | null = null
  private running = false
  /** Card generation reads and rewrites the recent timeline, so batches run one at a time. */
  private queue: Promise<void> = Promise.resolve()
  processing = 0
  private readonly deps: AnalysisDeps

  constructor(deps: AnalysisDeps) {
    this.deps = deps
  }

  start(): void {
    this.deps.store.resetInterruptedBatches()
    this.timer = setInterval(() => this.tick(), 60_000)
    setTimeout(() => this.tick(), 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(): void {
    if (this.running) return
    this.running = true
    try {
      const { store } = this.deps
      const now = Math.floor(Date.now() / 1000)
      const shots = store.unbatchedScreenshots(now - BATCHING.maxLookback)
      for (const b of buildBatches(shots)) {
        store.createBatch(b.start, b.end, b.shots.map((s) => s.id))
      }
      for (const batch of store.batchesWithStatus(['pending'], now - BATCHING.maxLookback)) {
        this.enqueue(batch.id)
      }
      this.retryFailedWithBackoff(now)
    } catch (err) {
      console.error('[analysis] tick failed', err)
    } finally {
      this.running = false
    }
  }

  private enqueued = new Set<number>()

  enqueue(batchId: number): void {
    if (this.enqueued.has(batchId)) return
    this.enqueued.add(batchId)
    this.queue = this.queue.then(async () => {
      this.processing++
      try {
        await this.processBatch(batchId)
      } catch (err) {
        console.error(`[analysis] batch ${batchId} crashed`, err)
      } finally {
        this.processing--
        this.enqueued.delete(batchId)
        this.deps.onChange()
      }
    })
  }

  /** Automatic retries per failed batch: attempt count and earliest next retry (unix s). */
  private retries = new Map<number, { attempts: number; nextAt: number }>()

  /** Re-queues failed batches automatically: after 5, 15 and 45 minutes, then only manually. */
  private retryFailedWithBackoff(now: number): void {
    const delays = [5 * 60, 15 * 60, 45 * 60]
    for (const b of this.deps.store.batchesWithStatus(['failed'], now - BATCHING.maxLookback)) {
      const r = this.retries.get(b.id)
      if (!r) {
        this.retries.set(b.id, { attempts: 0, nextAt: now + delays[0] })
        continue
      }
      if (r.attempts >= delays.length || now < r.nextAt) continue
      r.attempts++
      r.nextAt = now + (delays[r.attempts] ?? Infinity)
      this.deps.store.updateBatch(b.id, 'pending')
      this.enqueue(b.id)
    }
  }

  /**
   * Re-analyses a day: rebuilds batches from the screenshots that still exist for it. Throws
   * when none are left (they are purged after the retention period), so cards are never deleted
   * without a way to regenerate them.
   */
  reprocessDay(day: string): void {
    const { store } = this.deps
    const { start, end } = dayRange(day)
    const shots = store.liveScreenshotsInRange(start, end)
    if (shots.length === 0) {
      throw new Error('The screenshots for this day have already been deleted, so it cannot be reprocessed.')
    }
    // Every bucket is final here: a past day will not grow any more.
    const buckets = buildBatches(shots, BATCHING.targetDuration, BATCHING.maxGap, true)
    store.resetDay(day, buckets.map((b) => ({ start: b.start, end: b.end + 1 })))
    for (const b of buckets) store.createBatch(b.start, b.end, b.shots.map((s) => s.id))
    this.tick()
  }

  /** Retries failed batches from the last 24 h. */
  retryFailed(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const b of this.deps.store.batchesWithStatus(['failed'], now - BATCHING.maxLookback)) {
      this.deps.store.updateBatch(b.id, 'pending')
      this.enqueue(b.id)
    }
  }

  private isSuperseded(batchId: number): boolean {
    return this.deps.store.getBatch(batchId)?.status === 'superseded'
  }

  async processBatch(batchId: number): Promise<void> {
    const { store } = this.deps
    const batch = store.getBatch(batchId)
    if (!batch || batch.status === 'superseded') return
    const shots = store.screenshotsForBatch(batchId)
    if (shots.length === 0) {
      store.updateBatch(batchId, 'failed_empty')
      return
    }
    const duration = shots[shots.length - 1].capturedAt - shots[0].capturedAt
    if (duration < BATCHING.minDuration) {
      store.updateBatch(batchId, 'skipped_short')
      return
    }

    const categories = this.deps.categories()
    if (isIdleBatch(shots)) {
      const idle = categories.find((c) => c.isIdle)
      const card: ActivityCardData = {
        startTime: formatClock(batch.startTs),
        endTime: formatClock(batch.endTs),
        category: idle?.name ?? 'Idle',
        subcategory: '',
        title: 'Away from the computer',
        summary: 'No keyboard or mouse activity for most of this period.',
        detailedSummary: '',
      }
      store.replaceCardsInRange(batch.startTs, batch.endTs, [card], batchId)
      store.updateBatch(batchId, 'analyzed', 'idle')
      this.deps.onChange()
      return
    }

    store.updateBatch(batchId, 'processing')
    this.deps.onChange()
    try {
      const provider = this.deps.makeProvider(batchId)
      const lang = this.deps.language()
      const frames: Frame[] = shots.map((s) => ({
        path: s.filePath,
        offsetSeconds: s.capturedAt - batch.startTs,
        label: s.windowLabel ?? undefined,
      }))
      // As in the original, only the agent CLIs get the accessibility log.
      let a11yLog: string | null = null
      if ((provider.id === 'claude_cli' || provider.id === 'codex_cli') && this.deps.accessibilityLog) {
        a11yLog = await this.deps.accessibilityLog(batch.startTs, batch.endTs + 1, batchId).catch(() => null)
      }
      const observations = await transcribe(provider, frames, batch.startTs, duration, lang, a11yLog)
      // "Reprocess day" may have superseded this batch while the model was working.
      if (this.isSuperseded(batchId)) return
      store.saveObservations(batchId, observations, provider.model)

      const windowStart = batch.endTs - BATCHING.cardLookback
      const existing = store
        .cardsInRange(windowStart, batch.endTs, true)
        .filter((c) => c.category !== ERROR_CATEGORY)
        .map<ActivityCardData>((c) => ({
          startTime: c.startTime,
          endTime: c.endTime,
          category: c.category,
          subcategory: c.subcategory,
          title: c.title,
          summary: c.summary,
          detailedSummary: c.detailedSummary,
          distractions: c.distractions,
          appSites: c.appSites ?? undefined,
        }))
      const recentObs = store.observationsInRange(windowStart, batch.endTs)
      const projects = this.deps.projects?.() ?? []
      const cards = await generateCards(provider, recentObs, existing, categories, lang, projects)
      if (this.isSuperseded(batchId)) return

      // The model saw every card of this device overlapping the window and rewrote them all.
      const inserted = store.replaceCardsDetailed(windowStart, batch.endTs, cards, batchId)
      store.updateBatch(batchId, 'analyzed')
      try {
        this.deps.afterCards?.(inserted)
      } catch (err) {
        console.error('[analysis] project assignment failed', err)
      }
    } catch (err) {
      if (this.isSuperseded(batchId)) return
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[analysis] batch ${batchId} failed: ${message}`)
      store.updateBatch(batchId, 'failed', message)
      store.insertErrorCard(batchId, batch.startTs, batch.endTs, friendlyError(message))
    }
  }
}

function friendlyError(message: string): string {
  if (/API key|401|403|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) {
    return `The AI provider rejected the request — check your API key in Settings. (${message.slice(0, 160)})`
  }
  if (/429|RESOURCE_EXHAUSTED|rate/i.test(message)) {
    return `The AI provider is rate limiting requests. Dayflow retries automatically in a few minutes. (${message.slice(0, 160)})`
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(message)) {
    return `Could not reach the AI provider. Is it running and reachable? (${message.slice(0, 160)})`
  }
  if (/ENOENT|not recognized|not found/i.test(message)) {
    return `The CLI could not be started. Check that it is installed and on PATH. (${message.slice(0, 160)})`
  }
  return message.slice(0, 400)
}
