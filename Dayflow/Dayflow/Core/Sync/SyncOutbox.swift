//
//  SyncOutbox.swift
//  Dayflow — Dayflow Sync client core
//
//  Turns outbox entries into wire changes (port of windows/src/main/sync/outbox.ts). Records are
//  read in their current state at push time (so several edits of one card upload once);
//  deleted observations carry a tombstone payload.
//

import Foundation
import GRDB

/// Foreground window labels of this device's frames, for `metadata.windowApps` and project rules.
protocol WindowLabelSource: AnyObject, Sendable {
  /// One label per captured frame in [startTs, endTs): "app — window title" (" — " separated).
  func windowLabels(_ db: Database, startTs: Int64, endTs: Int64) -> [String]
}

/// Bookkeeping to run only once the server has accepted a change. Never run for failed or
/// rejected pushes.
typealias SyncCommit = (Database) throws -> Void

struct BuiltBatch: @unchecked Sendable {
  /// Entries that produced the changes, index-aligned with `changes`
  var used: [OutboxEntry] = []
  var changes: [SyncChange] = []
  /// Bookkeeping per change, index-aligned with `changes`: run for the ones the server accepted
  var commits: [[SyncCommit]] = []
  /// Entries with nothing to send (row gone, error card, …) — safe to drop
  var dropped: [OutboxEntry] = []
}

/// Splits "<a>:<b>" composite ids (uuids contain no ':').
func splitPair(_ id: String) -> (String, String)? {
  guard let i = id.firstIndex(of: ":") else { return nil }
  let a = String(id[..<i])
  let b = String(id[id.index(after: i)...])
  guard !a.isEmpty, !b.isEmpty else { return nil }
  return (a, b)
}

struct SyncOutboxBuilder: @unchecked Sendable {
  let local: SyncLocal
  let repo: SyncRepo
  let docs: SyncDocSources
  let labels: WindowLabelSource?

  init(local: SyncLocal, docs: SyncDocSources, labels: WindowLabelSource?) {
    self.local = local
    self.repo = SyncRepo(local: local)
    self.docs = docs
    self.labels = labels
  }

  /// `metadata.windowApps` of the local cards among `entries`, keyed by card uuid. Run it in a
  /// read before the push's write transaction: window labels come from the accessibility log on
  /// disk and must not be read while holding the writer.
  func windowAppsForBatch(_ db: Database, _ entries: [OutboxEntry]) -> [String: [String]] {
    guard labels != nil else { return [:] }
    let uuids = entries.filter { $0.entity == .card }.map { $0.entityId }
    var out: [String: [String]] = [:]
    for chunk in stride(from: 0, to: uuids.count, by: 500).map({ Array(uuids[$0..<min($0 + 500, uuids.count)]) }) {
      let ph = chunk.map { _ in "?" }.joined(separator: ",")
      guard
        let rows = try? Row.fetchAll(
          db,
          sql: """
            SELECT uuid, start_ts, end_ts FROM timeline_cards
             WHERE uuid IN (\(ph)) AND (device_id IS NULL OR device_id = ?)
            """,
          arguments: StatementArguments(chunk + [local.deviceId]))
      else { continue }
      for r in rows {
        let uuid: String = r["uuid"] ?? ""
        out[uuid] = windowApps(db, r["start_ts"] ?? 0, r["end_ts"] ?? 0)
      }
    }
    return out
  }

