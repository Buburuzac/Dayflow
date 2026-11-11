// Settings persisted as JSON in %APPDATA%\Dayflow; API keys encrypted with Electron's
// safeStorage (DPAPI on Windows) instead of the macOS Keychain.

import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Category, SecretsUpdate, Settings, SettingsWithSecrets } from '../shared/types.ts'
import { notifySync } from './sync/hooks.ts'

export const DEFAULT_CATEGORIES: Category[] = [
  {
    name: 'Work',
    color: '#B984FF',
    description:
      'Career, school, or productivity-focused activities (projects, emails, assignments, video calls, learning skills, etc.)',
  },
  {
    name: 'Personal',
    color: '#6AADFF',
    description:
      'Purposeful non-work activities or life tasks (paying bills, fitness tracking, meal planning, personal research, creative hobbies, etc.)',
  },
  {
    name: 'Distraction',
    color: '#FF5950',
    description:
      'Passive consumption or aimless browsing (scrolling feeds, watching random videos, clicking through news, mindless games, etc.)',
  },
  { name: 'Idle', color: '#A0AEC0', description: 'For when the user is idle for most of the time.', isIdle: true },
]

export const DEFAULT_SETTINGS: Settings = {
  provider: 'gemini',
  geminiModel: 'gemini-2.5-flash',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiModel: 'qwen2.5vl:7b',
  cliModel: '',
  claudeCommand: 'claude',
  codexCommand: 'codex',
  captureIntervalSeconds: 10,
  captureHeight: 1080,
  jpegQuality: 70,
  storageLimitGB: 10,
  retentionDays: 14,
  outputLanguage: '',
  launchAtLogin: true,
  categories: DEFAULT_CATEGORIES,
  excludedApps: [],
  accessibilityCaptureEnabled: false,
  syncExcludedCategories: ['Personal'],
  syncOutOfScope: true,
  syncObservations: false,
}

interface Secrets {
  geminiApiKey?: string
  openaiApiKey?: string
  /** Dayflow Sync Server device token (never sent to the renderer) */
  syncDeviceToken?: string
}

export class SettingsStore {
  private settings: Settings
  private secrets: Secrets
  private readonly file: string
  private readonly secretsFile: string
  private readonly listeners = new Set<(s: Settings, patch: Partial<Settings>) => void>()

  /** Called after every update with the new settings and the patch that was applied. */
  onChange(fn: (s: Settings, patch: Partial<Settings>) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  constructor(dir: string) {
    this.file = join(dir, 'settings.json')
    this.secretsFile = join(dir, 'secrets.bin')
    this.settings = { ...DEFAULT_SETTINGS }
    if (existsSync(this.file)) {
      try {
        this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(this.file, 'utf8')) }
      } catch (err) {
        console.error('[settings] could not read settings.json, using defaults', err)
      }
    }
    if (!this.settings.categories?.some((c) => c.isIdle)) {
      this.settings.categories = [...(this.settings.categories ?? []), DEFAULT_CATEGORIES[3]]
    }
    this.secrets = this.loadSecrets()
  }

  /**
   * secrets.bin format: "DFE1" + DPAPI-encrypted JSON, or "DFP1" + plain JSON when encryption is
   * unavailable. Files without a marker (earlier builds) are tried as encrypted, then as plain.
   */
  private loadSecrets(): Secrets {
    if (!existsSync(this.secretsFile)) return {}
    try {
      const buf = readFileSync(this.secretsFile)
      const marker = buf.subarray(0, 4).toString('latin1')
      const body = buf.subarray(4)
      let json: string
      if (marker === 'DFE1') json = safeStorage.decryptString(body)
      else if (marker === 'DFP1') json = body.toString('utf8')
      else {
        try {
          json = safeStorage.decryptString(buf)
        } catch {
          json = buf.toString('utf8')
        }
      }
      const secrets = JSON.parse(json) as Secrets
      // Upgrade plaintext storage once encryption becomes available.
      if (marker !== 'DFE1' && safeStorage.isEncryptionAvailable()) this.writeSecrets(secrets)
      return secrets
    } catch (err) {
      console.error('[settings] could not read secrets.bin; API keys need to be entered again', err)
      return {}
    }
  }

  private writeSecrets(secrets: Secrets): void {
    const json = JSON.stringify(secrets)
    if (safeStorage.isEncryptionAvailable()) {
      this.writeAtomic(this.secretsFile, Buffer.concat([Buffer.from('DFE1', 'latin1'), safeStorage.encryptString(json)]))
    } else {
      console.warn('[settings] DPAPI encryption unavailable; storing API keys unencrypted')
      this.writeAtomic(this.secretsFile, Buffer.concat([Buffer.from('DFP1', 'latin1'), Buffer.from(json, 'utf8')]))
    }
  }

  private writeAtomic(path: string, data: string | Buffer): void {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  }

  get(): Settings {
    return this.settings
  }

  getSecret(key: keyof Secrets): string {
    return this.secrets[key] ?? ''
  }

  /** Main-process only: stores or clears (empty string) one secret. */
  setSecret(key: keyof Secrets, value: string): void {
    if (value) this.secrets[key] = value
    else delete this.secrets[key]
    this.writeSecrets(this.secrets)
  }

  withSecrets(): SettingsWithSecrets {
    return { ...this.settings, hasGeminiKey: !!this.secrets.geminiApiKey, hasOpenaiKey: !!this.secrets.openaiApiKey }
  }

  update(patch: Partial<Settings>, secrets?: SecretsUpdate): Settings {
    this.settings = { ...this.settings, ...patch }
    this.writeAtomic(this.file, JSON.stringify(this.settings, null, 2))
    if (patch.categories) notifySync('user_doc', 'categories')
    for (const fn of this.listeners) {
      try {
        fn(this.settings, patch)
      } catch (err) {
        console.error('[settings] listener failed', err)
      }
    }
    if (secrets && Object.keys(secrets).length > 0) {
      for (const [k, v] of Object.entries(secrets) as [keyof Secrets, string | undefined][]) {
        if (v === undefined) continue
        if (v === '') delete this.secrets[k]
        else this.secrets[k] = v.trim()
      }
      this.writeSecrets(this.secrets)
    }
    return this.settings
  }
}
