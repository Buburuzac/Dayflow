//
//  SyncCenter.swift
//  Dayflow — Dayflow Sync client
//
//  The public API of Dayflow Sync for the app's UI. Mirrors the sync:* / projects:* IPC surface of
//  the Windows app (windows/src/main/features/sync.ts) on top of `SyncEngine`.
//
//  Usage from SwiftUI:
//
//      @ObservedObject private var sync = SyncCenter.shared
//      Text(sync.status.signedIn ? sync.status.user?.email ?? "" : "Not signed in")
//      Button("Sign in with Google") { Task { try? await sync.signIn() } }
//
//  Lifecycle: `SyncCenter.shared.start(platform:)` once at launch (AppDelegate does it through
//  `SyncCenter.startForApp()`), `stop()` on quit. Everything else is safe to call any time:
//  when signed out, account/team calls throw `SyncError("Not signed in")`/`HttpError(401)`.
//
//  Threading: SyncCenter is main-actor bound; the work runs on the `SyncEngine` actor.
//  Card ids in this API are `timeline_cards.id` (TimelineCard.recordId on the Mac).
//

import Foundation
import GRDB

#if canImport(Combine)
  import Combine
#endif

/// Platform services SyncCenter needs. The Mac implementation is `MacSyncPlatform`
/// (SyncPlatformMac.swift); tests provide their own.
protocol SyncPlatform: Sendable {
  /// Shown in the device list ("Max's MacBook Pro").
  var deviceName: String { get }
  /// Reported to the server ("macos").
  var platformName: String { get }
  /// The app's GRDB writer (StorageManager's DatabasePool). Called on every access, so a
  /// recovered/reopened pool is picked up.
  func database() -> DatabaseWriter
  var tokenStore: SyncTokenStore { get }
  /// Where the "What leaves this Mac" settings live.
  var defaults: UserDefaults { get }
  /// Opens a URL in the system browser.
  func openURL(_ url: URL) async throws
  /// A fresh loopback listener for one Google sign-in.
  func makeLoopbackListener() -> LoopbackHTTPListener
  var categories: CategoryDocBridge? { get }
  var windowLabels: WindowLabelSource? { get }
  var transport: SyncHTTPTransport { get }
  /// The shared local-sync state the StorageManager hooks use (`SyncLocal.shared` in the app).
  var local: SyncLocal { get }
  /// Background timers, debounce and SSE (false in unit tests).
  var background: Bool { get }
}

/// UserDefaults keys of the sync policy (same names as the Windows settings).
enum SyncPolicyKeys {
  static let excludedCategories = "syncExcludedCategories"
  static let outOfScope = "syncOutOfScope"
  static let observations = "syncObservations"
  /// Mac only: earlier names of renamed categories (`SyncPolicy.categoryAliases`).
  static let categoryAliases = "syncCategoryAliases"

  static func load(_ d: UserDefaults) -> SyncPolicy {
    SyncPolicy(
      excludedCategories: d.stringArray(forKey: excludedCategories) ?? SyncPolicy.default.excludedCategories,
      outOfScope: d.object(forKey: outOfScope) as? Bool ?? SyncPolicy.default.outOfScope,
      observations: d.object(forKey: observations) as? Bool ?? SyncPolicy.default.observations,
      categoryAliases: d.dictionary(forKey: categoryAliases) as? [String: [String]] ?? [:])
  }

  static func save(_ p: SyncPolicy, _ d: UserDefaults) {
    d.set(p.excludedCategories, forKey: excludedCategories)
    d.set(p.outOfScope, forKey: outOfScope)
    d.set(p.observations, forKey: observations)
    d.set(p.categoryAliases, forKey: categoryAliases)
  }
}

/// Dayflow Sync for the UI: account, background sync status, projects, card assignment,
/// team views and Odoo timesheets.
@MainActor
final class SyncCenter: ObservableObject {
  static let shared = SyncCenter()

  // MARK: Published state

