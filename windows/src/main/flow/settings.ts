// FlowAgentSettings.swift: defaults and validation, persisted in <dataDir>/flow-settings.json.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FlowAgentSettings } from '../../shared/flow-types.ts'

export const FLOW_DEFAULTS: FlowAgentSettings = {
  flowAgentEnabled: true,
  flowAgentModel: '',
  flowAgentReasoning: 'low',
  flowAgentTickSeconds: 15,
  flowAgentShotHeight: 1080,
  flowAgentJpegQuality: 0.6,
  flowAgentMaxFailures: 3,
  flowAgentTickTimeout: 60,
  flowAgentBriefing: '',
  flowAgentExtra: '',
  flowAgentTimelineSeconds: 60,
  flowBreakOverlaySeconds: 8,
  flowToastSeconds: 4,
  flowPraiseSeconds: 5,
  flowNudgeVariant: 'side',
  flowDefaultAlertStyle: 'friendly',
  flowDefaultMinutes: 50,
  flowUseNotifications: false,
}

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high']

/** Applies the validation rules of FlowAgentSettings (invalid → default). */
export function normalizeFlowSettings(raw: Partial<FlowAgentSettings> | null | undefined): FlowAgentSettings {
  const d = FLOW_DEFAULTS
  const r = { ...d, ...(raw ?? {}) }
  const num = (v: unknown, ok: (n: number) => boolean, def: number) =>
    typeof v === 'number' && Number.isFinite(v) && ok(v) ? v : def
  return {
    flowAgentEnabled: typeof r.flowAgentEnabled === 'boolean' ? r.flowAgentEnabled : d.flowAgentEnabled,
    flowAgentModel: typeof r.flowAgentModel === 'string' ? r.flowAgentModel.trim() : '',
    flowAgentReasoning: EFFORTS.includes(String(r.flowAgentReasoning)) ? String(r.flowAgentReasoning) : d.flowAgentReasoning,
    flowAgentTickSeconds: num(r.flowAgentTickSeconds, (n) => n >= 5, d.flowAgentTickSeconds),
    flowAgentShotHeight: num(r.flowAgentShotHeight, (n) => n >= 240, d.flowAgentShotHeight),
    flowAgentJpegQuality: num(r.flowAgentJpegQuality, (n) => n > 0 && n <= 1, d.flowAgentJpegQuality),
    flowAgentMaxFailures: Math.floor(num(r.flowAgentMaxFailures, (n) => n > 0, d.flowAgentMaxFailures)),
    flowAgentTickTimeout: num(r.flowAgentTickTimeout, (n) => n >= 10, d.flowAgentTickTimeout),
    flowAgentBriefing: typeof r.flowAgentBriefing === 'string' ? r.flowAgentBriefing : '',
    flowAgentExtra: typeof r.flowAgentExtra === 'string' ? r.flowAgentExtra : '',
    flowAgentTimelineSeconds: num(r.flowAgentTimelineSeconds, (n) => n >= 15, d.flowAgentTimelineSeconds),
    flowBreakOverlaySeconds: num(r.flowBreakOverlaySeconds, (n) => n > 0, d.flowBreakOverlaySeconds),
    flowToastSeconds: num(r.flowToastSeconds, (n) => n > 0, d.flowToastSeconds),
    flowPraiseSeconds: num(r.flowPraiseSeconds, (n) => n > 0, d.flowPraiseSeconds),
    flowNudgeVariant: (['side', 'top', 'peek'] as const).includes(r.flowNudgeVariant) ? r.flowNudgeVariant : 'side',
    flowDefaultAlertStyle: (['quiet', 'friendly', 'feisty'] as const).includes(r.flowDefaultAlertStyle)
      ? r.flowDefaultAlertStyle
      : d.flowDefaultAlertStyle,
    flowDefaultMinutes: Math.floor(num(r.flowDefaultMinutes, (n) => n >= 0 && n <= 24 * 60, d.flowDefaultMinutes)),
    flowUseNotifications: typeof r.flowUseNotifications === 'boolean' ? r.flowUseNotifications : false,
  }
}

export class FlowSettingsStore {
  private value: FlowAgentSettings
  private readonly file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'flow-settings.json')
    let raw: Partial<FlowAgentSettings> = {}
    try {
      if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FlowAgentSettings>
    } catch (err) {
      console.error('[flow] could not read flow-settings.json', err)
    }
    this.value = normalizeFlowSettings(raw)
  }

  get(): FlowAgentSettings {
    return this.value
  }

  update(patch: Partial<FlowAgentSettings>): FlowAgentSettings {
    this.value = normalizeFlowSettings({ ...this.value, ...patch })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2))
    renameSync(tmp, this.file)
    return this.value
  }

  reset(): FlowAgentSettings {
    return this.update({ ...FLOW_DEFAULTS })
  }
}
