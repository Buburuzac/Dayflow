//
//  SyncUIHelpers.swift
//  Dayflow — Dayflow Sync UI
//
//  Pure helpers for the Sync & team UI (no SwiftUI/AppKit), so the Linux harness
//  (Dayflow/SyncCoreHarness, see link-core.sh) can build and test them with the sync core.
//

import Foundation

// MARK: - Relative time ("Last sync 3 min ago")

private let syncShortDateFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateStyle = .short
  f.timeStyle = .none
  return f
}()

/// "never", "just now", "42 s ago", "5 min ago", "3 h ago", or the date (Windows `ago`).
func syncAgo(ms: Double?, now: Date = Date()) -> String {
  guard let ms, ms > 0, ms.isFinite else { return "never" }
  let s = Int(((now.timeIntervalSince1970 * 1000 - ms) / 1000).rounded())
  if s < 10 { return "just now" }
  if s < 60 { return "\(s) s ago" }
  if s < 3600 { return "\(Int((Double(s) / 60).rounded())) min ago" }
  if s < 86400 { return "\(Int((Double(s) / 3600).rounded())) h ago" }
  return syncShortDateFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
}

func syncAgo(ms: Int64?, now: Date = Date()) -> String {
  syncAgo(ms: ms.map { Double($0) }, now: now)
}

// MARK: - Durations

/// "2h 05m" / "45m" (minutes rounded first, so 119.6 min reads "2h 00m", never "1h 60m").
func syncHoursMinutes(_ minutes: Double) -> String {
  let total = minutes.isFinite ? max(0, Int(minutes.rounded())) : 0
  let h = total / 60
  let m = total % 60
  if h == 0 { return "\(m)m" }
  return m < 10 ? "\(h)h 0\(m)m" : "\(h)h \(m)m"
}

/// Timesheet hours: clamped to 0…24 and rounded to 0.25 h.
func roundToQuarterHour(_ hours: Double) -> Double {
  guard hours.isFinite else { return 0 }
  let clamped = min(24, max(0, hours))
  return (clamped * 4).rounded() / 4
}

/// "1.25 h"
func syncHoursLabel(_ hours: Double) -> String {
  let q = (hours * 100).rounded() / 100
  let whole = Int(q)
  var cents = Int(((q - Double(whole)) * 100).rounded())
  var w = whole
  if cents >= 100 {
    w += 1
    cents -= 100
  }
  return "\(w).\(cents < 10 ? "0" : "")\(cents) h"
}

// MARK: - Days ("YYYY-MM-DD", logical day starts at 4 AM like the timeline)

let SYNC_DAY_BOUNDARY_HOUR = 4

func syncDayString(_ date: Date, calendar: Calendar = .current) -> String {
  let c = calendar.dateComponents([.year, .month, .day], from: date)
  let y = c.year ?? 1970
  let m = c.month ?? 1
  let d = c.day ?? 1
  return "\(y)-\(m < 10 ? "0" : "")\(m)-\(d < 10 ? "0" : "")\(d)"
}

/// Noon of a "YYYY-MM-DD" day, or nil when the text is not a day.
func syncDate(fromDay day: String, calendar: Calendar = .current) -> Date? {
  let parts = day.split(separator: "-")
  guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
    let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
    (1...12).contains(m), (1...31).contains(d)
  else { return nil }
  var c = DateComponents()
  c.year = y
  c.month = m
  c.day = d
  c.hour = 12
  guard let date = calendar.date(from: c) else { return nil }
  // Reject overflowed days such as 2026-02-31.
  return syncDayString(date, calendar: calendar) == day ? date : nil
}

/// Today's logical day (before 4 AM it is still yesterday).
func syncCurrentDay(_ now: Date = Date(), calendar: Calendar = .current) -> String {
  let hour = calendar.component(.hour, from: now)
  if hour < SYNC_DAY_BOUNDARY_HOUR, let prev = calendar.date(byAdding: .day, value: -1, to: now) {
    return syncDayString(prev, calendar: calendar)
  }
  return syncDayString(now, calendar: calendar)
}

func syncShiftDay(_ day: String, by delta: Int, calendar: Calendar = .current) -> String {
  guard let date = syncDate(fromDay: day, calendar: calendar),
    let shifted = calendar.date(byAdding: .day, value: delta, to: date)
  else { return day }
  return syncDayString(shifted, calendar: calendar)
}

/// Monday of the week containing `day`.
func syncWeekStart(_ day: String, calendar: Calendar = .current) -> String {
  guard let date = syncDate(fromDay: day, calendar: calendar) else { return day }
  let weekday = calendar.component(.weekday, from: date)  // 1 = Sunday … 7 = Saturday
  let sinceMonday = (weekday + 5) % 7
  return syncShiftDay(day, by: -sinceMonday, calendar: calendar)
}

