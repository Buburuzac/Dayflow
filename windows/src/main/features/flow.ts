// Flow focus sessions: IPC channels (flow:*). The logic lives in src/main/flow/.

import { app, ipcMain } from 'electron'
import type { FlowAgentSettings, FlowOverlayAction, FlowStartRequest } from '../../shared/flow-types.ts'
import type { FeatureContext } from './context.ts'
import { FlowController } from '../flow/controller.ts'
import { BRIEFING_TEMPLATE } from '../flow/prompts.ts'

let controller: FlowController | null = null

export function register(ctx: FeatureContext): void {
  const c = new FlowController(ctx)
  controller = c
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  ipcMain.handle('flow:getState', () => c.state())
  ipcMain.handle('flow:start', (_e, req: FlowStartRequest) =>
    c.start({
      goals: Array.isArray(req?.goals) ? req.goals.map(String) : [],
      minutes: req?.minutes == null ? null : num(req.minutes, 50),
      alertStyle: req?.alertStyle ?? c.settings.get().flowDefaultAlertStyle,
    }),
  )
  ipcMain.handle('flow:end', () => c.end())
  ipcMain.handle('flow:extend', (_e, minutes: unknown) => c.extend(num(minutes, 10)))
  ipcMain.handle('flow:break', (_e, minutes: unknown) => c.takeBreak(num(minutes, 5)))
  ipcMain.handle('flow:resume', () => c.resumeFromBreak())
  ipcMain.handle('flow:reset', () => c.reset())
  ipcMain.handle('flow:addGoal', (_e, title: unknown) => c.addGoal(str(title)))
  ipcMain.handle('flow:removeGoal', (_e, id: unknown) => c.removeGoal(str(id)))
  ipcMain.handle('flow:setGoalDone', (_e, id: unknown, done: unknown) => c.setGoalDone(str(id), done === true))
  ipcMain.handle('flow:setAlertStyle', (_e, style: unknown) => c.setAlertStyle(str(style) as 'quiet'))
  ipcMain.handle('flow:sessions', () => c.sessions())
  ipcMain.handle('flow:getSettings', () => c.settings.get())
  ipcMain.handle('flow:saveSettings', (_e, patch: Partial<FlowAgentSettings>) => c.updateSettings(patch ?? {}))
  ipcMain.handle('flow:resetSettings', () => c.updateSettings({ ...c.settings.reset() }))
  ipcMain.handle('flow:builtInBriefing', () => BRIEFING_TEMPLATE)
  ipcMain.handle('flow:tickNow', () => c.agent.tickNow(true))
  ipcMain.handle('flow:simulateDistraction', () => c.simulateDistraction())
  ipcMain.handle('flow:overlayState', () => c.overlayPresentation())
  ipcMain.handle('flow:overlayAction', (_e, a: FlowOverlayAction) => {
    if (a && typeof a === 'object' && typeof a.action === 'string') c.overlayAction(a)
  })
  ipcMain.handle('flow:overlayHit', (_e, on: unknown) => c.overlay.setInteractive(on === true))

  app.on('before-quit', () => dispose())
}

/** Stops the agent (killing any CLI child in flight), closes the overlay and clears timers. Idempotent. */
export function dispose(): void {
  const c = controller
  controller = null
  c?.dispose()
}
