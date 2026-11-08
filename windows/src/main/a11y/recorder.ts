// Records what the user does alongside the screenshots — port of AccessibilityRecorder.swift.
//   - Clicks and drags: the element under the pointer, then the screen's changes 250 ms later
//     and 1.5 s later.
//   - Typing: individual keys are never stored (the helper doesn't even send them). 750 ms
//     after the last key the focused field is read back as a whole.
//   - Return: what was in the field, then the changes at 250 ms and 1.5 s.
//   - Scrolling: 750 ms after scrolling stops, the screen's changes.
//   - Window and tab switches: polled once a second (and on EVENT_SYSTEM_FOREGROUND), then a snapshot.
// Excluded apps are skipped entirely (one `window {blocked:true}` line), password fields are
// never read, Dayflow's own windows are never read. All handling runs through one serial
// queue, like the Swift recorder's DispatchQueue.

import { shortcutName } from './keys.ts'
import { A11yLogStore } from './store.ts'
import { TreeIds, clip, type A11ySnapshot } from './tree.ts'
import type { A11yEvent } from './types.ts'
import type { FgInfo, HelperEvent, UiaHelper } from './uia.ts'

const TYPING_PAUSE = 750
const SCROLL_PAUSE = 750
const REACTION_DELAY = 250
const OUTCOME_DELAY = 1500
const WINDOW_POLL_INTERVAL = 1000
const MIN_SNAPSHOT_GAP = 400
/** Physical pixels between press and release that make a drag. */
const DRAG_DISTANCE = 6
/** A snapshot slower than this switches the app to the per-node walk for a while. */
const SLOW_SUBTREE_MS = 2500

/** Never read, whatever the settings say: the lock screen, credential prompts, UAC. */
const ALWAYS_BLOCKED = ['LogonUI', 'LockApp', 'CredentialUIBroker', 'consent']

/** Display names the condenser's app lists know (`app` field), by process name (lowercase). */
const DISPLAY_NAMES: Record<string, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  brave: 'Brave',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  firefox: 'Firefox',
  arc: 'Arc',
  windowsterminal: 'Windows Terminal',
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  'wezterm-gui': 'WezTerm',
  alacritty: 'Alacritty',
  notepad: 'Notepad',
  onenote: 'OneNote',
  slack: 'Slack',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  code: 'Visual Studio Code',
  cursor: 'Cursor',
  obsidian: 'Obsidian',
  explorer: 'File Explorer',
  'whatsapp.root': 'WhatsApp',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  outlook: 'Outlook',
  olk: 'Outlook',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  'ms-teams': 'Microsoft Teams',
  teams: 'Microsoft Teams',
}

export interface FrontApp {
  pid: number
  hwnd: number
  process: string
  bundleId: string
  name: string
  /** Chromium / Electron (Chrome_WidgetWin_1): smaller child limit, tab-strip handling. */
  isWebShaped: boolean
}

export function appInfo(fg: FgInfo): FrontApp {
  const key = fg.process.toLowerCase()
  const description = fg.description.trim()
  const name = DISPLAY_NAMES[key] ?? (description && description.length <= 40 ? description : fg.process || 'Unknown app')
  return {
    pid: fg.pid,
    hwnd: fg.hwnd,
    process: fg.process,
    bundleId: fg.process ? `${fg.process.toLowerCase()}.exe` : '',
    name,
    isWebShaped: fg.windowClass === 'Chrome_WidgetWin_1',
  }
}

export interface A11yRecorderOptions {
  helper: UiaHelper
  store: A11yLogStore
  /** Excluded process names (no .exe), read on every check. */
  excludedApps: () => string[]
  ownPid?: number
}

export class A11yRecorder {
  private readonly helper: UiaHelper
  private readonly store: A11yLogStore
  private readonly excludedApps: () => string[]
  private readonly ownPid: number
  private readonly ids = new TreeIds()

  private running = false
  private chain: Promise<void> = Promise.resolve()
  private pollTimer: NodeJS.Timeout | null = null
  private pollQueued = false
  private timers = new Set<NodeJS.Timeout>()

  private frontApp: FrontApp | null = null
  private lastWindowKey: string | null = null
  private lastSnapshotByApp = new Map<string, A11ySnapshot>()
  private lastSnapshotAt = 0
  private slowApps = new Map<string, number>()

