//
//  SyncRepo.swift
//  Dayflow — Dayflow Sync client core
//
//  Local tables for sync (port of windows/src/main/sync/repo.ts): sync_state, outbox, projects,
//  project_members, card_projects, sync_meta. Every method takes the `Database` of the caller's
//  GRDB transaction.
//

import Foundation
import GRDB

struct SyncStateRow: Equatable {
  var deviceId: String
  var deviceName: String
  var serverUrl: String
  var enabled: Bool
  var userId: String?
  var user: UserInfo?
  var workspaces: [WorkspaceInfo]
  var cursor: Int64
  var lastPushAt: Int64?
  var lastPullAt: Int64?
  var lastSyncAt: Int64?
  var lastError: String?
}

/// A partial update of sync_state (`nil` = leave as is; `.some(nil)` = set NULL).
struct SyncStatePatch {
  var deviceName: String?
  var serverUrl: String?
  var userId: String??
  var user: UserInfo??
  var workspaces: [WorkspaceInfo]?
  var cursor: Int64?
  var lastPushAt: Int64??
  var lastPullAt: Int64??
  var lastSyncAt: Int64??
  var lastError: String??
}

struct OutboxEntry: Equatable, Sendable {
  var seq: Int64
  var entity: SyncEntity
  var entityId: String
  var payload: String?
  var rev: Int64
  var attempts: Int
}

struct ProjectRow: Equatable, Sendable {
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
  var deleted: Bool
  var hlc: String
}

struct CardProjectRow: Equatable, Sendable {
  var cardUuid: String
  var projectId: String
  var share: Double
  var source: AssignmentSource
  var confidence: Double
  var confirmed: Bool
  var deleted: Bool
  var hlc: String
}

struct AssignmentInput: Equatable, Sendable {
  var projectId: String
  var share: Double
  var source: AssignmentSource
  var confidence: Double
  var confirmed: Bool
}

private func decodeJSON<T: Decodable>(_ type: T.Type, _ text: String?) -> T? {
  guard let text, !text.isEmpty, let data = text.data(using: .utf8) else { return nil }
  return try? JSONDecoder().decode(type, from: data)
}

private func encodeJSON<T: Encodable>(_ v: T) -> String {
  guard let data = try? SyncCoding.encode(v), let s = String(data: data, encoding: .utf8) else { return "null" }
  return s
}

/// JS `Math.round(x * 1000) / 1000` (half rounds up).
func round3(_ x: Double) -> Double { (x * 1000 + 0.5).rounded(.down) / 1000 }

func clamp01(_ x: Double) -> Double { max(0, min(1, x)) }

struct SyncRepo: Sendable {
  let local: SyncLocal

  // MARK: sync_state

  func state(_ db: Database) throws -> SyncStateRow {
    guard let r = try Row.fetchOne(db, sql: "SELECT * FROM sync_state WHERE id = 1") else {
      return SyncStateRow(
        deviceId: local.deviceId, deviceName: "", serverUrl: DEFAULT_SYNC_SERVER_URL, enabled: false, userId: nil,
        user: nil, workspaces: [], cursor: 0, lastPushAt: nil, lastPullAt: nil, lastSyncAt: nil, lastError: nil)
    }
    return SyncStateRow(
      deviceId: r["device_id"] ?? "",
      deviceName: r["device_name"] ?? "",
      serverUrl: r["server_url"] ?? DEFAULT_SYNC_SERVER_URL,
      enabled: (r["enabled"] as Int? ?? 0) == 1,
      userId: r["user_id"],
      user: decodeJSON(UserInfo.self, r["user_json"]),
      workspaces: decodeJSON([WorkspaceInfo].self, r["workspaces_json"]) ?? [],
      cursor: r["cursor"] ?? 0,
      lastPushAt: r["last_push_at"],
      lastPullAt: r["last_pull_at"],
      lastSyncAt: r["last_sync_at"],
      lastError: r["last_error"])
  }

