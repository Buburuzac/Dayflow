// Types shared between the main process, the preload bridge and the renderer.

export type ProviderId = 'gemini' | 'openai_compatible' | 'claude_cli' | 'codex_cli'

export interface Category {
  name: string
  color: string
  description: string
  isIdle?: boolean
}

export interface Settings {
  provider: ProviderId
  /** Gemini model id, e.g. gemini-2.5-flash */
  geminiModel: string
  /** Base URL of an OpenAI-compatible server (Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1) */
  openaiBaseUrl: string
  openaiModel: string
  /** Optional model override for the Claude / Codex CLI */
  cliModel: string
  /** Path or command name of the CLI executable (default: "claude" / "codex") */
  claudeCommand: string
  codexCommand: string
  /** Seconds between screenshots */
  captureIntervalSeconds: number
  /** Height (px) each frame is scaled to */
  captureHeight: number
  jpegQuality: number
  /** Disk budget for screenshots, in GB. Oldest frames are purged first. */
  storageLimitGB: number
  /** Screenshots older than this are deleted regardless of the budget */
  retentionDays: number
  /** Language the LLM writes cards in; empty = English */
  outputLanguage: string
  launchAtLogin: boolean
  categories: Category[]
  /** Process names (without .exe) whose windows should not be captured, e.g. "KeePassXC" */
  excludedApps: string[]
  /** Accessibility recorder (UI Automation text, clicks, typing). Off by default. */
  accessibilityCaptureEnabled: boolean
  /** Sync: categories whose cards never leave this PC (case-insensitive). */
  syncExcludedCategories: string[]
  /** Sync: cards without a confirmed project are uploaded as time-only "Out of scope" blocks. */
  syncOutOfScope: boolean
  /** Sync: upload raw observations (the model's screen descriptions). */
  syncObservations: boolean
}

export interface SettingsWithSecrets extends Settings {
  hasGeminiKey: boolean
  hasOpenaiKey: boolean
}

export interface SecretsUpdate {
  geminiApiKey?: string
  openaiApiKey?: string
}

export interface Distraction {
  startTime: string
  endTime: string
  title: string
  summary: string
}

export interface AppSites {
  primary?: string | null
  secondary?: string | null
}

export interface TimelineCard {
  id: number
  batchId: number | null
  startTs: number
  endTs: number
  startTime: string
  endTime: string
  day: string
  title: string
  summary: string
  detailedSummary: string
  category: string
  subcategory: string
  distractions: Distraction[]
  appSites: AppSites | null
  isError: boolean
  /** Stable sync id (uuid). */
  uuid?: string
  /** Device that generated the card; null/undefined for legacy rows (this device). */
  deviceId?: string | null
  /** True when the card was pulled from another of the user's devices (shown, never rewritten here). */
  remote?: boolean
  /** metadata.private: synced to own devices only, never projected to the team. */
  private?: boolean
  /** Project assignments (filled by the cards:get channel). */
  projects?: CardProjectInfo[]
  detailProjects?: Record<string, DetailProjectRef[]>
}

export interface DetailProjectRef { projectId: string; share: number; source: 'manual' | 'rule' | 'llm'; confidence: number; confirmed: boolean }

export interface CardProjectInfo {
  projectId: string
  name: string
  color: string
  icon?: string
  share: number
  source: 'manual' | 'rule' | 'llm'
  confidence: number
  confirmed: boolean
}

export interface ScreenshotInfo {
  id: number
  capturedAt: number
  filePath: string
}

export type RecorderState = 'recording' | 'paused' | 'idle' | 'locked' | 'error' | 'stopped'

export interface AppStatus {
  recorder: RecorderState
  pausedUntil: number | null
  lastCaptureAt: number | null
  lastError: string | null
  pendingScreenshots: number
  batchesProcessing: number
  batchesFailed: number
  storageBytes: number
}

export interface BatchInfo {
  id: number
  startTs: number
  endTs: number
  status: string
  reason: string | null
}

export interface DayflowApi {
  getSettings(): Promise<SettingsWithSecrets>
  saveSettings(s: Partial<Settings>, secrets?: SecretsUpdate): Promise<SettingsWithSecrets>
  testProvider(): Promise<{ ok: boolean; message: string }>
  getCards(day: string): Promise<TimelineCard[]>
  getCardScreenshots(cardId: number): Promise<ScreenshotInfo[]>
  getBatches(day: string): Promise<BatchInfo[]>
  getStatus(): Promise<AppStatus>
  pause(minutes: number | null): Promise<void>
  resume(): Promise<void>
  analyzeNow(): Promise<void>
  reprocessDay(day: string): Promise<void>
  deleteCard(cardId: number): Promise<void>
  updateCardTitle(cardId: number, title: string): Promise<void>
  updateCardCategory(cardId: number, category: string): Promise<void>
  exportMarkdown(fromDay: string, toDay: string): Promise<string | null>
  openDataFolder(): Promise<void>
  imageUrl(filePath: string): string
  /** Generic channel for feature modules (weekly:*, daily:*, chat:*, flow:*, …). */
  call<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** Subscribe to a main → renderer event. Returns an unsubscribe function. */
  on(channel: string, cb: (...args: unknown[]) => void): () => void
  onStatus(cb: (s: AppStatus) => void): () => void
  onCardsChanged(cb: () => void): () => void
}
