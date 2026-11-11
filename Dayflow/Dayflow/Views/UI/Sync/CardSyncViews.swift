//
//  CardSyncViews.swift
//  Dayflow — Dayflow Sync UI
//
//  Timeline pieces for sync: project chips on cards ("?" = unconfirmed AI guess, click to
//  confirm), the private mark, the "from <device>" badge, the card-detail project picker and
//  Private toggle, and the timeline project filter.
//  Reference: windows/src/renderer/src/features/CardProjects.tsx and Timeline.tsx.
//

import Combine
import SwiftUI

// MARK: - Project chip

struct CardProjectChip: View {
  let project: CardProjectInfo
  let recordId: Int64
  var fontSize: CGFloat = 10

  @Environment(\.dayflowTheme) private var theme
  @State private var confirmError: String?

  private var sharePercent: Int? {
    project.share < 1 ? Int((project.share * 100).rounded()) : nil
  }

  private var helpText: String {
    let percent = Int((project.confidence * 100).rounded())
    if !project.confirmed {
      return String(
        localized: "Suggested by the AI (\(percent)% sure). Click to confirm; open the card to change.")
    }
    if project.share < 1 {
      let share = Int((project.share * 100).rounded())
      return "\(project.name) · \(share)% (\(project.source.rawValue))"
    }
    return "\(project.name) (\(project.source.rawValue))"
  }

  var body: some View {
    if project.confirmed {
      chipLabel
        .help(helpText)
    } else {
      Button(action: confirm) {
        chipLabel
      }
      .buttonStyle(.plain)
      .pointingHandCursor()
      .help(helpText)
      .alert(
        String(localized: "Could not confirm the project"),
        isPresented: Binding(get: { confirmError != nil }, set: { if !$0 { confirmError = nil } })
      ) {
        Button(String(localized: "OK"), role: .cancel) { confirmError = nil }
      } message: {
        Text(confirmError ?? "")
      }
    }
  }

  private var chipLabel: some View {
    let color = syncProjectColor(project.color)
    let dash: [CGFloat] = project.confirmed ? [] : [2, 2]
    return HStack(spacing: 3) {
      Circle()
        .fill(color)
        .frame(width: 6, height: 6)
      Text(project.name)
        .font(.custom("Figtree", size: fontSize).weight(.medium))
        .foregroundColor(theme.chipText)
        .lineLimit(1)
      if let sharePercent {
        Text("\(sharePercent)%")
          .font(.custom("Figtree", size: fontSize))
          .foregroundColor(theme.chipText.opacity(0.75))
          .lineLimit(1)
      }
      if !project.confirmed {
        Text("?")
          .font(.custom("Figtree", size: fontSize).weight(.bold))
          .foregroundColor(theme.chipText)
      }
    }
    .padding(.horizontal, 5)
    .padding(.vertical, 1.5)
    .background(Capsule(style: .continuous).fill(color.opacity(0.16)))
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(color.opacity(project.confirmed ? 0.4 : 0.9), style: StrokeStyle(lineWidth: 0.75, dash: dash))
    )
  }

  private func confirm() {
    let id = recordId
    let projectId = project.projectId
    Task { @MainActor in
      do {
        try await SyncCenter.shared.confirmCard(recordId: id, projectId: projectId)
      } catch {
        confirmError = syncErrorMessage(error)
      }
      CardSyncInfoStore.shared.refresh(recordIds: [id])
    }
  }
}

// MARK: - Small marks

/// "private" — stays on this Mac, never synced or shared. On another device's card the flag means
/// that device stops sharing it.
struct CardPrivateMark: View {
  /// Name of the device that made the card, when it is another device's card.
  var remoteDevice: String? = nil

  @Environment(\.dayflowTheme) private var theme

  var body: some View {
    Image(systemName: "lock.fill")
      .font(.system(size: 8, weight: .semibold))
      .foregroundColor(theme.textSecondary)
      .help(cardPrivateHelp(remoteDevice: remoteDevice))
  }
}

/// Tooltip of the private mark.
func cardPrivateHelp(remoteDevice: String?) -> String {
  if let remoteDevice {
    return String(localized: "Private: \(remoteDevice) stops sharing it; it never reaches the team")
  }
  return String(localized: "Private: stays on this Mac, never synced or shared")
}

/// "from Max's PC" — a card from another of the user's devices.
struct CardRemoteBadge: View {
  let deviceName: String
  var fontSize: CGFloat = 10