  func updateState(_ db: Database, _ p: SyncStatePatch) throws {
    var sets: [String] = []
    var vals: [DatabaseValueConvertible?] = []
    func add(_ col: String, _ v: DatabaseValueConvertible?) {
      sets.append("\(col) = ?")
      vals.append(v)
    }
    if let v = p.deviceName { add("device_name", v) }
    if let v = p.serverUrl { add("server_url", v) }
    if let v = p.userId { add("user_id", v) }
    if let v = p.user { add("user_json", v.map { encodeJSON($0) }) }
    if let v = p.workspaces { add("workspaces_json", encodeJSON(v)) }
    if let v = p.cursor { add("cursor", v) }
    if let v = p.lastPushAt { add("last_push_at", v) }
    if let v = p.lastPullAt { add("last_pull_at", v) }
    if let v = p.lastSyncAt { add("last_sync_at", v) }
    if let v = p.lastError { add("last_error", v.map { String($0.prefix(1000)) }) }
    guard !sets.isEmpty else { return }
    try db.execute(
      sql: "UPDATE sync_state SET \(sets.joined(separator: ", ")) WHERE id = 1", arguments: StatementArguments(vals))
  }

  // MARK: outbox

  func pendingCount(_ db: Database) throws -> Int {
    try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM outbox") ?? 0
  }

  func pending(_ db: Database, limit: Int) throws -> [OutboxEntry] {
    try Row.fetchAll(db, sql: "SELECT * FROM outbox ORDER BY seq ASC LIMIT ?", arguments: [limit]).compactMap { r in
      guard let entity = SyncEntity(rawValue: r["entity"] ?? "") else { return nil }
      return OutboxEntry(
        seq: r["seq"], entity: entity, entityId: r["entity_id"] ?? "", payload: r["payload"], rev: r["rev"] ?? 1,
        attempts: r["attempts"] ?? 0)
    }
  }

  /// Removes pushed entries, unless they were re-queued (newer rev) while the push was in flight.
  func markPushed(_ db: Database, _ entries: [OutboxEntry]) throws {
    for e in entries {
      try db.execute(sql: "DELETE FROM outbox WHERE seq = ? AND rev = ?", arguments: [e.seq, e.rev])
    }
  }

  /// Rejected changes would be rejected again; drop them (the reason goes to the status line).
  func markRejected(_ db: Database, _ entries: [(entry: OutboxEntry, reason: String)]) throws {
    try markPushed(db, entries.map { $0.entry })
  }

  func markFailed(_ db: Database, _ entries: [OutboxEntry], error: String) throws {
    for e in entries {
      try db.execute(
        sql: "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?",
        arguments: [String(error.prefix(500)), e.seq])
    }
  }

  func clearOutbox(_ db: Database) throws {
    try db.execute(sql: "DELETE FROM outbox")
  }

  /// Queues this device's existing records after sign-in (cards and observations of the last `days`).
  @discardableResult
  func backfill(_ db: Database, days: Int, nowSec: Int64 = Int64(Date().timeIntervalSince1970)) throws -> Int {
    let since = nowSec - Int64(days) * 86400
    let dev = local.deviceId
    var n = 0
    let cards = try Row.fetchAll(
      db,
      sql: """
        SELECT uuid, category, metadata FROM timeline_cards
        WHERE start_ts >= ? AND uuid IS NOT NULL AND (device_id IS NULL OR device_id = ?) AND is_deleted = 0
        """,
      arguments: [since, dev])
    for c in cards {
      let category: String = c["category"] ?? ""
      if category == ERROR_CATEGORY || parseJSONObject(c["metadata"])["isError"]?.boolValue == true { continue }
      try local.enqueue(db, .card, c["uuid"])
      n += 1
    }
    let obs = try String.fetchAll(
      db,
      sql: "SELECT uuid FROM observations WHERE start_ts >= ? AND uuid IS NOT NULL AND (device_id IS NULL OR device_id = ?)",
      arguments: [since, dev])
    for o in obs {
      try local.enqueue(db, .observation, o)
      n += 1
    }
    let cps = try Row.fetchAll(
      db,
      sql: """
        SELECT cp.card_uuid, cp.project_id FROM card_projects cp JOIN timeline_cards c ON c.uuid = cp.card_uuid
        WHERE c.start_ts >= ? AND cp.deleted = 0
        """,
      arguments: [since])
    for cp in cps {
      try local.enqueue(db, .cardProject, cardProjectId(cp["card_uuid"], cp["project_id"]))
      n += 1
    }
    return n
  }

