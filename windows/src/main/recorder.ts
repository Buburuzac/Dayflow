// Periodic screenshot capture — the Windows counterpart of ScreenRecorder.swift
// (ScreenCaptureKit). Uses Electron's desktopCapturer, which needs no permission prompt on
// Windows, and captures the display under the mouse cursor.

import { desktopCapturer, powerMonitor, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { stat, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RecorderState } from '../shared/types.ts'
import type { Store } from './db.ts'
import type { ForegroundProbe } from './foreground.ts'
import type { SettingsStore } from './settings.ts'

export class Recorder {
  state: RecorderState = 'stopped'
  pausedUntil: number | null = null
  lastCaptureAt: number | null = null
  lastError: string | null = null
  private timer: NodeJS.Timeout | null = null
  private resumeTimer: NodeJS.Timeout | null = null
  private locked = false
  private capturing = false
  private consecutiveFailures = 0
  private useGdi = false
  private readonly store: Store
  private readonly settings: SettingsStore
  private readonly probe: ForegroundProbe
  private readonly dir: string
  private readonly onChange: () => void

  constructor(store: Store, settings: SettingsStore, probe: ForegroundProbe, dir: string, onChange: () => void) {
    this.store = store
    this.settings = settings
    this.probe = probe
    this.dir = dir
    this.onChange = onChange
    powerMonitor.on('lock-screen', () => this.setLocked(true))
    powerMonitor.on('unlock-screen', () => this.setLocked(false))
    powerMonitor.on('suspend', () => this.setLocked(true))
    powerMonitor.on('resume', () => this.setLocked(false))
  }

  private setLocked(locked: boolean): void {
    this.locked = locked
    if (this.state === 'recording' || this.state === 'locked') {
      this.state = locked ? 'locked' : 'recording'
      this.onChange()
    }
  }

  start(): void {
    this.pausedUntil = null
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    this.state = this.locked ? 'locked' : 'recording'
    this.restartTimer()
    this.onChange()
  }

  /** Re-reads the capture interval. */
  restartTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.state === 'paused' || this.state === 'stopped') return
    const interval = Math.max(1, this.settings.get().captureIntervalSeconds) * 1000
    this.timer = setInterval(() => void this.tick(), interval)
    void this.tick()
  }

  /** Pauses for `minutes`, or indefinitely when null. */
  pause(minutes: number | null): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.state = 'paused'
    this.pausedUntil = minutes ? Date.now() + minutes * 60_000 : null
    if (minutes) this.resumeTimer = setTimeout(() => this.start(), minutes * 60_000)
    this.onChange()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.timer = null
    this.state = 'stopped'
  }

  private async tick(): Promise<void> {
    if (this.capturing || this.locked || this.state === 'paused' || this.state === 'stopped') return
    this.capturing = true
    try {
      await this.capture()
      this.consecutiveFailures = 0
      if (this.state === 'error') {
        this.state = 'recording'
        this.lastError = null
        this.onChange()
      }
    } catch (err) {
      this.consecutiveFailures++
      this.lastError = err instanceof Error ? err.message : String(err)
      console.error('[recorder] capture failed', err)
      if (this.consecutiveFailures >= 3 && this.state !== 'error') {
        this.state = 'error'
        this.onChange()
      }
    } finally {
      this.capturing = false
    }
  }

  private async capture(): Promise<void> {
    const cfg = this.settings.get()
    const fg = await this.probe.query()
    const excluded = cfg.excludedApps.map((a) => a.trim().toLowerCase()).filter(Boolean)
    // Privacy: never store frames of excluded apps. If the foreground window can't be
    // determined (helper slow or dead), skip the frame rather than risk capturing one.
    if (excluded.length > 0 && (!fg || excluded.includes(fg.process.toLowerCase()))) return

    // Started while the screen was already locked: no lock event will ever arrive for that.
    if (fg?.locked) {
      this.setLocked(true)
      this.locked = false // keep ticking so we notice the unlock
      return
    }
    if (this.state === 'locked') {
      this.state = 'recording'
      this.onChange()
    }

    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { width, height } = display.size
    const targetH = Math.min(cfg.captureHeight, Math.round(height * display.scaleFactor))
    const targetW = Math.round((width / height) * targetH)
    const quality = Math.min(95, Math.max(30, cfg.jpegQuality))

    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const folder = join(this.dir, day)
    mkdirSync(folder, { recursive: true })
    const ts = Math.floor(now.getTime() / 1000)
    const file = join(folder, `${now.getTime()}.jpg`)

    let size: number
    const sources = this.useGdi
      ? []
      : await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: targetW, height: targetH } })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (source && !source.thumbnail.isEmpty()) {
      const jpeg = source.thumbnail.toJPEG(quality)
      await writeFile(file, jpeg)
      size = jpeg.length
    } else {
      // desktopCapturer returns empty images on some drivers / remote sessions; use GDI instead
      // and stick with it for this session.
      const phys = screen.dipToScreenPoint(cursor)
      try {
        await this.probe.capture(file, targetH, quality, phys.x, phys.y)
      } catch (err) {
        this.useGdi = false // try desktopCapturer again next time
        throw err
      }
      if (!this.useGdi) console.log('[recorder] desktopCapturer returned no image; switched to GDI capture')
      this.useGdi = true
      size = (await stat(file)).size
    }

    const label = fg && (fg.process || fg.title) ? `${fg.process}${fg.title ? ` — ${fg.title}` : ''}`.slice(0, 300) : null
    try {
      this.store.insertScreenshot(ts, file, size, powerMonitor.getSystemIdleTime(), label)
    } catch (err) {
      await unlink(file).catch(() => {})
      throw err
    }
    this.lastCaptureAt = ts
  }
}
