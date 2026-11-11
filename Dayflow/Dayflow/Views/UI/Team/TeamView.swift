//
//  TeamView.swift
//  Dayflow — Dayflow Sync: Team tab (main sidebar)
//
//  Projects (list, editor for admins, my share level), Activity (project feed and totals) and
//  Timesheets (Odoo proposals → confirmed submit). Reference: windows/src/renderer/src/features/Team.tsx.
//

import SwiftUI

struct TeamView: View {
  enum Tab: String, CaseIterable, Identifiable {
    case projects
    case activity
    case timesheets

    var id: String { rawValue }

    var title: String {
      switch self {
      case .projects: return String(localized: "Projects")
      case .activity: return String(localized: "Activity")
      case .timesheets: return String(localized: "Timesheets")
      }
    }
  }

  @ObservedObject private var sync = SyncCenter.shared
  @State private var tab: Tab = .projects

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      header
      if sync.status.signedIn {
        ScrollView(.vertical, showsIndicators: false) {
          panel
            .frame(maxWidth: 780, alignment: .topLeading)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
      } else {
        notConnected
      }
    }
    .padding(.top, 24)
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .onAppear {
      Task { await sync.reloadProjects() }
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 16) {
      Text("Team")
        .font(.custom("InstrumentSerif-Regular", size: 30))
        .foregroundColor(SettingsStyle.text)
      Spacer(minLength: 12)
      if sync.status.signedIn {
        Picker("", selection: $tab) {
          ForEach(Tab.allCases) { t in
            Text(t.title).tag(t)
          }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 320)
      }
    }
  }

  @ViewBuilder
  private var panel: some View {
    switch tab {
    case .projects:
      TeamProjectsPanel()
    case .activity:
      TeamActivityPanel()
    case .timesheets:
      TeamTimesheetsPanel()
    }
  }

  private var notConnected: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Not connected to a team")
        .font(.custom("Figtree", size: 17))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
      Text(
        "Sign in under Settings → Sync & team to see your workspace's projects, the team's activity and timesheets."
      )
      .font(.custom("Figtree", size: 13))
      .foregroundColor(SettingsStyle.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: 520, alignment: .leading)
    .padding(.top, 24)
  }
}
