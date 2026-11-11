//
//  SettingsSyncTabView.swift
//  Dayflow — Dayflow Sync UI
//
//  Settings → Sync & team: server, Google sign-in, account and sync status, devices,
//  workspaces, web dashboard, sign-out, and "What leaves this Mac".
//  Functional reference: windows/src/renderer/src/features/Sync.tsx (SyncSettingsPanel).
//

import SwiftUI

struct SettingsSyncTabView: View {
  @ObservedObject private var sync = SyncCenter.shared

  @State private var serverURL = ""
  @State private var me: MeView?
  /// Why the account / device list could not be loaded (shown with Retry).
  @State private var meError: String?
  @State private var loadingMe = false
  @State private var busy: String?
  @State private var errorText: String?
  @State private var devEmail = ""
  @State private var confirmSignOut = false
  @State private var deviceToRevoke: DeviceInfo?

  private var signedIn: Bool { sync.status.signedIn }

  var body: some View {
    content
      .onAppear(perform: handleAppear)
      .onChange(of: sync.status.signedIn) { handleAccountChange() }
      .onChange(of: sync.status.serverUrl) { _, newValue in serverURL = newValue }
      .alert(String(localized: "Sign out of Dayflow Sync?"), isPresented: $confirmSignOut) {
        Button(String(localized: "Cancel"), role: .cancel) {}
        Button(String(localized: "Sign out"), role: .destructive) { signOut() }
      } message: {
        Text(
          "This Mac stops syncing. Cards from your other devices and your team's projects are removed from this Mac. This Mac's own cards stay, and come back to your other devices when you sign in again."
        )
      }
      .alert(
        String(localized: "Revoke this device?"), isPresented: revokeAlertBinding, presenting: deviceToRevoke
      ) { device in
        Button(String(localized: "Cancel"), role: .cancel) {}
        Button(String(localized: "Revoke"), role: .destructive) { revoke(device) }
      } message: { device in
        Text("Sign out \"\(device.name)\"? It stops syncing until it signs in again.")
      }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: SettingsStyle.sectionSpacing) {
      accountSection
      if signedIn {
        devicesSection
        workspacesSection
      }
      SyncPrivacySection()
    }
  }

  // MARK: - Account

  private var accountSection: some View {
    SettingsSection(
      title: String(localized: "Sync & team"),
      subtitle: String(
        localized:
          "Sync your timeline between your computers and share project time with your team through a Dayflow Sync Server. Screenshots, the accessibility log and chat never leave this Mac; cards marked private or in a never-upload category never leave it either."
      )
    ) {
      VStack(alignment: .leading, spacing: 0) {
        serverRow
        if signedIn {
          signedInRows
        } else {
          signedOutBlock
        }
        if let errorText {
          SyncNotice(text: errorText, tone: .error)
            .padding(.top, 12)
        }
      }
    }
  }

  private var serverRow: some View {
    SettingsRow(
      label: String(localized: "Server"),
      subtitle: signedIn ? String(localized: "Sign out to change the server.") : nil
    ) {
      HStack(spacing: 8) {
        TextField(DEFAULT_SYNC_SERVER_URL, text: $serverURL)
          .textFieldStyle(.roundedBorder)
          .font(.custom("Figtree", size: 12))
          .disableAutocorrection(true)
          .frame(width: 230)
          .disabled(signedIn || busy != nil)
          .onSubmit(saveServerURL)
        if !signedIn && serverURL != sync.status.serverUrl {
          SettingsSecondaryButton(
            title: String(localized: "Save"), isDisabled: busy != nil, action: saveServerURL)
        }
      }
    }
  }

  // MARK: Signed out

  private var signedOutBlock: some View {
    VStack(alignment: .leading, spacing: 12) {
      serverCheck
      HStack(spacing: 10) {
        SettingsPrimaryButton(
          title: sync.signingIn
            ? String(localized: "Waiting for the browser…") : String(localized: "Sign in with Google"),
          systemImage: "person.crop.circle",
          isLoading: sync.signingIn,
          isDisabled: !(sync.authConfig?.googleConfigured ?? false) || busy != nil,
          action: signIn
        )
        if sync.signingIn {
          SettingsSecondaryButton(title: String(localized: "Cancel")) {
            sync.cancelSignIn()
          }
        }
      }
      if sync.authConfig?.devAuth == true {
        devSignInRow
      }
    }
    .padding(.top, 14)
  }

  @ViewBuilder
  private var serverCheck: some View {
    if let auth = sync.authConfig {
      if !auth.reachable {
        let reason = auth.error ?? "no answer"
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          SyncNotice(text: String(localized: "Can't reach the server: \(reason)"), tone: .error)
          SettingsLinkButton(title: String(localized: "Retry"), systemImage: nil, action: checkServer)
        }
      } else if !auth.googleConfigured {
        SyncNotice(
          text: String(
            localized:
              "Google sign-in isn't set up on this server yet (no OAuth client configured). Ask the server admin to set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET."
          ),
          tone: .warn)
      } else {
        SettingsStatusDot(state: .good, label: String(localized: "Server ready"))
      }
    } else {
      SettingsStatusDot(state: .idle, label: String(localized: "Checking the server…"))
    }
  }

  private var devSignInRow: some View {
    HStack(spacing: 8) {
      TextField(String(localized: "email for dev sign-in"), text: $devEmail)
        .textFieldStyle(.roundedBorder)
        .font(.custom("Figtree", size: 12))
        .disableAutocorrection(true)
        .frame(width: 220)
      SettingsSecondaryButton(
        title: String(localized: "Dev sign-in"),
        isDisabled: busy != nil || devEmail.trimmingCharacters(in: .whitespaces).isEmpty
      ) {
        let email = devEmail.trimmingCharacters(in: .whitespaces)
        run("dev") { _ = try await sync.signInDev(email: email) }
      }
      SettingsMetadata(text: String(localized: "Test servers only (DEV_AUTH=1)."))
    }
  }

  // MARK: Signed in

  @ViewBuilder
  private var signedInRows: some View {
    let user = sync.status.user
    let name = user?.name ?? ""
    let email = user?.email ?? ""
    SettingsRow(label: name.isEmpty ? email : name, subtitle: name.isEmpty ? nil : email) {
      HStack(spacing: 8) {
        SettingsSecondaryButton(
          title: String(localized: "Open web dashboard"), systemImage: "arrow.up.right",
          isDisabled: busy != nil
        ) {
          run("dash") { try await sync.openDashboard() }
        }
        SettingsSecondaryButton(title: String(localized: "Sign out"), isDisabled: busy != nil) {
          confirmSignOut = true
        }
      }
    }
    SettingsRow(
      label: String(localized: "Status"), subtitle: statusDetail, showsDivider: sync.status.lastError != nil
    ) {
      HStack(spacing: 12) {
        SettingsStatusDot(state: statusDotState, label: statusDotLabel)
        SettingsSecondaryButton(
          title: String(localized: "Sync now"), systemImage: "arrow.triangle.2.circlepath",
          isDisabled: busy != nil || sync.status.syncing
        ) {
          run("sync") { _ = await sync.syncNow() }
        }
      }
    }
    if let lastError = sync.status.lastError {
      SyncNotice(text: lastError, tone: .error)
        .padding(.top, 12)
    }
  }

  private var statusDetail: String {
    let s = sync.status
    let last = s.syncing ? String(localized: "Syncing…") : String(localized: "Last sync \(syncAgo(ms: s.lastSyncAt))")
    let pending =
      s.pending == 1
      ? String(localized: "1 pending change") : String(localized: "\(s.pending) pending changes")
    let mode = s.streamConnected ? String(localized: "live") : String(localized: "polling")
    return "\(last) · \(pending) · \(mode)"
  }

  private var statusDotState: SettingsStatusDot.State {
    let s = sync.status
    if s.lastError != nil { return .bad }
    if s.syncing || s.pending > 0 { return .warn }
    return .good
  }

  private var statusDotLabel: String {
    let s = sync.status
    if s.lastError != nil { return String(localized: "Error") }
    if s.syncing { return String(localized: "Syncing") }
    if s.pending > 0 { return String(localized: "Pending") }
    return String(localized: "Up to date")
  }

  // MARK: - Devices

  private var devicesSection: some View {
    SettingsSection(
      title: String(localized: "Devices"),
      subtitle: String(localized: "Revoke a lost or old computer: it stops syncing right away.")
    ) {
      VStack(alignment: .leading, spacing: 0) {
        if let devices = me?.devices, !devices.isEmpty {
          ForEach(Array(devices.enumerated()), id: \.element.id) { index, device in
            deviceRow(device, isLast: index == devices.count - 1)
          }
        } else if let meError {
          HStack(spacing: 10) {
            SyncNotice(text: String(localized: "Could not load your devices: \(meError)"), tone: .error)
            SettingsSecondaryButton(
              title: loadingMe ? String(localized: "Retrying…") : String(localized: "Retry"), isDisabled: loadingMe,
              action: loadMe)
          }
        } else {
          SettingsMetadata(text: String(localized: "Loading devices…"))
        }
      }
    }
  }

  private func deviceRow(_ device: DeviceInfo, isLast: Bool) -> some View {
    SettingsRow(label: device.name, subtitle: deviceSubtitle(device), showsDivider: !isLast) {
      HStack(spacing: 10) {
        if device.current == true {
          SettingsBadge(text: String(localized: "THIS MAC"), isAccent: true)
        }
        if device.revoked {
          SettingsBadge(text: String(localized: "SIGNED OUT"))
        } else {
          SettingsSecondaryButton(
            title: device.current == true ? String(localized: "Sign out") : String(localized: "Revoke"),
            isDisabled: busy != nil
          ) {
            if device.current == true {
              confirmSignOut = true
            } else {
              deviceToRevoke = device
            }
          }
        }
      }
    }
  }

  private func deviceSubtitle(_ device: DeviceInfo) -> String {
    if device.revoked { return device.platform }
    guard let seen = device.lastSeenAt else { return device.platform }
    return "\(device.platform) · \(String(localized: "seen \(syncAgo(ms: seen))"))"
  }

  private var revokeAlertBinding: Binding<Bool> {
    Binding(
      get: { deviceToRevoke != nil },
      set: { if !$0 { deviceToRevoke = nil } }
    )
  }

  // MARK: - Workspaces

  @ViewBuilder
  private var workspacesSection: some View {
    let workspaces = me?.workspaces ?? sync.status.workspaces
    if !workspaces.isEmpty {
      SettingsSection(
        title: String(localized: "Workspaces"),
        subtitle: String(localized: "Projects and team views come from these workspaces. Admins invite people from the web dashboard.")
      ) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(workspaces.enumerated()), id: \.element.id) { index, workspace in
            SettingsRow(label: workspace.name, showsDivider: index < workspaces.count - 1) {
              SettingsBadge(text: workspace.role.label.uppercased())
            }
          }
        }
      }
    }
  }

  // MARK: - Actions

  private func handleAppear() {
    serverURL = sync.status.serverUrl
    handleAccountChange()
  }

  private func handleAccountChange() {
    if signedIn {
      loadMe()
    } else {
      me = nil
      meError = nil
      checkServer()
    }
  }

  private func loadMe() {
    loadingMe = true
    Task { @MainActor in
      defer { loadingMe = false }
      do {
        let view = try await sync.me()
        me = view
        meError = nil
        CardSyncInfoStore.shared.setDevices(view.devices)
      } catch {
        meError = syncErrorMessage(error)
      }
    }
  }

  private func checkServer() {
    Task { @MainActor in
      await sync.refreshAuthConfig()
    }
  }

  private func saveServerURL() {
    guard !signedIn, serverURL != sync.status.serverUrl else { return }
    let url = serverURL
    run("url") {
      try await sync.setServerURL(url)
      await sync.refreshAuthConfig()
    }
  }

  private func signIn() {
    run("google") { _ = try await sync.signIn() }
  }

  private func signOut() {
    run("out") {
      _ = await sync.signOut()
      CardSyncInfoStore.shared.projectFilter = .all
    }
  }

  private func revoke(_ device: DeviceInfo) {
    deviceToRevoke = nil
    run("revoke") {
      let view = try await sync.revokeDevice(device.id)
      me = view
      CardSyncInfoStore.shared.setDevices(view.devices)
    }
  }

  /// Runs one action at a time; errors show under the account block (a cancelled sign-in is silent).
  private func run(_ label: String, _ work: @escaping @MainActor () async throws -> Void) {
    busy = label
    errorText = nil
    Task { @MainActor in
      do {
        try await work()
      } catch is CancellationError {
        // Sign-in cancelled.
      } catch {
        errorText = syncErrorMessage(error)
      }
      busy = nil
      await sync.refreshStatus()
    }
  }
}
