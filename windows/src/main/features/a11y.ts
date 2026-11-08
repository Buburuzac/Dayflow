// Accessibility recorder feature (spec-rest.md §E): records clicks, shortcuts, typed text,
// submits and on-screen text through Windows UI Automation next to the screenshots, and
// condenses it per analysis batch for the transcription prompt.
//
// Main-process only: no IPC channels. index.ts drives it with setRecordingState() (start/stop
// together with screen recording) and shutdown(); the analysis pipeline calls condensedLogFor().
// Off by default (setting `accessibilityCaptureEnabled`, or DAYFLOW_A11Y=1/0 to override).

import { powerMonitor } from 'electron'
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { MINIMUM_EVENTS, condense, trimmed } from '../a11y/condenser.ts'
import { A11yRecorder } from '../a11y/recorder.ts'
import { A11yLogStore } from '../a11y/store.ts'
import { UiaHelper } from '../a11y/uia.ts'
import type { FeatureContext } from './context.ts'

/** Logs are deleted once the screenshots from the same time are gone, and never kept longer than this. */
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

interface State {
  ctx: FeatureContext
  store: A11yLogStore
  helper: UiaHelper
  recorder: A11yRecorder
  recordingActive: boolean
  locked: boolean
  /** Recording is running (a start succeeded and it hasn't been stopped). */
  wanted: boolean
  starting: boolean
  /** No new start attempt before this (epoch ms): backoff after a failed start. */
  retryAt: number
  excludedKey: string
  restartDelay: number
}

let state: State | null = null
let fullUserName: string | null = null

export function isEnabled(ctx: FeatureContext): boolean {
  const env = process.env.DAYFLOW_A11Y
  if (env === '1' || env === 'true') return true
  if (env === '0' || env === 'false') return false
  return (ctx.settings.get() as unknown as Record<string, unknown>).accessibilityCaptureEnabled === true
}

function excludedApps(ctx: FeatureContext): string[] {
  const list = ctx.settings.get().excludedApps
  return Array.isArray(list) ? list.filter((a) => typeof a === 'string' && a.trim()) : []
}

function sync(): void {
  const s = state
  if (!s) return
  const enabled = isEnabled(s.ctx)
  const want = enabled && s.recordingActive && !s.locked
  const key = excludedApps(s.ctx).join('\n')
  if (key !== s.excludedKey) {
    s.excludedKey = key
    s.recorder.refreshBlocked()
  }
  if (!want) {
    if (!s.wanted && !s.starting) return
    s.wanted = false
    s.retryAt = 0
    s.recorder.stop()
    if (!enabled) void s.recorder.idle().then(() => s.helper.dispose())
    return
  }
  // `wanted` means "recording and the helper is up": set only once a start succeeded, so a
  // failed start is retried (with backoff) by the next sync instead of never.
  if (s.wanted || s.starting || Date.now() < s.retryAt) return
  s.starting = true
  void s.recorder.start().then((ok) => {
    s.starting = false
    if (state !== s) return
    if (ok) {
      s.wanted = true
      s.restartDelay = 3000
      s.retryAt = 0
    } else {
      s.retryAt = Date.now() + s.restartDelay
      s.restartDelay = Math.min(s.restartDelay * 2, 5 * 60_000)
    }
    sync() // conditions may have changed while starting
  })
}

function prune(): void {
  const s = state
  if (!s) return
  let cutoff = Date.now() - MAX_RETENTION_MS
  try {
    const oldest = s.ctx.store.oldestScreenshots(1)[0]
    if (oldest) cutoff = Math.max(cutoff, oldest.capturedAt * 1000)
  } catch {
    /* database busy: use the time limit alone */
  }
  s.store.prune(cutoff)
}

