// Daily recap / standup service (spec-daily.md §3a): generation through the configured provider,
// the Daily view model, manual Regenerate, edits, and the automatic scheduler check.

import type {
  DailyStandupDraft,
  DailyStandupGenerationMetadata,
  RecapProviderKind,
  RegenerateResult,
  StandupView,
} from '../../shared/daily-types.ts'
import type { Settings, SettingsWithSecrets, TimelineCard } from '../../shared/types.ts'
import type { LLMProvider } from '../llm/types.ts'
import { languageInstruction } from '../llm/prompts.ts'
import { logicalDay } from '../time.ts'
import { makeRecapPrompt, recapInstructions } from './prompts.ts'
import { which } from './spawn.ts'
import { generateTextAbortable } from './abortable.ts'
import {
  decodeDraft,
  draftFromParsed,
  makeCardsText,
  MAX_AUTOMATIC_ATTEMPTS,
  parseRecapResponse,
  placeholderDraft,
  resolveSourceDay,
  SOURCE_MIN_MINUTES,
  standupTitles,
} from './standup.ts'
import type { DailyStore } from './store.ts'

export const UNLOCK_BATCHES = 20

export interface RecapDeps {
  daily: DailyStore
  cardsForDay: (day: string) => TimelineCard[]
  settings: () => SettingsWithSecrets
  makeProvider: () => LLMProvider
  notify: (day: string) => void
  changed: (day: string) => void
}

export function providerKindFor(provider: Settings['provider']): Exclude<RecapProviderKind, 'dayflow' | 'none'> {
  switch (provider) {
    case 'gemini':
      return 'gemini'
    case 'openai_compatible':
      return 'local'
    case 'claude_cli':
      return 'claude'
    case 'codex_cli':
      return 'chatgpt'
  }
}

const LABELS: Record<RecapProviderKind, string> = {
  dayflow: 'Dayflow',
  gemini: 'Gemini',
  local: 'Local model',
  claude: 'Claude (CLI)',
  chatgpt: 'ChatGPT (Codex CLI)',
  none: 'None',
}

const RUNTIME: Record<RecapProviderKind, string> = {
  dayflow: 'dayflow_backend',
  gemini: 'gemini_direct',
  local: 'local_llm',
  claude: 'chat_cli',
  chatgpt: 'chat_cli',
  none: 'disabled',
}

export class RecapService {
  private readonly d: RecapDeps
  private inFlight = false
  /** One manual regenerate per day; `abort` cancels its provider call. */
  private readonly running = new Map<string, { promise: Promise<RegenerateResult>; abort: AbortController }>()

  constructor(deps: RecapDeps) {
    this.d = deps
  }

  provider(): RecapProviderKind {
    return this.d.daily.settings().recapEnabled ? providerKindFor(this.d.settings().provider) : 'none'
  }

  available(kind: RecapProviderKind): boolean {
    const s = this.d.settings()
    switch (kind) {
      case 'gemini':
        return s.hasGeminiKey
      case 'local':
        return !!(s.openaiBaseUrl && s.openaiModel)
      case 'claude':
        return !!which(s.claudeCommand || 'claude')
      case 'chatgpt':
        return !!which(s.codexCommand || 'codex')
      case 'dayflow':
      case 'none':
        return false
    }
  }

  unlocked(): { unlocked: boolean; batches: number } {
    const batches = this.d.daily.analyzedBatchCount()
    let unlocked = this.d.daily.settings().isDailyUnlocked
    if (!unlocked && batches >= UNLOCK_BATCHES) {
      this.d.daily.updateSettings({ isDailyUnlocked: true })
      unlocked = true
    }
    return { unlocked, batches }
  }

  resolveSource(targetDay: string): string | null {
    return resolveSourceDay(targetDay, {
      consumed: this.d.daily.consumedSourceDays(targetDay),
      activityMinutes: (day) => this.d.daily.activityMinutes(day),
    })
  }

  view(day: string): StandupView {
    const today = logicalDay(Math.floor(Date.now() / 1000))
    const kind = this.provider()
    const stored = this.d.daily.fetchStandup(day)
    const draft = stored ? decodeDraft(stored) : null
    const sourceDay = draft?.generation?.sourceDay ?? this.resolveSource(day)
    const { unlocked, batches } = this.unlocked()
    const base = {
      day,
      sourceDay,
      titles: standupTitles(day, sourceDay, today),
      provider: kind,
      providerLabel: LABELS[kind],
      providerAvailable: this.available(kind),
      unlocked,
      unlockProgress: { batches, required: UNLOCK_BATCHES },
    }
    if (draft) return { ...base, draft, placeholder: null }
    const placeholder = kind === 'none' ? 'noProviderSelected' : sourceDay ? 'notGenerated' : 'insufficientHistory'
    return { ...base, draft: placeholderDraft(placeholder), placeholder }
  }

