//
//  SyncComponents.swift
//  Dayflow — Dayflow Sync UI
//
//  Small building blocks shared by Settings → Sync & team and the Team view. They sit on the
//  Settings design system (SettingsStyle tokens, Figtree type).
//

import SwiftUI

// MARK: - Notice

/// A short tinted message (server unreachable, Odoo not configured, submit result).
struct SyncNotice: View {
  enum Tone {
    case info, warn, error, ok
  }

  let text: String
  var tone: Tone = .info

  private var color: Color {
    switch tone {
    case .info: return SettingsStyle.secondary
    case .warn: return SettingsStyle.statusWarn
    case .error: return SettingsStyle.statusBad
    case .ok: return SettingsStyle.statusGood
    }
  }

  var body: some View {
    Text(text)
      .font(.custom("Figtree", size: 12))
      .foregroundColor(tone == .info ? SettingsStyle.secondary : color)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(color.opacity(0.1))
      )
  }
}

// MARK: - Small labels

/// The uppercase grey label used above blocks ("PROJECT", "DEVICES").
struct SyncCapsLabel: View {
  let text: String

  var body: some View {
    Text(text.uppercased())
      .font(.custom("Figtree", size: 11))
      .fontWeight(.semibold)
      .kerning(0.4)
      .foregroundColor(SettingsStyle.meta)
  }
}

/// A form field label with the control under it.
struct SyncField<Content: View>: View {
  let label: String
  var hint: String? = nil
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label)
        .font(.custom("Figtree", size: 12))
        .fontWeight(.semibold)
        .foregroundColor(SettingsStyle.text)
      content()
      if let hint {
        Text(hint)
          .font(.custom("Figtree", size: 11))
          .foregroundColor(SettingsStyle.meta)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

/// Swatch dot for a project color.
struct SyncColorDot: View {
  let hex: String
  var size: CGFloat = 10

  var body: some View {
    Circle()
      .fill(syncProjectColor(hex))
      .frame(width: size, height: size)
  }
}

// MARK: - Flow layout

/// Lays children left to right and wraps to new lines (chips, tokens, checkboxes).
struct SyncFlowLayout: Layout {
  var spacing: CGFloat = 6
  var lineSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var lineHeight: CGFloat = 0
    var widest: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > maxWidth {
        y += lineHeight + lineSpacing
        x = 0
        lineHeight = 0
      }
      widest = max(widest, x + size.width)
      x += size.width + spacing
      lineHeight = max(lineHeight, size.height)
    }
    let width = maxWidth.isFinite ? maxWidth : widest
    return CGSize(width: width, height: y + lineHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    var y = bounds.minY
    var lineHeight: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x > bounds.minX && x + size.width > bounds.maxX {
        y += lineHeight + lineSpacing
        x = bounds.minX
        lineHeight = 0
      }
      s.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
      x += size.width + spacing
      lineHeight = max(lineHeight, size.height)
    }
  }
}

// MARK: - Token input (project rules)

/// Chips for the current tokens plus a text field; Return, "," or ";" turns the typed text into
/// chips. The parent owns `draft` so text typed without Return is still saved.
struct TokenListField: View {
  let placeholder: String
  @Binding var tokens: [String]
  @Binding var draft: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !tokens.isEmpty {
        SyncFlowLayout(spacing: 6, lineSpacing: 6) {
          ForEach(tokens, id: \.self) { token in
            TokenChip(text: token) { remove(token) }
          }
        }
      }
      TextField(placeholder, text: $draft)
        .textFieldStyle(.roundedBorder)
        .font(.custom("Figtree", size: 12))
        .disableAutocorrection(true)
        .onSubmit(commit)
        .onChange(of: draft) { _, value in
          if value.contains(",") || value.contains(";") { commit() }
        }
    }
  }

  private func commit() {
    let next = addTokens(tokens, from: draft)
    if next != tokens { tokens = next }
    draft = ""
  }

  private func remove(_ token: String) {
    tokens.removeAll { $0 == token }
  }
}

private struct TokenChip: View {
  let text: String
  let onRemove: () -> Void

  var body: some View {
    HStack(spacing: 4) {
      Text(text)
        .font(.custom("Figtree", size: 12))
        .foregroundColor(SettingsStyle.text)
        .lineLimit(1)
      Button(action: onRemove) {
        Image(systemName: "xmark")
          .font(.system(size: 8, weight: .bold))
          .foregroundColor(SettingsStyle.secondary)
      }
      .buttonStyle(.plain)
      .pointingHandCursor()
      .help(String(localized: "Remove"))
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      Capsule(style: .continuous)
        .fill(SettingsStyle.subtleFill)
    )
  }
}
