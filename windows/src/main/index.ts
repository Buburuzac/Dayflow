// Electron main process: wires storage, recorder, analysis, tray and IPC together.
// Counterpart of AppDelegate.swift / DayflowApp.swift / StatusMenu on macOS.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, Tray } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppStatus, SecretsUpdate, Settings } from '../shared/types.ts'
import { AnalysisManager, BATCHING } from './analysis.ts'
import { runCleanup } from './cleanup.ts'
import { Store } from './db.ts'
import { cardsToMarkdown } from './export.ts'
import { ForegroundProbe } from './foreground.ts'
import { ClaudeCliProvider, CodexCliProvider } from './llm/cli.ts'
import { GeminiProvider } from './llm/gemini.ts'
import { OpenAICompatibleProvider } from './llm/openai.ts'
import type { LLMProvider } from './llm/types.ts'
import { Recorder } from './recorder.ts'
import type { FeatureContext, ProviderOptions } from './features/context.ts'
import { register as registerWeekly } from './features/weekly.ts'
import { register as registerChat } from './features/chat.ts'
import { register as registerDaily } from './features/daily.ts'
import * as a11y from './features/a11y.ts'
import { register as registerFlow } from './features/flow.ts'
import { register as registerTimelapse } from './features/timelapse.ts'
import { register as registerReview } from './features/review.ts'
import * as sync from './features/sync.ts'
import { assignProjects, projectsForPrompt } from './sync/assign.ts'
import { SyncRepo } from './sync/repo.ts'

/** Feature modules; each registers its own `<name>:*` IPC channels. */
const FEATURES: Array<{ name: string; register: (ctx: FeatureContext) => void }> = [
  { name: 'weekly', register: registerWeekly },
  { name: 'chat', register: registerChat },
  { name: 'daily', register: registerDaily },
  { name: 'a11y', register: a11y.register },
  { name: 'flow', register: registerFlow },
  { name: 'timelapse', register: registerTimelapse },
  { name: 'review', register: registerReview },
  { name: 'sync', register: sync.register },
]
import { SettingsStore } from './settings.ts'
import { sanitizeSettingsPatch } from './settings-schema.ts'
import { killAllCli } from './llm/cli.ts'
import { dayRange, shiftDay } from './time.ts'

// DAYFLOW_DATA_DIR lets tests and development runs use a throwaway data folder.
app.setPath('userData', process.env.DAYFLOW_DATA_DIR || join(app.getPath('appData'), 'Dayflow'))
app.setAppUserModelId('so.dayflow.windows')
// The UI is English; keep dates and times consistent with it instead of the OS locale.
app.commandLine.appendSwitch('lang', 'en-US')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'dayflow-img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const dataDir = app.getPath('userData')
const recordingsDir = join(dataDir, 'recordings')
mkdirSync(recordingsDir, { recursive: true })

const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
const startHidden = process.argv.includes('--hidden')

let store: Store
let settings: SettingsStore
let recorder: Recorder
let analysis: AnalysisManager
let probe: ForegroundProbe
let tray: Tray | null = null
let win: BrowserWindow | null = null
let quitting = false

function makeProvider(batchId: number | null, options: ProviderOptions = {}): LLMProvider {
  const s = settings.get()
  const logSuccess = options.logSuccess ?? true
  const log = (l: Parameters<Store['logCall']>[1]) => {
    if (!logSuccess && l.status === 'success') return
    try {
      store.logCall(batchId, l)
    } catch {
      /* logging must not break analysis */
    }
  }
  switch (s.provider) {
    case 'gemini': {
      const key = settings.getSecret('geminiApiKey')
      if (!key) throw new Error('No Gemini API key configured. Add one in Settings.')
      return new GeminiProvider(key, s.geminiModel, log)
    }
    case 'openai_compatible':
      if (!s.openaiModel) throw new Error('No model configured for the local / OpenAI-compatible provider.')
      return new OpenAICompatibleProvider(s.openaiBaseUrl, s.openaiModel, settings.getSecret('openaiApiKey'), log)
    case 'claude_cli':
      return new ClaudeCliProvider(s.claudeCommand, s.cliModel, log)
    case 'codex_cli':
      return new CodexCliProvider(s.codexCommand, s.cliModel, log)
  }
}