  /// Mirrors Windows `SyncStatus` (sync-ui.ts). Updated on every engine event (coalesced, ~250 ms).
  @Published private(set) var status: SyncStatus = .empty
  /// The workspace projects this device knows (archived included), refreshed on project changes.
  @Published private(set) var projects: [ProjectView] = []
  /// Result of the last `refreshAuthConfig()` (server reachable, Google configured, dev auth).
  @Published private(set) var authConfig: AuthConfigStatus?
  /// True while a Google sign-in waits for the browser.
  @Published private(set) var signingIn = false
  /// Incremented whenever cards (or their project chips) changed through sync: reload the timeline.
  @Published private(set) var cardsRevision = 0
  /// Incremented when pulled standups / day goals / categories were written locally.
  @Published private(set) var docsRevision = 0
  /// "What leaves this Mac" — persisted in UserDefaults (`syncExcludedCategories`,
  /// `syncOutOfScope`, `syncObservations`). Defaults: ["Personal"], true, false.
  @Published private(set) var policy: SyncPolicy = .default

  private var engine: SyncEngine?
  private var platform: SyncPlatform?
  private var statusRefreshPending = false
  private var signInTask: Task<SyncStatus, Error>?

  init() {}

  /// True once `start(platform:)` ran.
  var isStarted: Bool { engine != nil }

  // MARK: Lifecycle

  /// Wires the engine to the app (idempotent). Resumes a previous session in the background.
  func start(platform: SyncPlatform) {
    guard engine == nil else { return }
    self.platform = platform
    let p = SyncPolicyKeys.load(platform.defaults)
    policy = p
    platform.local.policy = p
    var events = SyncEngineEvents()
    events.onStatus = { [weak self] in Task { @MainActor in self?.scheduleStatusRefresh() } }
    events.onCardsChanged = { [weak self] in Task { @MainActor in self?.cardsRevision += 1 } }
    events.onProjectsChanged = { [weak self] in Task { @MainActor in await self?.reloadProjects() } }
    events.onDocsChanged = { [weak self] _ in Task { @MainActor in self?.docsRevision += 1 } }
    events.onPolicyChanged = { [weak self] p in Task { @MainActor in self?.policyChangedBySync(p) } }
    let e = SyncEngine(
      local: platform.local, database: { platform.database() },
      docs: MacSyncDocSources(categories: platform.categories), labels: platform.windowLabels,
      token: platform.tokenStore, transport: platform.transport,
      config: SyncEngineConfig(
        deviceName: platform.deviceName, platform: platform.platformName, background: platform.background),
      openBrowser: { url in try await platform.openURL(url) },
      makeListener: { platform.makeLoopbackListener() }, events: events)
    engine = e
    Task {
      await refreshStatus()
      await reloadProjects()
      if await e.signedIn() {
        await e.start()
        // Let the app finish launching before the first cycle.
        if platform.background { try? await Task.sleep(nanoseconds: 8_000_000_000) }
        await e.run()
      }
    }
  }

  /// Stops timers and the stream (on quit). Local data and the session stay.
  func stop() {
    guard let engine else { return }
    Task { await engine.stop() }
  }

  /// The engine (tests and advanced callers). nil before `start`.
  var syncEngine: SyncEngine? { engine }

  private func requireEngine() throws -> SyncEngine {
    guard let engine else { throw SyncError("Sync is not started.") }
    return engine
  }

  // MARK: Status

  /// Re-reads `status` now.
  func refreshStatus() async {
    guard let engine else { return }
    status = await engine.status()
  }

