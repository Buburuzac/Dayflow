// Sync & team feature: Dayflow Sync Server sign-in, background sync, projects and team views.
// IPC: sync:* (account, status, team, timesheets) and projects:* (list/edit, card assignment).
// The device token lives in secrets.bin (DPAPI) as `syncDeviceToken` and never reaches the renderer.

import type { Settings } from '../../shared/types.ts'
import { DEFAULT_SYNC_POLICY, type SyncPolicy } from '../sync/scope.ts'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { hostname } from 'node:os'
import type { FeatureContext } from './context.ts'
import type { ShareLevel, TimesheetSubmitRequest } from '../../shared/sync-types.ts'
import type { ProjectDraft } from '../../shared/sync-ui.ts'
import { makeDocSources } from '../sync/docs.ts'
import { syncHooks } from '../sync/hooks.ts'
import { SyncService, sanitizeSubmit } from '../sync/service.ts'

let service: SyncService | null = null

export function syncService(): SyncService | null {
  return service
}

export function register(ctx: FeatureContext): void {
  const docs = makeDocSources(ctx.store.db, ctx.settings)
  const svc = new SyncService({
    store: ctx.store,
    docs,
    token: {
      get: () => ctx.settings.getSecret('syncDeviceToken'),
      set: (t) => ctx.settings.setSecret('syncDeviceToken', t),
    },
    deviceName: hostname(),
    platform: 'windows',
    openBrowser: (url) => shell.openExternal(url),
    onCardsChanged: () => ctx.cardsChanged(),
    onProjectsChanged: () => ctx.broadcast('projects:changed'),
    onDocsChanged: (entities) => {
      ctx.broadcast('sync:docsChanged', entities)
      if (entities.includes('user_doc')) ctx.broadcast('settings:changed')
    },
    onStatus: () => broadcastStatus(),
    background: true,
  })
  service = svc
  syncHooks.record = (entity, id) => svc.repo.recordDoc(entity, id)

  // "What leaves this PC" (Settings → Sync & team), applied before anything is uploaded.
  const policyOf = (st: Settings): SyncPolicy => ({
    excludedCategories: st.syncExcludedCategories ?? DEFAULT_SYNC_POLICY.excludedCategories,
    outOfScope: st.syncOutOfScope ?? DEFAULT_SYNC_POLICY.outOfScope,
    observations: st.syncObservations ?? DEFAULT_SYNC_POLICY.observations,
  })
  ctx.store.syncPolicy = policyOf(ctx.settings.get())
  ctx.settings.onChange((st, patch) => {
    if ('syncExcludedCategories' in patch || 'syncOutOfScope' in patch || 'syncObservations' in patch) {
      svc.setPolicy(policyOf(st))
    }
  })

  let statusTimer: NodeJS.Timeout | null = null
  function broadcastStatus(): void {
    if (statusTimer) return
    statusTimer = setTimeout(() => {
      statusTimer = null
      ctx.broadcast('sync:status', svc.status())
    }, 250)
  }

  let signInAbort: AbortController | null = null
  const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '')

  ipcMain.handle('sync:status', () => svc.status())
  ipcMain.handle('sync:authConfig', () => svc.authConfig())
  ipcMain.handle('sync:setServerUrl', (_e, url: unknown) => svc.setServerUrl(str(url)))
  ipcMain.handle('sync:signInGoogle', async () => {
    signInAbort?.abort()
    signInAbort = new AbortController()
    try {
      return await svc.signInGoogle(signInAbort.signal)
    } finally {
      signInAbort = null
    }
  })
  ipcMain.handle('sync:cancelSignIn', () => signInAbort?.abort())
  ipcMain.handle('sync:signInDev', (_e, email: unknown) => svc.signInDev(str(email, 200)))
  ipcMain.handle('sync:signOut', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Sign out', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Dayflow',
      message: 'Sign out of the sync server?',
      detail: "This device stops syncing. Cards from your other devices and the team's projects are removed from this PC; your own cards stay.",
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 0) return svc.status()
    return svc.signOut()
  })
  ipcMain.handle('sync:syncNow', async () => {
    await svc.syncNow()
    return svc.status()
  })
  ipcMain.handle('sync:me', () => svc.me())
  ipcMain.handle('sync:revokeDevice', (_e, id: unknown) => svc.revokeDevice(str(id, 100)))
  ipcMain.handle('sync:openDashboard', async () => {
    const url = svc.status().signedIn ? await svc.webLink() : svc.status().serverUrl
    await shell.openExternal(url)
  })
  ipcMain.handle('sync:setCardPrivate', (_e, cardId: unknown, isPrivate: unknown) => {
    if (typeof cardId !== 'number') throw new Error('Invalid card')
    ctx.store.setCardPrivate(cardId, isPrivate === true)
    ctx.cardsChanged()
  })

  // ---- team views ----
  ipcMain.handle('sync:feed', (_e, projectId: unknown, from: unknown, to: unknown) => svc.feed(str(projectId, 100), str(from, 10), str(to, 10)))
  ipcMain.handle('sync:report', (_e, projectId: unknown, from: unknown, to: unknown) =>
    svc.report(str(projectId, 100), str(from, 10), str(to, 10)),
  )
  ipcMain.handle('sync:timesheetProposals', (_e, from: unknown, to: unknown, workspaceId: unknown) =>
    svc.proposals(str(from, 10), str(to, 10), str(workspaceId, 100)),
  )
  ipcMain.handle('sync:timesheetSubmit', async (_e, raw: unknown) => {
    // Writing to Odoo needs the user's explicit OK here in the main process, listing exactly
    // what will be written, so a compromised renderer cannot submit on its own.
    const req = sanitizeSubmit(raw as TimesheetSubmitRequest)
    const names = new Map(svc.listProjects().map((p) => [p.id, p]))
    const lines = req.lines.map((l) => {
      const p = names.get(l.projectId)
      const target = p?.odoo.projectName || p?.name || l.projectId
      const task = p?.odoo.taskName ? ` / ${p.odoo.taskName}` : ''
      return `${l.day}  ${l.hours.toFixed(2)} h  ${target}${task}\n    “${l.description || '(no description)'}”`
    })
    const total = req.lines.reduce((s, l) => s + l.hours, 0)
    const win = BrowserWindow.getFocusedWindow()
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Write to Odoo', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Submit timesheets',
      message: `Write ${req.lines.length} timesheet line${req.lines.length > 1 ? 's' : ''} (${total.toFixed(2)} h) to Odoo?`,
      detail:
        'These account.analytic.line records will be created (or updated if already sent):\n\n' +
        lines.slice(0, 40).join('\n') +
        (lines.length > 40 ? `\n… and ${lines.length - 40} more` : ''),
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 0) return null
    return svc.submitTimesheets(req)
  })

  // ---- projects ----
  ipcMain.handle('projects:list', () => svc.listProjects())
  ipcMain.handle('projects:save', (_e, draft: unknown) => svc.saveProject(draft as ProjectDraft))
  ipcMain.handle('projects:setMyShare', (_e, projectId: unknown, level: unknown) =>
    svc.setMyShare(str(projectId, 100), level === null ? null : (str(level, 20) as ShareLevel)),
  )
  ipcMain.handle('projects:assignCard', (_e, cardId: unknown, projectId: unknown) => {
    if (typeof cardId !== 'number') throw new Error('Invalid card')
    svc.assignCard(cardId, typeof projectId === 'string' && projectId ? projectId : null)
  })
  ipcMain.handle('projects:confirmCard', (_e, cardId: unknown, projectId: unknown) => {
    if (typeof cardId !== 'number') throw new Error('Invalid card')
    svc.confirmCard(cardId, str(projectId, 100))
  })
  ipcMain.handle('projects:editDetail', (_e, cardId: unknown, key: unknown, projectId: unknown, action: unknown) => {
    if (typeof cardId !== 'number') throw new Error('Invalid card')
    if (action !== 'add' && action !== 'remove' && action !== 'confirm') throw new Error('Invalid action')
    svc.editDetailProject(cardId, str(key, 100), str(projectId, 100), action)
  })

  // Resume a previous session in the background.
  if (svc.signedIn()) {
    svc.start()
    setTimeout(() => void svc.run(), 8_000)
  }
}

export function shutdown(): void {
  service?.stop()
}
