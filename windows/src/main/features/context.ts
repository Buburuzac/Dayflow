// Shared context handed to feature modules (weekly, daily, chat, flow, timelapse, …).
// Each feature lives in src/main/features/<name>.ts and exports `register(ctx: FeatureContext)`,
// which registers its ipcMain.handle('<name>:…') channels and any timers.

import type { Store } from '../db.ts'
import type { LLMProvider } from '../llm/types.ts'
import type { SettingsStore } from '../settings.ts'

export interface ProviderOptions {
  /** Log successful calls to llm_calls (default true). Frequent callers such as Flow pass false. */
  logSuccess?: boolean
}

export interface FeatureContext {
  store: Store
  settings: SettingsStore
  /** Configured provider for the current settings; throws with a user-facing message when not configured. */
  makeProvider: (batchId: number | null, options?: ProviderOptions) => LLMProvider
  /** %APPDATA%\Dayflow (or DAYFLOW_DATA_DIR) */
  dataDir: string
  recordingsDir: string
  dbPath: string
  /** Absolute path of the bundled resources folder (icons etc.) */
  resourcesDir: string
  /** Sends an event to the renderer: window.dayflow.on(channel, cb) */
  broadcast: (channel: string, ...args: unknown[]) => void
  /** Notifies the renderer that timeline cards changed */
  cardsChanged: () => void
}