  private func scheduleStatusRefresh() {
    guard !statusRefreshPending else { return }
    statusRefreshPending = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 250_000_000)
      statusRefreshPending = false
      await refreshStatus()
    }
  }

  /// Asks the server whether Google / dev sign-in are available (Settings → Sync & team).
  @discardableResult
  func refreshAuthConfig() async -> AuthConfigStatus {
    guard let engine else {
      let s = AuthConfigStatus(reachable: false, googleConfigured: false, devAuth: false, error: "Sync is not started.")
      authConfig = s
      return s
    }
    let s = await engine.authConfig()
    authConfig = s
    return s
  }

  // MARK: Server URL

  /// Default: http://192.168.0.90:8790. Only while signed out (throws otherwise).
  func setServerURL(_ url: String) async throws {
    status = try await requireEngine().setServerUrl(url)
    authConfig = nil
  }

  // MARK: Account

  /// Google sign-in: opens the system browser (loopback + PKCE) and waits up to 5 minutes.
  /// After the first sign-in this device's last 30 days are uploaded.
  @discardableResult
  func signIn() async throws -> SyncStatus {
    let e = try requireEngine()
    signInTask?.cancel()
    let t = Task { try await e.signInGoogle() }
    signInTask = t
    signingIn = true
    defer {
      signingIn = false
      signInTask = nil
    }
    status = try await t.value
    await reloadProjects()
    return status
  }

  /// Aborts a Google sign-in waiting for the browser.
  func cancelSignIn() {
    signInTask?.cancel()
  }

  /// Dev sign-in (only when the server runs with DEV_AUTH=1; see `authConfig.devAuth`).
  @discardableResult
  func signInDev(email: String) async throws -> SyncStatus {
    status = try await requireEngine().signInDev(email: email)
    await reloadProjects()
    return status
  }

  /// Revokes this device on the server and removes other devices' cards and the team's projects
  /// from this Mac; this Mac's own cards stay. Ask the user to confirm first.
  @discardableResult
  func signOut() async -> SyncStatus {
    guard let engine else { return status }
    status = await engine.signOut()
    await reloadProjects()
    return status
  }

  /// One pull → rescope → push cycle now.
  @discardableResult
  func syncNow() async -> SyncStatus {
    guard let engine else { return status }
    status = await engine.syncNow()
    return status
  }

  /// The signed-in user, their devices (`current` marks this Mac) and workspaces with roles.
  func me() async throws -> MeView {
    let v = try await requireEngine().me()
    await refreshStatus()
    return v
  }

  /// Revokes another device. Revoking this Mac signs it out (and throws "This device was signed out.").
  func revokeDevice(_ id: String) async throws -> MeView {
    defer { Task { await refreshStatus() } }
    return try await requireEngine().revokeDevice(id)
  }

  /// Opens the web dashboard. A signed-in client uses a one-time link; otherwise the web login opens.
  func openDashboard() async throws {
    let url: URL
    if status.signedIn {
      url = try await requireEngine().webLink()
    } else {
      guard let server = URL(string: status.serverUrl), ["http", "https"].contains(server.scheme ?? "")
      else { throw SyncError("Set a sync server URL in Settings first.") }
      url = server
    }
    try await platform?.openURL(url)
  }

  /// The one-time dashboard link without opening it.
  func dashboardLink() async throws -> URL {
    try await requireEngine().webLink()
  }

  // MARK: Projects

  /// Reloads `projects` from the local tables.
  @discardableResult
  func reloadProjects() async -> [ProjectView] {
    guard let engine else { return [] }
    projects = await engine.listProjects()
    return projects
  }

  /// Creates (draft.id == nil) or edits a project. Owners/admins of the workspace only.
  @discardableResult
  func saveProject(_ draft: ProjectDraft) async throws -> ProjectView {
    let v = try await requireEngine().saveProject(draft)
    await reloadProjects()
    return v
  }

  /// The signed-in user's share level in a project (nil = the project's default).
  func setMyShare(projectId: String, level: ShareLevel?) async throws {
    try await requireEngine().setMyShare(projectId: projectId, level: level)
    await reloadProjects()
  }

  /// True when the signed-in user may edit projects of the workspace.
  func canEditProjects(workspaceId: String) -> Bool {
    let w = status.workspaces.first { $0.id == workspaceId }
    return w?.role == .owner || w?.role == .admin
  }

  // MARK: Cards

  /// Manual project for a card (share 1, confirmed); nil clears the card's projects.
  func assignCard(recordId: Int64, projectId: String?) async throws {
    try await requireEngine().assignCard(recordId: recordId, projectId: projectId)
  }

  func editDetailProject(recordId: Int64, key: String, projectId: String,
                         action: DetailProjectAction) async throws {
    try await requireEngine().editDetailProject(recordId: recordId, key: key,
                                                projectId: projectId, action: action)
  }

  /// Confirms a guessed ("?") project on a card.
  func confirmCard(recordId: Int64, projectId: String) async throws {
    try await requireEngine().confirmCard(recordId: recordId, projectId: projectId)
  }

  /// Marks a card private: it never leaves this Mac (a copy already on the server is wiped)
  /// and never reaches team reports. Works for any device's card: only the flag travels, so the
  /// device that made the card stops uploading it and wipes the server's copy.
  func setCardPrivate(recordId: Int64, isPrivate: Bool) async throws {
    try await requireEngine().setCardPrivate(recordId: recordId, isPrivate: isPrivate)
  }

  /// Sync facts for timeline rows: uuid, origin device (remote = another device's lane),
  /// private flag and project chips. Missing ids are left out.
  func cardSyncInfo(recordIds: [Int64]) async -> [Int64: CardSyncInfo] {
    guard let engine else { return [:] }
    return await engine.cardSyncInfo(recordIds: recordIds)
  }

  // MARK: Team views

  /// Project feed (entries visible to the caller, per member share level). Days are "YYYY-MM-DD".
  func feed(projectId: String, from: String, to: String) async throws -> [ProjectEntry] {
    try await requireEngine().feed(projectId: projectId, from: from, to: to)
  }

  /// Totals per member / day / member×day / category.
  func report(projectId: String, from: String, to: String) async throws -> ProjectReport {
    try await requireEngine().report(projectId: projectId, from: from, to: to)
  }

  /// Proposed Odoo timesheet lines (confirmed project minutes per day × project, 0.25 h steps).
  func timesheetProposals(from: String, to: String, workspaceId: String) async throws -> TimesheetProposalsView {
    try await requireEngine().timesheetProposals(from: from, to: to, workspaceId: workspaceId)
  }

  /// Writes the lines to Odoo (account.analytic.line; re-sending a day/project updates the line).
  /// The UI MUST show the user exactly these lines and get an explicit confirmation first
  /// (Windows shows a modal listing day, hours, Odoo project/task and description).
  func timesheetSubmit(_ lines: [TimesheetLine]) async throws -> TimesheetSubmitResult {
    try await requireEngine().timesheetSubmit(TimesheetSubmitRequest(lines: lines))
  }

  // MARK: Policy ("What leaves this Mac")

  /// Replaces the whole policy. Cards are re-scoped on the next cycle; switching observation upload
  /// off sends tombstones so the server drops their text.
  func setPolicy(_ p: SyncPolicy) async {
    policy = p
    if let platform { SyncPolicyKeys.save(p, platform.defaults) }
    await engine?.setPolicy(p)
  }

  /// A pulled change updated the policy in the engine (a category renamed on another device kept
  /// its exclusion): publish and persist it.
  private func policyChangedBySync(_ p: SyncPolicy) {
    guard p != policy else { return }
    policy = p
    if let platform { SyncPolicyKeys.save(p, platform.defaults) }
  }

  /// A category was renamed on this Mac (CategoryStore.renameCategory): the new name is excluded
  /// when the old one was, and the old name stays excluded, because existing cards keep it.
  func categoryRenamed(from oldName: String, to newName: String) {
    guard let next = policy.renamingCategory(from: oldName, to: newName) else { return }
    Task { await self.setPolicy(next) }
  }

  /// Categories whose cards never leave this Mac (case-insensitive). Default ["Personal"].
  func setExcludedCategories(_ names: [String]) async {
    var p = policy
    p.excludedCategories = names.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    await setPolicy(p)
  }

  /// Upload work without a confirmed project as time-only "Out of scope" blocks (default true).
  /// false = upload such cards in full.
  func setOutOfScope(_ on: Bool) async {
    var p = policy
    p.outOfScope = on
    await setPolicy(p)
  }

  /// Upload raw observations (default false).
  func setObservationsUpload(_ on: Bool) async {
    var p = policy
    p.observations = on
    await setPolicy(p)
  }
}