  /// Signing out: drop everything that came from the account (other devices' rows, projects).
  func purgeRemote(_ db: Database) throws {
    let dev = local.deviceId
    try db.execute(
      sql: """
        DELETE FROM card_projects WHERE card_uuid IN
          (SELECT uuid FROM timeline_cards WHERE device_id IS NOT NULL AND device_id != ?)
        """,
      arguments: [dev])
    try db.execute(sql: "DELETE FROM timeline_cards WHERE device_id IS NOT NULL AND device_id != ?", arguments: [dev])
    try db.execute(sql: "DELETE FROM observations WHERE device_id IS NOT NULL AND device_id != ?", arguments: [dev])
    try db.execute(
      sql: "DELETE FROM projects; DELETE FROM project_members; DELETE FROM outbox; DELETE FROM sync_meta;")
    // Assignments to projects that no longer exist locally are meaningless.
    try db.execute(sql: "DELETE FROM card_projects")
  }

  // MARK: sync_meta

  func metaHlc(_ db: Database, _ key: String) throws -> String { try SyncLocal.metaHlc(db, key) }

  func setMetaHlc(_ db: Database, _ key: String, _ hlc: String) throws { try SyncLocal.setMetaHlc(db, key, hlc) }

  func recordDoc(_ db: Database, _ entity: DocEntity, _ id: String) throws { try local.recordDoc(db, entity, id) }

  // MARK: projects

  private static func mapProject(_ r: Row) -> ProjectRow {
    let share = ShareLevel(rawValue: r["default_share"] ?? "") ?? .time
    return ProjectRow(
      id: r["id"], workspaceId: r["workspace_id"] ?? "", name: r["name"] ?? "", color: r["color"] ?? "", icon: r["icon"] ?? "",
      description: r["description"] ?? "", rules: decodeJSON(ProjectRules.self, r["rules"]) ?? ProjectRules(),
      defaultShare: share, odoo: decodeJSON(OdooMapping.self, r["odoo"]) ?? OdooMapping(),
      archived: (r["archived"] as Int? ?? 0) == 1, deleted: (r["deleted"] as Int? ?? 0) == 1, hlc: r["hlc"] ?? "")
  }

  func projects(_ db: Database, includeArchived: Bool = false) throws -> [ProjectRow] {
    let w = includeArchived ? "deleted = 0" : "deleted = 0 AND archived = 0"
    return try Row.fetchAll(db, sql: "SELECT * FROM projects WHERE \(w) ORDER BY name COLLATE NOCASE").map(
      SyncRepo.mapProject)
  }

  func project(_ db: Database, _ id: String) throws -> ProjectRow? {
    try Row.fetchOne(db, sql: "SELECT * FROM projects WHERE id = ?", arguments: [id]).map(SyncRepo.mapProject)
  }

  /// Writes a project row as-is (remote apply and local saves).
  func putProject(_ db: Database, _ p: ProjectRow) throws {
    try db.execute(
      sql: """
        INSERT INTO projects (id, workspace_id, name, color, icon, description, rules, default_share, odoo, archived, deleted, hlc, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, name = excluded.name, color = excluded.color,
          icon = excluded.icon, description = excluded.description, rules = excluded.rules, default_share = excluded.default_share,
          odoo = excluded.odoo, archived = excluded.archived, deleted = excluded.deleted, hlc = excluded.hlc,
          updated_at = excluded.updated_at
        """,
      arguments: [
        p.id, p.workspaceId, p.name, p.color, p.icon, p.description, encodeJSON(p.rules), p.defaultShare.rawValue,
        encodeJSON(p.odoo), p.archived ? 1 : 0, p.deleted ? 1 : 0, p.hlc, syncNowMs(),
      ])
  }

  /// Admin edit from this device; the server rejects it for non-admins.
  @discardableResult
  func saveProject(_ db: Database, _ d: ProjectDraft) throws -> ProjectRow {
    let row = ProjectRow(
      id: (d.id?.isEmpty == false ? d.id! : syncNewUUID()), workspaceId: d.workspaceId, name: d.name, color: d.color, icon: d.icon,
      description: d.description, rules: d.rules, defaultShare: d.defaultShare, odoo: d.odoo,
      archived: d.archived ?? false, deleted: false, hlc: local.tick())
    try putProject(db, row)
    local.markScopeDirty()
    try local.enqueue(db, .project, row.id)
    return row
  }

  func memberShare(_ db: Database, projectId: String, userId: String) throws -> ShareLevel? {
    let s = try String.fetchOne(
      db, sql: "SELECT share_level FROM project_members WHERE project_id = ? AND user_id = ? AND deleted = 0",
      arguments: [projectId, userId])
    return s.flatMap { ShareLevel(rawValue: $0) }
  }

