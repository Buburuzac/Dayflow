//
//  SyncDocs.swift
//  Dayflow — Dayflow Sync client core
//
//  Synced records that live outside the sync tables (port of windows/src/main/sync/docs.ts):
//  standups (daily_standup_entries), day goals (day_goals + day_goal_categories) and the
//  'categories' user doc (CategoryStore / UserDefaults, through `CategoryDocBridge`).
//
//  Payloads use the Windows shapes so both clients read each other's records:
//  - standup  = DailyStandupDraft JSON. Same keys on both; the Mac stores `generation.generatedAt`
//               as JSONEncoder's default (seconds since 2001-01-01), Windows as an ISO-8601 string.
//               Uploads carry the ISO string; downloads are converted back.
//  - day_goal = DayGoalPlan { day, focusTargetMinutes, distractionLimitMinutes, focusCategories[],
//               distractionCategories[] ({ categoryID, name, colorHex, sortOrder }), isSkipped,
//               createdAt, updatedAt } — identical tables on both platforms.
//  - categories = [{ name, color, description, isIdle? }].
//

import Foundation
import GRDB

protocol SyncDocSources {
  /// Current payload (nil = gone).
  func read(_ db: Database, _ entity: DocEntity, _ id: String) throws -> JSONValue?
  /// Applies a pulled payload (nil = delete) without queueing it for upload.
  func write(_ db: Database, _ entity: DocEntity, _ id: String, _ payload: JSONValue?) throws
  /// The category store behind the 'categories' user doc, when there is one: pulled lists are then
  /// merged by `RemoteApplier` (`planCategoryApply`) instead of going through `write`.
  var categoryBridge: CategoryDocBridge? { get }
}

extension SyncDocSources {
  var categoryBridge: CategoryDocBridge? { nil }
}

/// One category in the shared 'categories' user doc (Windows `Category`).
struct SyncCategory: Equatable, Sendable {
  var name: String
  /// "#RRGGBB" or "#RRGGBBAA"
  var color: String
  var description: String
  var isIdle: Bool

  init(name: String, color: String, description: String, isIdle: Bool = false) {
    self.name = name
    self.color = color
    self.description = description
    self.isIdle = isIdle
  }

  var json: JSONValue {
    var o: [String: JSONValue] = [
      "name": .string(name), "color": .string(color), "description": .string(description),
    ]
    if isIdle { o["isIdle"] = .bool(true) }
    return .object(o)
  }
}

/// Bridges the categories doc to the app's category store (CategoryStore on the Mac).
protocol CategoryDocBridge: AnyObject, Sendable {
  /// The user's categories now (any thread). nil when the store has none.
  func currentCategories() -> [SyncCategory]?
  /// Replaces the user's categories with a pulled list (already validated). May apply
  /// asynchronously (e.g. on the main actor) and must not report the change back as a local edit.
  func applyRemoteCategories(_ categories: [SyncCategory])
}

private func isHexColor(_ s: String) -> Bool {
  let u = Array(s.utf8)
  guard u.first == 0x23, u.count == 7 || u.count == 9 else { return false }
  return u.dropFirst().allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66) }
}

/// Windows `validateCategories`: 1–30 items, name ≤ 60 (trimmed, unique case-insensitively), hex color,
/// description ≤ 500. Returns nil when the payload is invalid (then it is ignored, as on Windows).
func validateSyncCategories(_ payload: JSONValue?) -> [SyncCategory]? {
  guard let arr = payload?.arrayValue, !arr.isEmpty, arr.count <= 30 else { return nil }
  var out: [SyncCategory] = []
  for item in arr {
    guard let o = item.objectValue, let rawName = o["name"]?.stringValue, rawName.count <= 60 else { return nil }
    let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, let color = o["color"]?.stringValue, color.count <= 9, isHexColor(color) else { return nil }
    let desc: String
    switch o["description"] {
    case nil, .some(.null): desc = ""
    case .some(.string(let s)) where s.count <= 500: desc = s
    default: return nil
    }
    out.append(SyncCategory(name: name, color: color, description: desc, isIdle: o["isIdle"]?.boolValue == true))
  }
  guard Set(out.map { $0.name.lowercased() }).count == out.count else { return nil }
  return out
}

