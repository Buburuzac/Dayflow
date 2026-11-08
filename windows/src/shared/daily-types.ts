// Types shared by the Daily page (standup / recap, Daily Brief) and Day goals.
// Spec: docs/spec-daily.md. Dates are ISO-8601 strings unless noted (no macOS DB compatibility).

// ---------------------------------------------------------------------------------------------
// Standup / recap
// ---------------------------------------------------------------------------------------------

/** Recap provider kinds, as in DailyStandupGenerationMetadata.provider. "dayflow" only appears on legacy rows. */
export type RecapProviderKind = 'dayflow' | 'local' | 'gemini' | 'chatgpt' | 'claude' | 'none'

export interface DailyBulletItem {
  id: string
  text: string
}

export interface DailyStandupGenerationMetadata {
  provider: RecapProviderKind
  /** dayflow_backend | local_llm | gemini_direct | chat_cli | disabled */
  runtime: string
  modelOrTool?: string
  /** Logical day the content was built from. Used to mark source days as consumed. */
  sourceDay?: string
  /** ISO date */
  generatedAt?: string
}

export interface DailyStandupDraft {
  highlightsTitle: string
  highlights: DailyBulletItem[]
  tasksTitle: string
  tasks: DailyBulletItem[]
  blockersTitle: string
  blockersBody: string
  generation?: DailyStandupGenerationMetadata
}

export type StandupPlaceholder = 'notGenerated' | 'insufficientHistory' | 'noProviderSelected'

export interface StandupView {
  /** Target logical day (the day the standup is stored under). */
  day: string
  /** Day the content comes from; null when none could be resolved. */
  sourceDay: string | null
  draft: DailyStandupDraft
  /** Set when `draft` is a placeholder (never persisted, never copied). */
  placeholder: StandupPlaceholder | null
  /** Computed UI titles. */
  titles: { highlights: string; tasks: string; blockers: string; heading: string }
  provider: RecapProviderKind
  providerLabel: string
  providerAvailable: boolean
  unlocked: boolean
  /** Analyzed 15-minute batches so far / batches needed to unlock (20 = 5 h). */
  unlockProgress: { batches: number; required: number }
}

export type RegenerateStatus = 'ok' | 'noData' | 'noProvider' | 'cancelled' | 'error'

export interface RegenerateResult {
  status: RegenerateStatus
  message?: string
  view: StandupView
}

export interface DailySettings {
  /** false = the "None" provider: recap generation is off. */
  recapEnabled: boolean
  isDailyUnlocked: boolean
  /** Local replacement for the macOS email allowlist. */
  briefEnabled: boolean
  /** Model for Claude CLI brief runs (spec default "opus"). */
  briefModel: string
  briefOverrideInstructions: string
  briefPromptOverrideDocket: string
  briefPromptOverrideExtras: string
  docketAgent: HandoffAgent
  docketHandoffMethod: HandoffMethod
  docketShowsList: boolean
  docketPickedFolders: string[]
  showDailyGoalPopups: boolean
}

// ---------------------------------------------------------------------------------------------
// Daily Brief
// ---------------------------------------------------------------------------------------------

export type BriefSectionKey =
  | 'docket'
  | 'keep_tracking'
  | 'completed_yesterday'
  | 'team_decisions'
  | 'related_reading'
  | 'industry_news'
  | 'site_seeing'

export type BriefPart = 'docket' | 'extras'

export interface DocketPerson {
  name: string
  note?: string
}
export interface DocketLink {
  title: string
  url?: string
  app?: string
}
export interface DocketFeedback {
  name: string
  source?: string
  text: string
  url?: string
}
export interface DocketItem {
  title: string
  detail?: string
  due?: string
  people?: DocketPerson[]
  links?: DocketLink[]
  prompt?: string
  agent?: boolean
  feedback?: DocketFeedback[]
  feedbackSummary?: string
  feedbackUrl?: string
  attach?: string[]
}
export interface KeepTrackingItem {
  label: string
  status: string
  app?: string
  asOf?: string
  url?: string
}
export interface CompletedItem {
  project?: string
  title: string
  apps?: string[]
  cardId?: number
  /** "images/<file>", set by the app */
  imageFile?: string
}
export interface TeamDecision {
  decision: string
  date?: string
  people?: string[]
  place?: string
  app?: string
  url?: string
}
export interface ReadingItem {
  title: string
  source?: string
  url: string
  reason?: string
}
export interface NewsItem {
  headline: string
  source?: string
  url: string
  published?: string
}
export interface SiteSeeingItem {
  /** "images/<file>" after cleaning */
  file: string
  caption?: string
}

export interface DailyBriefContent {
  order: BriefSectionKey[]
  docket?: DocketItem[]
  keep_tracking?: KeepTrackingItem[]
  completed_yesterday?: CompletedItem[]
  team_decisions?: TeamDecision[]
  related_reading_intro?: string
  related_reading?: ReadingItem[]
  industry_news?: NewsItem[]
  site_seeing?: SiteSeeingItem[]
}

export type HandoffAgent = 'claude' | 'chatgpt'
/** terminal = open a new terminal window running the agent; copy = clipboard only; run = background run. */
export type HandoffMethod = 'terminal' | 'copy' | 'run'

export interface HandoffEntry {
  title: string
  dismissed: boolean
  agent?: HandoffAgent
  method?: HandoffMethod
  at: string
  reason?: string
  reviewed: boolean
  outputFile?: string
  finishedAt?: string
  failed: boolean
}

