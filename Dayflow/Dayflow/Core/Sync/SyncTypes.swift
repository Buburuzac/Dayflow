//
//  SyncTypes.swift
//  Dayflow — Dayflow Sync client core
//
//  Swift mirror of windows/src/shared/sync-types.ts (wire contract with the Dayflow Sync
//  Server, docs/sync-server-design.md) and windows/src/shared/sync-ui.ts (what the UI reads).
//  Field names match the JSON on the wire.
//

import Foundation

/// Default server (LAN, megaserv). Same as `DEFAULT_SYNC_SERVER_URL` on Windows.
let DEFAULT_SYNC_SERVER_URL = "http://192.168.0.90:8790"

enum SyncEntity: String, Codable, CaseIterable, Sendable {
  case card
  case cardProject = "card_project"
  case observation
  case standup
  case dayGoal = "day_goal"
  case userDoc = "user_doc"
  case project
  case projectMember = "project_member"
}

enum ShareLevel: String, Codable, CaseIterable, Sendable {
  case time
  case cards
  case detailed
}

enum WorkspaceRole: String, Codable, Sendable {
  case owner
  case admin
  case member
  case viewer
}

enum AssignmentSource: String, Codable, Sendable {
  case manual
  case rule
  case llm
}

enum DetailProjectAction: Sendable {
  case add, remove, confirm
}

/// One record on the wire (`SyncChange` in sync-types.ts).
struct SyncChange: Codable, Equatable, Sendable {
  var entity: SyncEntity
  /// uuid, or a composite key for standup/day_goal (`<userId>:<day>`) and user_doc (`<userId>:<kind>`)
  var id: String
  var deviceId: String
  /// Hybrid logical clock, see `SyncHLC.swift`.
  var hlc: String
  var deleted: Bool?
  var data: [String: JSONValue]?
  /// Cards only: per-field HLC for user-editable fields.
  var fieldHlc: [String: String]?

  init(
    entity: SyncEntity, id: String, deviceId: String, hlc: String, deleted: Bool? = nil,
    data: [String: JSONValue]? = nil, fieldHlc: [String: String]? = nil
  ) {
    self.entity = entity
    self.id = id
    self.deviceId = deviceId
    self.hlc = hlc
    self.deleted = deleted
    self.data = data
    self.fieldHlc = fieldHlc
  }

  enum CodingKeys: String, CodingKey {
    case entity, id, deviceId, hlc, deleted, data, fieldHlc
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    entity = try c.decode(SyncEntity.self, forKey: .entity)
    id = try c.decode(String.self, forKey: .id)
    deviceId = (try? c.decodeIfPresent(String.self, forKey: .deviceId)) ?? ""
    hlc = try c.decode(String.self, forKey: .hlc)
    deleted = try? c.decodeIfPresent(Bool.self, forKey: .deleted)
    // The server sends `null` for absent payloads.
    if let d = try? c.decodeIfPresent(JSONValue.self, forKey: .data) {
      data = d.objectValue
    } else {
      data = nil
    }
    if let f = try? c.decodeIfPresent([String: JSONValue].self, forKey: .fieldHlc) {
      var out: [String: String] = [:]
      for (k, v) in f { if let s = v.stringValue { out[k] = s } }
      fieldHlc = out
    } else {
      fieldHlc = nil
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(entity, forKey: .entity)
    try c.encode(id, forKey: .id)
    try c.encode(deviceId, forKey: .deviceId)
    try c.encode(hlc, forKey: .hlc)
    try c.encodeIfPresent(deleted, forKey: .deleted)
    try c.encodeIfPresent(data, forKey: .data)
    try c.encodeIfPresent(fieldHlc, forKey: .fieldHlc)
  }
}

struct PushRequest: Codable {
  var changes: [SyncChange]
}

struct PushRejection: Codable, Equatable, Sendable {
  var id: String
  var reason: String
  /// Not sent by the current server; used when present.
  var entity: String?