function loadFullUserName(): void {
  fullUserName = userInfo().username
  // The display name, as NSFullUserName() gives on macOS ("Jane Doe"); its first word is
  // stripped from browser titles as the profile name.
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '([adsi]"WinNT://$env:USERDOMAIN/$env:USERNAME,user").FullName'],
    { windowsHide: true, timeout: 15_000 },
    (err, stdout) => {
      const name = String(stdout ?? '').trim()
      if (!err && name) fullUserName = name
    },
  )
}

export function register(ctx: FeatureContext): void {
  const root = join(ctx.dataDir, 'accessibility')
  const store = new A11yLogStore(root)
  let recorder: A11yRecorder | null = null
  const helper = new UiaHelper({
    scriptDir: join(root, '.helper'),
    ownPid: process.pid,
    onEvent: (e) => recorder?.onHelperEvent(e),
    onExit: () => {
      // Crashed or killed by its own watchdog while recording: bring it back, with backoff.
      const s = state
      if (!s || !s.wanted) return
      const delay = s.restartDelay
      s.restartDelay = Math.min(delay * 2, 5 * 60_000)
      setTimeout(() => {
        if (state?.wanted) void helper.start().then((ok) => ok && state && (state.restartDelay = 3000))
      }, delay).unref()
    },
  })
  recorder = new A11yRecorder({ helper, store, excludedApps: () => excludedApps(ctx), ownPid: process.pid })
  state = {
    ctx,
    store,
    helper,
    recorder,
    recordingActive: false,
    locked: false,
    wanted: false,
    starting: false,
    retryAt: 0,
    excludedKey: '',
    restartDelay: 3000,
  }
  loadFullUserName()

  const setLocked = (locked: boolean) => {
    if (!state) return
    state.locked = locked
    sync()
  }
  powerMonitor.on('lock-screen', () => setLocked(true))
  powerMonitor.on('unlock-screen', () => setLocked(false))
  powerMonitor.on('suspend', () => setLocked(true))
  powerMonitor.on('resume', () => setLocked(false))

  // Settings changes (the toggle, excluded apps) are picked up within a few seconds.
  setInterval(sync, 3000).unref()
  setTimeout(prune, 60_000).unref()
  setInterval(prune, 30 * 60_000).unref()
  sync()
}

/**
 * Drive from the screen recorder: pass its state on every change. The accessibility recorder
 * runs only while screenshots are being taken ('recording'); paused, locked, stopped or
 * errored → stopped.
 */
export function setRecordingState(recorderState: string): void {
  if (!state) return
  state.recordingActive = recorderState === 'recording'
  sync()
}

/** Stops recording and closes files; call on quit. */
export function shutdown(): void {
  const s = state
  if (!s) return
  s.wanted = false
  s.recordingActive = false // an in-flight start must not bring it back
  s.recorder.stop()
  void s.recorder.idle().then(() => {
    s.store.close()
    s.helper.dispose()
  })
}

/**
 * The condensed accessibility log for `[startTs, endTs)` (epoch seconds), or null when the
 * feature is off, there is no log for that time, or it has too few events. Never throws: a log
 * that can't be read is the same as no log. With `batchId` the text is also saved next to the
 * raw logs as `HHmm-batch<id>.txt`.
 */
export async function condensedLogFor(startTs: number, endTs: number, batchId?: number): Promise<string | null> {
  const s = state
  if (!s || !isEnabled(s.ctx)) return null
  // Let pending I/O run first; condensing is synchronous CPU work.
  await new Promise((r) => setImmediate(r))
  try {
    const started = Date.now()
    const events = s.store.loadEvents(startTs * 1000, endTs * 1000)
    if (events.length < MINIMUM_EVENTS) return null
    const text = trimmed(condense(events, fullUserName ?? userInfo().username))
    if (!text) return null
    if (batchId !== undefined) s.store.saveCondensedLog(text, batchId, startTs * 1000)
    console.log(`[a11y] condensed ${events.length} events to ${text.length} chars in ${Date.now() - started} ms`)
    return text
  } catch (err) {
    console.error('[a11y] could not condense the log', err)
    return null
  }
}