/// A category renamed on another device: `from` disappeared and `to` took its place.
struct CategoryRename: Equatable, Sendable {
  var from: String
  var to: String
}

/// How a pulled categories list is applied locally.
struct CategoryApplyPlan: Equatable, Sendable {
  /// The list to apply (CategoryStore keeps ids, details and the idle category itself).
  var apply: [SyncCategory]
  /// Renames detected against the local list (their exclusions carry over).
  var renames: [CategoryRename]
  /// The applied list differs from the pulled one: upload it.
  var pushBack: Bool
}

/// Plans the apply of a pulled 'categories' doc onto the local list (both in display order).
/// - First pull after sign-in (no local clock for the doc yet): nothing local is deleted. The
///   server list is kept and local categories it lacks (by name) are appended, then uploaded.
/// - Otherwise the pulled list wins. A category that disappeared while a new one took the same
///   index is a rename (so an excluded category keeps its exclusion under the new name).
func planCategoryApply(local: [SyncCategory], remote: [SyncCategory], firstPull: Bool) -> CategoryApplyPlan {
  let remoteKeys = Set(remote.map { syncCategoryKey($0.name) })
  if firstPull {
    var merged = remote
    var keys = remoteKeys
    for c in local where !c.isIdle && merged.count < 30 {
      let k = syncCategoryKey(c.name)
      guard !k.isEmpty, !keys.contains(k) else { continue }
      keys.insert(k)
      merged.append(c)
    }
    return CategoryApplyPlan(apply: merged, renames: [], pushBack: merged.count > remote.count)
  }
  let localKeys = Set(local.map { syncCategoryKey($0.name) })
  var renames: [CategoryRename] = []
  for (i, r) in remote.enumerated() where i < local.count {
    let l = local[i]
    guard !r.isIdle, !l.isIdle, !localKeys.contains(syncCategoryKey(r.name)),
      !remoteKeys.contains(syncCategoryKey(l.name))
    else { continue }
    renames.append(CategoryRename(from: l.name, to: r.name))
  }
  return CategoryApplyPlan(apply: remote, renames: renames, pushBack: false)
}