  @Environment(\.dayflowTheme) private var theme

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: "arrow.left.arrow.right")
        .font(.system(size: fontSize - 2, weight: .semibold))
      Text("from \(deviceName)")
        .font(.custom("Figtree", size: fontSize))
        .lineLimit(1)
    }
    .foregroundColor(theme.textSecondary)
    .help(String(localized: "From another of your devices"))
  }
}

// MARK: - Overlay on Day timeline cards

/// Applied to each Day-view card: sync marks in the corner, dimmed when the project filter hides it.
struct CanvasCardSyncDecoration: ViewModifier {
  let recordId: Int64?
  let height: CGFloat

  @ObservedObject private var store = CardSyncInfoStore.shared

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .bottomTrailing) {
        CanvasCardSyncOverlay(recordId: recordId, height: height)
      }
      .opacity(store.isFilteredOut(recordId: recordId) ? 0.25 : 1)
      .animation(.easeOut(duration: 0.15), value: store.projectFilter)
  }
}

/// Sits at the bottom-trailing corner of a Day-view card (cards at least 40 pt tall).
struct CanvasCardSyncOverlay: View {
  let recordId: Int64?
  let height: CGFloat

  @ObservedObject private var store = CardSyncInfoStore.shared

  var body: some View {
    if height >= 40, let info = store.info(for: recordId), hasMarks(info) {
      // Only the "?" chips (confirm buttons) take clicks; everything else lets them reach the card.
      HStack(spacing: 4) {
        if info.isPrivate {
          CardPrivateMark(remoteDevice: info.remote ? store.deviceLabel(info.deviceId) : nil)
            .allowsHitTesting(false)
        }
        if info.remote {
          CardRemoteBadge(deviceName: store.deviceLabel(info.deviceId))
            .allowsHitTesting(false)
        }
        ForEach(Array(info.projects.prefix(3)), id: \.projectId) { project in
          CardProjectChip(project: project, recordId: info.recordId)
            .allowsHitTesting(!project.confirmed)
        }
      }
      .padding(.trailing, 16)
      .padding(.bottom, 4)
    }
  }

  private func hasMarks(_ info: CardSyncInfo) -> Bool {
    info.isPrivate || info.remote || !info.projects.isEmpty
  }
}

// MARK: - Card detail section

/// Card detail (ActivityCard): project picker, confirming AI guesses, the Private toggle and
/// the "from <device>" note.
struct CardSyncDetailSection: View {
  let recordId: Int64

  @ObservedObject private var store = CardSyncInfoStore.shared
  @ObservedObject private var sync = SyncCenter.shared
  @Environment(\.dayflowTheme) private var theme
  @State private var errorText: String?

  private var info: CardSyncInfo? { store.info(for: recordId) }
  private var assigned: [CardProjectInfo] { info?.projects ?? [] }

  /// Live projects, plus archived ones the card still has (so the picker can show them).
  private var pickerProjects: [ProjectView] {
    let assignedIds = Set(assigned.map { $0.projectId })
    return sync.projects.filter { !$0.archived || assignedIds.contains($0.id) }
  }

