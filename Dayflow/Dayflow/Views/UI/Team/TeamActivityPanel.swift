//
//  TeamActivityPanel.swift
//  Dayflow — Team → Activity: one project's feed and totals for today, this week, this month or a
//  custom range (`SyncCenter.feed` / `SyncCenter.report`): per member, per day, member × day and
//  per category. What each entry shows depends on its author's share level.
//

import SwiftUI

private let teamClockFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "HH:mm"
  f.dateStyle = .none
  return f
}()

func teamDayLabel(_ day: String) -> String {
  let today = syncCurrentDay()
  if day == today { return String(localized: "Today") }
  if day == syncShiftDay(today, by: -1) { return String(localized: "Yesterday") }
  guard let date = syncDate(fromDay: day) else { return day }
  return date.formatted(.dateTime.weekday(.wide).month(.wide).day())
}

struct TeamActivityPanel: View {
  enum Period: String, CaseIterable, Identifiable {
    case today
    case week
    case month
    case custom

    var id: String { rawValue }
    var title: String {
      switch self {
      case .today: return String(localized: "Today")
      case .week: return String(localized: "This week")
      case .month: return String(localized: "This month")
      case .custom: return String(localized: "Custom")
      }
    }
  }

  /// The server accepts ranges shorter than 93 days.
  private static let maxRangeDays = 92

  @ObservedObject private var sync = SyncCenter.shared
  @State private var projectId = ""
  @State private var range: Period = .today
  @State private var customFrom: Date = syncDate(fromDay: syncWeekStart(syncCurrentDay())) ?? Date()
  @State private var customTo: Date = syncDate(fromDay: syncCurrentDay()) ?? Date()
  @State private var feed: [ProjectEntry]?
  @State private var report: ProjectReport?
  @State private var errorText: String?
  @State private var loading = false

  private var active: [ProjectView] { sync.activeProjects }

  private var selectedId: String {
    if active.contains(where: { $0.id == projectId }) { return projectId }
    return active.first?.id ?? ""
  }

  /// Inclusive "YYYY-MM-DD" bounds of the chosen period.
  private var bounds: (from: String, to: String) {
    let today = syncCurrentDay()
    switch range {
    case .today: return (today, today)
    case .week: return (syncWeekStart(today), today)
    case .month: return (syncMonthStart(today), today)
    case .custom:
      let from = syncDayString(customFrom)
      let to = syncDayString(customTo)
      return from <= to ? (from, to) : (to, from)
    }
  }

  private var rangeTooLong: Bool {
    guard let a = syncDate(fromDay: bounds.from), let b = syncDate(fromDay: bounds.to) else { return false }
    let days = Calendar.current.dateComponents([.day], from: a, to: b).day ?? 0
    return days >= TeamActivityPanel.maxRangeDays
  }

