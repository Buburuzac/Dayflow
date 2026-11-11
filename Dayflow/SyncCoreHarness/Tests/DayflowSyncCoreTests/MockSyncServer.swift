//
//  An in-memory Dayflow Sync Server behind the `SyncHTTPTransport` seam — port of the mock in
//  windows/tests/sync-integration.test.ts (config / dev auth / push / pull / SSE / me / devices /
//  web-link), including its server-side card merge.
//

import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@testable import DayflowSyncCore

final class MockSyncServer: SyncHTTPTransport, @unchecked Sendable {
  struct Record {
    var change: SyncChange
    var seq: Int
    var userId: String
  }

  let devAuth: Bool
  let clientId: String
  private let lock = NSLock()
  private var seq = 0
  private(set) var records: [String: Record] = [:]
  private var tokens: [String: (userId: String, deviceId: String)] = [:]
  private var users: [String: (id: String, email: String, name: String)] = [:]
  private(set) var devices: [String: (id: String, userId: String, name: String, revoked: Bool)] = [:]
  private var streams: [UUID: (@Sendable (String) -> Void)] = [:]
  private var streamEnds: [UUID: CheckedContinuation<Void, Error>] = [:]
  private(set) var pushes: [[SyncChange]] = []
  /// When false, every request fails as if the server were down.
  var reachable = true

  init(devAuth: Bool, clientId: String = "") {
    self.devAuth = devAuth
    self.clientId = clientId
  }

  /// Server-side card merge per the contract: origin owns analysis fields, user fields merge by fieldHlc.
  private func mergeCard(_ cur: SyncChange, _ next: SyncChange) -> SyncChange {
    var cd = cur.data ?? [:]
    let nd = next.data ?? [:]
    let origin = cd["originDeviceId"]?.stringValue ?? cur.deviceId
    if next.deviceId == origin {
      for k in ["startTs", "endTs", "day", "summary", "detailedSummary", "isError"] { cd[k] = nd[k] }
      var m = nd["metadata"]?.objectValue ?? [:]
      m["private"] = cd["metadata"]?["private"]
      cd["metadata"] = .object(m.filter { !$0.value.isNull })
    }
    var fh = cur.fieldHlc ?? [:]
    var deleted = cur.deleted
    for f in CARD_USER_FIELDS {
      guard let h = next.fieldHlc?[f], h > (fh[f] ?? "") else { continue }
      fh[f] = h
      if f == "deleted" {
        deleted = next.deleted
      } else if f == "private" {
        var m = cd["metadata"]?.objectValue ?? [:]
        m["private"] = nd["metadata"]?["private"]
        cd["metadata"] = .object(m.filter { !$0.value.isNull })
      } else {
        cd[f] = nd[f]
      }
    }
    let hlc = next.hlc > cur.hlc ? next.hlc : cur.hlc
    return SyncChange(entity: .card, id: cur.id, deviceId: next.deviceId, hlc: hlc, deleted: deleted == true ? true : nil, data: cd, fieldHlc: fh)
  }

  private func json(_ status: Int, _ v: JSONValue) -> (Int, Data) {
    (status, (try? SyncCoding.encode(v)) ?? Data())
  }

  private func authUser(_ req: URLRequest) -> (userId: String, deviceId: String)? {
    guard let h = req.value(forHTTPHeaderField: "Authorization"), h.hasPrefix("Bearer ") else { return nil }
    guard let a = tokens[String(h.dropFirst(7))], devices[a.deviceId]?.revoked == false else { return nil }
    return a
  }