  private var showsProjects: Bool { !sync.activeProjects.isEmpty || !assigned.isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let info, info.remote {
        Text("From \(store.deviceLabel(info.deviceId)) — screenshots stay on that computer.")
          .font(.custom("Figtree", size: 11))
          .foregroundColor(theme.textSecondary)
      }
      if showsProjects {
        projectBlock
      }
      // A local flag: available signed out too (the card then never leaves the Mac once signed in).
      if info != nil {
        privateToggle
      }
      if let errorText {
        Text(errorText)
          .font(.custom("Figtree", size: 11))
          .foregroundColor(SettingsStyle.destructive)
          .textSelection(.enabled)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .task(id: recordId) {
      errorText = nil
      store.refresh(recordIds: [recordId])
    }
    .onReceive(sync.$cardsRevision.dropFirst()) { _ in
      store.refresh(recordIds: [recordId])
    }
  }

  private var projectBlock: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("PROJECT")
        .font(.custom("Figtree", size: 12).weight(.semibold))
        .foregroundColor(Color(red: 0.55, green: 0.55, blue: 0.55))

      ForEach(assigned.filter { !$0.confirmed }, id: \.projectId) { guess in
        guessRow(guess)
      }

      if assigned.count > 1 {
        SyncFlowLayout(spacing: 4, lineSpacing: 4) {
          ForEach(assigned, id: \.projectId) { project in
            CardProjectChip(project: project, recordId: recordId, fontSize: 11)
          }
        }
      }

      HStack(spacing: 8) {
        projectPicker
        if let source = sourceLabel {
          Text(source)
            .font(.custom("Figtree", size: 11))
            .foregroundColor(theme.textSecondary)
        }
      }
    }
  }

  private func guessRow(_ guess: CardProjectInfo) -> some View {
    let percent = Int((guess.confidence * 100).rounded())
    return HStack(spacing: 8) {
      SyncColorDot(hex: guess.color, size: 8)
      Text("Looks like \(guess.name) (\(percent)% sure).")
        .font(.custom("Figtree", size: 12))
        .foregroundColor(theme.textPrimary)
      Button(String(localized: "Confirm")) {
        run { try await SyncCenter.shared.confirmCard(recordId: recordId, projectId: guess.projectId) }
      }
      .buttonStyle(.link)
      .font(.custom("Figtree", size: 12).weight(.semibold))
      .pointingHandCursor()
    }
  }

  private var projectPicker: some View {
    Picker(String(localized: "Project"), selection: projectSelection) {
      Text(
        assigned.count > 1
          ? String(localized: "Split between projects — pick one to replace") : String(localized: "No project")
      )
      .tag("")
      ForEach(pickerProjects) { project in
        Text(project.archived ? String(localized: "\(project.name) (archived)") : project.name)
          .tag(project.id)
      }
    }
    .pickerStyle(.menu)
    .labelsHidden()
    .fixedSize()
  }

  private var projectSelection: Binding<String> {
    Binding(
      get: { assigned.count == 1 ? assigned[0].projectId : "" },
      set: { value in
        let current = assigned.count == 1 ? assigned[0].projectId : ""
        guard value != current else { return }
        let target: String? = value.isEmpty ? nil : value
        run { try await SyncCenter.shared.assignCard(recordId: recordId, projectId: target) }
      }
    )
  }

  private var sourceLabel: String? {
    guard !assigned.isEmpty else { return nil }
    if assigned.allSatisfy({ $0.source == .manual }) { return String(localized: "Chosen by you.") }
    if assigned.contains(where: { $0.source == .rule }) { return String(localized: "Matched by project rules.") }
    return String(localized: "Suggested by the AI.")
  }

  private var privateLabel: String {
    if let info, info.remote {
      return String(
        localized: "Private: \(store.deviceLabel(info.deviceId)) stops sharing it; it never reaches the team")
    }
    if !sync.status.signedIn {
      return String(localized: "Private — stays on this Mac; never uploaded if you sign in to Dayflow Sync")
    }
    return String(localized: "Private — never leaves this Mac (not synced to my other devices or the team)")
  }

  private var privateToggle: some View {
    Toggle(isOn: privateBinding) {
      Text(privateLabel)
        .font(.custom("Figtree", size: 12))
        .foregroundColor(theme.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .toggleStyle(.checkbox)
    .pointingHandCursor()
  }

  private var privateBinding: Binding<Bool> {
    Binding(
      get: { info?.isPrivate ?? false },
      set: { on in
        run { try await SyncCenter.shared.setCardPrivate(recordId: recordId, isPrivate: on) }
      }
    )
  }

  private func run(_ work: @escaping @MainActor () async throws -> Void) {
    errorText = nil
    let id = recordId
    Task { @MainActor in
      do {
        try await work()
      } catch {
        errorText = syncErrorMessage(error)
      }
      CardSyncInfoStore.shared.refresh(recordIds: [id])
    }
  }
}

// MARK: - Timeline project filter

/// "All projects / <project> / No project" menu next to the category chips (Day view).
/// Non-matching cards are dimmed, like muted categories.
struct TimelineProjectFilterMenu: View {
  @ObservedObject private var store = CardSyncInfoStore.shared
  @ObservedObject private var sync = SyncCenter.shared

  var body: some View {
    if !sync.projects.isEmpty {
      Picker(String(localized: "Project"), selection: $store.projectFilter) {
        Text("All projects").tag(TimelineProjectFilter.all)
        ForEach(sync.activeProjects) { project in
          Text(project.name).tag(TimelineProjectFilter.project(project.id))
        }
        Text("No project").tag(TimelineProjectFilter.unassigned)
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .fixedSize()
      .help(String(localized: "Filter by project"))
    }
  }
}