  init(id: String, reason: String, entity: String? = nil) {
    self.id = id
    self.reason = reason
    self.entity = entity
  }
}

struct PushResponse: Codable, Sendable {
  var accepted: Int?
  var rejected: [PushRejection]?
  var serverTime: Double?
}

struct PullResponse: Codable, Sendable {
  var changes: [SyncChange]?
  var cursor: Int64?
  var more: Bool?
}

// MARK: - Projects

struct ProjectRules: Codable, Equatable, Sendable {
  var apps: [String]?
  var domains: [String]?
  var titleKeywords: [String]?
  var repos: [String]?

  init(apps: [String]? = nil, domains: [String]? = nil, titleKeywords: [String]? = nil, repos: [String]? = nil) {
    self.apps = apps
    self.domains = domains
    self.titleKeywords = titleKeywords
    self.repos = repos
  }
}

struct OdooMapping: Codable, Equatable, Sendable {
  var projectId: Int?
  var taskId: Int?
  var projectName: String?
  var taskName: String?

  init(projectId: Int? = nil, taskId: Int? = nil, projectName: String? = nil, taskName: String? = nil) {
    self.projectId = projectId
    self.taskId = taskId
    self.projectName = projectName
    self.taskName = taskName
  }
}

// MARK: - Account

struct DeviceInfo: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var name: String
  var platform: String
  /// unix ms (or ISO text from older servers; then nil)
  var lastSeenAt: Double?
  var revoked: Bool
  var current: Bool?

  enum CodingKeys: String, CodingKey { case id, name, platform, lastSeenAt, revoked, current }

  init(id: String, name: String, platform: String, lastSeenAt: Double?, revoked: Bool, current: Bool? = nil) {
    self.id = id
    self.name = name
    self.platform = platform
    self.lastSeenAt = lastSeenAt
    self.revoked = revoked
    self.current = current
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
    platform = (try? c.decodeIfPresent(String.self, forKey: .platform)) ?? ""
    lastSeenAt = try? c.decodeIfPresent(Double.self, forKey: .lastSeenAt)
    revoked = (try? c.decodeIfPresent(Bool.self, forKey: .revoked)) ?? false
    current = try? c.decodeIfPresent(Bool.self, forKey: .current)
  }
}

struct UserInfo: Codable, Equatable, Sendable {
  var id: String
  var email: String
  var name: String
  var avatarUrl: String?
}

struct WorkspaceInfo: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var name: String
  var role: WorkspaceRole
}

struct SyncMeResponse: Codable, Sendable {
  var user: UserInfo
  var devices: [DeviceInfo]?
  var workspaces: [WorkspaceInfo]?
}

struct GoogleExchangeDevice: Codable, Sendable {
  var name: String
  var platform: String
  var id: String?
}

struct GoogleExchangeRequest: Codable, Sendable {
  var code: String
  var codeVerifier: String
  var redirectUri: String
  var device: GoogleExchangeDevice
}

struct AuthResponse: Codable, Sendable {
  var deviceToken: String
  var user: UserInfo
  var device: DeviceInfo?
}

struct GoogleConfigResponse: Codable, Sendable {
  var clientId: String?
  var devAuth: Bool?
}

struct DevAuthRequest: Codable, Sendable {
  var email: String
  var deviceName: String
  var platform: String?
  var deviceId: String?
}

struct WebLinkResponse: Codable, Sendable {
  var url: String?
}

// MARK: - Team views

struct ProjectEntry: Codable, Equatable, Sendable {
  var cardId: String
  var projectId: String
  var userId: String
  var userName: String
  var startTs: Double
  var endTs: Double
  var minutes: Double
  var shareLevel: ShareLevel
  var title: String?
  var summary: String?
  var detailed: String?
  var day: String?
  var category: String?
  var distractions: [JSONValue]?
}

struct ProjectFeedResponse: Codable, Sendable {
  var entries: [ProjectEntry]?
}

struct ReportMemberMinutes: Codable, Equatable, Sendable {
  var userId: String
  var userName: String
  var minutes: Double
}

struct ReportDayMinutes: Codable, Equatable, Sendable {
  var day: String
  var minutes: Double
}