  private mouseDownPoint = { x: 0, y: 0 }
  private mouseDownTarget: string | null = null

  private typingTimer: NodeJS.Timeout | null = null
  private lastTyped: { field: string; text: string; at: number } | null = null
  private scrollTimer: NodeJS.Timeout | null = null

  constructor(opts: A11yRecorderOptions) {
    this.helper = opts.helper
    this.store = opts.store
    this.excludedApps = opts.excludedApps
    this.ownPid = opts.ownPid ?? process.pid
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Handles one helper event (wire to UiaHelper's onEvent). */
  onHelperEvent(e: HelperEvent): void {
    if (!this.running) return
    switch (e.ev) {
      case 'md':
        this.enqueue(() => this.mouseDown(e.x, e.y, e.r === 1))
        break
      case 'mu':
        this.enqueue(() => this.mouseUp(e.x, e.y))
        break
      case 'kd': {
        // Only allowlisted combinations are shortcuts; anything else (AltGr, Alt codes, …) is typing.
        const keys = e.k === 'sc' ? shortcutName(Number(e.vk), Number(e.m), e.np === 1) : null
        const k = e.k === 'sc' && keys === null ? 'key' : e.k
        this.enqueue(() => this.keyDown(k, keys ?? undefined))
        break
      }
      case 'wheel':
        this.enqueue(() => this.scroll())
        break
      case 'fg':
        this.queuePoll()
        break
    }
  }

  // MARK: - Start/Stop

  /** Safe to call repeatedly. Resolves true once recording runs, false when the helper could not start. */
  start(): Promise<boolean> {
    let started = false
    this.enqueue(async () => {
      if (this.running) {
        started = true
        return
      }
      const ok = await this.helper.start()
      if (!ok) {
        console.error('[a11y] not starting: UI Automation helper unavailable')
        return
      }
      started = true
      await this.helper.setBlocked(this.blockList())
      await this.helper.setHooks(true)
      this.running = true
      this.store.append({ time: Date.now(), kind: 'session_start' })
      this.pollTimer = setInterval(() => this.queuePoll(), WINDOW_POLL_INTERVAL)
      this.queuePoll()
    })
    return this.chain.then(() => started)
  }

  stop(): void {
    this.enqueue(async () => {
      if (!this.running) return
      if (this.typingTimer) await this.flushTyping()
      this.running = false
      await this.helper.setHooks(false)
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = null
      for (const t of this.timers) clearTimeout(t)
      this.timers.clear()
      this.cancelTyping()
      if (this.scrollTimer) clearTimeout(this.scrollTimer)
      this.scrollTimer = null

      this.frontApp = null
      this.lastWindowKey = null
      this.lastSnapshotByApp.clear()
      this.lastTyped = null
      this.mouseDownTarget = null
      this.ids.reset()
      this.store.append({ time: Date.now(), kind: 'session_stop' })
    })
  }

  /** Resolves when everything queued so far has run (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain
  }

  /** Pushes the current exclusion list to the helper (call when settings change). */
  refreshBlocked(): void {
    this.enqueue(() => this.helper.setBlocked(this.blockList()))
  }

  private blockList(): string[] {
    return [...ALWAYS_BLOCKED, ...this.excludedApps()]
  }

  private enqueue(fn: () => Promise<void> | void): void {
    this.chain = this.chain.then(fn).catch((err) => console.error('[a11y]', err))
  }

  private later(ms: number, fn: () => Promise<void> | void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.enqueue(fn)
    }, ms)
    this.timers.add(t)
  }

  // MARK: - Input

  private async mouseDown(x: number, y: number, isRight: boolean): Promise<void> {
    const app = this.activeApp()
    if (!app) return
    this.mouseDownPoint = { x, y }
    // Dayflow's own windows (checked by the helper), elements of blocked processes: no target.
    const hit = await this.helper.describeElement(x, y)
    this.mouseDownTarget =
      !hit || hit.own || hit.blocked || this.isBlockedProcess(hit.process) ? null : hit.description
    if (isRight) {
      const event = this.makeEvent('context_menu', app)
      if (this.mouseDownTarget !== null) event.target = this.mouseDownTarget
      this.record(event)
    }
  }