/// First day of the month containing `day` ("YYYY-MM-01").
func syncMonthStart(_ day: String) -> String {
  guard syncIsDayString(day) else { return day }
  return String(day.prefix(8)) + "01"
}

// MARK: - Team report (member × day grid)

/// The report's `byMemberDay` as a grid: one row per member (in `byMember` order), one column per
/// day that has time, minutes aligned with `days`.
struct TeamMemberDayGrid: Equatable {
  struct Row: Equatable {
    var userId: String
    var userName: String
    var minutes: [Double]
    var total: Double
  }
  var days: [String]
  var rows: [Row]
}

func teamMemberDayGrid(_ report: ProjectReport) -> TeamMemberDayGrid {
  let days = Array(Set(report.byMemberDay.map { $0.day })).sorted()
  let index = Dictionary(uniqueKeysWithValues: days.enumerated().map { ($0.element, $0.offset) })
  var order: [String] = report.byMember.map { $0.userId }
  var names: [String: String] = [:]
  for m in report.byMember { names[m.userId] = m.userName }
  var cells: [String: [Double]] = [:]
  for c in report.byMemberDay {
    if cells[c.userId] == nil {
      cells[c.userId] = Array(repeating: 0, count: days.count)
      if !order.contains(c.userId) { order.append(c.userId) }
    }
    if let i = index[c.day] { cells[c.userId]![i] += c.minutes }
  }
  let rows = order.compactMap { uid -> TeamMemberDayGrid.Row? in
    guard let m = cells[uid] else { return nil }
    return TeamMemberDayGrid.Row(userId: uid, userName: names[uid] ?? uid, minutes: m, total: m.reduce(0, +))
  }
  return TeamMemberDayGrid(days: days, rows: rows)
}

// MARK: - Token lists (project rules)

/// Splits "Code, idea64; EXCEL" (commas, semicolons, new lines) into trimmed tokens,
/// dropping empties and case-insensitive duplicates (first spelling wins).
func parseTokenList(_ text: String) -> [String] {
  addTokens([], from: text)
}

/// `existing` plus the tokens typed in `text`, without case-insensitive duplicates.
func addTokens(_ existing: [String], from text: String) -> [String] {
  var out: [String] = []
  var seen = Set<String>()
  let typed = text.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" || $0 == "\r" }).map { String($0) }
  for raw in existing + typed {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { continue }
    let key = t.lowercased()
    guard !seen.contains(key) else { continue }
    seen.insert(key)
    out.append(t)
  }
  return out
}

/// Odoo record ids typed by hand: digits only; empty → nil.
func parseOdooId(_ text: String) -> Int? {
  let digits = text.filter { $0.isASCII && $0.isNumber }
  guard !digits.isEmpty, let v = Int(digits), v > 0 else { return nil }
  return v
}

/// nil for blank text (Odoo names are optional).
func optionalText(_ text: String) -> String? {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.isEmpty ? nil : t
}

// MARK: - "What leaves this Mac": excluded categories

