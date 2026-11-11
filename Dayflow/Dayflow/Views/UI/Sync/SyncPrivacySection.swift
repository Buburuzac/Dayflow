//
//  SyncPrivacySection.swift
//  Dayflow — Dayflow Sync UI
//
//  Settings → Sync & team → "What leaves this Mac". The filtering itself happens on this Mac
//  before anything is uploaded (Core/Sync/SyncScope.swift). Reference: `SyncPrivacy` in
//  windows/src/renderer/src/Settings.tsx.
//

import SwiftUI

struct SyncPrivacySection: View {
  @ObservedObject private var sync = SyncCenter.shared
  @ObservedObject private var categoryStore = CategoryStore.shared

  private let columns = [GridItem(.adaptive(minimum: 150, maximum: 260), spacing: 10, alignment: .leading)]

  /// User categories (Idle and the system category are never offered).
  private var categories: [TimelineCategory] {
    categoryStore.editableCategories.filter { !$0.isIdle }
  }

  var body: some View {
    SettingsSection(
      title: String(localized: "What leaves this Mac"),
      subtitle: String(
        localized:
          "Checked before anything is uploaded. Screenshots, timelapses, the accessibility log and chat never leave this Mac."
      )
    ) {
      VStack(alignment: .leading, spacing: 0) {
        categoriesBlock
        SettingsRow(
          label: String(localized: "Upload work without a confirmed project as \"Out of scope\" (time only)"),
          subtitle: String(
            localized:
              "Only cards confirmed for a project upload with their title and details. Everything else shows on your other devices and the server as an \"Out of scope\" block, without what it was. Workspace admins see your timeline: project work at the level you share, everything else as time only. Your Account page in the web dashboard lists who opened it."
          )
        ) {
          SettingsToggle(isOn: outOfScopeBinding)
        }
        SettingsRow(
          label: String(localized: "Upload observations (the AI's raw screen descriptions)"),
          subtitle: String(
            localized: "Off by default. Turning it off removes the ones already uploaded from the server."),
          showsDivider: false
        ) {
          SettingsToggle(isOn: observationsBinding)
        }
      }
    }
  }

  private var categoriesBlock: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 10) {
        Text("Never upload cards in these categories")
          .font(.custom("Figtree", size: 14))
          .fontWeight(.semibold)
          .foregroundColor(SettingsStyle.text)
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
          ForEach(categories) { category in
            categoryCheckbox(category)
          }
        }
        Text("Cards marked private are never uploaded either. Copies already on the server are wiped.")
          .font(.custom("Figtree", size: 12))
          .foregroundColor(SettingsStyle.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.vertical, SettingsStyle.rowVerticalPadding)
      Rectangle()
        .fill(SettingsStyle.divider)
        .frame(height: 1)
    }
  }

  private func categoryCheckbox(_ category: TimelineCategory) -> some View {
    Toggle(isOn: categoryBinding(category)) {
      HStack(spacing: 6) {
        Circle()
          .fill(Color(hex: category.colorHex))
          .frame(width: 8, height: 8)
        Text(category.name)
          .font(.custom("Figtree", size: 13))
          .foregroundColor(SettingsStyle.text)
          .lineLimit(1)
      }
    }
    .toggleStyle(.checkbox)
    .pointingHandCursor()
  }

  private func categoryBinding(_ category: TimelineCategory) -> Binding<Bool> {
    let name = category.name
    return Binding(
      get: { isCategoryExcluded(name, in: sync.policy.excludedCategories) },
      set: { on in
        let next = toggledExclusions(
          sync.policy.excludedCategories, categoryNames: categories.map { $0.name }, name: name, on: on,
          aliases: sync.policy.categoryAliases)
        Task { await sync.setExcludedCategories(next) }
      }
    )
  }

  private var outOfScopeBinding: Binding<Bool> {
    Binding(
      get: { sync.policy.outOfScope },
      set: { on in Task { await sync.setOutOfScope(on) } }
    )
  }

  private var observationsBinding: Binding<Bool> {
    Binding(
      get: { sync.policy.observations },
      set: { on in Task { await sync.setObservationsUpload(on) } }
    )
  }
}