  private async mouseUp(x: number, y: number): Promise<void> {
    const app = this.activeApp()
    if (!app) return
    if (this.typingTimer) await this.flushTyping()
    const distance = Math.hypot(x - this.mouseDownPoint.x, y - this.mouseDownPoint.y)
    const kind = distance >= DRAG_DISTANCE ? 'drag' : 'click'
    const event = this.makeEvent(kind, app)
    if (this.mouseDownTarget !== null) event.target = this.mouseDownTarget
    this.record(event)
    this.snapshotAfterAction(kind)
  }

  private async keyDown(k: string, keys: string | undefined): Promise<void> {
    const app = this.activeApp()
    if (!app) return
    if (k === 'ret') {
      await this.recordSubmit(app)
    } else if (k === 'sc' && keys) {
      // Never while a password field (or a field we can't check) has focus.
      const field = await this.helper.focusedField()
      if (!field || field.secure || field.blocked || this.isBlockedProcess(field.process)) {
        this.scheduleTypingFlush()
        return
      }
      if (this.typingTimer) await this.flushTyping()
      const event = this.makeEvent('shortcut', app)
      event.keys = keys
      this.record(event)
      this.snapshotAfterAction('shortcut')
    } else if (k === 'esc') {
      if (this.typingTimer) await this.flushTyping()
      this.record(this.makeEvent('escape', app))
      this.snapshotAfterAction('escape')
    } else {
      this.scheduleTypingFlush()
    }
  }

