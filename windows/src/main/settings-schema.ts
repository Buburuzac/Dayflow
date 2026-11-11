// Validation for settings patches coming from the renderer. The renderer is not trusted with
// arbitrary values: some settings are executed (CLI commands) or receive screenshots (server
// URL), so every key is checked here and unknown keys are dropped. Pure module (no Electron).

import type { Category, ProviderId, Settings } from '../shared/types.ts'

const PROVIDERS: ProviderId[] = ['gemini', 'openai_compatible', 'claude_cli', 'codex_cli']
const MODEL_RE = /^[\w.:\-/@]{0,120}$/
/** cmd.exe metacharacters that would let a "command" setting run something else. */
const SHELL_META_RE = /[&|<>^"%!()`\r\n]/

export class SettingsValidationError extends Error {}

function fail(key: string, why: string): never {
  throw new SettingsValidationError(`Invalid setting "${key}": ${why}`)
}

function str(key: string, v: unknown, max: number): string {
  if (typeof v !== 'string') fail(key, 'expected text')
  if (v.length > max) fail(key, `longer than ${max} characters`)
  return v
}

function num(key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(key, `expected a number ${min}–${max}`)
  return v
}

function bool(key: string, v: unknown): boolean {
  if (typeof v !== 'boolean') fail(key, 'expected true/false')
  return v
}

/**
 * A CLI command is either a bare program name looked up on PATH (e.g. "claude") or an absolute
 * path to an .exe/.cmd/.bat file. `exists` checks the file for absolute paths.
 */
export function validateCommand(key: string, v: unknown, exists: (path: string) => boolean): string {
  const s = str(key, v, 260).trim()
  if (s === '') return ''
  if (SHELL_META_RE.test(s)) fail(key, 'must be a program name or a path, without shell characters')
  if (/^[\w.-]+$/.test(s)) return s
  if (/^[a-zA-Z]:\\/.test(s) && /\.(exe|cmd|bat)$/i.test(s)) {
    if (!exists(s)) fail(key, 'file not found')
    return s
  }
  fail(key, 'use a program name on PATH or a full path to an .exe/.cmd file')
}

function validateUrl(key: string, v: unknown): string {
  const s = str(key, v, 500).trim()
  let u: URL
  try {
    u = new URL(s)
  } catch {
    fail(key, 'not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(key, 'must start with http:// or https://')
  return s
}

function validateCategories(v: unknown): Category[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 30) fail('categories', 'expected 1–30 categories')
  const out = v.map((c, i): Category => {
    if (!c || typeof c !== 'object') fail('categories', `item ${i + 1} is not an object`)
    const o = c as Record<string, unknown>
    const name = str('categories.name', o.name, 60).trim()
    if (!name) fail('categories', `item ${i + 1} has no name`)
    const color = str('categories.color', o.color, 9)
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) fail('categories', `"${name}" has an invalid color`)
    const cat: Category = { name, color, description: str('categories.description', o.description ?? '', 500) }
    if (o.isIdle === true) cat.isIdle = true
    return cat
  })
  if (new Set(out.map((c) => c.name.toLowerCase())).size !== out.length) fail('categories', 'names must be unique')
  return out
}

/** Returns a clean patch with only known, valid keys; throws SettingsValidationError otherwise. */
export function sanitizeSettingsPatch(raw: unknown, exists: (path: string) => boolean): Partial<Settings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsValidationError('Invalid settings')
  const p = raw as Record<string, unknown>
  const out: Partial<Settings> = {}
  for (const key of Object.keys(p)) {
    const v = p[key]
    switch (key) {
      case 'provider':
        if (!PROVIDERS.includes(v as ProviderId)) fail(key, 'unknown provider')
        out.provider = v as ProviderId
        break
      case 'geminiModel':
      case 'openaiModel':
      case 'cliModel': {
        const s = str(key, v, 120).trim()
        if (!MODEL_RE.test(s)) fail(key, 'unexpected characters')
        out[key] = s
        break
      }
      case 'openaiBaseUrl':
        out.openaiBaseUrl = validateUrl(key, v)
        break
      case 'claudeCommand':
      case 'codexCommand':
        out[key] = validateCommand(key, v, exists)
        break
      case 'captureIntervalSeconds':
        out.captureIntervalSeconds = num(key, v, 1, 600)
        break
      case 'captureHeight':
        out.captureHeight = num(key, v, 360, 2160)
        break
      case 'jpegQuality':
        out.jpegQuality = num(key, v, 30, 95)
        break
      case 'storageLimitGB':
        out.storageLimitGB = num(key, v, 0.5, 10_000)
        break
      case 'retentionDays':
        out.retentionDays = num(key, v, 1, 3650)
        break
      case 'outputLanguage': {
        const s = str(key, v, 40).trim()
        if (!/^[\p{L} ()-]*$/u.test(s)) fail(key, 'use a language name such as "Russian"')
        out.outputLanguage = s
        break
      }
      case 'launchAtLogin':
      case 'syncOutOfScope':
      case 'syncObservations':
      case 'accessibilityCaptureEnabled':
        out[key] = bool(key, v)
        break
      case 'categories':
        out.categories = validateCategories(v)
        break
      case 'syncExcludedCategories': {
        if (!Array.isArray(v) || v.length > 30) fail(key, 'expected a list of up to 30 categories')
        out.syncExcludedCategories = v.map((c) => {
          const n = str(key, c, 60).trim()
          if (!n) fail(key, 'empty category name')
          return n
        })
        break
      }
      case 'excludedApps': {
        if (!Array.isArray(v) || v.length > 100) fail(key, 'expected a list of up to 100 apps')
        out.excludedApps = v.map((a) => {
          const s = str(key, a, 80).trim()
          if (!/^[\w .+-]+$/.test(s)) fail(key, `"${s}" is not a process name`)
          return s
        })
        break
      }
      default:
        // Unknown or read-only keys (e.g. hasGeminiKey) are ignored.
        break
    }
  }
  return out
}