private func categoryKey(_ s: String) -> String {
  s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func isCategoryExcluded(_ name: String, in excluded: [String]) -> Bool {
  let k = categoryKey(name)
  return excluded.contains { categoryKey($0) == k }
}

/// The excluded list after ticking/unticking `name` in the category checkboxes (which list only the
/// current categories). Names that are not in `categoryNames` (a category that exists only on
/// another device, an earlier name of a renamed one) stay excluded, except that unticking a
/// category also removes its earlier names (`aliases`, keyed by `syncCategoryKey`).
func toggledExclusions(
  _ current: [String], categoryNames: [String], name: String, on: Bool, aliases: [String: [String]] = [:]
) -> [String] {
  let known = Set(categoryNames.map(categoryKey))
  let dropped: Set<String> = on ? [] : Set((aliases[categoryKey(name)] ?? []).map(categoryKey))
  var out = current.filter { !known.contains(categoryKey($0)) && !dropped.contains(categoryKey($0)) }
  for n in categoryNames {
    let checked = categoryKey(n) == categoryKey(name) ? on : isCategoryExcluded(n, in: current)
    if checked && !isCategoryExcluded(n, in: out) { out.append(n) }
  }
  if on && !known.contains(categoryKey(name)) && !isCategoryExcluded(name, in: out) { out.append(name) }
  return out
}

/// The excluded list after a category was renamed, or nil when nothing changes (the old name was
/// not excluded, or the new one already is). The new name is added and the old one kept: cards
/// made before the rename still carry the old category string.
func renamedExclusions(_ current: [String], from oldName: String, to newName: String) -> [String]? {
  let new = newName.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !new.isEmpty, isCategoryExcluded(oldName, in: current), !isCategoryExcluded(new, in: current) else {
    return nil
  }
  return current + [new]
}

// MARK: - Category colors

/// Neutral grey of the time-only "Out of scope" blocks synced from the user's other devices
/// (Windows uses the same #C9C4BE). They have no CategoryStore entry.
let OUT_OF_SCOPE_COLOR_HEX = "C9C4BE"

/// A fixed color for categories that are not user categories, or nil.
func syncFixedCategoryColorHex(_ category: String) -> String? {
  categoryKey(category) == categoryKey(OUT_OF_SCOPE_LABEL) ? OUT_OF_SCOPE_COLOR_HEX : nil
}

// MARK: - Timeline project filter

enum TimelineProjectFilter: Equatable, Hashable, Sendable {
  case all
  /// Cards without any project.
  case unassigned
  case project(String)
}

func projectFilterMatches(_ filter: TimelineProjectFilter, projectIds: [String]) -> Bool {
  switch filter {
  case .all: return true
  case .unassigned: return projectIds.isEmpty
  case .project(let id): return projectIds.contains(id)
  }
}

// MARK: - Team feed

struct SyncFeedDay: Identifiable, Equatable {
  let day: String
  let entries: [ProjectEntry]
  var id: String { day }
}

/// Feed entries grouped by day, in the server's order.
func groupFeedByDay(_ entries: [ProjectEntry], calendar: Calendar = .current) -> [SyncFeedDay] {
  var order: [String] = []
  var byDay: [String: [ProjectEntry]] = [:]
  for e in entries {
    let day = e.day ?? syncDayString(Date(timeIntervalSince1970: e.startTs), calendar: calendar)
    if byDay[day] == nil { order.append(day) }
    byDay[day, default: []].append(e)
  }
  return order.map { SyncFeedDay(day: $0, entries: byDay[$0] ?? []) }
}

/// Share of `part` in `total` for a bar, 0…1.
func syncFraction(_ part: Double, of total: Double) -> Double {
  guard total > 0, part.isFinite else { return 0 }
  return min(1, max(0, part / total))
}

// MARK: - Timesheets

/// One editable proposal row in the Timesheets panel.
struct TimesheetDraftLine: Equatable, Identifiable {
  var proposal: TimesheetProposal
  var include: Bool
  var hours: Double
  var description: String

  var id: String {
    let task = proposal.odooTaskId.map { String($0) } ?? "-"
    return proposal.day + ":" + proposal.projectId + ":" + task
  }

  var line: TimesheetLine {
    TimesheetLine(
      day: proposal.day, projectId: proposal.projectId, hours: roundToQuarterHour(hours),
      description: description.trimmingCharacters(in: .whitespacesAndNewlines), cardIds: proposal.cardIds)
  }
}

func timesheetDraftLines(_ proposals: [TimesheetProposal]) -> [TimesheetDraftLine] {
  proposals.map {
    TimesheetDraftLine(proposal: $0, include: $0.hours > 0, hours: roundToQuarterHour($0.hours), description: $0.description)
  }
}

/// Exactly what Submit sends: included rows with hours > 0.
func timesheetChosen(_ drafts: [TimesheetDraftLine]) -> [TimesheetDraftLine] {
  drafts.filter { $0.include && roundToQuarterHour($0.hours) > 0 }
}

func timesheetTotalHours(_ lines: [TimesheetLine]) -> Double {
  lines.reduce(0) { $0 + $1.hours }
}

enum TimesheetLineOutcome: Equatable {
  case written(odooLineId: Int, updated: Bool)
  case failed(String)
  /// The server did not report this line.
  case unknown
}

func timesheetOutcome(day: String, projectId: String, in result: TimesheetSubmitResult) -> TimesheetLineOutcome {
  if let f = result.failed.first(where: { $0.day == day && $0.projectId == projectId }) { return .failed(f.error) }
  if let s = result.sent.first(where: { $0.day == day && $0.projectId == projectId }) {
    return .written(odooLineId: s.odooLineId, updated: s.updated)
  }
  return .unknown
}

/// "3 lines written to Odoo (1 updated)."
func timesheetResultSummary(_ result: TimesheetSubmitResult) -> String {
  let n = result.sent.count
  let updated = result.sent.filter { $0.updated }.count
  var s = "\(n) line\(n == 1 ? "" : "s") written to Odoo"
  if updated > 0 { s += " (\(updated) updated)" }
  s += "."
  if !result.failed.isEmpty { s += " \(result.failed.count) failed." }
  return s
}

/// "Odoo: Biosun #12 / Import #340" for a project's mapping, or nil when unmapped.
func odooMappingLabel(_ o: OdooMapping) -> String? {
  guard o.projectId != nil || o.projectName != nil else { return nil }
  var s = o.projectName ?? "#\(o.projectId ?? 0)"
  if o.taskName != nil || o.taskId != nil {
    s += " / " + (o.taskName ?? "#\(o.taskId ?? 0)")
  }
  return s
}
