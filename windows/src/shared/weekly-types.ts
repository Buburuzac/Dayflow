// Snapshot types for the Weekly review page (spec: docs/spec-weekly.md §12).
// Hex colours are 6-digit strings without '#'.

export type Hex = string

export interface WeeklyDonutItem {
  id: string
  name: string
  colorHex: Hex
  minutes: number
}
export interface WeeklyDonutSnapshot {
  items: WeeklyDonutItem[]
  totalMinutes: number
}

export interface WeeklyContextComparisonDay {
  day: string
  distracted: number
  shifts: number
}
export interface WeeklyContextChartsSnapshot {
  comparison: { days: WeeklyContextComparisonDay[]; insight: string }
}

export interface WeeklyTimeLabel {
  id: string
  label: string
  minute: number
}

export interface WeeklyWorkflowCell {
  id: string
  categoryName: string | null
  colorHex: Hex | null
  minutes: number
  occupancy: number
}
export interface WeeklyWorkflowRow {
  id: string
  label: string
  cells: WeeklyWorkflowCell[]
}
export interface WeeklyWorkflowTotalItem {
  id: string
  name: string
  minutes: number
  duration: string
  colorHex: Hex
}
export interface WeeklyWorkflowSnapshot {
  title: string
  startMinute: number
  endMinute: number
  slotMinutes: number
  timeLabels: WeeklyTimeLabel[]
  rows: WeeklyWorkflowRow[]
  totals: WeeklyWorkflowTotalItem[]
}

export interface WeeklyFocusHeatmapRow {
  id: string
  label: string
  values: number[]
}
export interface WeeklyFocusHeatmapSnapshot {
  title: string
  focusedLabel: string
  distractedLabel: string
  startMinute: number
  endMinute: number
  bucketMinutes: number
  timeLabels: WeeklyTimeLabel[]
  rows: WeeklyFocusHeatmapRow[]
}

export interface FaviconFields {
  faviconPrimaryRaw?: string | null
  faviconSecondaryRaw?: string | null
  faviconPrimaryHost?: string | null
  faviconSecondaryHost?: string | null
}

export interface WeeklyTreemapChange {
  text: string
  kind: 'positive' | 'negative' | 'neutral'
}
export interface WeeklyTreemapApp extends FaviconFields {
  id: string
  name: string
  colorHex: Hex
  durationSeconds: number
  change: WeeklyTreemapChange | null
  isAggregate: boolean
  isPlaceholder: boolean
}
export interface WeeklyTreemapCategory {
  id: string
  name: string
  colorHex: Hex
  apps: WeeklyTreemapApp[]
}
export interface WeeklyTreemapSnapshot {
  title: string
  categories: WeeklyTreemapCategory[]
}

export interface WeeklySankeySnapshotCategory {
  id: string
  name: string
  minutes: number
  colorHex: Hex
}
export interface WeeklySankeySnapshotApp extends FaviconFields {
  id: string
  name: string
  minutes: number
  colorHex: Hex
}
export interface WeeklySankeySnapshotLink {
  id: string
  from: string
  to: string
  minutes: number
}
export interface WeeklySankeySnapshot {
  id: string
  sourceName: string
  categories: WeeklySankeySnapshotCategory[]
  apps: WeeklySankeySnapshotApp[]
  links: WeeklySankeySnapshotLink[]
}

export type SankeyIcon =
  | { type: 'asset'; name: string }
  | { type: 'monogram'; text: string; backgroundHex: Hex; foregroundHex: Hex }
  | { type: 'none' }

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface WeeklySankeyNode {
  id: string
  name: string
  metric: string
  percent: string
  minutes: number
  barColorHex: Hex
  icon: SankeyIcon
  bar: Rect
  label: { x: number; y: number; width: number }
}
export interface WeeklySankeyFlow {
  id: string
  from: string
  to: string
  fromColorHex: Hex
  toColorHex: Hex
  x0: number
  y0Top: number
  y0Bottom: number
  x1: number
  y1Top: number
  y1Bottom: number
  curveTension: number
  opacity: number
}
/** Render model in virtual 1748 x 933 coordinates. */
export interface WeeklySankeyModel {
  id: string
  source: WeeklySankeyNode
  categories: WeeklySankeyNode[]
  apps: WeeklySankeyNode[]
  flows: WeeklySankeyFlow[]
}

export interface WeeklyDashboardSnapshot {
  donut: WeeklyDonutSnapshot
  contextCharts: WeeklyContextChartsSnapshot
  workflow: WeeklyWorkflowSnapshot
  heatmap: WeeklyFocusHeatmapSnapshot
  treemap: WeeklyTreemapSnapshot
  sankey: WeeklySankeySnapshot
  sankeyModel: WeeklySankeyModel
}

/** Result of `weekly:snapshot`. Timestamps are unix seconds. */
export interface WeeklyPageData {
  weekStart: number
  weekEnd: number
  /** "yyyy-MM-dd" of the Monday the week starts on */
  weekStartDay: string
  canNavigateForward: boolean
  /** Recorded minutes of non-System cards that start in the week (gate at 900) */
  recordedMinutes: number
  snapshot: WeeklyDashboardSnapshot
}

/** Result of `weekly:access`. */
export interface WeeklyAccessState {
  completedBatchCount: number
  targetBatchCount: number
  progress: number
  isComplete: boolean
  manuallyLocked: boolean
  unlocked: boolean
  recordedText: string
  /** Unix seconds; null when already complete */
  estimatedUnlockAt: number | null
  notificationScheduled: boolean
}

export const WEEKLY_RECORDED_MINUTES_GATE = 15 * 60
