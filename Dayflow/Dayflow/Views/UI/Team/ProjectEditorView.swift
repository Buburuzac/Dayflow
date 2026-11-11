//
//  ProjectEditorView.swift
//  Dayflow — Team → Projects: create/edit a project (owners and admins).
//  Name, color, description, rules (apps / domains / title keywords / repos), default share
//  level, Odoo mapping and archive. Reference: `ProjectEditor` in features/Team.tsx.
//

import SwiftUI

struct ProjectEditorView: View {
  let workspaces: [WorkspaceInfo]
  let onClose: () -> Void

  @State private var draft: ProjectDraft
  @State private var apps: [String]
  @State private var domains: [String]
  @State private var keywords: [String]
  @State private var repos: [String]
  @State private var appsDraft = ""
  @State private var domainsDraft = ""
  @State private var keywordsDraft = ""
  @State private var reposDraft = ""
  @State private var odooProjectId: String
  @State private var odooProjectName: String
  @State private var odooTaskId: String
  @State private var odooTaskName: String
  @State private var saving = false
  @State private var errorText: String?

  init(draft: ProjectDraft, workspaces: [WorkspaceInfo], onClose: @escaping () -> Void) {
    self.workspaces = workspaces
    self.onClose = onClose
    _draft = State(initialValue: draft)
    _apps = State(initialValue: draft.rules.apps ?? [])
    _domains = State(initialValue: draft.rules.domains ?? [])
    _keywords = State(initialValue: draft.rules.titleKeywords ?? [])
    _repos = State(initialValue: draft.rules.repos ?? [])
    _odooProjectId = State(initialValue: draft.odoo.projectId.map { String($0) } ?? "")
    _odooProjectName = State(initialValue: draft.odoo.projectName ?? "")
    _odooTaskId = State(initialValue: draft.odoo.taskId.map { String($0) } ?? "")
    _odooTaskName = State(initialValue: draft.odoo.taskName ?? "")
  }