  private var loadKey: String { selectedId + "|" + bounds.from + "|" + bounds.to }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      if active.isEmpty {
        Text("No projects yet.")
          .font(.custom("Figtree", size: 13))
          .foregroundColor(SettingsStyle.secondary)
      } else {
        controls
        if rangeTooLong {
          SyncNotice(
            text: String(localized: "Pick a range shorter than \(TeamActivityPanel.maxRangeDays + 1) days."), tone: .warn)
        }
        if let errorText {
          SyncNotice(text: errorText, tone: .error)
        }
        if loading && report == nil {
          ProgressView().controlSize(.small)
        }
        if let report {
          totals(report)
        }
        if let feed {
          feedList(feed)
        }
      }
    }
    .task(id: loadKey) { await load() }
  }

  private var controls: some View {
    HStack(spacing: 12) {
      Picker("", selection: projectBinding) {
        ForEach(active) { p in
          Text(p.name).tag(p.id)
        }
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .fixedSize()
      Picker("", selection: $range) {
        ForEach(Period.allCases) { r in
          Text(r.title).tag(r)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .frame(width: 330)
      if range == .custom {
        DatePicker("", selection: $customFrom, in: ...customTo, displayedComponents: .date)
          .datePickerStyle(.field)
          .labelsHidden()
          .fixedSize()
        Text("–")
          .foregroundColor(SettingsStyle.secondary)
        DatePicker("", selection: $customTo, in: customFrom..., displayedComponents: .date)
          .datePickerStyle(.field)
          .labelsHidden()
          .fixedSize()
      }
      Spacer()
      SettingsLinkButton(title: String(localized: "Refresh"), systemImage: "arrow.clockwise") {
        Task { await load() }
      }
    }
  }

  private var projectBinding: Binding<String> {
    Binding(get: { selectedId }, set: { projectId = $0 })
  }

  // MARK: Totals

  private func totals(_ report: ProjectReport) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("\(syncHoursMinutes(report.totalMinutes)) in total")
        .font(.custom("Figtree", size: 17))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
      ForEach(report.byMember, id: \.userId) { member in
        memberRow(member, total: report.totalMinutes)
      }
      if range != .today && !report.byDay.isEmpty {
        SyncFlowLayout(spacing: 6, lineSpacing: 6) {
          ForEach(report.byDay, id: \.day) { d in
            dayChip(d)
          }
        }
      }
      let grid = teamMemberDayGrid(report)
      if grid.days.count > 1 && !grid.rows.isEmpty {
        memberDayGrid(grid)
      }
      if let categories = report.byCategory, !categories.isEmpty {
        categoryBlock(categories, total: report.totalMinutes)
      }
    }
  }

  // MARK: Member × day

  private func memberDayGrid(_ grid: TeamMemberDayGrid) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      SyncCapsLabel(text: String(localized: "By member and day"))
      ScrollView(.horizontal, showsIndicators: true) {
        Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 6) {
          GridRow {
            Text("")
              .frame(width: 150, alignment: .leading)
            ForEach(grid.days, id: \.self) { day in
              Text(String(day.suffix(5)))
                .foregroundColor(SettingsStyle.secondary)
            }
            Text("Total")
              .foregroundColor(SettingsStyle.secondary)
          }
          ForEach(grid.rows, id: \.userId) { row in
            GridRow {
              Text(row.userName)
                .foregroundColor(SettingsStyle.text)
                .lineLimit(1)
                .frame(width: 150, alignment: .leading)
              ForEach(Array(row.minutes.enumerated()), id: \.offset) { _, minutes in
                Text(minutes > 0 ? syncHoursMinutes(minutes) : "–")
                  .foregroundColor(minutes > 0 ? SettingsStyle.text : SettingsStyle.meta)
              }
              Text(syncHoursMinutes(row.total))
                .fontWeight(.semibold)
                .foregroundColor(SettingsStyle.text)
            }
          }
        }
        .font(.custom("Figtree", size: 12))
        .padding(.bottom, 4)
      }
    }
  }

  // MARK: By category

  private func categoryBlock(_ categories: [ReportCategoryMinutes], total: Double) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SyncCapsLabel(text: String(localized: "By category"))
      ForEach(categories.sorted { $0.minutes > $1.minutes }, id: \.category) { c in
        let fraction = syncFraction(c.minutes, of: total)
        HStack(spacing: 12) {
          HStack(spacing: 6) {
            SyncColorDot(hex: syncFixedCategoryColorHex(c.category) ?? categoryColorHex(c.category), size: 8)
            Text(c.category.isEmpty ? String(localized: "Uncategorized") : c.category)
              .font(.custom("Figtree", size: 13))
              .foregroundColor(SettingsStyle.text)
              .lineLimit(1)
          }
          .frame(width: 160, alignment: .leading)
          ZStack(alignment: .leading) {
            Capsule().fill(SettingsStyle.subtleFill)
            Capsule().fill(SettingsStyle.ink.opacity(0.5))
              .frame(width: 260 * CGFloat(fraction))
          }
          .frame(width: 260, height: 6)
          Text(syncHoursMinutes(c.minutes))
            .font(.custom("Figtree", size: 13))
            .fontWeight(.semibold)
            .foregroundColor(SettingsStyle.text)
            .frame(width: 70, alignment: .trailing)
        }
      }
    }
  }

  /// The user's own color for a category name, else a neutral grey.
  private func categoryColorHex(_ name: String) -> String {
    let key = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return CategoryStore.shared.categories.first {
      $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == key
    }?.colorHex ?? OUT_OF_SCOPE_COLOR_HEX
  }

  private func memberRow(_ m: ReportMemberMinutes, total: Double) -> some View {
    let fraction = syncFraction(m.minutes, of: total)
    return HStack(spacing: 12) {
      Text(m.userName)
        .font(.custom("Figtree", size: 13))
        .foregroundColor(SettingsStyle.text)
        .lineLimit(1)
        .frame(width: 160, alignment: .leading)
      ZStack(alignment: .leading) {
        Capsule().fill(SettingsStyle.subtleFill)
        Capsule().fill(SettingsStyle.ink.opacity(0.7))
          .frame(width: 260 * CGFloat(fraction))
      }
      .frame(width: 260, height: 6)
      Text(syncHoursMinutes(m.minutes))
        .font(.custom("Figtree", size: 13))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
        .frame(width: 70, alignment: .trailing)
    }
  }

  private func dayChip(_ d: ReportDayMinutes) -> some View {
    HStack(spacing: 4) {
      Text(String(d.day.suffix(5)))
        .foregroundColor(SettingsStyle.secondary)
      Text(syncHoursMinutes(d.minutes))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
    }
    .font(.custom("Figtree", size: 12))
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(Capsule(style: .continuous).fill(SettingsStyle.subtleFill))
  }

  // MARK: Feed

  @ViewBuilder
  private func feedList(_ entries: [ProjectEntry]) -> some View {
    if entries.isEmpty {
      Text("Nothing shared on this project yet.")
        .font(.custom("Figtree", size: 13))
        .foregroundColor(SettingsStyle.secondary)
    } else {
      VStack(alignment: .leading, spacing: 18) {
        ForEach(groupFeedByDay(entries)) { group in
          VStack(alignment: .leading, spacing: 0) {
            SyncCapsLabel(text: teamDayLabel(group.day))
              .padding(.bottom, 6)
            ForEach(Array(group.entries.enumerated()), id: \.offset) { _, entry in
              TeamFeedRow(entry: entry)
            }
          }
        }
      }
    }
  }

  // MARK: Load

  private func load() async {
    let pid = selectedId
    guard !pid.isEmpty else { return }
    guard !rangeTooLong else {
      feed = nil
      report = nil
      return
    }
    let key = loadKey
    let (from, to) = bounds
    loading = true
    errorText = nil
    do {
      let f = try await sync.feed(projectId: pid, from: from, to: to)
      let r = try await sync.report(projectId: pid, from: from, to: to)
      guard key == loadKey else { return }
      feed = f
      report = r
    } catch is CancellationError {
      // A newer load replaced this one.
    } catch {
      guard key == loadKey else { return }
      feed = nil
      report = nil
      errorText = syncErrorMessage(error)
    }
    loading = false
  }
}