export interface DailyBriefUserState {
  checkedItemKeys: string[]
  dismissedItemKeys: string[]
  addedTasks: { id: string; title: string }[]
  hasBeenShown: boolean
  promptEdits: Record<string, string>
  folders: Record<string, string>
  handoffs: HandoffEntry[]
}

export interface DailyBriefRunStats {
  durationSeconds: number
  model?: string
  costUSD?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  numTurns?: number
  toolCalls?: Record<string, number>
  cardCount?: number
  candidateImageCount?: number
  promptCharacters?: number
  usedPromptOverride: boolean
  usedOverrideInstructions: boolean
  trigger?: string
  /** Which engine produced the brief: claude_cli with connectors, or timeline-only via the configured provider. */
  engine?: string
  failedParts?: Partial<Record<BriefPart, string>>
}

export interface DailyBrief {
  day: string
  sourceDay: string
  generatedAt: string
  content: DailyBriefContent
  userState: DailyBriefUserState
  stats?: DailyBriefRunStats
}

export type FeedbackAction = 'opened' | 'saved' | 'dismissed' | 'checked' | 'expanded'

export interface DailyBriefFeedbackEvent {
  day: string
  section: string
  itemTitle: string
  action: FeedbackAction
  at: string
}

export interface DailyBriefSavedItem {
  id: string
  savedAt: string
  imageFile: string
  caption?: string
  sourceDay: string
}

export type SummaryRange = 'last_7_days' | 'last_30_days' | 'quarter_to_date' | 'year_to_date'

export interface DailyBriefRangeSummary {
  range: SummaryRange
  startDay: string
  endDay: string
  generatedAt: string
  overview: string
  milestones: string[]
  projects: { title: string; bullets: string[]; impact?: string; imageFile?: string }[]
}

export type BriefRunState =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: string; trigger: string }
  | { kind: 'failed'; message: string }

export interface BriefViewState {
  enabled: boolean
  today: string
  brief: DailyBrief | null
  run: BriefRunState
  lastFailedRunStats: DailyBriefRunStats | null
  /** "connectors" when Claude CLI runs with the user's connectors, else "timeline". */
  engine: 'connectors' | 'timeline'
  engineLabel: string
}

export type DocketStatus = 'new' | 'dismissed' | 'inProgress' | 'ready' | 'reviewed' | 'failed'

export const DISMISS_REASONS = [
  'That task was irrelevant to what I’m working on',
  'That task should not be handed to an agent',
  'The task did not capture what I was actually supposed to do',
  'The prompt provided was not helpful',
  'Other',
] as const

export type BriefAction =
  | { type: 'toggleCheck'; section: BriefSectionKey; title: string }
  | { type: 'dismissItem'; section: BriefSectionKey; title: string }
  | { type: 'addTask'; title: string }
  | { type: 'removeTask'; id: string }
  | { type: 'setPromptEdit'; title: string; prompt: string }
  | { type: 'setFolder'; title: string; folder: string }
  | { type: 'handoff'; title: string; agent: HandoffAgent; method: HandoffMethod }
  | { type: 'dismissDocket'; title: string }
  | { type: 'undoDismissDocket'; title: string }
  | { type: 'setDismissReason'; title: string; reason: string }
  | { type: 'openResult'; title: string }
  | { type: 'resetDocket' }
  | { type: 'saveImage'; file: string; caption?: string }
  | { type: 'feedback'; section: BriefSectionKey; title: string; action: FeedbackAction }

export interface BriefActionResult {
  brief: DailyBrief | null
  /** Human-readable note, e.g. "Prompt copied to the clipboard". */
  message?: string
}

export interface CompletedDayGroup {
  day: string
  sourceDay: string
  items: CompletedItem[]
}

// ---------------------------------------------------------------------------------------------
// Day goals
// ---------------------------------------------------------------------------------------------

export interface DayGoalCategorySnapshot {
  /** Windows categories have no UUID; the normalized category name is used as the id. */
  categoryID: string
  name: string
  colorHex: string
  sortOrder: number
}

export interface DayGoalPlan {
  day: string
  focusTargetMinutes: number
  distractionLimitMinutes: number
  focusCategories: DayGoalCategorySnapshot[]
  distractionCategories: DayGoalCategorySnapshot[]
  isSkipped: boolean
  /** unix seconds; 0 = carried forward / default (no row for this day) */
  createdAt: number
  updatedAt: number
}

export interface CategoryDuration {
  name: string
  colorHex: string
  minutes: number
}

export interface DayGoalProgress {
  day: string
  plan: DayGoalPlan
  /** true when the plan row belongs to this day (not carried forward). */
  isExplicit: boolean
  totalCapturedMinutes: number
  focusMinutes: number
  distractedMinutes: number
  /** Up to 4 focus categories with their own durations, for the segmented bar. */
  focusSegments: CategoryDuration[]
  categoryDurations: CategoryDuration[]
  focusBlocks: { start: number; end: number }[]
}

export interface DayGoalPromptState {
  show: boolean
  startOn: 'review' | 'setup'
  /** Yesterday's progress against yesterday's plan, when the review applies. */
  review: DayGoalProgress | null
}

export interface DayGoalReference {
  /** minutes per selected category kind, for D-1 and the D-1…D-7 average */
  yesterdayFocus: number
  weekAverageFocus: number
  yesterdayDistraction: number
  weekAverageDistraction: number
}
