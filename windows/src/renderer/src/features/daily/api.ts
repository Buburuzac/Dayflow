// Typed wrappers over window.dayflow.call for the daily:* and goals:* channels.

import type {
  BriefAction,
  BriefActionResult,
  BriefPart,
  BriefSectionKey,
  BriefViewState,
  CompletedDayGroup,
  DailyBrief,
  DailyBriefRangeSummary,
  DailyBriefSavedItem,
  DailySettings,
  DailyStandupDraft,
  DayGoalCategorySnapshot,
  DayGoalPlan,
  DayGoalProgress,
  DayGoalPromptState,
  DayGoalReference,
  FeedbackAction,
  RegenerateResult,
  StandupView,
  SummaryRange,
} from '../../../../shared/daily-types.ts'

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)

export const dailyApi = {
  settings: () => call<DailySettings>('daily:settings:get'),
  setSettings: (patch: Partial<DailySettings>) => call<DailySettings>('daily:settings:set', patch),
  unlock: () => call<DailySettings>('daily:unlock'),

  standup: (day: string) => call<StandupView>('daily:standup:get', day),
  regenerate: (day: string) => call<RegenerateResult>('daily:standup:regenerate', day),
  cancelRegenerate: (day: string) => call<void>('daily:standup:cancel', day),
  edit: (day: string, draft: DailyStandupDraft) => call<StandupView>('daily:standup:edit', day, draft),
  copy: (day: string, draft: DailyStandupDraft) => call<string>('daily:standup:copy', day, draft),

  brief: () => call<BriefViewState>('daily:brief:get'),
  generateBrief: () => call<BriefViewState>('daily:brief:generate'),
  cancelBrief: () => call<void>('daily:brief:cancel'),
  briefShown: (day: string | null) => call<void>('daily:brief:shown', day),
  briefAction: (day: string, action: BriefAction) => call<BriefActionResult>('daily:brief:action', day, action),
  feedback: (day: string, section: BriefSectionKey, title: string, action: FeedbackAction) =>
    call<BriefActionResult>('daily:brief:feedback', day, section, title, action),
  briefImage: (day: string, rel: string) => call<string | null>('daily:brief:image', day, rel),
  transcript: (day: string, part: BriefPart) => call<string | null>('daily:brief:transcript', day, part),
  refreshRuns: (day: string) => call<DailyBrief | null>('daily:brief:refreshRuns', day),
  pickFolder: () => call<string | null>('daily:brief:pickFolder'),
  recentFolders: () => call<string[]>('daily:brief:recentFolders'),
  completed: () => call<CompletedDayGroup[]>('daily:brief:completed'),
  summary: (range: SummaryRange) => call<DailyBriefRangeSummary | null>('daily:brief:summary', range),
  summarize: (range: SummaryRange) => call<DailyBriefRangeSummary>('daily:brief:summarize', range),
  defaultPrompt: (part: BriefPart) => call<string>('daily:brief:defaultPrompt', part),
  saved: () => call<DailyBriefSavedItem[]>('daily:brief:saved'),
  savedImage: (file: string) => call<string | null>('daily:brief:savedImage', file),
}

export const goalsApi = {
  get: (day: string) => call<{ plan: DayGoalPlan; isExplicit: boolean }>('goals:get', day),
  set: (plan: DayGoalPlan) => call<DayGoalProgress>('goals:set', plan),
  skip: (day: string) => call<DayGoalProgress>('goals:skip', day),
  progress: (day: string) => call<DayGoalProgress>('goals:progress', day),
  reference: (day: string, focus: DayGoalCategorySnapshot[], distraction: DayGoalCategorySnapshot[]) =>
    call<DayGoalReference>('goals:reference', day, focus, distraction),
  prompt: (day: string) => call<DayGoalPromptState>('goals:prompt', day),
  promptHandled: (day: string) => call<void>('goals:promptHandled', day),
  reviewShown: (day: string) => call<void>('goals:reviewShown', day),
}

/** Strips the "Error invoking remote method 'x': Error: " prefix Electron adds to rejected IPC calls. */
export function errorText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