function status(): AppStatus {
  const now = Math.floor(Date.now() / 1000)
  const since = now - BATCHING.maxLookback
  return {
    recorder: recorder.state,
    pausedUntil: recorder.pausedUntil,
    lastCaptureAt: recorder.lastCaptureAt,
    lastError: recorder.lastError,
    pendingScreenshots: store.countUnbatched(since),
    batchesProcessing: analysis.processing,
    batchesFailed: store.batchesWithStatus(['failed'], since).length,
    storageBytes: store.totalScreenshotBytes(),
  }
}

let statusTimer: NodeJS.Timeout | null = null
function broadcastStatus(): void {
  // Coalesce bursts of changes.
  if (statusTimer) return
  statusTimer = setTimeout(() => {
    statusTimer = null
    updateTray()
    win?.webContents.send('status', status())
  }, 200)
}

function cardsChanged(): void {
  win?.webContents.send('cards-changed')
  broadcastStatus()
}

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Dayflow',
    icon: join(resourcesDir, 'icon.png'),
    backgroundColor: '#FBF7F2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload only uses contextBridge and ipcRenderer, so the renderer can be sandboxed.
      sandbox: true,
      contextIsolation: true,
    },
  })
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.once('ready-to-show', () => show && win?.show())
  if (process.env.DAYFLOW_SMOKE_SHOTS) void smokeShots(process.env.DAYFLOW_SMOKE_SHOTS)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Development aid: renders each main screen off-screen and saves PNGs to `dir`, then quits. */
async function smokeShots(dir: string): Promise<void> {
  const w = win!
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()))
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const shot = async (name: string) => {
    await wait(1500)
    writeFileSync(join(dir, `${name}.png`), (await w.webContents.capturePage()).toPNG())
  }
  const js = (code: string) => w.webContents.executeJavaScript(code)
  await shot('1-onboarding')
  await js("localStorage.setItem('onboarded','1'); location.reload()")
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()))
  await shot('2-timeline')
  await js("document.querySelectorAll('.card')[1]?.click()")
  await shot('3-card-detail')
  const tabs = await js("[...document.querySelectorAll('.nav')].map((n) => n.textContent.trim())")
  for (const [i, label] of (tabs as string[]).entries()) {
    if (i === 0) continue
    await js(`document.querySelectorAll('.nav')[${i}].click()`)
    await shot(`${4 + i}-${label.toLowerCase()}`)
  }
  // Settings is the last tab: also capture the Sync & team section below the fold.
  await js("document.querySelector('.sync-panel')?.scrollIntoView()")
  await shot(`${4 + (tabs as string[]).length}-sync`)
  quitting = true
  app.quit()
}

function showWindow(): void {
  if (!win) createWindow(true)
  else {
    win.show()
    win.focus()
  }
}