  /// Distinct process names seen in this device's frames for a card (metadata.windowApps).
  private func windowApps(_ db: Database, _ startTs: Int64, _ endTs: Int64) -> [String] {
    guard let labels else { return [] }
    var seen = Set<String>()
    var out: [String] = []
    for l in labels.windowLabels(db, startTs: startTs, endTs: endTs) {
      let p = (l.components(separatedBy: " — ").first ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !p.isEmpty, !seen.contains(p) {
        seen.insert(p)
        out.append(p)
      }
    }
    return Array(out.prefix(20))
  }

  /// True when this card has a confirmed assignment to a project that is neither deleted nor archived.
  static func hasConfirmedLiveProject(_ db: Database, _ cardUuid: String) throws -> Bool {
    try Row.fetchOne(
      db,
      sql: """
        SELECT 1 FROM card_projects cp JOIN projects p ON p.id = cp.project_id
         WHERE cp.card_uuid = ? AND cp.confirmed = 1 AND cp.deleted = 0 AND p.deleted = 0 AND p.archived = 0 LIMIT 1
        """,
      arguments: [cardUuid]) != nil
  }

  /// Scope a local card should have now under the device's sync policy.
  func currentCardScope(_ db: Database, _ row: Row) throws -> CardScope {
    let meta = parseJSONObject(row["metadata"])
    return cardScope(
      category: row["category"] ?? "", isPrivate: meta["private"]?.boolValue == true,
      hasConfirmedLiveProject: try SyncOutboxBuilder.hasConfirmedLiveProject(db, row["uuid"] ?? ""),
      policy: local.policy)
  }

  /// The wire id of an entry's change (docs are keyed `<userId>:<day|kind>`).
  static func changeId(_ e: OutboxEntry, userId: String) -> String {
    switch e.entity {
    case .standup, .dayGoal, .userDoc: return "\(userId):\(e.entityId)"
    default: return e.entityId
    }
  }

  /// `windowApps`: precomputed `metadata.windowApps` by card uuid (`windowAppsForBatch`); cards
  /// missing from it are computed here.
  func buildChange(
    _ db: Database, userId: String, _ e: OutboxEntry, windowApps precomputed: [String: [String]]? = nil,
    onSent: (@escaping SyncCommit) -> Void
  ) throws -> SyncChange? {
    let me = local.deviceId
    switch e.entity {
    case .card:
      guard let r = try Row.fetchOne(db, sql: "SELECT * FROM timeline_cards WHERE uuid = ?", arguments: [e.entityId])
      else { return nil }
      let meta = parseJSONObject(r["metadata"])
      let category: String = r["category"] ?? ""
      if category == ERROR_CATEGORY || meta["isError"]?.boolValue == true { return nil }
      let rowDevice: String? = r["device_id"]
      let isLocal = rowDevice == nil || rowDevice == me
      let startTs: Int64 = r["start_ts"] ?? 0
      let endTs: Int64 = r["end_ts"] ?? 0
      var metadata: [String: JSONValue] = [
        "distractions": meta["distractions"]?.arrayValue.map { .array($0) } ?? .array([]),
        "appSites": meta["appSites"] ?? .null,
      ]
      // Always a boolean: the server only takes a boolean, so un-marking a card must say `false`.
      metadata["private"] = .bool(meta["private"]?.boolValue == true)
      if let detailProjects = meta["detailProjects"]?.objectValue {
        metadata["detailProjects"] = .object(detailProjects)
      }
      if isLocal {
        let apps = precomputed?[e.entityId] ?? windowApps(db, startTs, endTs)
        metadata["windowApps"] = .array(apps.map { .string($0) })
      } else if let w = meta["windowApps"]?.arrayValue {
        metadata["windowApps"] = .array(w)
      }
      var data: [String: JSONValue] = [
        "userId": .string(userId),
        "startTs": .int(startTs),
        "endTs": .int(endTs),
        "day": .string(r["day"] ?? ""),
        "title": .string(r["title"] ?? ""),
        "summary": .string(r["summary"] ?? ""),
        "detailedSummary": .string(r["detailed_summary"] ?? ""),
        "category": .string(category),
        "subcategory": .string(r["subcategory"] ?? ""),
        "metadata": .object(metadata),
        "isError": .bool(false),
        "originDeviceId": .string(isLocal ? me : (rowDevice ?? me)),
      ]
      // The record HLC is the card's creation (analysis never edits a card in place, except an idle
      // card stretched by `cardAnalysisChanged`, which re-clocks it). Every user-editable field gets
      // an explicit HLC (its last edit, else creation), and the change's HLC is the newest of them,
      // so receivers and the server can merge field by field.
      let rowHlc: String = r["hlc"] ?? ""
      var recordHlc = isLocal ? local.localHlc(rowHlc) : rowHlc
      let stored = parseJSONObject(r["field_hlc"])
      var fieldHlc: [String: String] = [:]
      for f in CARD_USER_FIELDS { fieldHlc[f] = stored[f]?.stringValue ?? recordHlc }

      // Sync scope (SyncScope.swift): only for cards this device generated — other devices' cards
      // arrive already scoped by the device that made them.
      var scope: CardScope = .full
      if isLocal {
        scope = try currentCardScope(db, r)
        let storedScopeHlc: String? = r["scope_hlc"]
        var scopeHlc = storedScopeHlc.map { local.localHlc($0) } ?? ""
        // A card never sent under a scope was uploaded as-is before this feature (or not yet at all).
        let sentRaw: String? = r["sync_scope"]
        let sent = sentRaw.flatMap { CardScope(rawValue: $0) } ?? .full
        let changed = scope != sent
        if changed { scopeHlc = local.tick() }  // must beat the copy the server already holds
        if !scopeHlc.isEmpty {
          // Analysis fields (summaries, metadata) must replace the server's copy.
          if scopeHlc > recordHlc { recordHlc = scopeHlc }
          // Only the fields the scope rewrites get the newer clock, so edits made on other devices
          // to anything else keep their place in the per-field merge.
          var bumped = ["title", "category", "subcategory"]
          if scope == .excluded || (changed && sent == .excluded) { bumped.append("deleted") }
          for f in bumped where scopeHlc > (fieldHlc[f] ?? "") { fieldHlc[f] = scopeHlc }
        }
        data = redactCardData(data, scope: scope)
        // Recorded only once the server has accepted this upload: the scope it now holds, and the
        // field clocks it holds (local = max(local, sent)). After a sign-out / sign-in this device
        // has a new id, so the scoped echo of this upload ("Out of scope", a wiped personal card)
        // no longer looks like our own write; with the clocks recorded it is not newer either.
        let uuid = e.entityId
        let recorded = scopeHlc
        let scopeValue = scope.rawValue
        let sentClocks = fieldHlc
        onSent { db in
          let cur = try String.fetchOne(db, sql: "SELECT field_hlc FROM timeline_cards WHERE uuid = ?", arguments: [uuid])
          var fh = parseJSONObject(cur)
          for (f, h) in sentClocks where !h.isEmpty && h > (fh[f]?.stringValue ?? "") { fh[f] = .string(h) }
          try db.execute(
            sql: "UPDATE timeline_cards SET sync_scope = ?, scope_hlc = ?, field_hlc = ? WHERE uuid = ?",
            arguments: [scopeValue, recorded.isEmpty ? nil : recorded, fh.jsonString, uuid])
        }
      }
      // The server requires the change clock to carry this device's id: for our own card that is
      // the record clock; for another device's card it is our newest edit of it.
      let mine = fieldHlc.values.filter { $0.hasSuffix("-\(me)") }
      let hlc: String
      if isLocal {
        hlc = recordHlc
      } else {
        let m = maxHlc(Array(mine))
        hlc = m.isEmpty ? local.tick() : m
      }
      var ch = SyncChange(entity: .card, id: e.entityId, deviceId: me, hlc: hlc, data: data, fieldHlc: fieldHlc)
      let isDeleted: Int = r["is_deleted"] ?? 0
      // Always explicit: the server keeps its value when the field is absent, so a card leaving
      // "excluded" (or restored) must say `false`.
      ch.deleted = isDeleted == 1 || scope == .excluded
      return ch

    case .observation:
      let r = try Row.fetchOne(db, sql: "SELECT * FROM observations WHERE uuid = ?", arguments: [e.entityId])
      let t = parseJSONObject(e.payload)
      // Tombstones win even if the row still exists locally (observation upload switched off).
      if t["deleted"]?.boolValue == true, let th = t["hlc"]?.stringValue {
        let uuid = e.entityId
        onSent { db in
          try db.execute(sql: "UPDATE observations SET uploaded = 0 WHERE uuid = ?", arguments: [uuid])
        }
        return SyncChange(entity: .observation, id: e.entityId, deviceId: me, hlc: local.localHlc(th), deleted: true)
      }
      guard let r else { return nil }
      let dev: String? = r["device_id"]
      if let dev, dev != me { return nil }
      if !local.policy.observations { return nil }
      // Re-sent after upload was switched back on: a fresh clock beats the earlier tombstone.
      let revive = t["revive"]?.stringValue
      let data: [String: JSONValue] = [
        "userId": .string(userId),
        "startTs": .int(r["start_ts"] ?? 0),
        "endTs": .int(r["end_ts"] ?? 0),
        "text": .string(r["observation"] ?? ""),
      ]
      let uuid = e.entityId
      let local = self.local
      onSent { db in
        try db.execute(sql: "UPDATE observations SET uploaded = 1 WHERE uuid = ?", arguments: [uuid])
        // Observation upload was switched off while this push was in flight: the server holds the
        // text now, so remove it again (setPolicy's requeue only saw uploaded = 0).
        if !local.policy.observations {
          let payload: [String: JSONValue] = ["deleted": .bool(true), "hlc": .string(local.tick())]
          try local.enqueue(db, .observation, uuid, payload: payload.jsonString)
        }
      }
      return SyncChange(
        entity: .observation, id: e.entityId, deviceId: me,
        hlc: local.localHlc(revive ?? (r["hlc"] ?? "")), data: data)

    case .cardProject:
      guard let pair = splitPair(e.entityId),
        let row = try repo.cardProject(db, cardUuid: pair.0, projectId: pair.1),
        let card = try Row.fetchOne(db, sql: "SELECT * FROM timeline_cards WHERE uuid = ?", arguments: [pair.0])
      else { return nil }
      let cat: String = card["category"] ?? ""
      if cat == ERROR_CATEGORY || parseJSONObject(card["metadata"])["isError"]?.boolValue == true { return nil }
      // A personal card's project links stay on this Mac along with the card.
      let cardDev: String? = card["device_id"]
      let localCard = cardDev == nil || cardDev == me
      if localCard, try currentCardScope(db, card) == .excluded { return nil }
      let data: [String: JSONValue] = [
        "cardId": .string(row.cardUuid),
        "projectId": .string(row.projectId),
        "share": .double(row.share),
        "source": .string(row.source.rawValue),
        "confidence": .double(row.confidence),
        "confirmed": .bool(row.confirmed),
      ]
      var ch = SyncChange(
        entity: .cardProject, id: e.entityId, deviceId: me, hlc: local.localHlc(row.hlc), data: data)
      if row.deleted { ch.deleted = true }
      return ch

    case .project:
      guard let p = try repo.project(db, e.entityId) else { return nil }
      var data: [String: JSONValue] = [
        "workspaceId": .string(p.workspaceId),
        "name": .string(p.name),
        "color": .string(p.color),
        "icon": .string(p.icon),
        "description": .string(p.description),
        "rules": SyncCoding.value(p.rules),
        "defaultShare": .string(p.defaultShare.rawValue),
        "archived": .bool(p.archived),
      ]
      data["odoo"] = SyncCoding.value(p.odoo)
      var ch = SyncChange(entity: .project, id: p.id, deviceId: me, hlc: p.hlc, data: data)
      if p.deleted { ch.deleted = true }
      return ch

    case .projectMember:
      guard let pair = splitPair(e.entityId), let m = try repo.memberRow(db, projectId: pair.0, userId: pair.1)
      else { return nil }
      let data: [String: JSONValue] = [
        "projectId": .string(pair.0),
        "userId": .string(pair.1),
        "shareLevel": m.shareLevel.map { .string($0.rawValue) } ?? .null,
      ]
      var ch = SyncChange(entity: .projectMember, id: e.entityId, deviceId: me, hlc: m.hlc, data: data)
      if m.deleted { ch.deleted = true }
      return ch

    case .standup, .dayGoal, .userDoc:
      let docEntity: DocEntity = e.entity == .standup ? .standup : (e.entity == .dayGoal ? .dayGoal : .userDoc)
      let hlc = try repo.metaHlc(db, "\(e.entity.rawValue):\(e.entityId)")
      if hlc.isEmpty { return nil }
      let payload = try docs.read(db, docEntity, e.entityId)
      let id = "\(userId):\(e.entityId)"
      guard let payload else {
        return SyncChange(entity: e.entity, id: id, deviceId: me, hlc: hlc, deleted: true)
      }
      let data: [String: JSONValue] =
        e.entity == .userDoc
        ? ["userId": .string(userId), "kind": .string(e.entityId), "payload": payload]
        : ["userId": .string(userId), "day": .string(e.entityId), "payload": payload]
      return SyncChange(entity: e.entity, id: id, deviceId: me, hlc: hlc, data: data)
    }
  }

  /// Builds up to `maxChanges` changes / `maxBytes` of JSON from the head of the outbox. A batch
  /// never holds two changes with the same id (a standup and a day goal share `<userId>:<day>`):
  /// the server reports rejections by id only, so the second one waits for the next batch.
  func buildBatch(
    _ db: Database, userId: String, _ entries: [OutboxEntry], maxChanges: Int = 1000, maxBytes: Int = 4_500_000,
    windowApps: [String: [String]]? = nil
  ) -> BuiltBatch {
    var out = BuiltBatch()
    var bytes = 20
    var ids = Set<String>()
    for e in entries {
      if out.changes.count >= maxChanges { break }
      if ids.contains(SyncOutboxBuilder.changeId(e, userId: userId)) { break }
      var commits: [SyncCommit] = []
      var ch: SyncChange?
      do {
        ch = try buildChange(db, userId: userId, e, windowApps: windowApps, onSent: { commits.append($0) })
      } catch {
        print("⚠️ [Sync] could not build change \(e.entity.rawValue): \(error)")
      }
      guard let ch else {
        out.dropped.append(e)
        continue
      }
      let size = ((try? SyncCoding.encode(ch))?.count ?? 0) + 1
      if !out.changes.isEmpty && bytes + size > maxBytes { break }
      bytes += size
      ids.insert(ch.id)
      out.used.append(e)
      out.changes.append(ch)
      out.commits.append(commits)
    }
    return out
  }

  /// How far back scope changes are re-checked (the first upload covers the last 30 days).
  static let RESCOPE_WINDOW_DAYS: Int64 = 31

  /// Queues every local card whose scope differs from what the server last received — after a project
  /// was confirmed, archived or deleted, a category edit, or a change of the sync policy. Returns the
  /// number of cards queued. With `full` (the default, and whenever `SyncLocal.takeScopeDirty()` says
  /// so) older cards that were sent before are re-checked too; otherwise only the recent window.
  @discardableResult
  func rescopeCards(_ db: Database, full: Bool = true, nowSec: Int64 = Int64(Date().timeIntervalSince1970)) throws
    -> Int
  {
    let since = nowSec - SyncOutboxBuilder.RESCOPE_WINDOW_DAYS * 86400
    let span = full ? "(c.start_ts >= ? OR c.sync_scope IS NOT NULL)" : "c.start_ts >= ?"
    // One query: the per-card project check runs inside SQLite, not as a query per card.
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT c.uuid, c.category, c.metadata, c.sync_scope,
               EXISTS (SELECT 1 FROM card_projects cp JOIN projects p ON p.id = cp.project_id
                        WHERE cp.card_uuid = c.uuid AND cp.confirmed = 1 AND cp.deleted = 0
                          AND p.deleted = 0 AND p.archived = 0) AS has_project
          FROM timeline_cards c
         WHERE c.uuid IS NOT NULL AND (c.device_id IS NULL OR c.device_id = ?) AND c.category != ?
           AND \(span)
        """,
      arguments: [local.deviceId, ERROR_CATEGORY, since])
    var n = 0
    let policy = local.policy
    for r in rows {
      let meta = parseJSONObject(r["metadata"])
      if meta["isError"]?.boolValue == true { continue }
      let scope = cardScope(
        category: r["category"] ?? "", isPrivate: meta["private"]?.boolValue == true,
        hasConfirmedLiveProject: (r["has_project"] as Int? ?? 0) == 1, policy: policy)
      let sentRaw: String? = r["sync_scope"]
      let sent = sentRaw ?? CardScope.full.rawValue
      if scope.rawValue != sent {
        try local.enqueue(db, .card, r["uuid"])
        n += 1
      }
    }
    return n
  }

  /// Observation upload switched off: tombstones for every observation the server holds (no time
  /// window; the server wipes their text). Switched on: re-sends the recent ones with a clock newer
  /// than those tombstones.
  @discardableResult
  func requeueObservations(_ db: Database, upload: Bool, nowSec: Int64 = Int64(Date().timeIntervalSince1970)) throws
    -> Int
  {
    let own = "uuid IS NOT NULL AND (device_id IS NULL OR device_id = ?)"
    let uuids: [String]
    if upload {
      uuids = try String.fetchAll(
        db, sql: "SELECT uuid FROM observations WHERE \(own) AND start_ts >= ?",
        arguments: [local.deviceId, nowSec - SyncOutboxBuilder.RESCOPE_WINDOW_DAYS * 86400])
    } else {
      uuids = try String.fetchAll(
        db, sql: "SELECT uuid FROM observations WHERE \(own) AND uploaded = 1", arguments: [local.deviceId])
    }
    for u in uuids {
      let payload: [String: JSONValue] =
        upload ? ["revive": .string(local.tick())] : ["deleted": .bool(true), "hlc": .string(local.tick())]
      try local.enqueue(db, .observation, u, payload: payload.jsonString)
    }
    return uuids.count
  }
}

/// Runs the bookkeeping of the accepted changes (see `SyncCommit`).
func commitAccepted(_ db: Database, _ batch: BuiltBatch, accepted: (Int) -> Bool) throws {
  for i in 0..<batch.changes.count where accepted(i) {
    for fn in batch.commits[i] { try fn(db) }
  }
}
