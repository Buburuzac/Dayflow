//
//  SyncUIStore.swift
//  Dayflow — Dayflow Sync UI
//
//  Shared UI state for sync: per-card sync facts for the timeline (project chips, private mark,
//  "from <device>" badge), the timeline project filter, device names, and small SwiftUI helpers.
//

import AppKit
import Combine
import Foundation
import SwiftUI

// MARK: - Labels and colors

extension ShareLevel {
  /// Same wording as Windows `SHARE_LABELS`.
  var label: String {
    switch self {
    case .time: return String(localized: "Time only")
    case .cards: return String(localized: "Time + titles & summaries")
    case .detailed: return String(localized: "Everything (detailed summaries, distractions)")
    }
  }
}

extension WorkspaceRole {
  var label: String {
    switch self {
    case .owner: return String(localized: "owner")
    case .admin: return String(localized: "admin")
    case .member: return String(localized: "member")
    case .viewer: return String(localized: "viewer")
    }
  }
}

/// A project's "#RRGGBB" as a SwiftUI color (neutral grey when the text is not a color).
func syncProjectColor(_ hex: String) -> Color {
  let ns = NSColor(hex: hex) ?? NSColor(hex: OUT_OF_SCOPE_COLOR_HEX) ?? NSColor.gray
  return Color(nsColor: ns)
}

/// "#RRGGBB" of a SwiftUI color (for the project color picker).
func syncHexString(from color: Color) -> String? {
  guard let c = NSColor(color).usingColorSpace(.sRGB) else { return nil }
  let r = Int((min(1, max(0, c.redComponent)) * 255).rounded())
  let g = Int((min(1, max(0, c.greenComponent)) * 255).rounded())
  let b = Int((min(1, max(0, c.blueComponent)) * 255).rounded())
  return String(format: "#%02X%02X%02X", r, g, b)
}

// MARK: - SyncCenter helpers for the UI

extension SyncCenter {
  /// Projects that can take new assignments.
  var activeProjects: [ProjectView] { projects.filter { !$0.archived } }

  /// Workspaces where the signed-in user may create and edit projects.
  var adminWorkspaces: [WorkspaceInfo] {
    status.workspaces.filter { $0.role == .owner || $0.role == .admin }
  }
}

// MARK: - Per-card sync facts for the timeline

@MainActor
final class CardSyncInfoStore: ObservableObject {
  static let shared = CardSyncInfoStore()

  /// timeline_cards.id → sync facts, for the cards the timeline loaded.
  @Published private(set) var info: [Int64: CardSyncInfo] = [:]
  /// Ids whose facts were looked up at least once (found or not): the card detail waits for this
  /// before it lays out the screenshot block, so the layout does not jump.
  @Published private(set) var loaded: Set<Int64> = []
  /// device id → name ("Max's MacBook Pro"), from `SyncCenter.me()`.
  @Published private(set) var deviceNames: [String: String] = [:]
  /// Timeline project filter (Day view): non-matching cards are dimmed.
  @Published var projectFilter: TimelineProjectFilter = .all

  private var lastDeviceFetch: Date?

  init() {}

  /// Re-reads the facts for these cards (fire and forget). Ids without facts are dropped.
  func refresh(recordIds: [Int64]) {
    let ids = Array(Set(recordIds))
    guard !ids.isEmpty else { return }
    Task { @MainActor in
      let fresh = await SyncCenter.shared.cardSyncInfo(recordIds: ids)
      var next = self.info
      for id in ids { next[id] = fresh[id] }
      if next != self.info { self.info = next }
      let nowLoaded = self.loaded.union(ids)
      if nowLoaded != self.loaded { self.loaded = nowLoaded }
      self.fetchDeviceNamesIfNeeded(fresh)
    }
  }

  func info(for recordId: Int64?) -> CardSyncInfo? {
    guard let recordId else { return nil }
    return info[recordId]
  }

  /// True once the facts of this card were looked up (always true without an id or a sync engine).
  func isLoaded(_ recordId: Int64?) -> Bool {
    guard let recordId, SyncCenter.shared.isStarted else { return true }
    return loaded.contains(recordId)
  }

  /// Name of the device a card came from, or "another device".
  func deviceLabel(_ deviceId: String?) -> String {
    if let deviceId, let name = deviceNames[deviceId], !name.isEmpty { return name }
    return String(localized: "another device")
  }

  /// Settings → Sync & team passes the device list it loaded.
  func setDevices(_ devices: [DeviceInfo]) {
    var next = deviceNames
    for d in devices where !d.name.isEmpty { next[d.id] = d.name }
    if next != deviceNames { deviceNames = next }
  }

  /// True when the project filter hides (dims) this card.
  func isFilteredOut(recordId: Int64?) -> Bool {
    let projects = SyncCenter.shared.projects
    switch projectFilter {
    case .all:
      return false
    case .unassigned:
      if projects.isEmpty { return false }
    case .project(let id):
      // The project went away (sign-out, another workspace): show everything.
      if !projects.contains(where: { $0.id == id }) { return false }
    }
    let ids = info(for: recordId)?.projects.map { $0.projectId } ?? []
    return !projectFilterMatches(projectFilter, projectIds: ids)
  }

  private func fetchDeviceNamesIfNeeded(_ infos: [Int64: CardSyncInfo]) {
    let center = SyncCenter.shared
    guard center.status.signedIn else { return }
    let unknown = infos.values.contains { i in
      guard i.remote, let d = i.deviceId else { return false }
      return self.deviceNames[d] == nil
    }
    guard unknown else { return }
    if let last = lastDeviceFetch, Date().timeIntervalSince(last) < 60 { return }
    lastDeviceFetch = Date()
    Task { @MainActor in
      guard let me = try? await center.me() else { return }
      self.setDevices(me.devices)
    }
  }
}