/// Upload form of the local categories, clipped so Windows' validation accepts it.
func categoriesPayload(_ cats: [SyncCategory]) -> JSONValue? {
  var seen = Set<String>()
  var out: [JSONValue] = []
  for c in cats {
    let name = String(c.name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
    guard !name.isEmpty, !seen.contains(name.lowercased()) else { continue }
    seen.insert(name.lowercased())
    let color = isHexColor(c.color) ? c.color : "#E5E7EB"
    out.append(
      SyncCategory(name: name, color: color, description: String(c.description.prefix(500)), isIdle: c.isIdle).json)
    if out.count == 30 { break }
  }
  return out.isEmpty ? nil : .array(out)
}

// MARK: - Standup payload mapping

private let iso8601: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

private let iso8601NoFraction = ISO8601DateFormatter()

private let RECAP_RUNTIME: [String: String] = [
  "dayflow": "dayflow_backend", "gemini": "gemini_direct", "local": "local_llm", "claude": "chat_cli",
  "chatgpt": "chat_cli", "none": "disabled",
]

private let DEFAULT_TITLES = (highlights: "Yesterday's highlights", tasks: "Today's tasks", blockers: "Blockers")

/// Mac stored standup JSON → shared (Windows) payload.
func standupPayloadFromMac(_ json: String) -> JSONValue? {
  guard var o = JSONValue.parse(json)?.objectValue else { return nil }
  if var g = o["generation"]?.objectValue {
    if let n = g["generatedAt"]?.numberValue {
      g["generatedAt"] = .string(iso8601.string(from: Date(timeIntervalSinceReferenceDate: n)))
    }
    o["generation"] = .object(g)
  }
  return .object(o)
}

/// Shared payload → JSON the Mac's `DailyStandupDraft` decoder accepts (Windows `decodeDraft` defaults).
func standupJSONForMac(_ payload: JSONValue) -> String? {
  guard let o = payload.objectValue else { return nil }
  func items(_ v: JSONValue?) -> JSONValue {
    .array(
      (v?.arrayValue ?? []).compactMap { i -> JSONValue? in
        guard let io = i.objectValue, let text = io["text"]?.stringValue else { return nil }
        let id = io["id"]?.stringValue.flatMap { UUID(uuidString: $0)?.uuidString } ?? UUID().uuidString
        return .object(["id": .string(id), "text": .string(text)])
      })
  }
  var out: [String: JSONValue] = [
    "highlightsTitle": .string(o["highlightsTitle"]?.stringValue ?? DEFAULT_TITLES.highlights),
    "highlights": items(o["highlights"]),
    "tasksTitle": .string(o["tasksTitle"]?.stringValue ?? DEFAULT_TITLES.tasks),
    "tasks": items(o["tasks"]),
    "blockersTitle": .string(o["blockersTitle"]?.stringValue ?? DEFAULT_TITLES.blockers),
    "blockersBody": .string(o["blockersBody"]?.stringValue ?? ""),
  ]
  if let g = o["generation"]?.objectValue, let provider = g["provider"]?.stringValue,
    RECAP_RUNTIME[provider] != nil
  {
    var gen: [String: JSONValue] = [
      "provider": .string(provider),
      "runtime": .string(g["runtime"]?.stringValue ?? RECAP_RUNTIME[provider]!),
    ]
    if let m = g["modelOrTool"]?.stringValue { gen["modelOrTool"] = .string(m) }
    if let s = g["sourceDay"]?.stringValue { gen["sourceDay"] = .string(s) }
    if let at = g["generatedAt"] {
      if let n = at.numberValue {
        gen["generatedAt"] = .double(n)
      } else if let s = at.stringValue, let d = iso8601.date(from: s) ?? iso8601NoFraction.date(from: s) {
        gen["generatedAt"] = .double(d.timeIntervalSinceReferenceDate)
      }
    }
    out["generation"] = .object(gen)
  }
  return JSONValue.object(out).jsonString
}

// MARK: - Mac doc sources

/// Standups and day goals straight from the Mac tables; categories through the bridge.
final class MacSyncDocSources: SyncDocSources, @unchecked Sendable {
  let categories: CategoryDocBridge?

  init(categories: CategoryDocBridge?) {
    self.categories = categories
  }

  var categoryBridge: CategoryDocBridge? { categories }

  func read(_ db: Database, _ entity: DocEntity, _ id: String) throws -> JSONValue? {
    switch entity {
    case .standup:
      guard
        let json = try String.fetchOne(
          db, sql: "SELECT payload_json FROM daily_standup_entries WHERE standup_day = ?", arguments: [id])
      else { return nil }
      return standupPayloadFromMac(json)
    case .dayGoal:
      return try MacSyncDocSources.readDayGoal(db, day: id)
    case .userDoc:
      guard id == "categories", let cats = categories?.currentCategories() else { return nil }
      return categoriesPayload(cats)
    }
  }

  func write(_ db: Database, _ entity: DocEntity, _ id: String, _ payload: JSONValue?) throws {
    switch entity {
    case .standup:
      guard syncIsDayString(id) else { return }
      guard let payload else {
        try db.execute(sql: "DELETE FROM daily_standup_entries WHERE standup_day = ?", arguments: [id])
        return
      }
      guard let json = standupJSONForMac(payload) else { return }
      try db.execute(
        sql: """
          INSERT INTO daily_standup_entries (standup_day, payload_json, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(standup_day) DO UPDATE SET payload_json = excluded.payload_json, updated_at = CURRENT_TIMESTAMP
          """,
        arguments: [id, json])
    case .dayGoal:
      guard syncIsDayString(id) else { return }
      guard let payload else {
        try db.execute(sql: "DELETE FROM day_goals WHERE day = ?", arguments: [id])
        try db.execute(sql: "DELETE FROM day_goal_categories WHERE day = ?", arguments: [id])
        return
      }
      guard let p = payload.objectValue else { return }
      try MacSyncDocSources.writeDayGoal(db, day: id, p)
    case .userDoc:
      guard id == "categories", let bridge = categories, let cats = validateSyncCategories(payload) else { return }
      bridge.applyRemoteCategories(cats)
    }
  }

  static func readDayGoal(_ db: Database, day: String) throws -> JSONValue? {
    guard
      let r = try Row.fetchOne(
        db,
        sql: """
          SELECT day, focus_target_minutes, distraction_limit_minutes, is_skipped, created_at, updated_at
          FROM day_goals WHERE day = ?
          """, arguments: [day])
    else { return nil }
    var focus: [JSONValue] = []
    var distraction: [JSONValue] = []
    for c in try Row.fetchAll(
      db,
      sql: """
        SELECT kind, category_id, category_name, category_color_hex, sort_order
        FROM day_goal_categories WHERE day = ? ORDER BY kind, sort_order
        """, arguments: [day])
    {
      let cid: String = c["category_id"] ?? ""
      let cname: String = c["category_name"] ?? ""
      let ccolor: String = c["category_color_hex"] ?? ""
      let corder: Int64 = c["sort_order"] ?? 0
      var snapObj: [String: JSONValue] = [:]
      snapObj["categoryID"] = .string(cid)
      snapObj["name"] = .string(cname)
      snapObj["colorHex"] = .string(ccolor)
      snapObj["sortOrder"] = .int(corder)
      let snap = JSONValue.object(snapObj)
      let kind: String = c["kind"] ?? ""
      if kind == "focus" { focus.append(snap) } else if kind == "distraction" { distraction.append(snap) }
    }
    let dayValue: String = r["day"] ?? day
    let focusMinutes: Int64 = r["focus_target_minutes"] ?? 0
    let distractionMinutes: Int64 = r["distraction_limit_minutes"] ?? 0
    let skipped: Int64 = r["is_skipped"] ?? 0
    let createdAt: Int64 = r["created_at"] ?? 0
    let updatedAt: Int64 = r["updated_at"] ?? 0
    var o: [String: JSONValue] = [:]
    o["day"] = .string(dayValue)
    o["focusTargetMinutes"] = .int(focusMinutes)
    o["distractionLimitMinutes"] = .int(distractionMinutes)
    o["focusCategories"] = .array(focus)
    o["distractionCategories"] = .array(distraction)
    o["isSkipped"] = .bool(skipped != 0)
    o["createdAt"] = .int(createdAt)
    o["updatedAt"] = .int(updatedAt)
    return .object(o)
  }

  /// Same writes as StorageManager.saveDayGoalPlan (and Windows DailyStore.saveDayGoalPlan).
  static func writeDayGoal(_ db: Database, day: String, _ p: [String: JSONValue]) throws {
    let now = Int64(Date().timeIntervalSince1970)
    let created = p["createdAt"]?.intValue ?? 0
    let updated = p["updatedAt"]?.intValue ?? 0
    try db.execute(
      sql: """
        INSERT INTO day_goals(day, focus_target_minutes, distraction_limit_minutes, is_skipped, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET
            focus_target_minutes = excluded.focus_target_minutes,
            distraction_limit_minutes = excluded.distraction_limit_minutes,
            is_skipped = excluded.is_skipped,
            updated_at = excluded.updated_at
        """,
      arguments: [
        day, p["focusTargetMinutes"]?.intValue ?? 0, p["distractionLimitMinutes"]?.intValue ?? 0,
        p["isSkipped"]?.boolValue == true ? 1 : 0, created > 0 ? created : now, updated > 0 ? updated : now,
      ])
    try db.execute(sql: "DELETE FROM day_goal_categories WHERE day = ?", arguments: [day])
    for (kind, key) in [("focus", "focusCategories"), ("distraction", "distractionCategories")] {
      var seen = Set<String>()
      for (index, item) in (p[key]?.arrayValue ?? []).enumerated() {
        guard let o = item.objectValue else { continue }
        let name = o["name"]?.stringValue ?? ""
        let cid = o["categoryID"]?.stringValue ?? name.lowercased()
        // (day, kind, category_id) is the primary key.
        guard !cid.isEmpty, !seen.contains(cid) else { continue }
        seen.insert(cid)
        try db.execute(
          sql: """
            INSERT INTO day_goal_categories(day, kind, category_id, category_name, category_color_hex, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
          arguments: [day, kind, cid, name, o["colorHex"]?.stringValue ?? "#E5E7EB", index])
      }
    }
  }
}

/// Docs that are never synced (tests of the card mechanics).
struct NoSyncDocs: SyncDocSources {
  func read(_ db: Database, _ entity: DocEntity, _ id: String) throws -> JSONValue? { nil }
  func write(_ db: Database, _ entity: DocEntity, _ id: String, _ payload: JSONValue?) throws {}
}
