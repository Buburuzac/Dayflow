import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSettingsPatch, SettingsValidationError, validateCommand } from '../src/main/settings-schema.ts'

const TOOL = 'C:\\Tools\\claude.cmd'
const exists = (p: string) => p === TOOL

test('unknown keys are dropped, valid keys kept', () => {
  const out = sanitizeSettingsPatch({ provider: 'gemini', hasGeminiKey: true, evil: 1, captureIntervalSeconds: 10 }, exists)
  assert.deepEqual(out, { provider: 'gemini', captureIntervalSeconds: 10 })
})

test('commands: names and existing absolute paths only', () => {
  assert.equal(validateCommand('c', 'claude', exists), 'claude')
  assert.equal(validateCommand('c', TOOL, exists), TOOL)
  const bad = ['calc & claude', 'claude"', 'C:\\Tools\\missing.cmd', '..\\run.exe', 'powershell -c x', '%COMSPEC%', 'a|b']
  for (const b of bad) assert.throws(() => validateCommand('c', b, exists), SettingsValidationError, b)
})

test('rejects bad urls, numbers, providers and categories', () => {
  assert.throws(() => sanitizeSettingsPatch({ openaiBaseUrl: 'file:///C:/x' }, exists), SettingsValidationError)
  assert.throws(() => sanitizeSettingsPatch({ captureIntervalSeconds: 0 }, exists), SettingsValidationError)
  assert.throws(() => sanitizeSettingsPatch({ provider: 'shell' }, exists), SettingsValidationError)
  assert.throws(
    () => sanitizeSettingsPatch({ categories: [{ name: 'A', color: 'red', description: '' }] }, exists),
    SettingsValidationError,
  )
  assert.throws(() => sanitizeSettingsPatch({ excludedApps: ['ok', 'a;b'] }, exists), SettingsValidationError)
  assert.deepEqual(sanitizeSettingsPatch({ openaiBaseUrl: 'http://localhost:11434/v1' }, exists), {
    openaiBaseUrl: 'http://localhost:11434/v1',
  })
  assert.deepEqual(sanitizeSettingsPatch({ outputLanguage: 'Русский' }, exists), { outputLanguage: 'Русский' })
})