struct ReportMemberDayMinutes: Codable, Equatable, Sendable {
  var userId: String
  var day: String
  var minutes: Double
}

struct ReportCategoryMinutes: Codable, Equatable, Sendable {
  var category: String
  var minutes: Double
}

struct ProjectReport: Codable, Equatable, Sendable {
  var projectId: String
  var from: String
  var to: String
  var totalMinutes: Double
  var byMember: [ReportMemberMinutes]
  var byDay: [ReportDayMinutes]
  var byMemberDay: [ReportMemberDayMinutes]
  var byCategory: [ReportCategoryMinutes]?
}

struct TimesheetProposal: Codable, Equatable, Sendable {
  var userId: String
  var day: String
  var projectId: String
  var odooProjectId: Int?
  var odooTaskId: Int?
  /// rounded to 0.25 h
  var hours: Double
  var description: String
  var cardIds: [String]
  /// set when a line was already sent for this user/day/project/task
  var existingOdooLineId: Int?
  var minutes: Double?
  var projectName: String?
}

/// One line the user confirmed for Odoo (`TimesheetSubmitRequest.lines[i]`).
struct TimesheetLine: Codable, Equatable, Sendable {
  var day: String
  var projectId: String
  var hours: Double
  var description: String
  var cardIds: [String]

  init(day: String, projectId: String, hours: Double, description: String, cardIds: [String]) {
    self.day = day
    self.projectId = projectId
    self.hours = hours
    self.description = description
    self.cardIds = cardIds
  }
}

struct TimesheetSubmitRequest: Codable, Equatable, Sendable {
  var lines: [TimesheetLine]
}

struct TimesheetSent: Codable, Equatable, Sendable {
  var day: String
  var projectId: String
  var odooLineId: Int
  var updated: Bool
}

struct TimesheetFailed: Codable, Equatable, Sendable {
  var day: String
  var projectId: String
  var error: String
}

struct TimesheetSubmitResult: Codable, Equatable, Sendable {
  var sent: [TimesheetSent]
  var failed: [TimesheetFailed]
}

struct TimesheetProposalsResponse: Codable, Sendable {
  var proposals: [TimesheetProposal]?
  var odooConfigured: Bool?
  var employeeMapped: Bool?
}

func cardProjectId(_ cardId: String, _ projectId: String) -> String { "\(cardId):\(projectId)" }
func projectMemberId(_ projectId: String, _ userId: String) -> String { "\(projectId):\(userId)" }

// MARK: - What the UI reads (sync-ui.ts)

/// Mirrors `SyncStatus` in windows/src/shared/sync-ui.ts.
struct SyncStatus: Equatable, Sendable {
  var serverUrl: String
  var signedIn: Bool
  var user: UserInfo?
  var deviceId: String
  var deviceName: String
  var workspaces: [WorkspaceInfo]
  /// unix ms
  var lastSyncAt: Int64?
  var lastPushAt: Int64?
  var lastPullAt: Int64?
  /// changes waiting in the outbox
  var pending: Int
  var lastError: String?
  var syncing: Bool
  var streamConnected: Bool

  static let empty = SyncStatus(
    serverUrl: DEFAULT_SYNC_SERVER_URL, signedIn: false, user: nil, deviceId: "", deviceName: "",
    workspaces: [], lastSyncAt: nil, lastPushAt: nil, lastPullAt: nil, pending: 0, lastError: nil,
    syncing: false, streamConnected: false)
}

/// Mirrors `AuthConfigStatus`.
struct AuthConfigStatus: Equatable, Sendable {
  /// Server reachable and answered /api/auth/google/config
  var reachable: Bool
  var googleConfigured: Bool
  var devAuth: Bool
  var error: String?
}

/// Mirrors `ProjectView`.
struct ProjectView: Equatable, Identifiable, Sendable {
  var id: String
  var workspaceId: String
  var name: String
  var color: String
  var icon: String = ""
  var description: String
  var rules: ProjectRules
  var defaultShare: ShareLevel
  var odoo: OdooMapping
  var archived: Bool
  /// The signed-in user's override (nil = project default)
  var myShare: ShareLevel?
}