  func memberRow(_ db: Database, projectId: String, userId: String) throws -> (
    shareLevel: ShareLevel?, deleted: Bool, hlc: String
  )? {
    guard
      let r = try Row.fetchOne(
        db, sql: "SELECT * FROM project_members WHERE project_id = ? AND user_id = ?", arguments: [projectId, userId])
    else { return nil }
    let s: String? = r["share_level"]
    return (s.flatMap { ShareLevel(rawValue: $0) }, (r["deleted"] as Int? ?? 0) == 1, r["hlc"] ?? "")
  }

  func putMember(_ db: Database, projectId: String, userId: String, shareLevel: ShareLevel?, deleted: Bool, hlc: String)
    throws
  {
    try db.execute(
      sql: """
        INSERT INTO project_members (project_id, user_id, share_level, deleted, hlc) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET share_level = excluded.share_level, deleted = excluded.deleted, hlc = excluded.hlc
        """,
      arguments: [projectId, userId, shareLevel?.rawValue, deleted ? 1 : 0, hlc])
  }

  func setMyShare(_ db: Database, projectId: String, userId: String, level: ShareLevel?) throws {
    try putMember(db, projectId: projectId, userId: userId, shareLevel: level, deleted: false, hlc: local.tick())
    try local.enqueue(db, .projectMember, projectMemberId(projectId, userId))
  }

  func projectViews(_ db: Database, userId: String?, includeArchived: Bool = true) throws -> [ProjectView] {
    try projects(db, includeArchived: includeArchived).map { p in
      ProjectView(
        id: p.id, workspaceId: p.workspaceId, name: p.name, color: p.color, icon: p.icon, description: p.description,
        rules: p.rules, defaultShare: p.defaultShare, odoo: p.odoo, archived: p.archived,
        myShare: try userId.flatMap { try memberShare(db, projectId: p.id, userId: $0) })
    }
  }

  // MARK: card_projects

  private static func mapCardProject(_ r: Row) -> CardProjectRow {
    CardProjectRow(
      cardUuid: r["card_uuid"], projectId: r["project_id"], share: r["share"] ?? 1,
      source: AssignmentSource(rawValue: r["source"] ?? "") ?? .manual, confidence: r["confidence"] ?? 1,
      confirmed: (r["confirmed"] as Int? ?? 0) == 1, deleted: (r["deleted"] as Int? ?? 0) == 1, hlc: r["hlc"] ?? "")
  }

  func cardProject(_ db: Database, cardUuid: String, projectId: String) throws -> CardProjectRow? {
    try Row.fetchOne(
      db, sql: "SELECT * FROM card_projects WHERE card_uuid = ? AND project_id = ?", arguments: [cardUuid, projectId]
    ).map(SyncRepo.mapCardProject)
  }

  func cardProjects(_ db: Database, cardUuid: String) throws -> [CardProjectRow] {
    try Row.fetchAll(
      db, sql: "SELECT * FROM card_projects WHERE card_uuid = ? AND deleted = 0", arguments: [cardUuid]
    ).map(SyncRepo.mapCardProject)
  }

  func putCardProject(_ db: Database, _ r: CardProjectRow) throws {
    try db.execute(
      sql: """
        INSERT INTO card_projects (card_uuid, project_id, share, source, confidence, confirmed, deleted, hlc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(card_uuid, project_id) DO UPDATE SET share = excluded.share, source = excluded.source,
          confidence = excluded.confidence, confirmed = excluded.confirmed, deleted = excluded.deleted, hlc = excluded.hlc
        """,
      arguments: [
        r.cardUuid, r.projectId, r.share, r.source.rawValue, r.confidence, r.confirmed ? 1 : 0, r.deleted ? 1 : 0,
        r.hlc,
      ])
  }

  /// Replaces a card's assignments with `next` (one source); removed ones become tombstones.
  /// Shares are scaled so they sum to at most 1.
  func setAssignments(_ db: Database, cardUuid: String, _ next: [AssignmentInput]) throws {
    local.markScopeDirty()
    let total = next.reduce(0.0) { $0 + max(0, $1.share) }
    let scale = total > 1 ? 1 / total : 1
    let keep = Set(next.map { $0.projectId })
    for cur in try cardProjects(db, cardUuid: cardUuid) where !keep.contains(cur.projectId) {
      var t = cur
      t.deleted = true
      t.hlc = local.tick()
      try putCardProject(db, t)
      try local.enqueue(db, .cardProject, cardProjectId(cardUuid, cur.projectId))
    }
    for a in next {
      try putCardProject(
        db,
        CardProjectRow(
          cardUuid: cardUuid, projectId: a.projectId, share: round3(clamp01(a.share * scale)), source: a.source,
          confidence: clamp01(a.confidence), confirmed: a.confirmed, deleted: false, hlc: local.tick()))
      try local.enqueue(db, .cardProject, cardProjectId(cardUuid, a.projectId))
    }
  }

