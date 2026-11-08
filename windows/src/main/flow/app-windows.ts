// Tracks the helper windows created by feature modules (Flow overlay, hidden timelapse
// renderer) so the main Dayflow window can be found without access to index.ts.

import { BrowserWindow } from 'electron'
import { join } from 'node:path'

export const auxWindows = new Set<BrowserWindow>()

export function trackAux(win: BrowserWindow): BrowserWindow {
  auxWindows.add(win)
  win.on('closed', () => auxWindows.delete(win))
  return win
}

export function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !auxWindows.has(w)) ?? null
}

/** Shows and focuses the main window; `route` is broadcast as `app:navigate` for App.tsx. */
export function showMainWindow(route?: string): void {
  const w = mainWindow()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  if (route) w.webContents.send('app:navigate', route)
}

/** Loads a hash route of the main renderer (e.g. "flow-overlay") into `win`. */
export function loadRendererRoute(win: BrowserWindow, hash: string): Promise<void> {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return win.loadURL(`${dev}#${hash}`)
  return win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

export function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}
