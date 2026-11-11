//
//  SyncClient.swift
//  Dayflow — Dayflow Sync client core
//
//  HTTP client for the Dayflow Sync Server (port of windows/src/main/sync/client.ts).
//  URLSession for requests; Server-Sent Events read line by line from `URLSession.bytes(for:)`
//  on Apple platforms (a delegate-based stream where FoundationNetworking lacks `bytes`).
//

import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

struct HttpError: Error, LocalizedError, Equatable {
  /// HTTP status; 0 = the server could not be reached.
  let status: Int
  let message: String
  var errorDescription: String? { message }
}

/// Plain error with a user-facing message.
struct SyncError: Error, LocalizedError, Equatable {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

func syncErrorMessage(_ error: Error) -> String {
  if let e = error as? LocalizedError, let d = e.errorDescription { return d }
  return String(describing: error)
}

/// The network seam (tests can swap it).
protocol SyncHTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
  /// Opens a streaming response; `onLine` gets every text line (empty lines included, as SSE needs).
  /// Returns when the server closes the stream. Throws `HttpError` for non-2xx statuses.
  func streamLines(_ request: URLRequest, onOpen: @escaping @Sendable () -> Void, onLine: @escaping @Sendable (String) -> Void)
    async throws
}

/// `normalizeServerUrl`: trimmed, no trailing slashes, http(s) only.
func normalizeServerUrl(_ raw: String) throws -> String {
  var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  while s.hasSuffix("/") { s.removeLast() }
  guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), u.host != nil else {
    throw SyncError("Invalid server URL")
  }
  guard scheme == "http" || scheme == "https" else {
    throw SyncError("The server URL must start with http:// or https://")
  }
  return s
}

final class URLSessionSyncTransport: SyncHTTPTransport, @unchecked Sendable {
  private let session: URLSession

  init(session: URLSession? = nil) {
    if let session {
      self.session = session
    } else {
      let cfg = URLSessionConfiguration.ephemeral
      cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
      cfg.timeoutIntervalForResource = 24 * 3600
      self.session = URLSession(configuration: cfg)
    }
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    final class Box: @unchecked Sendable { var task: URLSessionDataTask? }
    let box = Box()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Data, HTTPURLResponse), Error>) in
        let task = session.dataTask(with: request) { data, response, error in
          if let error {
            cont.resume(throwing: error)
          } else if let http = response as? HTTPURLResponse {
            cont.resume(returning: (data ?? Data(), http))
          } else {
            cont.resume(throwing: URLError(.badServerResponse))
          }
        }
        box.task = task
        task.resume()
      }
    } onCancel: {
      box.task?.cancel()
    }
  }

  func streamLines(
    _ request: URLRequest, onOpen: @escaping @Sendable () -> Void, onLine: @escaping @Sendable (String) -> Void
  ) async throws {
    #if canImport(FoundationNetworking)
      try await DelegateLineStream(request: request).run(onOpen: onOpen, onLine: onLine)
    #else
      let (bytes, response) = try await session.bytes(for: request)
      guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      guard (200..<300).contains(http.statusCode) else {
        throw HttpError(status: http.statusCode, message: "stream: \(http.statusCode)")
      }
      onOpen()
      // `bytes.lines` drops empty lines, which delimit SSE events, so split by hand.
      var buf = [UInt8]()
      for try await b in bytes {
        if b == 0x0A {
          if buf.last == 0x0D { buf.removeLast() }
          onLine(String(decoding: buf, as: UTF8.self))
          buf.removeAll(keepingCapacity: true)
        } else {
          buf.append(b)
        }
      }
    #endif
  }
}