  /// Manual choice in the timeline: one project (share 1) or none.
  func setManualProject(_ db: Database, cardUuid: String, projectId: String?) throws {
    try setAssignments(
      db, cardUuid: cardUuid,
      projectId.map { [AssignmentInput(projectId: $0, share: 1, source: .manual, confidence: 1, confirmed: true)] }
        ?? [])
  }

  func confirmProject(_ db: Database, cardUuid: String, projectId: String) throws {
    guard var cur = try cardProject(db, cardUuid: cardUuid, projectId: projectId), !cur.deleted else { return }
    local.markScopeDirty()
    cur.confirmed = true
    cur.source = .manual
    cur.confidence = 1
    cur.hlc = local.tick()
    try putCardProject(db, cur)
    try local.enqueue(db, .cardProject, cardProjectId(cardUuid, projectId))
  }

  /// Project chips for cards (Windows `attachProjects`), keyed by card uuid, largest share first.
  func projectChips(_ db: Database, cardUuids: [String]) throws -> [String: [CardProjectInfo]] {
    guard !cardUuids.isEmpty else { return [:] }
    var out: [String: [CardProjectInfo]] = [:]
    for chunk in stride(from: 0, to: cardUuids.count, by: 500).map({ Array(cardUuids[$0..<min($0 + 500, cardUuids.count)]) }) {
      let ph = chunk.map { _ in "?" }.joined(separator: ",")
      let rows = try Row.fetchAll(
        db,
        sql: """
          SELECT cp.*, p.name, p.color, p.icon FROM card_projects cp JOIN projects p ON p.id = cp.project_id
          WHERE cp.deleted = 0 AND p.deleted = 0 AND cp.card_uuid IN (\(ph)) ORDER BY cp.share DESC
          """,
        arguments: StatementArguments(chunk))
      for r in rows {
        let uuid: String = r["card_uuid"]
        out[uuid, default: []].append(
          CardProjectInfo(
            projectId: r["project_id"], name: r["name"] ?? "", color: r["color"] ?? "", icon: r["icon"] ?? "", share: r["share"] ?? 1,
            source: AssignmentSource(rawValue: r["source"] ?? "") ?? .manual, confidence: r["confidence"] ?? 1,
            confirmed: (r["confirmed"] as Int? ?? 0) == 1))
      }
    }
    return out
  }

  /// Sync facts for timeline rows (uuid, origin device, private flag, project chips).
  func cardSyncInfo(_ db: Database, recordIds: [Int64]) throws -> [Int64: CardSyncInfo] {
    guard !recordIds.isEmpty else { return [:] }
    var base: [Int64: CardSyncInfo] = [:]
    let me = local.deviceId
    for chunk in stride(from: 0, to: recordIds.count, by: 500).map({ Array(recordIds[$0..<min($0 + 500, recordIds.count)]) }) {
      let ph = chunk.map { _ in "?" }.joined(separator: ",")
      for r in try Row.fetchAll(
        db, sql: "SELECT id, uuid, device_id, metadata FROM timeline_cards WHERE id IN (\(ph))",
        arguments: StatementArguments(chunk))
      {
        let id: Int64 = r["id"]
        let dev: String? = r["device_id"]
        base[id] = CardSyncInfo(
          recordId: id, uuid: r["uuid"], deviceId: dev, remote: dev != nil && dev != me,
          isPrivate: parseJSONObject(r["metadata"])["private"]?.boolValue == true, projects: [],
          detailProjects: (parseJSONObject(r["metadata"])["detailProjects"]?.objectValue ?? [:])
            .mapValues { ($0.arrayValue ?? []).compactMap(DetailProjectRef.init) })
      }
    }
    let chips = try projectChips(db, cardUuids: base.values.compactMap { $0.uuid })
    for (k, v) in base {
      if let u = v.uuid, let c = chips[u] { base[k]?.projects = c }
    }
    return base
  }
}
