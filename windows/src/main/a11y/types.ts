// Accessibility log event, as kept in memory. On disk (see store.ts) the keys are snake_case
// and `time` is an ISO-8601 string; here `time` is epoch milliseconds.
// Port of AccessibilityLogEvent (AccessibilityLogStore.swift).

export interface A11yEvent {
  time: number
  /** session_start, session_stop, window, click, drag, context_menu, text, submit, shortcut, escape, snapshot, diff */
  kind: string
  app?: string
  /** Windows: exe name, e.g. "slack.exe" */
  bundleId?: string
  window?: string
  /** True when the foreground app is excluded; nothing else about it is recorded. */
  blocked?: boolean
  /** The clicked element, e.g. `button "Send"`. */
  target?: string
  field?: string
  text?: string
  /** Shortcut, e.g. "Ctrl+C" */
  keys?: string
  /** What caused a snapshot or diff, e.g. "click +250ms" or "window". */
  trigger?: string
  tree?: string
  diff?: string
  snapshotMs?: number
}