  /** 3a.3 generate(context). Throws on failure. */
  async generate(sourceDay: string, cards: TimelineCard[], kind: RecapProviderKind, signal?: AbortSignal): Promise<DailyStandupDraft> {
    if (cards.length === 0) throw new Error('There are no timeline cards for that day.')
    if (kind === 'none' || kind === 'dayflow') throw new Error('No Daily provider is selected.')
    const provider = this.d.makeProvider()
    const prompt = makeRecapPrompt(
      recapInstructions(kind),
      makeCardsText(sourceDay, cards),
      languageInstruction(this.d.settings().outputLanguage, true),
    )
    const generation: DailyStandupGenerationMetadata = {
      provider: kind,
      runtime: RUNTIME[kind],
      modelOrTool: provider.model ?? undefined,
      sourceDay,
      generatedAt: new Date().toISOString(),
    }
    let raw: string
    try {
      raw = await generateTextAbortable(provider, prompt, 'daily_recap', true, signal)
    } catch (err) {
      // ChatGPT: one retry on any non-cancel error (the macOS app retried with a fallback model).
      if (kind !== 'chatgpt' || signal?.aborted || /cancel/i.test(String(err))) throw err
      raw = await generateTextAbortable(provider, prompt, 'daily_recap_retry', true, signal)
    }
    return draftFromParsed(parseRecapResponse(raw), generation, raw)
  }

  saveDraft(day: string, draft: DailyStandupDraft): void {
    this.d.daily.saveStandup(day, JSON.stringify(draft))
  }

  /** User edit (debounced in the renderer). Placeholders are never saved. */
  edit(day: string, draft: DailyStandupDraft): StandupView {
    const stored = this.d.daily.fetchStandup(day)
    const prev = stored ? decodeDraft(stored) : null
    const sourceDay = prev?.generation?.sourceDay ?? this.resolveSource(day) ?? undefined
    const generation = prev?.generation ?? draft.generation ?? { provider: this.provider(), runtime: RUNTIME[this.provider()], sourceDay }
    const cleaned: DailyStandupDraft = {
      ...draft,
      highlights: draft.highlights.filter((b) => typeof b.text === 'string'),
      tasks: draft.tasks.filter((b) => typeof b.text === 'string'),
      generation,
    }
    // No standup-changed broadcast here: the editing view already has this content.
    this.saveDraft(day, cleaned)
    return this.view(day)
  }

  cancel(day: string): void {
    this.running.get(day)?.abort.abort()
  }

  /**
   * 3a.6 Manual Regenerate. Not limited by the attempt budget. A request while one is running joins
   * it, unless that one was cancelled: then a fresh run starts (the cancelled one resolves as
   * 'cancelled' and never saves).
   */
  regenerate(day: string): Promise<RegenerateResult> {
    const existing = this.running.get(day)
    if (existing && !existing.abort.signal.aborted) return existing.promise
    const abort = new AbortController()
    const promise = this.doRegenerate(day, abort.signal).finally(() => {
      if (this.running.get(day)?.abort === abort) this.running.delete(day)
    })
    this.running.set(day, { promise, abort })
    return promise
  }

  private async doRegenerate(day: string, signal: AbortSignal): Promise<RegenerateResult> {
    const kind = this.provider()
    if (kind === 'none') return { status: 'noProvider', view: this.view(day) }
    const stored = this.d.daily.fetchStandup(day)
    const sourceDay = (stored ? decodeDraft(stored)?.generation?.sourceDay : undefined) ?? this.resolveSource(day)
    if (!sourceDay) return { status: 'noData', view: this.view(day) }
    const cards = this.d.cardsForDay(sourceDay)
    if (cards.length === 0) return { status: 'noData', view: this.view(day) }
    try {
      const draft = await this.generate(sourceDay, cards, kind, signal)
      if (signal.aborted) return { status: 'cancelled', view: this.view(day) }
      this.saveDraft(day, draft)
      this.d.changed(day)
      this.d.notify(day)
      return { status: 'ok', view: this.view(day) }
    } catch (err) {
      if (signal.aborted) return { status: 'cancelled', view: this.view(day) }
      return { status: 'error', message: err instanceof Error ? err.message : String(err), view: this.view(day) }
    }
  }

  /** 3a.1 scheduler check: one in flight at a time; at most 3 automatic attempts per target day. */
  async schedulerCheck(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      if (!this.unlocked().unlocked) return
      const now = new Date()
      if (now.getHours() < 4) return
      const targetDay = logicalDay(Math.floor(now.getTime() / 1000))
      if (this.d.daily.fetchStandup(targetDay) !== null) return
      if (this.running.has(targetDay)) return
      // Same 120-minute threshold as the Daily view (see SOURCE_MIN_MINUTES).
      const sourceDay = resolveSourceDay(
        targetDay,
        { consumed: this.d.daily.consumedSourceDays(targetDay), activityMinutes: (d) => this.d.daily.activityMinutes(d) },
        SOURCE_MIN_MINUTES,
      )
      if (!sourceDay) return
      const kind = this.provider()
      if (kind === 'none' || !this.available(kind)) return
      const budget = this.d.daily.getKV<{ day: string; count: number }>('recapAutomaticAttempts', { day: '', count: 0 })
      const count = budget.day === targetDay ? budget.count : 0
      if (count >= MAX_AUTOMATIC_ATTEMPTS) return
      // Reserve before generating, so crashes and failures count too.
      this.d.daily.setKV('recapAutomaticAttempts', { day: targetDay, count: count + 1 })
      const cards = this.d.cardsForDay(sourceDay)
      try {
        const draft = await this.generate(sourceDay, cards, kind)
        if (this.d.daily.fetchStandup(targetDay) !== null) return // a manual run won the race
        this.saveDraft(targetDay, draft)
        if (this.d.daily.fetchStandup(targetDay) === null) return
        this.d.changed(targetDay)
        this.d.notify(targetDay)
      } catch (err) {
        console.warn('[daily] automatic recap failed', err)
      }
    } finally {
      this.inFlight = false
    }
  }
}