  private var isNew: Bool { draft.id == nil }
  private var trimmedName: String { draft.name.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(isNew ? String(localized: "New project") : String(localized: "Edit project"))
        .font(.custom("Figtree", size: 17))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
      nameRow
      if isNew && workspaces.count > 1 {
        workspacePicker
      }
      descriptionField
      rulesBlock
      shareField
      odooBlock
      if !isNew {
        Toggle(isOn: archivedBinding) {
          Text("Archived (no new assignments)")
            .font(.custom("Figtree", size: 13))
            .foregroundColor(SettingsStyle.text)
        }
        .toggleStyle(.checkbox)
      }
      if let errorText {
        SyncNotice(text: errorText, tone: .error)
      }
      HStack(spacing: 10) {
        SettingsPrimaryButton(
          title: String(localized: "Save project"), isLoading: saving, isDisabled: trimmedName.isEmpty,
          action: save)
        SettingsSecondaryButton(title: String(localized: "Cancel"), isDisabled: saving, action: onClose)
      }
    }
    .padding(18)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(SettingsStyle.editorFill)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(SettingsStyle.editorBorder, lineWidth: 1)
    )
  }

  // MARK: Fields

  private var nameRow: some View {
    HStack(spacing: 10) {
      ColorPicker("", selection: colorBinding, supportsOpacity: false)
        .labelsHidden()
        .help(String(localized: "Project color"))
      TextField("Icon", text: $draft.icon)
        .textFieldStyle(.roundedBorder)
        .frame(width: 54)
        .help(String(localized: "Optional project emoji"))
      TextField(String(localized: "Project name"), text: $draft.name)
        .textFieldStyle(.roundedBorder)
        .font(.custom("Figtree", size: 13))
    }
  }

  private var workspacePicker: some View {
    SyncField(label: String(localized: "Workspace")) {
      Picker("", selection: $draft.workspaceId) {
        ForEach(workspaces) { w in
          Text(w.name).tag(w.id)
        }
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .fixedSize()
    }
  }

  private var descriptionField: some View {
    SyncField(label: String(localized: "Description")) {
      TextField(
        String(localized: "What belongs to this project? (helps the AI assign cards)"),
        text: $draft.description, axis: .vertical
      )
      .lineLimit(2...4)
      .textFieldStyle(.roundedBorder)
      .font(.custom("Figtree", size: 12))
    }
  }

  private var rulesBlock: some View {
    VStack(alignment: .leading, spacing: 12) {
      SyncCapsLabel(text: String(localized: "Rules — a card matching any of these is assigned automatically"))
      SyncField(label: String(localized: "Apps")) {
        TokenListField(placeholder: "Code, Xcode, Microsoft Excel", tokens: $apps, draft: $appsDraft)
      }
      SyncField(label: String(localized: "Domains")) {
        TokenListField(placeholder: "erp.velesagro.pl, github.com/acme", tokens: $domains, draft: $domainsDraft)
      }
      SyncField(label: String(localized: "Title keywords")) {
        TokenListField(placeholder: "Dayflow, invoice", tokens: $keywords, draft: $keywordsDraft)
      }
      SyncField(
        label: String(localized: "Repositories"),
        hint: String(
          localized:
            "Press Return or type a comma to add. Matched against window titles, the card's apps and sites, title and summary."
        )
      ) {
        TokenListField(placeholder: "acme/dayflow", tokens: $repos, draft: $reposDraft)
      }
    }
  }

  private var shareField: some View {
    SyncField(
      label: String(localized: "Default share level for members"),
      hint: String(localized: "Each member can override this for themselves.")
    ) {
      Picker("", selection: $draft.defaultShare) {
        ForEach(ShareLevel.allCases, id: \.self) { level in
          Text(level.label).tag(level)
        }
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .fixedSize()
    }
  }

  private var odooBlock: some View {
    VStack(alignment: .leading, spacing: 10) {
      SyncCapsLabel(text: String(localized: "Odoo timesheets"))
      HStack(alignment: .top, spacing: 12) {
        SyncField(label: String(localized: "Project id")) {
          numericField($odooProjectId)
        }
        .frame(width: 110)
        SyncField(label: String(localized: "Project name")) {
          plainField($odooProjectName)
        }
      }
      HStack(alignment: .top, spacing: 12) {
        SyncField(label: String(localized: "Task id")) {
          numericField($odooTaskId)
        }
        .frame(width: 110)
        SyncField(label: String(localized: "Task name")) {
          plainField($odooTaskName)
        }
      }
    }
  }

  private func numericField(_ text: Binding<String>) -> some View {
    TextField("", text: text)
      .textFieldStyle(.roundedBorder)
      .font(.custom("Figtree", size: 12))
      .onChange(of: text.wrappedValue) { _, value in
        let digits = value.filter { $0.isASCII && $0.isNumber }
        if digits != value { text.wrappedValue = digits }
      }
  }

  private func plainField(_ text: Binding<String>) -> some View {
    TextField("", text: text)
      .textFieldStyle(.roundedBorder)
      .font(.custom("Figtree", size: 12))
  }

  // MARK: Bindings

  private var colorBinding: Binding<Color> {
    Binding(
      get: { syncProjectColor(draft.color) },
      set: { color in
        if let hex = syncHexString(from: color) { draft.color = hex }
      }
    )
  }

  private var archivedBinding: Binding<Bool> {
    Binding(
      get: { draft.archived ?? false },
      set: { draft.archived = $0 }
    )
  }

  // MARK: Save

  private func save() {
    var d = draft
    d.name = trimmedName
    d.description = d.description.trimmingCharacters(in: .whitespacesAndNewlines)
    d.rules = ProjectRules(
      apps: addTokens(apps, from: appsDraft),
      domains: addTokens(domains, from: domainsDraft),
      titleKeywords: addTokens(keywords, from: keywordsDraft),
      repos: addTokens(repos, from: reposDraft))
    d.odoo = OdooMapping(
      projectId: parseOdooId(odooProjectId), taskId: parseOdooId(odooTaskId),
      projectName: optionalText(odooProjectName), taskName: optionalText(odooTaskName))
    guard !d.name.isEmpty else { return }
    saving = true
    errorText = nil
    Task { @MainActor in
      do {
        _ = try await SyncCenter.shared.saveProject(d)
        saving = false
        onClose()
      } catch {
        saving = false
        errorText = syncErrorMessage(error)
      }
    }
  }
}
