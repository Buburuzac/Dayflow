//
//  TeamTimesheetsPanel.swift
//  Dayflow — Team → Timesheets: proposals from confirmed project time (0.25 h steps), editable
//  hours and descriptions, and Submit behind a confirmation sheet that lists exactly what will be
//  written to Odoo and then shows the result per line. Nothing reaches Odoo without that confirm.
//

import SwiftUI

struct TeamTimesheetsPanel: View {
  @ObservedObject private var sync = SyncCenter.shared

  @State private var fromDate: Date
  @State private var toDate: Date
  @State private var workspaceId = ""
  @State private var proposalsView: TimesheetProposalsView?
  @State private var lines: [TimesheetDraftLine] = []
  @State private var busy = false
  @State private var errorText: String?
  @State private var lastResult: TimesheetSubmitResult?
  @State private var pendingSubmit: [TimesheetDraftLine] = []
  @State private var showingConfirm = false
  /// Bumped whenever the shown proposals stop matching the controls: a load that finishes for an
  /// older workspace / range is dropped.
  @State private var loadGeneration = 0

  init() {
    let today = syncCurrentDay()
    _fromDate = State(initialValue: syncDate(fromDay: syncWeekStart(today)) ?? Date())
    _toDate = State(initialValue: syncDate(fromDay: today) ?? Date())
  }

  private var effectiveWorkspaceId: String {
    if sync.status.workspaces.contains(where: { $0.id == workspaceId }) { return workspaceId }
    return sync.status.workspaces.first?.id ?? ""
  }

  private var projectsById: [String: ProjectView] {
    Dictionary(sync.projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
  }

  private var chosen: [TimesheetDraftLine] { timesheetChosen(lines) }

  private var workspaceName: String {
    sync.status.workspaces.first { $0.id == effectiveWorkspaceId }?.name ?? ""
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(
        "Proposed from your confirmed project time, rounded to 15 minutes. Review and edit, then submit — nothing is written to Odoo until you confirm."
      )
      .font(.custom("Figtree", size: 12))
      .foregroundColor(SettingsStyle.secondary)
      .fixedSize(horizontal: false, vertical: true)
      controls
      if let errorText {
        SyncNotice(text: errorText, tone: .error)
      }
      warnings
      if !lines.isEmpty {
        linesTable
        footer
      }
      if let lastResult {
        SyncNotice(text: timesheetResultSummary(lastResult), tone: lastResult.failed.isEmpty ? .ok : .warn)
      }
    }
    // Proposals of another workspace or range must never stay on screen (or be submitted).
    .onChange(of: effectiveWorkspaceId) { clearProposals() }
    .onChange(of: fromDate) { clearProposals() }
    .onChange(of: toDate) { clearProposals() }
    .sheet(isPresented: $showingConfirm) {
      TimesheetSubmitSheet(drafts: pendingSubmit, projects: projectsById, workspaceName: workspaceName) { result in
        showingConfirm = false
        if let result {
          load(keepResult: result)
        }
      }
      .environment(\.colorScheme, .light)
      .preferredColorScheme(.light)
    }
  }

  // MARK: Controls