function updateTray(): void {
  if (!tray) return
  const st = recorder.state
  const recording = st === 'recording'
  tray.setImage(nativeImage.createFromPath(join(resourcesDir, recording ? 'tray.png' : 'tray-paused.png')))
  const label =
    st === 'paused'
      ? recorder.pausedUntil
        ? `Paused until ${new Date(recorder.pausedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
        : 'Paused'
      : st === 'locked'
        ? 'Screen locked — not recording'
        : st === 'error'
          ? `Capture error: ${recorder.lastError ?? ''}`.slice(0, 80)
          : 'Recording'
  tray.setToolTip(`Dayflow — ${label}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Open Dayflow', click: showWindow },
      recording || st === 'locked' || st === 'error'
        ? {
            label: 'Pause recording',
            submenu: [
              { label: 'For 15 minutes', click: () => recorder.pause(15) },
              { label: 'For 30 minutes', click: () => recorder.pause(30) },
              { label: 'For 1 hour', click: () => recorder.pause(60) },
              { label: 'Until I resume', click: () => recorder.pause(null) },
            ],
          }
        : { label: 'Resume recording', click: () => recorder.start() },
      { label: 'Analyze now', click: () => analysis.tick() },
      { label: 'Open recordings folder', click: () => void shell.openPath(dataDir) },
      { type: 'separator' },
      {
        label: 'Quit Dayflow',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

function applyLoginItem(s: Settings): void {
  if (!app.isPackaged) return
  // Only an installed copy may register itself to start with Windows. A build run straight from
  // electron-builder's `win-unpacked` folder would otherwise autostart from the build directory,
  // keep its files locked and break the next build.
  const fromBuildDir = /[\\/]win-unpacked[\\/]/i.test(process.execPath)
  app.setLoginItemSettings({ openAtLogin: s.launchAtLogin && !fromBuildDir, args: ['--hidden'] })
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings.withSecrets())
  ipcMain.handle('settings:save', (_e, rawPatch: unknown, rawSecrets?: unknown) => {
    const patch = sanitizeSettingsPatch(rawPatch, (p) => existsSync(p))
    const secrets: SecretsUpdate = {}
    if (rawSecrets && typeof rawSecrets === 'object') {
      for (const k of ['geminiApiKey', 'openaiApiKey'] as const) {
        const v = (rawSecrets as Record<string, unknown>)[k]
        if (typeof v === 'string' && v.length <= 500) secrets[k] = v
      }
    }
    const before = settings.get()
    // CLI commands are executed, so a changed command needs the user's explicit OK here, in the
    // main process, where a compromised renderer cannot click through it.
    for (const key of ['claudeCommand', 'codexCommand'] as const) {
      const next = patch[key]
      if (next === undefined || next === before[key] || next === '' || next === 'claude' || next === 'codex') continue
      const options: Electron.MessageBoxSyncOptions = {
        type: 'warning',
        buttons: ['Use this command', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Dayflow',
        message: `Run "${next}" for AI analysis?`,
        detail: 'Dayflow will start this program and send it your screenshots and timeline. Only continue if you set it yourself.',
      }
      const choice = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)
      if (choice !== 0) delete patch[key]
    }
    const after = settings.update(patch, secrets)
    if (before.captureIntervalSeconds !== after.captureIntervalSeconds) recorder.restartTimer()
    if (before.launchAtLogin !== after.launchAtLogin) applyLoginItem(after)
    return settings.withSecrets()
  })
  ipcMain.handle('provider:test', async () => {
    try {
      const p = makeProvider(null)
      const out = await p.generateText('Reply with exactly the word OK and nothing else.', 'test', false)
      return { ok: true, message: `${p.id}${p.model ? ` (${p.model})` : ''} replied: ${out.trim().slice(0, 80)}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('cards:get', (_e, day: string) => new SyncRepo(store).attachProjects(store.cardsForDay(day, true)))
  ipcMain.handle('cards:screenshots', (_e, id: number) => {
    const card = store.getCard(id)
    // Cards pulled from another device have no screenshots here (frames never leave a PC).
    return card && !card.remote ? store.screenshotsInRange(card.startTs, card.endTs) : []
  })
  ipcMain.handle('cards:delete', (_e, id: number) => {
    store.deleteCard(id)
    cardsChanged()
  })
  ipcMain.handle('cards:title', (_e, id: number, title: string) => {
    store.updateCardTitle(id, title)
    cardsChanged()
  })
  ipcMain.handle('cards:category', (_e, id: number, category: string) => {
    store.updateCardCategory(id, category)
    cardsChanged()
  })
  ipcMain.handle('batches:get', (_e, day: string) => {
    const { start, end } = dayRange(day)
    return store.batchesInRange(start, end)
  })
  ipcMain.handle('status:get', () => status())
  ipcMain.handle('recorder:pause', (_e, minutes: number | null) => recorder.pause(minutes))
  ipcMain.handle('recorder:resume', () => recorder.start())
  ipcMain.handle('analysis:now', () => {
    analysis.retryFailed()
    analysis.tick()
  })
  ipcMain.handle('analysis:reprocessDay', (_e, day: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid day')
    analysis.reprocessDay(day)
    cardsChanged()
  })
  ipcMain.handle('export:markdown', async (_e, from: string, to: string) => {
    const days: { day: string; cards: ReturnType<Store['cardsForDay']> }[] = []
    for (let d = from; d <= to; d = shiftDay(d, 1)) days.push({ day: d, cards: store.cardsForDay(d) })
    const options = {
      title: 'Export timeline',
      defaultPath: join(app.getPath('documents'), `dayflow-${from}${to !== from ? `_${to}` : ''}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, cardsToMarkdown(days), 'utf8')
    return result.filePath
  })
  ipcMain.handle('app:openData', () => shell.openPath(dataDir))
}

app.whenReady().then(() => {
  try {
    startup()
  } catch (err) {
    console.error('[startup] failed', err)
    dialog.showErrorBox('Dayflow could not start', err instanceof Error ? (err.stack ?? err.message) : String(err))
    quitting = true
    app.quit()
  }
})

function startup(): void {
  // Serve screenshots to the renderer, restricted to the recordings folder.
  protocol.handle('dayflow-img', (req) => {
    // searchParams.get() already decodes; decoding again breaks paths containing '%'.
    const path = resolve(new URL(req.url).searchParams.get('p') ?? '')
    if (!path.toLowerCase().startsWith(resolve(recordingsDir).toLowerCase() + sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(path).toString())
  })

  settings = new SettingsStore(dataDir)
  store = new Store(join(dataDir, 'chunks.sqlite'))
  probe = new ForegroundProbe()
  recorder = new Recorder(store, settings, probe, recordingsDir, () => {
    a11y.setRecordingState(recorder.state)
    broadcastStatus()
  })
  analysis = new AnalysisManager({
    store,
    makeProvider: (batchId) => makeProvider(batchId),
    categories: () => settings.get().categories,
    language: () => settings.get().outputLanguage,
    onChange: cardsChanged,
    accessibilityLog: (s, e, id) => a11y.condensedLogFor(s, e, id),
    projects: () => projectsForPrompt(store),
    afterCards: (cards) => assignProjects(store, cards),
  })
  registerIpc()
  const ctx: FeatureContext = {
    store,
    settings,
    makeProvider,
    dataDir,
    recordingsDir,
    dbPath: join(dataDir, 'chunks.sqlite'),
    resourcesDir,
    broadcast: (channel, ...args) => win?.webContents.send(channel, ...args),
    cardsChanged,
  }
  for (const f of FEATURES) {
    try {
      f.register(ctx)
    } catch (err) {
      console.error(`[features] ${f.name} failed to register`, err)
    }
  }

  tray = new Tray(nativeImage.createFromPath(join(resourcesDir, 'tray.png')))
  tray.on('click', showWindow)
  recorder.start()
  analysis.start()
  applyLoginItem(settings.get())

  const cleanup = () => runCleanup(store, settings, recordingsDir).catch((e) => console.error('[cleanup]', e))
  setTimeout(cleanup, 30_000)
  setInterval(cleanup, 30 * 60_000)
  // Status ticks keep "last capture" fresh in the UI.
  setInterval(broadcastStatus, 15_000)

  createWindow(!startHidden)
}

app.on('second-instance', showWindow)
app.on('before-quit', () => {
  quitting = true
  killAllCli()
  a11y.shutdown()
  sync.shutdown()
  recorder?.stop()
  analysis?.stop()
  probe?.dispose()
})
app.on('will-quit', () => store?.close())
// Keep running in the tray when the window is closed.
app.on('window-all-closed', () => {})