struct TeamFeedRow: View {
  let entry: ProjectEntry

  private var timeRange: String {
    let start = teamClockFormatter.string(from: Date(timeIntervalSince1970: entry.startTs))
    let end = teamClockFormatter.string(from: Date(timeIntervalSince1970: entry.endTs))
    return "\(start) – \(end)"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        Text(timeRange)
          .font(.custom("Figtree", size: 12))
          .foregroundColor(SettingsStyle.secondary)
          .frame(width: 130, alignment: .leading)
        Text(entry.userName)
          .font(.custom("Figtree", size: 12))
          .fontWeight(.semibold)
          .foregroundColor(SettingsStyle.text)
          .lineLimit(1)
          .frame(width: 120, alignment: .leading)
        details
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(syncHoursMinutes(entry.minutes))
          .font(.custom("Figtree", size: 12))
          .foregroundColor(SettingsStyle.text)
          .frame(width: 60, alignment: .trailing)
      }
      .padding(.vertical, 8)
      Rectangle()
        .fill(SettingsStyle.divider)
        .frame(height: 1)
    }
  }

  @ViewBuilder
  private var details: some View {
    VStack(alignment: .leading, spacing: 3) {
      if let title = entry.title, !title.isEmpty {
        Text(title)
          .font(.custom("Figtree", size: 13))
          .fontWeight(.semibold)
          .foregroundColor(SettingsStyle.text)
      } else {
        Text("\(syncHoursMinutes(entry.minutes)) of work")
          .font(.custom("Figtree", size: 13))
          .foregroundColor(SettingsStyle.secondary)
      }
      if let summary = entry.summary, !summary.isEmpty {
        Text(summary)
          .font(.custom("Figtree", size: 12))
          .foregroundColor(SettingsStyle.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let detailed = entry.detailed, !detailed.isEmpty {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(syncDetailRecords(summary: detailed, distractions: [])) { line in
            HStack(alignment: .firstTextBaseline, spacing: 3) {
              if !line.stamp.isEmpty { Text(line.stamp).bold() }
              Text(line.text)
            }
          }
        }
        .font(.custom("Figtree", size: 11))
        .foregroundColor(SettingsStyle.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      }
    }
  }
}