/// Mirrors `ProjectDraft` (create when `id` is nil).
struct ProjectDraft: Equatable, Sendable {
  var id: String?
  var workspaceId: String
  var name: String
  var color: String
  var icon: String
  var description: String
  var rules: ProjectRules
  var defaultShare: ShareLevel
  var odoo: OdooMapping
  var archived: Bool?

  init(
    id: String? = nil, workspaceId: String, name: String, color: String, icon: String = "", description: String = "",
    rules: ProjectRules = ProjectRules(), defaultShare: ShareLevel = .time, odoo: OdooMapping = OdooMapping(),
    archived: Bool? = nil
  ) {
    self.id = id
    self.workspaceId = workspaceId
    self.name = name
    self.color = color
    self.icon = icon
    self.description = description
    self.rules = rules
    self.defaultShare = defaultShare
    self.odoo = odoo
    self.archived = archived
  }
}

/// Mirrors `TimesheetProposalsView`.
struct TimesheetProposalsView: Equatable, Sendable {
  var proposals: [TimesheetProposal]
  var odooConfigured: Bool
  var employeeMapped: Bool
}

/// Mirrors `MeView`.
struct MeView: Equatable, Sendable {
  var user: UserInfo
  var devices: [DeviceInfo]
  var workspaces: [WorkspaceInfo]
}

/// A project chip on a card (`CardProjectInfo` on Windows).
struct CardProjectInfo: Equatable, Sendable {
  var projectId: String
  var name: String
  var color: String
  var icon: String = ""
  var share: Double
  var source: AssignmentSource
  var confidence: Double
  var confirmed: Bool
}

/// Sync facts about one local `timeline_cards` row, for the timeline UI.
struct CardSyncInfo: Equatable, Sendable {
  /// timeline_cards.id
  var recordId: Int64
  var uuid: String?
  /// Device that generated the card (nil = this device, written before sync existed)
  var deviceId: String?
  /// true when the card came from another device (show it in that device's lane, read-only analysis)
  var remote: Bool
  /// metadata.private: never leaves this Mac, never reaches team reports
  var isPrivate: Bool
  /// Project chips, largest share first. Unconfirmed ones need a "confirm project" chip.
  var projects: [CardProjectInfo]
  var detailProjects: [String: [DetailProjectRef]] = [:]
}

struct DetailProjectRef: Equatable, Sendable {
  var projectId: String
  var share: Double
  var source: AssignmentSource
  var confidence: Double
  var confirmed: Bool

  init(projectId: String, share: Double = 1, source: AssignmentSource = .manual,
       confidence: Double = 1, confirmed: Bool = true) {
    self.projectId = projectId
    self.share = share
    self.source = source
    self.confidence = confidence
    self.confirmed = confirmed
  }

  init?(_ value: JSONValue) {
    guard let object = value.objectValue, let id = object["projectId"]?.stringValue else { return nil }
    self.init(projectId: id, share: clamp01(object["share"]?.numberValue ?? 1),
              source: AssignmentSource(rawValue: object["source"]?.stringValue ?? "") ?? .manual,
              confidence: clamp01(object["confidence"]?.numberValue ?? 1),
              confirmed: object["confirmed"]?.boolValue == true)
  }

  var json: JSONValue {
    .object(["projectId": .string(projectId), "share": .double(share),
             "source": .string(source.rawValue), "confidence": .double(confidence),
             "confirmed": .bool(confirmed)])
  }
}

struct SyncDetailRecord: Identifiable, Sendable {
  let key: String
  var id: String { key }
  let stamp: String
  let text: String
  let minutes: Double
}