  private scroll(): void {
    if (!this.activeApp()) return
    // Wheel events come in bursts; one snapshot once scrolling stops.
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null
      this.enqueue(() => this.takeSnapshot('scroll'))
    }, SCROLL_PAUSE)
  }

  private scheduleTypingFlush(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer)
    this.typingTimer = setTimeout(() => {
      this.enqueue(async () => {
        if (this.running && this.typingTimer) await this.flushTyping()
      })
    }, TYPING_PAUSE)
  }

  private cancelTyping(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer)
    this.typingTimer = null
  }

  /** Reads the focused field back and records its whole contents. */
  private async flushTyping(): Promise<void> {
    this.cancelTyping()
    const app = this.activeApp()
    if (!app) return
    const field = await this.helper.focusedField()
    if (!field || field.blocked || this.isBlockedProcess(field.process)) return
    const event = this.makeEvent('text', app)
    event.field = clip(field.label)
    event.text = clip(field.value ?? '')
    this.record(event)
    if (field.value !== null) this.lastTyped = { field: field.label, text: field.value, at: Date.now() }
  }

  /** Return was pressed. The app may already have cleared the field, so fall back to the last text typed into it. */
  private async recordSubmit(app: FrontApp): Promise<void> {
    this.cancelTyping()
    let field = await this.helper.focusedField()
    if (field && (field.blocked || this.isBlockedProcess(field.process))) field = null
    let text = field?.value ?? null
    const last = this.lastTyped
    if (text === null && last && field && last.field === field.label && Date.now() - last.at < 10_000) {
      text = last.text
    }
    this.lastTyped = null

    const event = this.makeEvent('submit', app)
    if (field) event.field = clip(field.label)
    if (text !== null) event.text = clip(text)
    this.record(event)
    this.snapshotAfterAction('submit')
  }

  // MARK: - Snapshots

  /** One diff right away, one once the result has settled. */
  private snapshotAfterAction(action: string): void {
    this.later(REACTION_DELAY, () => this.takeSnapshot(`${action} +250ms`))
    this.later(OUTCOME_DELAY, () => this.takeSnapshot(`${action} +1.5s`))
  }

  /** Records a diff against this app's last snapshot, or the full tree the first time. */
  private async takeSnapshot(trigger: string): Promise<void> {
    const app = this.activeApp()
    if (!app) return
    if (Date.now() - this.lastSnapshotAt < MIN_SNAPSHOT_GAP) return
    this.lastSnapshotAt = Date.now()

    const appKey = app.bundleId || app.name
    const slowUntil = this.slowApps.get(appKey) ?? 0
    const subtree = Date.now() >= slowUntil
    const raw = await this.helper.snapshot(app.hwnd, app.isWebShaped, app.bundleId || 'app', 1500, subtree)
    if (!raw) {
      if (subtree) this.slowApps.set(appKey, Date.now() + 10 * 60_000)
      return
    }
    if (subtree && raw.ms > SLOW_SUBTREE_MS) this.slowApps.set(appKey, Date.now() + 10 * 60_000)
    if (!this.running || this.frontApp?.pid !== app.pid) return
    const snapshot = this.ids.build(raw.items, raw.title || null, raw.ms)

    let event: A11yEvent
    const previous = this.lastSnapshotByApp.get(appKey)
    if (previous) {
      const diff = this.ids.diff(previous, snapshot)
      if (diff === null) {
        this.lastSnapshotByApp.set(appKey, snapshot)
        return // nothing changed
      }
      event = this.makeEvent('diff', app)
      event.diff = diff
    } else {
      event = this.makeEvent('snapshot', app)
      event.tree = snapshot.lines.map((l) => l.text).join('\n')
    }
    if (snapshot.windowTitle !== null) event.window = snapshot.windowTitle
    event.trigger = trigger
    event.snapshotMs = snapshot.durationMs
    this.record(event)
    this.lastSnapshotByApp.set(appKey, snapshot)
  }

  // MARK: - Window changes

  private queuePoll(): void {
    if (!this.running || this.pollQueued) return
    this.pollQueued = true
    this.enqueue(async () => {
      this.pollQueued = false
      if (!this.running) return
      const fg = await this.helper.foreground()
      if (!this.running) return
      if (!fg || fg.hwnd === 0 || fg.locked || fg.pid === this.ownPid || !fg.process) {
        this.setFrontApp(null)
        return
      }
      const current = this.frontApp
      // The process name too: pids (and hwnds) are reused.
      if (!current || current.pid !== fg.pid || current.hwnd !== fg.hwnd || current.process !== fg.process) {
        this.frontApp = appInfo(fg)
      }
      this.checkForWindowChange(fg.title)
    })
  }

  /** Null while Dayflow itself (or nothing / the lock screen) is in front. */
  private setFrontApp(app: FrontApp | null): void {
    if (app) {
      this.frontApp = app
      return
    }
    this.cancelTyping()
    this.frontApp = null
    this.lastWindowKey = null
  }

  private checkForWindowChange(title: string): void {
    const app = this.frontApp
    if (!this.running || !app) return
    const appKey = app.bundleId || app.name

    if (this.isBlocked(app)) {
      const key = 'blocked|' + appKey
      if (key === this.lastWindowKey) return
      this.lastWindowKey = key
      this.cancelTyping()
      const event = this.makeEvent('window', app)
      event.blocked = true
      this.store.append(event) // only the app name, no title or content
      return
    }

    const key = appKey + '|' + title
    if (key === this.lastWindowKey) return
    this.lastWindowKey = key
    const event = this.makeEvent('window', app)
    if (title) event.window = title
    this.record(event)
    this.later(REACTION_DELAY, () => this.takeSnapshot('window'))
  }

  // MARK: - Helpers

  /** The front app when recording and it isn't blocked. */
  private activeApp(): FrontApp | null {
    if (!this.running) return null
    const app = this.frontApp
    if (!app || this.isBlocked(app)) return null
    return app
  }

  private isBlocked(app: FrontApp): boolean {
    return this.isBlockedProcess(app.process) || this.isBlockedName(app.name)
  }

  private isBlockedProcess(process: string): boolean {
    const p = process.trim().replace(/\.exe$/i, '').toLowerCase()
    if (!p) return false
    return this.blockList().some((a) => a.trim().replace(/\.exe$/i, '').toLowerCase() === p)
  }

  private isBlockedName(name: string): boolean {
    const n = name.trim().toLowerCase()
    return !!n && this.excludedApps().some((a) => a.trim().toLowerCase() === n)
  }

  private makeEvent(kind: string, app: FrontApp): A11yEvent {
    const event: A11yEvent = { time: Date.now(), kind, app: app.name }
    if (app.bundleId) event.bundleId = app.bundleId
    return event
  }

  private record(event: A11yEvent): void {
    this.store.append(event)
  }
}
