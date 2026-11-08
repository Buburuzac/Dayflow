// The nudge overlay (FlowOverlayController, spec A.10): a small transparent, frameless,
// non-activating, always-on-top window near the bottom-right of the active display. It loads
// the `#flow-overlay` route of the main renderer. Clicks pass through everywhere except the
// creature, bubble and pills (the renderer reports hover via `flow:overlayHit`).

import { BrowserWindow, screen } from 'electron'
import type { FlowNudgeVariant, FlowOverlayPresentation } from '../../shared/flow-types.ts'
import { loadRendererRoute, preloadPath, trackAux } from './app-windows.ts'

export const OVERLAY_WIDTH = 420
export const OVERLAY_HEIGHT = 300
const FADE_MS = 450

export class FlowOverlayWindow {
  presentation: FlowOverlayPresentation = { kind: 'hidden' }
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private readonly onUnavailable: (p: FlowOverlayPresentation) => void

  /** `onUnavailable` gets presentations that could not be shown (window failed to load or crashed). */
  constructor(onUnavailable: (p: FlowOverlayPresentation) => void = () => {}) {
    this.onUnavailable = onUnavailable
  }

  /** False when the window could not be created; callers fall back to notifications. */
  get usable(): boolean {
    return !this.failed
  }

  private ensure(): BrowserWindow | null {
    if (this.win && !this.win.isDestroyed()) return this.win
    try {
      const win = new BrowserWindow({
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
        show: false,
        transparent: true,
        frame: false,
        focusable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        title: 'Dayflow Flow',
        // The preload only uses contextBridge/ipcRenderer, so it runs sandboxed.
        webPreferences: {
          preload: preloadPath(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      trackAux(win)
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true)
      win.setIgnoreMouseEvents(true, { forward: true })
      win.on('closed', () => {
        this.win = null
        this.ready = null
      })
      // A crashed overlay is recreated on the next presentation.
      win.webContents.on('render-process-gone', () => {
        if (!win.isDestroyed()) win.destroy()
      })
      this.win = win
      this.ready = loadRendererRoute(win, 'flow-overlay').catch((err) => {
        console.error('[flow] overlay failed to load', err)
        this.failed = true
      })
      return win
    } catch (err) {
      console.error('[flow] could not create the overlay window', err)
      this.failed = true
      return null
    }
  }

  private position(win: BrowserWindow, variant: FlowNudgeVariant): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const wa = display.workArea
    const x = wa.x + wa.width - OVERLAY_WIDTH - 8
    const y = variant === 'side' ? wa.y + wa.height - OVERLAY_HEIGHT - 8 : wa.y + 8
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT })
  }

  async show(p: FlowOverlayPresentation): Promise<void> {
    if (p.kind === 'hidden') return this.hide()
    const fromHidden = this.presentation.kind === 'hidden'
    this.presentation = p
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
    const win = this.ensure()
    if (!win) return this.onUnavailable(p)
    await this.ready
    if (this.failed) {
      if (!win.isDestroyed()) win.destroy()
      return this.onUnavailable(p)
    }
    if (win.isDestroyed() || this.presentation !== p) return
    if (fromHidden || !win.isVisible()) this.position(win, p.kind === 'nudge' ? p.variant : 'side')
    win.webContents.send('flow:overlay', p)
    if (!win.isVisible()) win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  hide(): void {
    this.presentation = { kind: 'hidden' }
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('flow:overlay', this.presentation)
    win.setIgnoreMouseEvents(true, { forward: true })
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      if (this.presentation.kind === 'hidden' && !win.isDestroyed()) win.hide()
    }, FADE_MS)
  }

  /** The pointer entered / left an interactive part of the overlay. */
  setInteractive(on: boolean): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (on) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: true })
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