private func syncClockMinutes(_ raw: String) -> Int? {
  let pieces = raw.trimmingCharacters(in: .whitespaces).uppercased().split(separator: ":")
  guard pieces.count == 2, let hour = Int(pieces[0]) else { return nil }
  let second = String(pieces[1]).trimmingCharacters(in: .whitespaces)
  guard let minute = Int(second.prefix(2)), (0...59).contains(minute) else { return nil }
  let period = String(second.dropFirst(2)).trimmingCharacters(in: .whitespaces)
  guard (period.isEmpty && (0...23).contains(hour)) ||
        ((period == "AM" || period == "PM") && (1...12).contains(hour)) else { return nil }
  return (period.isEmpty ? hour : hour % 12 + (period == "PM" ? 12 : 0)) * 60 + minute
}

private func syncInterval(_ start: String, _ end: String) -> (Int, Int)? {
  guard let a = syncClockMinutes(start), let b = syncClockMinutes(end) else { return nil }
  let finish = b <= a ? b + 1440 : b
  return finish - a <= 720 ? (a, finish) : nil
}

private func syncCoveredMinutes(_ target: (Int, Int), _ covers: [(Int, Int)]) -> Int {
  var parts: [(Int, Int)] = []
  for cover in covers {
    for shift in [-1440, 0, 1440] {
      let a = max(target.0, cover.0 + shift), b = min(target.1, cover.1 + shift)
      if b > a { parts.append((a, b)) }
    }
  }
  parts.sort { $0.0 < $1.0 }
  var total = 0, end = target.0
  for part in parts {
    total += max(0, part.1 - max(part.0, end))
    end = max(end, part.1)
  }
  return total
}

/// The same stable line keys and minute weights used by the Windows client and server.
func syncDetailRecords(summary: String, distractions: [JSONValue]) -> [SyncDetailRecord] {
  let expression = try? NSRegularExpression(
    pattern: #"^\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[-–—]\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*:\s*(.*)$"#,
    options: [.caseInsensitive])
  let distractionRanges: [(Int, Int)?] = distractions.map {
    let o = $0.objectValue ?? [:]
    return syncInterval(o["startTime"]?.stringValue ?? "", o["endTime"]?.stringValue ?? "")
  }
  let covers = distractionRanges.compactMap { $0 }
  var result: [SyncDetailRecord] = []
  for raw in summary.components(separatedBy: "\n").filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
    let i = result.count
    guard let match = expression?.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)) else {
      result.append(SyncDetailRecord(key: "detail:\(i)", stamp: "", text: raw, minutes: 1))
      continue
    }
    func group(_ number: Int) -> String {
      guard let range = Range(match.range(at: number), in: raw) else { return "" }
      return String(raw[range])
    }
    let start = group(1), end = group(2)
    let interval = syncInterval(start, end)
    let stamp: String
    if let a = syncClockMinutes(start), let b = syncClockMinutes(end) {
      stamp = String(format: "%02d:%02d–%02d:%02d", a / 60, a % 60, b / 60, b % 60)
    } else { stamp = "" }
    let minutes = interval.map { max(0, $0.1 - $0.0 - syncCoveredMinutes($0, covers)) } ?? 1
    result.append(SyncDetailRecord(key: "detail:\(i)", stamp: stamp, text: group(3), minutes: Double(minutes)))
  }
  for (i, distraction) in distractions.enumerated() {
    let o = distraction.objectValue ?? [:]
    let start = o["startTime"]?.stringValue ?? "", end = o["endTime"]?.stringValue ?? ""
    let interval = distractionRanges[i]
    let prior = distractionRanges.prefix(i).compactMap { $0 }
    let minutes = interval.map { max(0, $0.1 - $0.0 - syncCoveredMinutes($0, prior)) } ?? 1
    let stamp: String
    if let a = syncClockMinutes(start), let b = syncClockMinutes(end) {
      stamp = String(format: "%02d:%02d–%02d:%02d", a / 60, a % 60, b / 60, b % 60)
    } else { stamp = "" }
    let title = o["title"]?.stringValue ?? ""
    let summary = o["summary"]?.stringValue ?? ""
    result.append(SyncDetailRecord(key: "distraction:\(i)", stamp: stamp,
                                   text: summary.isEmpty ? title : "\(title) — \(summary)", minutes: Double(minutes)))
  }
  return result
}