#if canImport(FoundationNetworking)
  /// Streaming body reader for swift-corelibs-foundation (no `URLSession.bytes`).
  private final class DelegateLineStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let request: URLRequest
    private var session: URLSession?
    private var cont: CheckedContinuation<Void, Error>?
    private var onOpen: (@Sendable () -> Void)?
    private var onLine: (@Sendable (String) -> Void)?
    private var buf = [UInt8]()
    private let lock = NSLock()
    private var finished = false

    init(request: URLRequest) {
      self.request = request
    }

    func run(onOpen: @escaping @Sendable () -> Void, onLine: @escaping @Sendable (String) -> Void) async throws {
      self.onOpen = onOpen
      self.onLine = onLine
      let cfg = URLSessionConfiguration.ephemeral
      cfg.timeoutIntervalForRequest = 24 * 3600
      cfg.timeoutIntervalForResource = 24 * 3600
      let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
      session = s
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
          lock.lock()
          cont = c
          lock.unlock()
          s.dataTask(with: request).resume()
        }
      } onCancel: {
        self.finish(CancellationError())
        s.invalidateAndCancel()
      }
    }

    private func finish(_ error: Error?) {
      lock.lock()
      guard !finished else {
        lock.unlock()
        return
      }
      finished = true
      let c = cont
      cont = nil
      lock.unlock()
      if let error { c?.resume(throwing: error) } else { c?.resume() }
    }

    func urlSession(
      _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(status) {
        onOpen?()
        completionHandler(.allow)
      } else {
        completionHandler(.cancel)
        finish(HttpError(status: status, message: "stream: \(status)"))
      }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      for b in data {
        if b == 0x0A {
          if buf.last == 0x0D { buf.removeLast() }
          onLine?(String(decoding: buf, as: UTF8.self))
          buf.removeAll(keepingCapacity: true)
        } else {
          buf.append(b)
        }
      }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      finish(error)
      session.finishTasksAndInvalidate()
    }
  }
#endif

/// Parses SSE lines into (event, data) pairs (same rules as client.ts `stream`).
final class SSEParser {
  private var event = "message"
  private var data: [String] = []

  /// Feeds one line; returns a completed event when the line ends one.
  func feed(_ line: String) -> (event: String, data: String)? {
    if line.isEmpty {
      defer {
        event = "message"
        data = []
      }
      if !data.isEmpty || event != "message" { return (event, data.joined(separator: "\n")) }
      return nil
    }
    if line.hasPrefix(":") { return nil }  // comment / heartbeat
    let field: String
    var val: String
    if let i = line.firstIndex(of: ":") {
      field = String(line[..<i])
      val = String(line[line.index(after: i)...])
      if val.hasPrefix(" ") { val.removeFirst() }
    } else {
      field = line
      val = ""
    }
    if field == "event" { event = val } else if field == "data" { data.append(val) }
    return nil
  }
}

struct SyncClient: Sendable {
  let baseUrl: String
  let token: String?
  let transport: SyncHTTPTransport

  init(baseUrl: String, token: String?, transport: SyncHTTPTransport) throws {
    self.baseUrl = try normalizeServerUrl(baseUrl)
    self.token = token
    self.transport = transport
  }

  private func request(_ method: String, _ path: String, body: Data?, auth: Bool, timeout: TimeInterval) throws
    -> URLRequest
  {
    guard let url = URL(string: baseUrl + path) else { throw SyncError("Invalid server URL") }
    var r = URLRequest(url: url, timeoutInterval: timeout)
    r.httpMethod = method
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = body
    }
    if auth {
      guard let token, !token.isEmpty else { throw HttpError(status: 401, message: "Not signed in") }
      r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return r
  }

  private func req<T: Decodable>(
    _ method: String, _ path: String, body: Data? = nil, auth: Bool = true, timeout: TimeInterval = 30
  ) async throws -> T {
    let r = try request(method, path, body: body, auth: auth, timeout: timeout)
    let data: Data
    let res: HTTPURLResponse
    do {
      (data, res) = try await transport.send(r)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw HttpError(status: 0, message: "Could not reach the sync server (\(error.localizedDescription))")
    }
    let text = String(decoding: data, as: UTF8.self)
    guard (200..<300).contains(res.statusCode) else {
      let o = (try? SyncCoding.decode(JSONValue.self, from: data))?.objectValue ?? [:]
      let detail = o["error"]?.stringValue ?? o["message"]?.stringValue ?? String(text.prefix(200))
      let reason = HTTPURLResponse.localizedString(forStatusCode: res.statusCode)
      throw HttpError(status: res.statusCode, message: "\(res.statusCode) \(reason)\(detail.isEmpty ? "" : ": \(detail)")")
    }
    let payload = data.isEmpty ? Data("null".utf8) : data
    do {
      return try SyncCoding.decode(T.self, from: payload)
    } catch {
      throw HttpError(status: res.statusCode, message: "Unexpected response from the sync server (\(path))")
    }
  }

