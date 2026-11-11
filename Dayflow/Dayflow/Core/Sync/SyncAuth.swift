//
//  SyncAuth.swift
//  Dayflow — Dayflow Sync client core
//
//  Google sign-in for installed apps (port of windows/src/main/sync/auth.ts): loopback redirect on
//  127.0.0.1:<random port> + PKCE (S256). The browser returns an authorization code to the local
//  listener; the sync server exchanges it (it holds the client secret) via
//  POST /api/auth/google/exchange. ASWebAuthenticationSession cannot capture http loopback
//  callbacks, so the system browser and a local listener are used instead.
//
//  The listener and the browser are protocols: on the Mac they are NWListener and NSWorkspace
//  (SyncPlatformMac.swift); tests use in-memory fakes.
//

import Foundation

let GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"

/// A one-shot HTTP listener on 127.0.0.1.
protocol LoopbackHTTPListener: AnyObject, Sendable {
  /// Starts listening on 127.0.0.1 on a free port and returns it.
  func start() async throws -> UInt16
  /// Waits for the first GET /callback request and answers it with `reply(query)`; other paths get 404.
  /// Returns the request's query items. Throws `CancellationError` when the task is cancelled.
  func awaitCallback(reply: @escaping @Sendable ([URLQueryItem]) -> (status: Int, html: String)) async throws
    -> [URLQueryItem]
  func stop()
}

struct LoopbackResult: Equatable, Sendable {
  var code: String
  var codeVerifier: String
  var redirectUri: String
}

// MARK: - SHA-256 (FIPS 180-4), dependency-free so the core builds everywhere

func syncSHA256(_ message: [UInt8]) -> [UInt8] {
  let k: [UInt32] = [
    0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
    0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
    0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
    0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
    0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
    0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
    0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
    0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
  ]
  var h: [UInt32] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
  ]
  var msg = message
  let bitLen = UInt64(message.count) * 8
  msg.append(0x80)
  while msg.count % 64 != 56 { msg.append(0) }
  for i in (0..<8).reversed() { msg.append(UInt8((bitLen >> (UInt64(i) * 8)) & 0xff)) }
  func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
  var w = [UInt32](repeating: 0, count: 64)
  for chunk in stride(from: 0, to: msg.count, by: 64) {
    for i in 0..<16 {
      let j = chunk + i * 4
      w[i] = UInt32(msg[j]) << 24 | UInt32(msg[j + 1]) << 16 | UInt32(msg[j + 2]) << 8 | UInt32(msg[j + 3])
    }
    for i in 16..<64 {
      let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
      let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
      w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
    for i in 0..<64 {
      let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      let ch = (e & f) ^ (~e & g)
      let t1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
      let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      let maj = (a & b) ^ (a & c) ^ (b & c)
      let t2 = s0 &+ maj
      hh = g
      g = f
      f = e
      e = d &+ t1
      d = c
      c = b
      b = a
      a = t1 &+ t2
    }
    h[0] = h[0] &+ a
    h[1] = h[1] &+ b
    h[2] = h[2] &+ c
    h[3] = h[3] &+ d
    h[4] = h[4] &+ e
    h[5] = h[5] &+ f
    h[6] = h[6] &+ g
    h[7] = h[7] &+ hh
  }
  return h.flatMap { v in [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)] }
}

func syncBase64url(_ bytes: [UInt8]) -> String {
  Data(bytes).base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func syncRandomBytes(_ n: Int) -> [UInt8] {
  var g = SystemRandomNumberGenerator()
  return (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
}

func pkcePair() -> (verifier: String, challenge: String) {
  let verifier = syncBase64url(syncRandomBytes(48))
  return (verifier, syncBase64url(syncSHA256(Array(verifier.utf8))))
}

func authorizeUrl(clientId: String, redirectUri: String, challenge: String, state: String, base: String = GOOGLE_AUTHORIZE_URL)
  -> String
{
  var c = URLComponents(string: base)!
  c.queryItems = [
    URLQueryItem(name: "client_id", value: clientId),
    URLQueryItem(name: "redirect_uri", value: redirectUri),
    URLQueryItem(name: "response_type", value: "code"),
    URLQueryItem(name: "scope", value: "openid email profile"),
    URLQueryItem(name: "code_challenge", value: challenge),
    URLQueryItem(name: "code_challenge_method", value: "S256"),
    URLQueryItem(name: "state", value: state),
    URLQueryItem(name: "prompt", value: "select_account"),
  ]
  // URLComponents leaves "+" and ":" alone; Google accepts both, as URLSearchParams' output.
  return c.string ?? base
}

func callbackPage(_ title: String, _ body: String) -> String {
  "<!doctype html><meta charset=\"utf-8\"><title>\(title)</title>"
    + "<body style=\"font-family:-apple-system,Helvetica,sans-serif;background:#fbf7f2;color:#333;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">"
    + "<div style=\"text-align:center\"><h1 style=\"font-weight:400\">\(title)</h1><p>\(body)</p></div></body>"
}

/// Opens the system browser at Google's consent page and waits (up to `timeout`) for the redirect
/// to the local listener. Throws on denial, state mismatch, timeout or cancellation.
func loopbackAuthorize(
  clientId: String, listener: LoopbackHTTPListener, openBrowser: @escaping @Sendable (URL) async throws -> Void,
  timeout: TimeInterval = 300, authorizeBase: String = GOOGLE_AUTHORIZE_URL
) async throws -> LoopbackResult {
  let (verifier, challenge) = pkcePair()
  let state = syncBase64url(syncRandomBytes(16))
  let port = try await listener.start()
  defer { listener.stop() }
  let redirectUri = "http://127.0.0.1:\(port)/callback"
  guard let url = URL(string: authorizeUrl(clientId: clientId, redirectUri: redirectUri, challenge: challenge, state: state, base: authorizeBase))
  else { throw SyncError("Could not build the sign-in URL") }

  return try await withThrowingTaskGroup(of: LoopbackResult?.self) { group in
    group.addTask {
      let items = try await listener.awaitCallback { items in
        let v = { (n: String) in items.first(where: { $0.name == n })?.value }
        let error = v("error")
        let ok = error == nil && !(v("code") ?? "").isEmpty && v("state") == state
        if ok { return (200, callbackPage("Signed in to Dayflow", "You can close this tab and return to Dayflow.")) }
        let safe = (error ?? "").filter { !"<>&\"".contains($0) }
        return (
          400,
          callbackPage(
            "Sign-in failed", error != nil ? "Google returned: \(safe)" : "The response did not match this sign-in.")
        )
      }
      let v = { (n: String) in items.first(where: { $0.name == n })?.value }
      let error = v("error")
      let code = v("code") ?? ""
      if error == nil, !code.isEmpty, v("state") == state {
        return LoopbackResult(code: code, codeVerifier: verifier, redirectUri: redirectUri)
      }
      if error == "access_denied" { throw SyncError("Sign-in was cancelled.") }
      throw SyncError("Sign-in failed\(error.map { ": \($0)" } ?? "")")
    }
    group.addTask {
      try await openBrowser(url)
      try await Task.sleep(nanoseconds: UInt64(max(0.01, timeout) * 1_000_000_000))
      throw SyncError("Sign-in timed out. Try again.")
    }
    // Whatever finishes first (callback, timeout, error, cancellation) ends the sign-in: stop the
    // listener too, so a pending `awaitCallback` returns and the group can finish.
    defer {
      group.cancelAll()
      listener.stop()
    }
    guard let first = try await group.next(), let r = first else { throw SyncError("Sign-in was cancelled.") }
    return r
  }
}
