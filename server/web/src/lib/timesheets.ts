// Pure helpers for the Timesheets page: editable rows built from server proposals, and the submit payload.

import type { TimesheetProposal, TimesheetSubmitRequest } from '../api/types.ts'
import { roundQuarter } from './format.ts'

export interface SheetRow {
  key: string
  proposal: TimesheetProposal
  hours: number
  description: string
  selected: boolean
}

export const rowKey = (p: Pick<TimesheetProposal, 'day' | 'projectId'>) => `${p.day}|${p.projectId}`

/** A row can be written only when its project is mapped to an Odoo project. */
export const canSubmit = (p: TimesheetProposal) => p.odooProjectId != null

export function toRows(proposals: TimesheetProposal[]): SheetRow[] {
  return [...proposals]
    .sort((a, b) => a.day.localeCompare(b.day) || a.projectId.localeCompare(b.projectId))
    .map((p) => ({
      key: rowKey(p),
      proposal: p,
      hours: roundQuarter(p.hours),
      description: p.description,
      // pre-select new lines only; lines already in Odoo are updated only when the user opts in
      selected: canSubmit(p) && p.hours > 0 && p.existingOdooLineId == null,
    }))
}

export const isDirty = (r: SheetRow) => r.hours !== roundQuarter(r.proposal.hours) || r.description !== r.proposal.description

export function submittable(rows: SheetRow[]): SheetRow[] {
  return rows.filter((r) => r.selected && canSubmit(r.proposal) && r.hours > 0)
}

export function buildSubmit(rows: SheetRow[]): TimesheetSubmitRequest {
  return {
    lines: submittable(rows).map((r) => ({
      day: r.proposal.day,
      projectId: r.proposal.projectId,
      hours: roundQuarter(r.hours),
      description: r.description.trim(),
      cardIds: r.proposal.cardIds,
    })),
  }
}

export function totalHours(rows: SheetRow[]): number {
  return rows.reduce((s, r) => s + r.hours, 0)
}