  private func json<T: Encodable>(_ v: T) throws -> Data { try SyncCoding.encode(v) }

  private func q(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
  }

  // MARK: auth

  func googleConfig() async throws -> GoogleConfigResponse {
    try await req("GET", "/api/auth/google/config", auth: false, timeout: 10)
  }

  func googleExchange(_ body: GoogleExchangeRequest) async throws -> AuthResponse {
    try await req("POST", "/api/auth/google/exchange", body: json(body), auth: false)
  }

  func devAuth(_ body: DevAuthRequest) async throws -> AuthResponse {
    try await req("POST", "/api/auth/dev", body: json(body), auth: false)
  }

  func webLink() async throws -> WebLinkResponse {
    try await req("POST", "/api/auth/web-link", body: Data("{}".utf8))
  }

  func me() async throws -> SyncMeResponse {
    try await req("GET", "/api/me")
  }

  func revokeDevice(_ id: String) async throws {
    let _: JSONValue = try await req("DELETE", "/api/devices/\(q(id))")
  }

  // MARK: sync

  func push(_ changes: [SyncChange]) async throws -> PushResponse {
    try await req("POST", "/api/sync/push", body: json(PushRequest(changes: changes)), timeout: 60)
  }

  func pull(cursor: Int64, limit: Int = 1000) async throws -> PullResponse {
    try await req("GET", "/api/sync/pull?cursor=\(cursor)&limit=\(limit)", timeout: 60)
  }

  /// Server-Sent Events: calls `onEvent` for every event. Returns when the server closes the
  /// stream; throws on HTTP/network errors. `onOpen` fires once the stream is up, `onChunk` on
  /// every line (heartbeats included) for an idle watchdog.
  func stream(
    onEvent: @escaping @Sendable (String, String) -> Void, onOpen: @escaping @Sendable () -> Void,
    onChunk: @escaping @Sendable () -> Void
  ) async throws {
    guard let token, !token.isEmpty else { throw HttpError(status: 401, message: "Not signed in") }
    guard let url = URL(string: baseUrl + "/api/sync/stream") else { throw SyncError("Invalid server URL") }
    var r = URLRequest(url: url, timeoutInterval: 24 * 3600)
    r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let parser = SSEParser()
    let lock = NSLock()
    try await transport.streamLines(
      r, onOpen: onOpen,
      onLine: { line in
        onChunk()
        lock.lock()
        let ev = parser.feed(line)
        lock.unlock()
        if let ev { onEvent(ev.event, ev.data) }
      })
  }

  // MARK: team

  func projectFeed(_ projectId: String, from: String, to: String) async throws -> [ProjectEntry] {
    let v: JSONValue = try await req("GET", "/api/projects/\(q(projectId))/feed?from=\(from)&to=\(to)")
    let arr: JSONValue = v.arrayValue != nil ? v : (v["entries"] ?? .array([]))
    return (try? SyncCoding.decode([ProjectEntry].self, from: SyncCoding.encode(arr))) ?? []
  }

  func projectReport(_ projectId: String, from: String, to: String) async throws -> ProjectReport {
    try await req("GET", "/api/projects/\(q(projectId))/report?from=\(from)&to=\(to)")
  }

  func timesheetProposals(from: String, to: String, workspaceId: String) async throws -> TimesheetProposalsView {
    let v: JSONValue = try await req(
      "GET", "/api/timesheets/proposals?from=\(from)&to=\(to)&workspaceId=\(q(workspaceId))")
    if v.arrayValue != nil {
      let p = (try? SyncCoding.decode([TimesheetProposal].self, from: SyncCoding.encode(v))) ?? []
      return TimesheetProposalsView(proposals: p, odooConfigured: true, employeeMapped: true)
    }
    let r = (try? SyncCoding.decode(TimesheetProposalsResponse.self, from: SyncCoding.encode(v)))
    return TimesheetProposalsView(
      proposals: r?.proposals ?? [], odooConfigured: r?.odooConfigured != false,
      employeeMapped: r?.employeeMapped != false)
  }

  func timesheetSubmit(_ body: TimesheetSubmitRequest) async throws -> TimesheetSubmitResult {
    try await req("POST", "/api/timesheets/submit", body: json(body), timeout: 120)
  }
}