  private func handle(_ req: URLRequest) -> (Int, Data) {
    lock.lock()
    defer { lock.unlock() }
    let url = req.url!
    let p = url.path
    let body = req.httpBody.flatMap { try? SyncCoding.decode(JSONValue.self, from: $0) }
    let method = req.httpMethod ?? "GET"
    if p == "/api/auth/google/config" {
      return json(200, .object(["clientId": .string(clientId), "devAuth": .bool(devAuth)]))
    }
    if p == "/api/auth/dev" && method == "POST" {
      guard devAuth else { return json(404, .object(["error": .string("disabled")])) }
      let email = body?["email"]?.stringValue ?? ""
      let deviceName = body?["deviceName"]?.stringValue ?? ""
      var user = users.values.first { $0.email == email }
      if user == nil {
        let u = (id: "user-\(users.count + 1)", email: email, name: String(email.split(separator: "@").first ?? ""))
        users[u.id] = u
        user = u
      }
      let deviceId = "srv-\(devices.count + 1)"
      devices[deviceId] = (deviceId, user!.id, deviceName, false)
      let token = syncNewUUID()
      tokens[token] = (user!.id, deviceId)
      return json(
        200,
        .object([
          "deviceToken": .string(token),
          "user": .object(["id": .string(user!.id), "email": .string(email), "name": .string(user!.name), "avatarUrl": .null]),
          "device": .object([
            "id": .string(deviceId), "name": .string(deviceName), "platform": .string("macos"), "lastSeenAt": .null,
            "revoked": .bool(false),
          ]),
        ]))
    }
    guard let a = authUser(req) else { return json(401, .object(["error": .string("unauthorized")])) }
    if p == "/api/me" {
      let u = users[a.userId]!
      return json(
        200,
        .object([
          "user": .object(["id": .string(u.id), "email": .string(u.email), "name": .string(u.name), "avatarUrl": .null]),
          "devices": .array(
            devices.values.filter { $0.userId == a.userId }.sorted { $0.id < $1.id }.map { d in
              .object([
                "id": .string(d.id), "name": .string(d.name), "platform": .string("macos"), "lastSeenAt": .null,
                "revoked": .bool(d.revoked),
              ])
            }),
          "workspaces": .array([.object(["id": .string("ws-1"), "name": .string("Veles"), "role": .string("owner")])]),
        ]))
    }
    if p.hasPrefix("/api/devices/") && method == "DELETE" {
      let id = String(p.dropFirst("/api/devices/".count)).removingPercentEncoding ?? ""
      if var d = devices[id], d.userId == a.userId {
        d.revoked = true
        devices[id] = d
      }
      return json(200, .object(["ok": .bool(true)]))
    }
    if p == "/api/auth/web-link" { return json(200, .object(["url": .string("http://dashboard.local/link?code=abc")])) }
    if p == "/api/sync/push" && method == "POST" {
      let changes = (body?["changes"]).flatMap { try? SyncCoding.decode([SyncChange].self, from: SyncCoding.encode($0)) } ?? []
      pushes.append(changes)
      var rejected: [JSONValue] = []
      var accepted = 0
      for c in changes {
        if c.deviceId != a.deviceId {
          rejected.append(.object(["id": .string(c.id), "reason": .string("foreign_device")]))
          continue
        }
        // Like the real server: the change clock must carry the caller's device id.
        if !c.hlc.hasSuffix("-\(a.deviceId)") {
          rejected.append(.object(["id": .string(c.id), "reason": .string("hlc_device_mismatch")]))
          continue
        }
        let key = "\(c.entity.rawValue):\(c.id)"
        if let cur = records[key], c.entity == .card {
          seq += 1
          records[key] = Record(change: mergeCard(cur.change, c), seq: seq, userId: a.userId)
          accepted += 1
          continue
        }
        if let cur = records[key], cur.change.hlc >= c.hlc { continue }
        seq += 1
        records[key] = Record(change: c, seq: seq, userId: a.userId)
        accepted += 1
      }
      for s in streams.values { for l in ["event: changed", "data: {}", ""] { s(l) } }
      return json(
        200, .object(["accepted": .int(Int64(accepted)), "rejected": .array(rejected), "serverTime": .int(syncNowMs())]))
    }
    if p == "/api/sync/pull" {
      let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let cursor = Int(q.first { $0.name == "cursor" }?.value ?? "0") ?? 0
      let limit = Int(q.first { $0.name == "limit" }?.value ?? "1000") ?? 1000
      let visible = records.values.filter { $0.seq > cursor && ($0.userId == a.userId || $0.change.entity == .project) }
        .sorted { $0.seq < $1.seq }
      let page = Array(visible.prefix(limit))
      let changes = (try? SyncCoding.decode(JSONValue.self, from: SyncCoding.encode(page.map { $0.change }))) ?? .array([])
      return json(
        200,
        .object([
          "changes": changes, "cursor": .int(Int64(page.last?.seq ?? cursor)), "more": .bool(visible.count > limit),
        ]))
    }
    return json(404, .object(["error": .string("not found")]))
  }

  // MARK: SyncHTTPTransport

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    if !reachable { throw URLError(.cannotConnectToHost) }
    let (status, data) = handle(request)
    return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
  }

  func streamLines(_ request: URLRequest, onOpen: @escaping @Sendable () -> Void, onLine: @escaping @Sendable (String) -> Void)
    async throws
  {
    if !reachable { throw URLError(.cannotConnectToHost) }
    guard isAuthorized(request) else { throw HttpError(status: 401, message: "stream: 401") }
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
        lock.lock()
        streams[id] = onLine
        streamEnds[id] = c
        lock.unlock()
        onOpen()
        onLine(": hello")
        onLine("")
      }
    } onCancel: {
      self.endStream(id, CancellationError())
    }
  }

  private func isAuthorized(_ request: URLRequest) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return authUser(request) != nil
  }

  private func endStream(_ id: UUID, _ error: Error?) {
    lock.lock()
    let c = streamEnds.removeValue(forKey: id)
    streams.removeValue(forKey: id)
    lock.unlock()
    if let error { c?.resume(throwing: error) } else { c?.resume() }
  }

  func closeAllStreams() {
    lock.lock()
    let ids = Array(streamEnds.keys)
    lock.unlock()
    for id in ids { endStream(id, nil) }
  }

  var allPushes: [SyncChange] {
    lock.lock()
    defer { lock.unlock() }
    return pushes.flatMap { $0 }
  }
}
