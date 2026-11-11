//
//  TeamProjectsPanel.swift
//  Dayflow — Team → Projects: the workspace projects, "my share level" for every member,
//  and the editor for owners/admins.
//

import SwiftUI

struct TeamProjectsPanel: View {
  @ObservedObject private var sync = SyncCenter.shared
  @State private var editing: ProjectDraft?
  @State private var errorText: String?

  /// Live projects first, archived ones last.
  private var orderedProjects: [ProjectView] {
    sync.projects.filter { !$0.archived } + sync.projects.filter { $0.archived }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let errorText {
        SyncNotice(text: errorText, tone: .error)
      }
      if let draft = editing {
        ProjectEditorView(draft: draft, workspaces: sync.adminWorkspaces) {
          editing = nil
        }
        .id(draft.id ?? "new")
      } else if let first = sync.adminWorkspaces.first {
        SettingsPrimaryButton(title: String(localized: "New project"), systemImage: "plus") {
          editing = ProjectDraft(workspaceId: first.id, name: "", color: "#7BC47F", defaultShare: .cards)
        }
      }
      if sync.projects.isEmpty && editing == nil {
        Text(
          sync.adminWorkspaces.isEmpty
            ? String(localized: "No projects yet. A workspace admin can create them.")
            : String(localized: "No projects yet. Create one to start tracking time per project.")
        )
        .font(.custom("Figtree", size: 13))
        .foregroundColor(SettingsStyle.secondary)
      }
      VStack(alignment: .leading, spacing: 0) {
        ForEach(orderedProjects) { project in
          TeamProjectRow(
            project: project,
            workspaceName: workspaceName(project.workspaceId),
            canEdit: sync.canEditProjects(workspaceId: project.workspaceId),
            onEdit: { editing = draft(from: project) },
            onError: { errorText = $0 }
          )
        }
      }
    }
  }

  private func workspaceName(_ id: String) -> String {
    sync.status.workspaces.first { $0.id == id }?.name ?? ""
  }

  private func draft(from p: ProjectView) -> ProjectDraft {
    ProjectDraft(
      id: p.id, workspaceId: p.workspaceId, name: p.name, color: p.color, icon: p.icon, description: p.description,
      rules: p.rules, defaultShare: p.defaultShare, odoo: p.odoo, archived: p.archived)
  }
}

// MARK: - Row

struct TeamProjectRow: View {
  let project: ProjectView
  let workspaceName: String
  let canEdit: Bool
  let onEdit: () -> Void
  let onError: (String) -> Void

  private var meta: String {
    var parts: [String] = []
    if !workspaceName.isEmpty { parts.append(workspaceName) }
    if let odoo = odooMappingLabel(project.odoo) { parts.append("Odoo: \(odoo)") }
    return parts.joined(separator: " · ")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        titleRow
        if !project.description.isEmpty {
          Text(project.description)
            .font(.custom("Figtree", size: 12))
            .foregroundColor(SettingsStyle.text)
            .fixedSize(horizontal: false, vertical: true)
        }
        rulesSummary
        shareRow
      }
      .padding(.vertical, SettingsStyle.rowVerticalPadding)
      .opacity(project.archived ? 0.6 : 1)
      Rectangle()
        .fill(SettingsStyle.divider)
        .frame(height: 1)
    }
  }

  private var titleRow: some View {
    HStack(alignment: .center, spacing: 10) {
      if project.icon.isEmpty {
        SyncColorDot(hex: project.color, size: 12)
      } else {
        Text(project.icon).font(.system(size: 15))
      }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 8) {
          Text(project.name)
            .font(.custom("Figtree", size: 15))
            .fontWeight(.semibold)
            .foregroundColor(SettingsStyle.text)
          if project.archived {
            SettingsBadge(text: String(localized: "ARCHIVED"))
          }
        }
        if !meta.isEmpty {
          Text(meta)
            .font(.custom("Figtree", size: 12))
            .foregroundColor(SettingsStyle.secondary)
        }
      }
      Spacer(minLength: 12)
      if canEdit {
        SettingsSecondaryButton(title: String(localized: "Edit"), action: onEdit)
      }
    }
  }

  @ViewBuilder
  private var rulesSummary: some View {
    let parts = ruleParts
    if parts.isEmpty {
      Text("No rules — cards are assigned by the AI or by hand.")
        .font(.custom("Figtree", size: 11))
        .foregroundColor(SettingsStyle.meta)
    } else {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(parts, id: \.self) { part in
          Text(part)
            .font(.custom("Figtree", size: 11))
            .foregroundColor(SettingsStyle.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private var ruleParts: [String] {
    let r = project.rules
    let all: [(String, [String]?)] = [
      (String(localized: "Apps"), r.apps),
      (String(localized: "Domains"), r.domains),
      (String(localized: "Title keywords"), r.titleKeywords),
      (String(localized: "Repos"), r.repos),
    ]
    return all.compactMap { label, values in
      guard let values, !values.isEmpty else { return nil }
      return "\(label): \(values.joined(separator: ", "))"
    }
  }

  private var shareRow: some View {
    HStack(spacing: 12) {
      Text("What the team sees of my time on this project")
        .font(.custom("Figtree", size: 12))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
      Spacer(minLength: 8)
      Picker("", selection: myShareBinding) {
        Text("Project default — \(project.defaultShare.label)").tag(ShareLevel?.none)
        ForEach(ShareLevel.allCases, id: \.self) { level in
          Text(level.label).tag(ShareLevel?.some(level))
        }
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .fixedSize()
    }
  }

  private var myShareBinding: Binding<ShareLevel?> {
    let projectId = project.id
    let onError = self.onError
    return Binding(
      get: { project.myShare },
      set: { level in
        Task { @MainActor in
          do {
            try await SyncCenter.shared.setMyShare(projectId: projectId, level: level)
          } catch {
            onError(syncErrorMessage(error))
          }
        }
      }
    )
  }
}
