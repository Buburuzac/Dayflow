// Chat with your work journal. IPC (all via window.dayflow.call):
//   chat:status()                 → ChatStatus  (activeTurn: the running turn to re-attach to)
//   chat:acceptBeta()             → ChatStatus
//   chat:send(ChatSendRequest)    → ChatTurnResult   (resolves when the turn is done)
//   chat:cancel(turnId)           → void
//   chat:list()                   → ConversationSummary[]
//   chat:load(id)                 → ConversationDetail | null  (in-memory state + activeTurn while a turn runs)
//   chat:delete(id)               → void
//   chat:getMemory()              → ChatMemory
//   chat:saveMemory(text)         → ChatMemory
//   chat:clearMemory()            → ChatMemory
// Events (window.dayflow.on): 'chat:event' (ChatEvent) while a turn streams; type 'done' ends it.

import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSendRequest } from '../../shared/chat-types.ts'
import { ChatService, chatCliDir } from '../chat/service.ts'
import type { McpLaunch } from '../chat/runner-cli.ts'
import type { FeatureContext } from './context.ts'

/** Locates the built MCP server (out/main/mcp-server.js, inside app.asar when packaged). */
function mcpScriptPath(): string {
  const candidates = [
    join(__dirname, 'mcp-server.js'),
    join(app.getAppPath(), 'out', 'main', 'mcp-server.js'),
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

export function mcpLaunch(dbPath: string): McpLaunch {
  return { command: process.execPath, args: [mcpScriptPath(), dbPath], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

let service: ChatService | null = null

/**
 * Aborts running chat turns and kills their CLI process trees (claude/codex + MCP server).
 * Wired to before-quit by register(); safe to call more than once.
 */
export function dispose(): void {
  service?.dispose()
}

export function register(ctx: FeatureContext): void {
  service = new ChatService({
    db: ctx.store.db,
    getSettings: () => ctx.settings.get(),
    getSecret: (k) => ctx.settings.getSecret(k),
    broadcast: (ev) => ctx.broadcast('chat:event', ev),
    cliCwd: chatCliDir(ctx.dataDir),
    mcp: mcpLaunch(ctx.dbPath),
  })

  app.on('before-quit', dispose)
  const svc = service
  ipcMain.handle('chat:status', () => svc.status())
  ipcMain.handle('chat:acceptBeta', () => svc.acceptBeta())
  ipcMain.handle('chat:send', (_e, req: ChatSendRequest) => svc.send(req))
  ipcMain.handle('chat:cancel', (_e, turnId: string) => svc.cancel(turnId))
  ipcMain.handle('chat:list', () => svc.list())
  ipcMain.handle('chat:load', (_e, id: string) => svc.load(id))
  ipcMain.handle('chat:delete', (_e, id: string) => svc.delete(id))
  ipcMain.handle('chat:getMemory', () => svc.getMemory())
  ipcMain.handle('chat:saveMemory', (_e, text: string) => svc.saveMemory(text))
  ipcMain.handle('chat:clearMemory', () => svc.clearMemory())
}