  private var controls: some View {
    HStack(spacing: 10) {
      if sync.status.workspaces.count > 1 {
        Picker("", selection: workspaceBinding) {
          ForEach(sync.status.workspaces) { w in
            Text(w.name).tag(w.id)
          }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .fixedSize()
      }
      DatePicker("", selection: $fromDate, in: ...toDate, displayedComponents: .date)
        .datePickerStyle(.field)
        .labelsHidden()
        .fixedSize()
      Text("–")
        .foregroundColor(SettingsStyle.secondary)
      DatePicker("", selection: $toDate, in: fromDate..., displayedComponents: .date)
        .datePickerStyle(.field)
        .labelsHidden()
        .fixedSize()
      SettingsSecondaryButton(
        title: busy ? String(localized: "Loading…") : String(localized: "Load proposals"),
        isDisabled: busy || effectiveWorkspaceId.isEmpty,
        action: { load() })
      Spacer()
    }
  }

  private var workspaceBinding: Binding<String> {
    Binding(get: { effectiveWorkspaceId }, set: { workspaceId = $0 })
  }

  @ViewBuilder
  private var warnings: some View {
    if let view = proposalsView {
      if !view.odooConfigured {
        SyncNotice(text: String(localized: "Odoo is not configured for this workspace yet — ask an admin."), tone: .warn)
      } else if !view.employeeMapped {
        SyncNotice(
          text: String(localized: "Your account is not mapped to an Odoo employee yet — ask an admin."), tone: .warn)
      }
      if lines.isEmpty {
        Text("No confirmed project time in this range.")
          .font(.custom("Figtree", size: 13))
          .foregroundColor(SettingsStyle.secondary)
      }
    }
  }

  // MARK: Lines

  private var linesTable: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      ForEach($lines) { $line in
        TimesheetLineRow(line: $line, project: projectsById[line.proposal.projectId])
      }
    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      Color.clear.frame(width: 18, height: 1)
      SyncCapsLabel(text: String(localized: "Day")).frame(width: 84, alignment: .leading)
      SyncCapsLabel(text: String(localized: "Project → Odoo")).frame(width: 190, alignment: .leading)
      SyncCapsLabel(text: String(localized: "Hours")).frame(width: 96, alignment: .leading)
      SyncCapsLabel(text: String(localized: "Description"))
      Spacer(minLength: 0)
    }
    .padding(.bottom, 6)
  }

  private var footer: some View {
    let chosenLines = chosen.map { $0.line }
    let count = chosenLines.count
    let total = syncHoursLabel(timesheetTotalHours(chosenLines))
    let summary = count == 1 ? String(localized: "1 line · \(total)") : String(localized: "\(count) lines · \(total)")
    return HStack(spacing: 12) {
      Spacer()
      SettingsMetadata(text: summary)
      SettingsPrimaryButton(
        title: String(localized: "Submit to Odoo…"),
        isDisabled: busy || count == 0 || proposalsView?.odooConfigured == false
      ) {
        pendingSubmit = chosen
        showingConfirm = true
      }
    }
    .padding(.top, 12)
  }

  // MARK: Load

  private func clearProposals() {
    loadGeneration += 1
    lines = []
    proposalsView = nil
    lastResult = nil
    errorText = nil
  }

  /// `keepResult`: the submit result to show above the reloaded proposals.
  private func load(keepResult: TimesheetSubmitResult? = nil) {
    let wsId = effectiveWorkspaceId
    guard !wsId.isEmpty else { return }
    let from = syncDayString(fromDate)
    let to = syncDayString(toDate)
    clearProposals()
    lastResult = keepResult
    let generation = loadGeneration
    busy = true
    Task { @MainActor in
      do {
        let v = try await sync.timesheetProposals(from: from, to: to, workspaceId: wsId)
        guard generation == loadGeneration else { return }
        proposalsView = v
        lines = timesheetDraftLines(v.proposals)
      } catch {
        if generation == loadGeneration { errorText = syncErrorMessage(error) }
      }
      busy = false
    }
  }
}

// MARK: - One editable line

struct TimesheetLineRow: View {
  @Binding var line: TimesheetDraftLine
  let project: ProjectView?

  private var odooText: String {
    let p = line.proposal
    var s: String
    if let id = p.odooProjectId {
      s = "\(project?.odoo.projectName ?? String(localized: "project")) #\(id)"
    } else {
      s = String(localized: "no Odoo project mapped")
    }
    if let task = p.odooTaskId {
      s += " / \(project?.odoo.taskName ?? String(localized: "task")) #\(task)"
    }
    if let existing = p.existingOdooLineId {
      s += " · " + String(localized: "updates line #\(existing)")
    }
    return s
  }

  private var hoursBinding: Binding<Double> {
    Binding(
      get: { line.hours },
      set: { line.hours = roundToQuarterHour($0) }
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        Toggle("", isOn: $line.include)
          .toggleStyle(.checkbox)
          .labelsHidden()
          .frame(width: 18)
        Text(line.proposal.day)
          .font(.custom("Figtree", size: 12))
          .foregroundColor(SettingsStyle.text)
          .frame(width: 84, alignment: .leading)
        projectCell
          .frame(width: 190, alignment: .leading)
        hoursCell
          .frame(width: 96, alignment: .leading)
        TextField(String(localized: "Description"), text: $line.description, axis: .vertical)
          .lineLimit(1...3)
          .textFieldStyle(.roundedBorder)
          .font(.custom("Figtree", size: 12))
      }
      .padding(.vertical, 8)
      .opacity(line.include ? 1 : 0.5)
      Rectangle()
        .fill(SettingsStyle.divider)
        .frame(height: 1)
    }
  }

  private var projectCell: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        SyncColorDot(hex: project?.color ?? OUT_OF_SCOPE_COLOR_HEX, size: 8)
        Text(project?.name ?? line.proposal.projectName ?? line.proposal.projectId)
          .font(.custom("Figtree", size: 12))
          .fontWeight(.semibold)
          .foregroundColor(SettingsStyle.text)
          .lineLimit(1)
      }
      Text(odooText)
        .font(.custom("Figtree", size: 11))
        .foregroundColor(SettingsStyle.meta)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var hoursCell: some View {
    HStack(spacing: 2) {
      TextField("", value: hoursBinding, format: .number.precision(.fractionLength(2)))
        .textFieldStyle(.roundedBorder)
        .font(.custom("Figtree", size: 12))
        .multilineTextAlignment(.trailing)
        .frame(width: 56)
      Stepper("", value: hoursBinding, in: 0...24, step: 0.25)
        .labelsHidden()
    }
  }
}

// MARK: - Confirmation sheet

/// Lists exactly the lines that will be written to Odoo; after the user confirms, shows the
/// result per line. `onClose(nil)` = cancelled, `onClose(result)` = submitted.
struct TimesheetSubmitSheet: View {
  let drafts: [TimesheetDraftLine]
  let projects: [String: ProjectView]
  /// The workspace whose Odoo the lines go to.
  let workspaceName: String
  let onClose: (TimesheetSubmitResult?) -> Void

