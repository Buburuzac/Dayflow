// Transcribe-then-generate pipeline, ported from LLMService.processBatch and the providers'
// transcribeScreenshots / generateActivityCards implementations.

import type { Category } from '../../shared/types.ts'
import { formatClock, formatMMSS, parseVideoTimestamp } from '../time.ts'
import { extractArray, extractJson } from './json.ts'
import {
  FRAME_DESCRIPTION_PROMPT,
  accessibilityLogSection,
  cardsPrompt,
  retrySuffix,
  segmentGroupingPrompt,
  transcriptionPrompt,
} from './prompts.ts'
import type { ActivityCardData, Frame, LLMProvider, Observation } from './types.ts'
import { coerceCards, validateDurations, validateTimeCoverage } from './validate.ts'

/** Evenly samples at most `max` items, always keeping the first and last. */
export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))])
  return out
}

interface Segment {
  startTimestamp: string
  endTimestamp: string
  description: string
}

function segmentsToObservations(segments: Segment[], batchStartTs: number, durationSeconds: number): Observation[] {
  const tolerance = 10
  const out: Observation[] = []
  for (const s of segments) {
    if (!s || typeof s.description !== 'string' || !s.description.trim()) continue
    const start = parseVideoTimestamp(String(s.startTimestamp ?? ''))
    const end = parseVideoTimestamp(String(s.endTimestamp ?? ''))
    if (start < -tolerance || end > durationSeconds + tolerance || end < start) continue
    out.push({
      startTs: batchStartTs + Math.min(start, durationSeconds),
      endTs: batchStartTs + Math.min(end, durationSeconds),
      observation: s.description.trim(),
    })
  }
  return out
}

/** Frames → observations with absolute timestamps. */
export async function transcribe(
  provider: LLMProvider,
  frames: Frame[],
  batchStartTs: number,
  durationSeconds: number,
  lang: string,
  accessibilityLog: string | null = null,
): Promise<Observation[]> {
  const duration = formatMMSS(durationSeconds)

  if (provider.generateWithImages) {
    const sampled = sampleEvenly(frames, 30)
    const prompt =
      transcriptionPrompt(duration, sampled.length, lang) +
      (accessibilityLog ? accessibilityLogSection(accessibilityLog, batchStartTs) : '')
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const raw = await provider.generateWithImages(prompt, sampled, 'transcribe')
        const obs = segmentsToObservations(extractArray<Segment>(raw, 'segments'), batchStartTs, durationSeconds)
        if (obs.length > 0) return obs
        lastError = new Error('Transcription returned no usable segments')
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  if (provider.describeFrame) {
    // Local models: one description per sampled frame, then group them into segments.
    const sampled = sampleEvenly(frames, 15)
    const described: string[] = []
    for (const f of sampled) {
      try {
        const d = await provider.describeFrame(FRAME_DESCRIPTION_PROMPT, f)
        if (d.trim()) described.push(`[${formatMMSS(f.offsetSeconds)}] ${d.trim()}`)
      } catch {
        // Skip the frame, as the macOS app does.
      }
    }
    if (described.length === 0) throw new Error('The local model could not describe any frame')
    const base = segmentGroupingPrompt(described.join('\n'), described.length, duration)
    let prompt = base
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await provider.generateText(prompt, 'segment_video_activity', true)
        const obs = segmentsToObservations(extractArray<Segment>(raw, 'segments'), batchStartTs, durationSeconds)
        const covered = obs.reduce((sum, o) => sum + (o.endTs - o.startTs), 0)
        if (obs.length > 0 && covered >= durationSeconds * 0.8) return obs
        if (obs.length > 0 && attempt === 2) return obs
        lastError = new Error(`Segments only cover ${Math.round((covered / durationSeconds) * 100)}% of the period`)
        prompt = base + retrySuffix([String((lastError as Error).message) + `. Cover 00:00 to ${duration}.`])
      } catch (err) {
        lastError = err
      }
    }
    // Last resort: use the raw frame descriptions as observations.
    if (described.length > 0) {
      return sampled.map((f, i) => ({
        startTs: batchStartTs + Math.round(f.offsetSeconds),
        endTs: batchStartTs + Math.round(sampled[i + 1]?.offsetSeconds ?? durationSeconds),
        observation: described[i]?.replace(/^\[[^\]]+\]\s*/, '') ?? '',
      })).filter((o) => o.observation)
    }
    throw lastError
  }

  throw new Error(`Provider ${provider.id} cannot read screenshots`)
}

/** Observations + previous cards → revised cards for the lookback window. */
export async function generateCards(
  provider: LLMProvider,
  observations: Observation[],
  existingCards: ActivityCardData[],
  categories: Category[],
  lang: string,
  /** Workspace projects; when present the model also returns per-card project guesses. */
  projects: { name: string; description: string }[] = [],
): Promise<ActivityCardData[]> {
  const transcript = observations
    .map((o) => `[${formatClock(o.startTs)} - ${formatClock(o.endTs)}]: ${o.observation}`)
    .join('\n')
  const base = cardsPrompt({ existingCards, transcript, categories, lang, projects })
  let prompt = base
  let lastError: unknown
  let best: ActivityCardData[] | null = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const raw = await provider.generateText(prompt, 'generate_cards', true)
      const parsed = extractJson(raw)
      const list = Array.isArray(parsed)
        ? parsed
        : extractArray(raw, 'cards', 'timeline', 'activities')
      const cards = coerceCards(list, categories)
      if (cards.length === 0) throw new Error('Model returned no valid cards')
      best = cards
      const errors: string[] = []
      const coverage = validateTimeCoverage(existingCards, cards)
      if (coverage) {
        errors.push(
          `TIME COVERAGE ERROR:\n${coverage}\n\nYou MUST ensure your output cards collectively cover ALL time periods from the input cards. Do not drop any time segments.`,
        )
      }
      const duration = validateDurations(cards)
      if (duration) {
        errors.push(
          `DURATION ERROR:\n${duration}\n\nREMINDER: All cards except the last one must be at least 10 minutes long. Please merge short activities into longer, more meaningful cards that tell a coherent story.`,
        )
      }
      if (errors.length === 0) return cards
      lastError = new Error(errors.join('\n'))
      prompt = base + retrySuffix(errors)
    } catch (err) {
      lastError = err
    }
  }
  // Validation is advisory: a parseable result beats an error card.
  if (best) return best
  throw lastError
}
