// Timelapse videos: IPC channels (timelapse:*). Logic in src/main/timelapse/.

import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { copyFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { FeatureContext } from './context.ts'
import { TimelapseService } from '../timelapse/service.ts'

export function register(ctx: FeatureContext): void {
  const svc = new TimelapseService(ctx)
  const id = (v: unknown) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid card id')
    return n
  }

  ipcMain.handle('timelapse:card', (_e, cardId: unknown) => svc.cardData(id(cardId)))
  ipcMain.handle('timelapse:info', (_e, cardId: unknown) => svc.info(id(cardId)))
  ipcMain.handle('timelapse:generate', (_e, cardId: unknown, force?: unknown) => svc.generate(id(cardId), force === true))
  ipcMain.handle('timelapse:read', (_e, cardId: unknown) => svc.read(id(cardId)))
  ipcMain.handle('timelapse:open', async (_e, cardId: unknown) => {
    const i = svc.info(id(cardId))
    return i ? (await shell.openPath(i.path)) || null : 'No video yet'
  })
  ipcMain.handle('timelapse:showInFolder', (_e, cardId: unknown) => {
    const i = svc.info(id(cardId))
    if (i) shell.showItemInFolder(i.path)
    else void shell.openPath(svc.root)
  })
  ipcMain.handle('timelapse:openFolder', () => shell.openPath(svc.root))
  ipcMain.handle('timelapse:saveAs', async (e, cardId: unknown): Promise<string | null> => {
    const i = svc.info(id(cardId))
    if (!i) return null
    const card = ctx.store.getCard(i.cardId)
    const safe = (card?.title ?? basename(i.path)).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'timelapse'
    const opts = {
      title: 'Save timelapse',
      defaultPath: join(app.getPath('videos'), `${safe}.${i.format}`),
      filters: [{ name: i.format === 'mp4' ? 'MP4 video' : 'WebM video', extensions: [i.format] }],
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    await copyFile(i.path, r.filePath)
    return r.filePath
  })
  ipcMain.handle('timelapse:storage', () => svc.storage())
  ipcMain.handle('timelapse:setLimit', (_e, bytes: unknown) => svc.setLimit(Number(bytes)))
  ipcMain.handle('timelapse:purge', async () => {
    await svc.purge()
    return svc.storage()
  })

  // Apply the cap (and drop videos of deleted cards) shortly after launch and then hourly.
  setTimeout(() => void svc.purge().catch((err) => console.error('[timelapse] purge failed', err)), 60_000)
  setInterval(() => void svc.purge().catch((err) => console.error('[timelapse] purge failed', err)), 60 * 60_000)
}