  @State private var sending = false
  @State private var result: TimesheetSubmitResult?
  @State private var errorText: String?

  private var lines: [TimesheetLine] { drafts.map { $0.line } }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(result == nil ? String(localized: "Write these lines to Odoo?") : String(localized: "Sent to Odoo"))
        .font(.custom("Figtree", size: 18))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
      if !workspaceName.isEmpty {
        SettingsMetadata(text: String(localized: "Workspace: \(workspaceName)"))
      }
      Text(introText)
        .font(.custom("Figtree", size: 12))
        .foregroundColor(SettingsStyle.secondary)
        .fixedSize(horizontal: false, vertical: true)
      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(drafts) { d in
            sheetRow(d)
          }
        }
      }
      .frame(maxHeight: 360)
      SettingsMetadata(text: String(localized: "Total: \(syncHoursLabel(timesheetTotalHours(lines)))"))
      if let errorText {
        SyncNotice(text: errorText, tone: .error)
      }
      buttons
    }
    .padding(24)
    .frame(width: 660)
    .background(Color.white)
    // Once sent, only Done closes it, so the result banner and the reload always happen.
    .interactiveDismissDisabled(sending || result != nil)
  }

  private var introText: String {
    if let result { return timesheetResultSummary(result) }
    return String(
      localized:
        "Exactly these timesheet lines will be written to Odoo. A day and project that was sent before updates its existing line instead of adding a new one."
    )
  }

  @ViewBuilder
  private var buttons: some View {
    HStack(spacing: 10) {
      Spacer()
      if let result {
        SettingsPrimaryButton(title: String(localized: "Done")) { onClose(result) }
      } else {
        SettingsSecondaryButton(title: String(localized: "Cancel"), isDisabled: sending) { onClose(nil) }
        SettingsPrimaryButton(
          title: lines.count == 1
            ? String(localized: "Write 1 line to Odoo") : String(localized: "Write \(lines.count) lines to Odoo"),
          isLoading: sending,
          isDisabled: lines.isEmpty,
          action: submit)
      }
    }
  }

  private func sheetRow(_ d: TimesheetDraftLine) -> some View {
    let line = d.line
    let project = projects[line.projectId]
    return VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        Text(line.day)
          .frame(width: 84, alignment: .leading)
        Text(syncHoursLabel(line.hours))
          .fontWeight(.semibold)
          .frame(width: 60, alignment: .leading)
        VStack(alignment: .leading, spacing: 2) {
          Text(project?.name ?? d.proposal.projectName ?? line.projectId)
            .fontWeight(.semibold)
          Text(odooTarget(d, project: project))
            .font(.custom("Figtree", size: 11))
            .foregroundColor(SettingsStyle.meta)
        }
        .frame(width: 180, alignment: .leading)
        Text(line.description.isEmpty ? String(localized: "(no description)") : line.description)
          .foregroundColor(SettingsStyle.text)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
        if let result {
          outcomeLabel(timesheetOutcome(day: line.day, projectId: line.projectId, in: result))
            .frame(width: 130, alignment: .trailing)
        }
      }
      .font(.custom("Figtree", size: 12))
      .foregroundColor(SettingsStyle.text)
      .padding(.vertical, 8)
      Rectangle()
        .fill(SettingsStyle.divider)
        .frame(height: 1)
    }
  }

  private func odooTarget(_ d: TimesheetDraftLine, project: ProjectView?) -> String {
    let p = d.proposal
    guard let pid = p.odooProjectId else { return String(localized: "no Odoo project mapped") }
    var s = "\(project?.odoo.projectName ?? String(localized: "Odoo project")) #\(pid)"
    if let tid = p.odooTaskId {
      s += " / \(project?.odoo.taskName ?? String(localized: "task")) #\(tid)"
    }
    if let existing = p.existingOdooLineId {
      s += " · " + String(localized: "updates line #\(existing)")
    }
    return s
  }

  @ViewBuilder
  private func outcomeLabel(_ outcome: TimesheetLineOutcome) -> some View {
    switch outcome {
    case .written(let id, let updated):
      Text(updated ? String(localized: "Updated line #\(id)") : String(localized: "Created line #\(id)"))
        .foregroundColor(SettingsStyle.statusGood)
    case .failed(let message):
      Text(message)
        .foregroundColor(SettingsStyle.statusBad)
        .fixedSize(horizontal: false, vertical: true)
    case .unknown:
      Text("Not reported")
        .foregroundColor(SettingsStyle.meta)
    }
  }

  private func submit() {
    let toSend = lines
    guard !toSend.isEmpty else { return }
    sending = true
    errorText = nil
    Task { @MainActor in
      do {
        result = try await SyncCenter.shared.timesheetSubmit(toSend)
      } catch {
        errorText = syncErrorMessage(error)
      }
      sending = false
    }
  }
}
