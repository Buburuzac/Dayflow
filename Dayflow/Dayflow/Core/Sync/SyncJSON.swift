//
//  SyncJSON.swift
//  Dayflow — Dayflow Sync client core
//
//  A dynamic JSON value for the parts of the sync protocol that are free-form
//  (`SyncChange.data`, user-doc payloads, card metadata). Foundation only.
//

import Foundation

/// A JSON value. Integers and doubles are kept apart so timestamps and HLC milliseconds
/// round-trip exactly.
enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case int(Int64)
  case double(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let i = try? c.decode(Int64.self) {
      self = .int(i)
    } else if let d = try? c.decode(Double.self) {
      self = .double(d)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else if let o = try? c.decode([String: JSONValue].self) {
      self = .object(o)
    } else {
      throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .int(let i): try c.encode(i)
    case .double(let d):
      if d.isFinite { try c.encode(d) } else { try c.encodeNil() }
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  // MARK: accessors

  var stringValue: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  var boolValue: Bool? {
    if case .bool(let b) = self { return b }
    return nil
  }

  /// A finite number (int or double), as `Number.isFinite` in the TypeScript client.
  var numberValue: Double? {
    switch self {
    case .int(let i): return Double(i)
    case .double(let d): return d.isFinite ? d : nil
    default: return nil
    }
  }

  var intValue: Int64? {
    switch self {
    case .int(let i): return i
    case .double(let d): return d.isFinite && d.rounded() == d ? Int64(d) : nil
    default: return nil
    }
  }

  var arrayValue: [JSONValue]? {
    if case .array(let a) = self { return a }
    return nil
  }

  var objectValue: [String: JSONValue]? {
    if case .object(let o) = self { return o }
    return nil
  }

  var isNull: Bool {
    if case .null = self { return true }
    return false
  }

  subscript(key: String) -> JSONValue? {
    objectValue?[key]
  }

  /// JS truthiness for the few places the TypeScript client tests `if (x)`.
  var isTruthy: Bool {
    switch self {
    case .null: return false
    case .bool(let b): return b
    case .int(let i): return i != 0
    case .double(let d): return d != 0 && !d.isNaN
    case .string(let s): return !s.isEmpty
    case .array, .object: return true
    }
  }

  /// A JS-like `String(v)` for scalars ('' for null).
  var looseString: String {
    switch self {
    case .null: return ""
    case .bool(let b): return b ? "true" : "false"
    case .int(let i): return String(i)
    case .double(let d): return d.rounded() == d && abs(d) < 1e15 ? String(Int64(d)) : String(d)
    case .string(let s): return s
    case .array, .object: return JSONValue.encodeString(self) ?? ""
    }
  }

  // MARK: conversion

  static func parse(_ text: String?) -> JSONValue? {
    guard let text, !text.isEmpty, let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(JSONValue.self, from: data)
  }

  static func encodeString(_ value: JSONValue) -> String? {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? enc.encode(value) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  var jsonString: String { JSONValue.encodeString(self) ?? "null" }
}

/// `parseJsonObject` from db.ts: a JSON object, or `[:]` for anything else.
func parseJSONObject(_ text: String?) -> [String: JSONValue] {
  JSONValue.parse(text)?.objectValue ?? [:]
}

func encodeJSONObject(_ object: [String: JSONValue]) -> String {
  JSONValue.object(object).jsonString
}

extension Dictionary where Key == String, Value == JSONValue {
  var jsonString: String { JSONValue.object(self).jsonString }
}

/// Encodes and decodes the wire types with the server's conventions.
enum SyncCoding {
  static func encoder() -> JSONEncoder {
    let e = JSONEncoder()
    e.outputFormatting = [.withoutEscapingSlashes]
    return e
  }

  static func decoder() -> JSONDecoder {
    JSONDecoder()
  }

  static func encode<T: Encodable>(_ value: T) throws -> Data {
    try encoder().encode(value)
  }

  static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    try decoder().decode(type, from: data)
  }

  /// Converts an Encodable value to a `JSONValue` (for building `SyncChange.data`).
  static func value<T: Encodable>(_ v: T) -> JSONValue {
    guard let data = try? encode(v), let j = try? decode(JSONValue.self, from: data) else {
      return .null
    }
    return j
  }
}
