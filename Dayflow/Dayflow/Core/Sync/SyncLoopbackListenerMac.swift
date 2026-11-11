//
//  SyncLoopbackListenerMac.swift
//  Dayflow — Dayflow Sync, macOS glue
//
//  The Google sign-in redirect target: a one-shot HTTP listener on 127.0.0.1:<free port>
//  built on Network.framework (NWListener). Answers GET /callback with a small HTML page and
//  hands the query items to `loopbackAuthorize` (SyncAuth.swift); other paths get 404.
//

#if os(macOS)
  import Foundation
  import Network

  final class NWLoopbackListener: LoopbackHTTPListener, @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.dayflow.sync.loopback")
    private let lock = NSLock()
    private var listener: NWListener?
    private var waiter: CheckedContinuation<[URLQueryItem], Error>?
    private var reply: (@Sendable ([URLQueryItem]) -> (status: Int, html: String))?
    /// A callback that arrived before `awaitCallback` was called.
    private var early: [URLQueryItem]?
    private var delivered = false
    private var stopped = false

    private final class Once: @unchecked Sendable {
      var done = false
    }

    func start() async throws -> UInt16 {
      let params = NWParameters.tcp
      params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
      let l = try NWListener(using: params)
      lock.lock()
      listener = l
      lock.unlock()
      l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
      let once = Once()
      return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
        l.stateUpdateHandler = { state in
          // Runs on `queue` (serial), so `once` needs no lock.
          switch state {
          case .ready:
            guard !once.done else { return }
            once.done = true
            if let port = l.port?.rawValue {
              cont.resume(returning: port)
            } else {
              cont.resume(throwing: SyncError("Could not open a local port for sign-in."))
            }
          case .failed(let error), .waiting(let error):
            // `.waiting` on a loopback listener means the bind cannot succeed; don't hang sign-in.
            guard !once.done else { return }
            once.done = true
            l.cancel()
            cont.resume(throwing: error)
          case .cancelled:
            guard !once.done else { return }
            once.done = true
            cont.resume(throwing: CancellationError())
          default:
            break
          }
        }
        l.start(queue: queue)
      }
    }

    func awaitCallback(reply: @escaping @Sendable ([URLQueryItem]) -> (status: Int, html: String)) async throws
      -> [URLQueryItem]
    {
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[URLQueryItem], Error>) in
          lock.lock()
          if stopped {
            lock.unlock()
            cont.resume(throwing: CancellationError())
            return
          }
          if let early {
            self.early = nil
            delivered = true
            lock.unlock()
            cont.resume(returning: early)
            return
          }
          waiter = cont
          self.reply = reply
          lock.unlock()
        }
      } onCancel: {
        self.failWaiter(CancellationError())
      }
    }

    func stop() {
      lock.lock()
      stopped = true
      let l = listener
      listener = nil
      lock.unlock()
      l?.cancel()
      failWaiter(CancellationError())
    }

    private func failWaiter(_ error: Error) {
      lock.lock()
      let w = waiter
      waiter = nil
      lock.unlock()
      w?.resume(throwing: error)
    }

    // MARK: connections

    private func handle(_ conn: NWConnection) {
      conn.start(queue: queue)
      receive(conn, Data())
    }

    private func receive(_ conn: NWConnection, _ buffer: Data) {
      conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
        guard let self else {
          conn.cancel()
          return
        }
        var buf = buffer
        if let data { buf.append(data) }
        let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) != nil
        if headerEnd || isComplete || error != nil || buf.count > 64 * 1024 {
          self.process(conn, buf)
        } else {
          self.receive(conn, buf)
        }
      }
    }

    private func process(_ conn: NWConnection, _ request: Data) {
      // "GET /callback?code=…&state=… HTTP/1.1"
      let head = String(decoding: request.prefix(8 * 1024), as: UTF8.self)
      let firstLine = head.components(separatedBy: "\r\n").first ?? ""
      let parts = firstLine.split(separator: " ")
      guard parts.count >= 2, parts[0] == "GET",
        let comps = URLComponents(string: "http://127.0.0.1" + String(parts[1])), comps.path == "/callback"
      else {
        send(conn, status: 404, html: "")
        return
      }
      let items = comps.queryItems ?? []
      lock.lock()
      let first = !delivered
      let r = reply
      let w = waiter
      if first {
        delivered = true
        if w == nil { early = items }
        waiter = nil
      }
      lock.unlock()
      let page: (status: Int, html: String) =
        r?(items)
        ?? (status: 200, html: callbackPage("Dayflow", "You can close this tab and return to Dayflow."))
      send(conn, status: page.status, html: page.html)
      if first { w?.resume(returning: items) }
    }

    private func send(_ conn: NWConnection, status: Int, html: String) {
      let body = Data(html.utf8)
      let reason = HTTPURLResponse.localizedString(forStatusCode: status).capitalized
      var head = "HTTP/1.1 \(status) \(reason)\r\n"
      head += "Content-Type: text/html; charset=utf-8\r\n"
      head += "Content-Length: \(body.count)\r\n"
      head += "Cache-Control: no-store\r\n"
      head += "Connection: close\r\n\r\n"
      var out = Data(head.utf8)
      out.append(body)
      conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
  }
#endif
