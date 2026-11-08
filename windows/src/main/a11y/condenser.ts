// Turns the raw accessibility log for a stretch of time into a short text record that card
// generation reads next to the screenshots: window switches, the new on-screen text, and what
// the user typed, sent, clicked and ran.
//
// A 1:1 port of AccessibilityLogCondenser.swift (itself a port of the Python "opus7"
// condenser). It must produce the same text for the same log, so the structure, names and
// order of checks follow the Swift file closely. Differences that are deliberate:
//   - NSRegularExpression (ICU) patterns are translated to JS (see `icu`): \w, \d, \s, \b and
//     $ get ICU's Unicode semantics, `.` matches newlines (dotMatchesLineSeparators).
//   - Shingles are kept as strings instead of String.hashValue (same sets, no collisions).
//   - Windows additions are data only (extra app names, address-field labels, title junk and
//     Ctrl+… shortcut forms); a macOS log condenses exactly as before.
//
// Pure: no I/O. Loading lives in store.ts.

import type { A11yEvent } from './types.ts'

/** Fewer events than this is a stretch where the recorder was barely running. */
export const MINIMUM_EVENTS = 20

/** The largest record sent with a batch, in UTF-8 bytes. */
export const MAX_BYTES = 200_000

/** The condensed text for events already in time order. */
export function condense(events: A11yEvent[], userName: string): string {
  const firstName = userName.split(/\s+/u).find((s) => s.length > 0) ?? ''
  const condenser = new Condenser(titleJunk(firstName))
  return condenser.run(events)
}

/**
 * Keeps a record under `maxBytes`. Lines that start with a time are kept first; the indented
 * screen-text lines under them are kept in order until the budget runs out. When the action
 * lines alone are too big, the end of the record is cut off.
 */
export function trimmed(text: string, maxBytes: number = MAX_BYTES): string {
  if (utf8Length(text) <= maxBytes) return text
  const lines = text.split('\n')
  const actionBytes = lines.filter((l) => !l.startsWith('  ')).reduce((n, l) => n + utf8Length(l) + 1, 0)
  const noteRoom = 100
  let screenBudget = maxBytes - noteRoom - actionBytes
  const kept: string[] = []
  let leftOut = 0
  for (const line of lines) {
    if (!line.startsWith('  ')) {
      kept.push(line)
    } else if (utf8Length(line) + 1 <= screenBudget) {
      kept.push(line)
      screenBudget -= utf8Length(line) + 1
    } else {
      leftOut += 1
    }
  }

  const note = `(${leftOut} more lines of screen text left out to keep this log short)`
  let budget = maxBytes - noteRoom
  const result: string[] = []
  for (const line of kept) {
    if (!(utf8Length(line) + 1 <= budget)) break
    result.push(line)
    budget -= utf8Length(line) + 1
  }
  if (result.length < kept.length) {
    result.push('(the rest of this stretch is left out to keep this log short)')
  } else if (leftOut > 0) {
    result.push(note)
  }
  return result.join('\n')
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

// MARK: - ICU → JS regex translation

// ICU \w: [\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}\u200c\u200d]
const WORD = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200C\\u200D'
// ICU \s: [\t\n\f\r\p{Z}]
const SPACE = '\\t\\n\\f\\r\\p{Z}'
// ICU $ (not multiline): end of input, or before a line terminator that ends the input.
const DOLLAR = '(?=(?:\\r\\n|[\\n\\v\\f\\r\\u0085\\u2028\\u2029])?$)'
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`
// When the next character matched must be a word character, \b is just "not after one".
// Same result, and far cheaper: a leading \b is tried at every position of the text.
const BOUNDARY_BEFORE_WORD = `(?<![${WORD}])`

function isOptionalQuantifier(p: string, i: number): boolean {
  const q = p[i]
  return q === '?' || q === '*' || (q === '{' && p[i + 1] === '0')
}

/** Index just past the group that opens at `open`, and its top-level alternatives. */
function groupAt(p: string, open: number): { end: number; alternatives: string[] } | null {
  let depth = 0
  let inClass = false
  let start = open + 1
  const alternatives: string[] = []
  for (let i = open; i < p.length; i++) {
    const c = p[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) {
        alternatives.push(p.slice(start, i))
        return { end: i + 1, alternatives }
      }
    } else if (c === '|' && depth === 1) {
      alternatives.push(p.slice(start, i))
      start = i + 1
    }
  }
  return null
}

/** True when whatever the pattern matches from `i` on must start with a word character. */
function startsWithWord(p: string, i: number): boolean {
  const c = p[i]
  if (c === undefined) return false
  if (c === '\\') return (p[i + 1] === 'd' || p[i + 1] === 'w') && !isOptionalQuantifier(p, i + 2)
  if (/[A-Za-z0-9_]/.test(c)) return !isOptionalQuantifier(p, i + 1)
  if (c === '(') {
    if (p[i + 1] === '?' && p[i + 2] !== ':') return false // lookaround
    const group = groupAt(p, i)
    if (!group) return false
    const alternatives = group.alternatives.map((a, n) => (n === 0 && a.startsWith('?:') ? a.slice(2) : a))
    if (!alternatives.every((a) => startsWithWord(a, 0))) return false
    // An optional group: what follows it must start with a word character too.
    if (isOptionalQuantifier(p, group.end)) {
      const after = p[group.end] === '{' ? p.indexOf('}', group.end) + 1 : group.end + 1
      return after > 0 && startsWithWord(p, after)
    }
    return true
  }
  return false
}

export function icu(pattern: string): string {
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const n = pattern[i + 1] ?? ''
      i++
      if (n === 'w') out += inClass ? WORD : `[${WORD}]`
      else if (n === 'd') out += '\\p{Nd}'
      else if (n === 's') out += inClass ? SPACE : `[${SPACE}]`
      else if (n === 'b' && !inClass) out += startsWithWord(pattern, i + 1) ? BOUNDARY_BEFORE_WORD : BOUNDARY
      else out += '\\' + n
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      out += c
      continue
    }
    if (c === '[') {
      inClass = true
      out += c
      if (pattern[i + 1] === '^') {
        out += '^'
        i++
      }
      continue
    }
    if (c === '$') {
      out += DOLLAR
      continue
    }
    out += c
  }
  return out
}

/** Thin wrapper with the handful of operations the condenser needs (PatternMatcher). */
class Pattern {
  private readonly g: RegExp
  private readonly y: RegExp

  constructor(pattern: string, caseInsensitive = false) {
    const src = icu(pattern)
    const flags = 'su' + (caseInsensitive ? 'i' : '')
    this.g = new RegExp(src, flags + 'g')
    this.y = new RegExp(src, flags + 'y')
  }

  /** True when the pattern matches anywhere in the text. */
  search(text: string): boolean {
    this.g.lastIndex = 0
    return this.g.test(text)
  }

  /** True when the pattern matches at the start of the text. */
  matchesStart(text: string): boolean {
    this.y.lastIndex = 0
    return this.y.test(text)
  }

  /** True when the (first) match at the start covers the whole text. */
  matchesWhole(text: string): boolean {
    this.y.lastIndex = 0
    const m = this.y.exec(text)
    return m !== null && m[0].length === text.length
  }

  /** Groups of a match at the start of the text; index 0 is the whole match. */
  matchAtStart(text: string): (string | undefined)[] | null {
    this.y.lastIndex = 0
    const m = this.y.exec(text)
    return m ? Array.from(m) : null
  }

  /** Groups of the first match anywhere in the text. */
  firstMatch(text: string): (string | undefined)[] | null {
    this.g.lastIndex = 0
    const m = this.g.exec(text)
    return m ? Array.from(m) : null
  }

  count(text: string): number {
    let n = 0
    this.g.lastIndex = 0
    for (const m of text.matchAll(this.g)) {
      void m
      n++
    }
    return n
  }

  allMatches(text: string): string[] {
    this.g.lastIndex = 0
    return Array.from(text.matchAll(this.g), (m) => m[0])
  }

  /** Replaces every match. `template` uses `$1` for groups. */
  replace(text: string, template: string): string {
    this.g.lastIndex = 0
    return text.replace(this.g, template)
  }

  /** The pieces between matches. */
  split(text: string): string[] {
    const pieces: string[] = []
    let start = 0
    this.g.lastIndex = 0
    for (const m of text.matchAll(this.g)) {
      pieces.push(text.slice(start, m.index))
      start = m.index + m[0].length
    }
    pieces.push(text.slice(start))
    return pieces
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

// MARK: - Patterns and word lists

const P = {
  screenLine: new Pattern(
    String.raw`^\s*(?:([~+]) )?\s*\[(\d+)\] (\w+)(?: "(.*?)")?(?: \(([a-z,]*)\))?(?: = "(.*)")?(?: placeholder="(.*?)")?(?: <(.*)>)?\s*$`,
  ),
  controlRoles: new Set([
    'button', 'checkbox', 'radiobutton', 'popupbutton', 'menuitem', 'menubutton',
    'slider', 'tab', 'disclosuretriangle', 'incrementor', 'colorwell', 'switch',
  ]),
  dropRoles: new Set([
    'listmarker', 'toolbar', 'menu', 'menubar', 'list', 'window', 'scrollarea',
    'splitgroup', 'tabgroup', 'outline', 'table', 'browser', 'image', 'progressindicator',
    'busyindicator', 'levelindicator', 'valueindicator', 'matte', 'ruler',
  ]),
  browsers: new Set([
    'Google Chrome', 'Safari', 'Arc', 'Firefox', 'Dia', 'Comet',
    // Windows
    'Microsoft Edge', 'Brave', 'Opera', 'Vivaldi',
  ]),
  addressFields: new Set([
    'Address and search bar', 'Address bar', 'Search or enter address',
    // Windows (Firefox), and Chrome/Edge in Russian (seen on this machine)
    'Search with Google or enter address',
    'Адресная строка и строка поиска',
  ]),
  terminals: new Set([
    'Ghostty', 'Terminal', 'iTerm2', 'Warp', 'kitty', 'Alacritty',
    // Windows
    'Windows Terminal', 'Windows PowerShell', 'PowerShell', 'Command Prompt', 'WezTerm',
  ]),
  noteApps: new Set(['Notes', 'TextEdit', 'Obsidian', 'Bear', /* Windows */ 'Notepad', 'OneNote']),
  chatApps: new Set(['Messages', 'Slack', 'Claude', 'ChatGPT', 'Grok Bot']),
  uiWords: new Set([
    'copy', 'fork from here', 'read aloud', 'pin as chapter', 'add reaction…', 'forward message…',
    'add to-do', 'more actions', 'message actions', 'emoji', 'mention someone', 'attach', 'close',
    'show formatting', 'record video clip', 'like', 'reply', 'repost', 'share post', 'bookmark',
    'grok actions', 'more', 'stop', 'send', 'new tab', 'reload', 'back', 'forward',
  ]),
  /** Status words that belong to the row before them. */
  rowStatus: new Set([
    'Running', 'Unread response', 'Unread', 'Failed', 'Completed', 'Queued', 'Waiting', 'Paused',
    'Has draft',
  ]),
  /** Status words that belong to the row after them. */
  nextStatus: new Set(['in progress', 'not done', 'done']),
  metric: new Pattern(
    String.raw`^[\s\d.,:kKmM%·/|()+\-–—]*(?:(?:replies|reply|reposts?|likes?|bookmarks?|views?|reactions?|` +
      String.raw`react with[^,]*|comments?|shares?|minutes?|hours?|seconds?|ago|days?|weeks?|AM|PM|` +
      String.raw`Today|Yesterday|at|Like|Reply|Repost|View post analytics|Share|Bookmark|emoji)[\s\d.,:kKmM%·/|()+\-–—]*)*$`,
    true,
  ),
  tracking: new Pattern(
    String.raw`([?&])(utm_[a-z]+|ved|ei|sa|usg|sca_esv|sxsrf|oq|gs_lcrp|sourceid|ie|uact|fbclid|gclid|` +
      String.raw`si|ref_src|ref|source|aqs|rlz|bih|biw|dpr|client|iflsig|gs_lp|sclient|ust|opi|` +
      String.raw`g_st|pli|hl|zx|no_sw_cr)=[^&#]*`,
    true,
  ),
  counter: new Pattern(
    String.raw`\b\d[\d.,]*[km]?\s*(replies|reply|reposts?|likes?|bookmarks?|views?|reactions?|comments?|` +
      String.raw`votes?|retweets?|quotes?|shares?|upvotes?|points?|(seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?) ago|[smhd] ago)\b` +
      String.raw`|\b(\d+|an?) (seconds?|minutes?|hours?|days?) ago\b|\b\d+[smhd]\b(?= ·| ago)|(\d[\d.,]*[km]?)(?= (likes|views|replies|reposts))`,
  ),
  elapsed: new Pattern(String.raw`\b(\d+h )?\d+m \d+s\b|\b\d+s\b|\b\d+m\b`),
  durationOnly: new Pattern(String.raw`^(\d+h )?(\d+m )?\d+[sm]$|^[\d.]+k? tokens$|^\d+%$|^\d+(\.\d+)?k?$`),
  metricPhrase: new Pattern(
    String.raw`\b\d[\d.,]*[KkMm]? (replies|reply|reposts?|likes?|bookmarks?|views?|votes?|comments?)\b,?( ·)?`,
  ),
  dateToken: new Pattern(
    String.raw`\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? |\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},?( \d{4})?|\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b`,
  ),
  value: new Pattern(
    String.raw`^[$€£]\s?\d[\d.,]*\s?[kKmMbB]?( (per|/) .{1,20})?$|^\d[\d,]*\.\d+%?$|^\d{1,3}(,\d{3})+( \w+)?$|^\d+(\.\d+)?%$`,
  ),
  plainValue: new Pattern(String.raw`^\d+(\.\d+)?[kKmM]?$`),
  divider: new Pattern(
    String.raw`^((Today|Yesterday|(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d{1,2}(, \d{4})?),? )?(at )?\d{1,2}:\d\d(:\d\d)?\s?[AP]M$|^(Today|Yesterday)$`,
  ),
  claudeUI: new Pattern(
    String.raw`^(More options for |Message \d+$|Open .* in Background tasks$|.*, rename session$|Show message actions)`,
  ),
  statusLine: new Pattern(
    String.raw`^((Claude|ChatGPT|Gemini|Grok|Copilot) (is responding|is thinking|finished the response|stopped)|` +
      String.raw`(Thinking|Generating|Searching|Stopped|Sending|Sent|Delivered|Read|Failed)\b.{0,30}$)`,
  ),
  messageBubble: new Pattern(
    String.raw`^(Your iMessage|Your Text Message|Your SMS|[^,]{1,60}), (.*), (\d{1,2}:\d\d\s?[AP]M)$`,
  ),
  ownBubble: new Pattern(String.raw`^(Your iMessage|Your Text Message|Your SMS), (.*), (\d{1,2}:\d\d\s?[AP]M)$`),
  reaction: new Pattern(String.raw`, (You|[^,]{1,40}) reacted with [^,]+$`),
  replyDecoration: new Pattern(
    String.raw`^(Reply Preview|Reply…), |, [^,]{1,40} (liked|loved|laughed at|emphasized|disliked|questioned) this$`,
  ),
  nonTextBubble: new Pattern(String.raw`^(Sticker|Includes picture|Image|Photo|Attachment|\d+ (images?|photos?|videos?)\b)`),
  sendFailure: new Pattern(String.raw`Message Send Failure|Not Delivered|failed to send|couldn.t be sent`),
  slackReactions: new Pattern(String.raw`\.? ?\d+ reactions?\.?$`),
  slackPermalink: new Pattern(String.raw`/archives/[A-Z0-9]+/p\d+`),
  slackTimestampLabel: new Pattern(String.raw`^(Today|Yesterday|\w+day|\w+ \d+)(st|nd|rd|th)? at |^\d`),
  xStatus: new Pattern(String.raw`x\.com/[^/]+/status/\d+$`),
  chatHeading: new Pattern(String.raw`^(You said|Claude responded): `),
  messageGroup: new Pattern(String.raw`^Message \d+$`),
  clockTime: new Pattern(String.raw`\d:\d\d\s?[AP]M`),
  memoryTab: new Pattern(String.raw` - (Memory usage|High memory usage)`),
  gmailUnread: new Pattern(String.raw`^unread, `),
  focusedField: new Pattern(
    String.raw`\] (textarea|textfield)(?: "(.*?)")?(?: \(([a-z,]*)\))?(?: = "(.*)")?(?: placeholder=".*")?\s*$`,
  ),
  ignoredClickTarget: new Pattern(String.raw`^(webarea|dockitem|group "(Chat messages|Messages)")`),
  whitespaceRun: new Pattern(String.raw`\s+`),
  doubleSpace: new Pattern(String.raw`\s{2,}`),
  whitespace: new Pattern(String.raw`\s`),
  threeLetters: new Pattern(String.raw`[A-Za-z]{3}`),
  digit: new Pattern(String.raw`\d`),
  endsWithDigit: new Pattern(String.raw`\d$`),
  upToThreeDigits: new Pattern(String.raw`\d{1,3}`),
  continuation: new Pattern(String.raw`^[,.;:?!)]`),
  sentenceEnd: new Pattern(String.raw`[.!?:]$`),
  sentenceBreak: new Pattern(String.raw`(?<=[.!?])\s+(?=[A-Z“"(])`),
  shingleWord: new Pattern(String.raw`[a-z0-9#]+`),
  googleRedirect: new Pattern(String.raw`https?://www\.google\.[a-z.]+/url\?(?:.*&)?q=([^&]+)`),
  trailingQuerySeparators: new Pattern(String.raw`[?&]+$`),
  repeatedAmpersands: new Pattern(String.raw`&&+`),
  statusSubpage: new Pattern(String.raw`(/status/\d+)/(analytics|photo/\d+|likes|retweets|quotes)$`),
  mapsTail: new Pattern(String.raw`(/maps/(place|dir)/[^@]*?)/(@|data=).*$`),
  urlBase: new Pattern(String.raw`^(https?://[^/?#]+)([^?#]*)`),
  urlHost: new Pattern(String.raw`^[^/]+`),
  /** Shortcuts that say nothing (app/window switchers, Spotlight / input language). */
  ignoredShortcuts: new Set([
    '⌘\t', '⌘ ', '⌘⇧\t', '⌘`',
    // Windows
    'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Win+Tab', 'Win+Space', 'Alt+Esc',
  ]),
  /** Clipboard, close/new tab, reload and undo shortcuts write any waiting draft first. */
  flushShortcuts: new Set([
    '⌘V', '⌘C', '⌘X', '⌘W', '⌘T', '⌘R', '⌘Z',
    // Windows
    'Ctrl+V', 'Ctrl+C', 'Ctrl+X', 'Ctrl+W', 'Ctrl+T', 'Ctrl+R', 'Ctrl+Z',
  ]),
}

/** Window-title endings that say nothing about the page: browser tab states and the profile name. */
function titleJunk(profileName: string): Pattern {
  let endings =
    'Audio playing|Camera and microphone recording|Camera recording|Microphone recording|' +
    String.raw`High memory usage - [\d.]+ [MG]B|Memory usage - [\d.]+ [MG]B|Network sharing|Google Chrome` +
    // Windows: browser names at the end of the foreground window title
    '|Microsoft\u200B? Edge|Brave|Opera|Vivaldi|Mozilla Firefox'
  if (profileName) {
    const name = escapeRegex(profileName)
    endings += '|' + name + '|' + name + String.raw` \(Personal\)`
  }
  return new Pattern('( - (' + endings + '))+$')
}

// MARK: - Text helpers

function scalarCount(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** UTF-16 index just after the first `count` scalars. */
function scalarIndex(s: string, count: number): number {
  let i = 0
  let n = 0
  while (i < s.length && n < count) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    i++
    n++
  }
  return i
}

function scalarPrefix(s: string, count: number): string {
  return s.slice(0, scalarIndex(s, count))
}

function droppingFirst(s: string, count: number): string {
  return s.slice(scalarIndex(s, count))
}

function droppingLast(s: string, count: number): string {
  const total = scalarCount(s)
  return scalarPrefix(s, Math.max(0, total - count))
}

/** Whitespace as Python's `strip()` sees it. */
const WHITESPACE = new Set(
  Array.from(
    '\t\n\u000B\u000C\r\u001C\u001D\u001E\u001F \u0085\u00A0\u1680' +
      '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A' +
      '\u2028\u2029\u202F\u205F\u3000',
  ),
)

function trimSet(s: string, set: Set<string>, leading = true): string {
  let start = 0
  let end = s.length
  if (leading) while (start < end && set.has(s[start])) start++
  while (end > start && set.has(s[end - 1])) end--
  return s.slice(start, end)
}

function trim(s: string): string {
  return trimSet(s, WHITESPACE)
}

function trimTrailingWhitespace(s: string): string {
  return trimSet(s, WHITESPACE, false)
}

function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === '/') end--
  return s.slice(0, end)
}

function trimChars(s: string, chars: string): string {
  return trimSet(s, new Set(Array.from(chars)))
}

/** Substring test where an empty needle is always found. */
function includes(haystack: string, needle: string): boolean {
  return needle.length === 0 || haystack.includes(needle)
}

function nonEmpty(s: string | undefined | null): string | null {
  return s ? s : null
}

/**
 * Lowercases and collapses text so the same line reads the same each time: curly quotes
 * straightened, whitespace collapsed, and (with `maskNumbers`) ticking counters and elapsed
 * times replaced by `#`.
 */
function normalized(input: string, maskNumbers = true): string {
  let text = input
    .replaceAll('⏎', ' ')
    .replaceAll('’', "'")
    .replaceAll('‘', "'")
    .replaceAll('“', '"')
    .replaceAll('”', '"')
  text = trim(P.whitespaceRun.replace(text, ' ')).toLowerCase()
  if (maskNumbers) {
    // Neither pattern can match without a digit (or, for "an hour ago", without " ago").
    const hasDigit = /\p{Nd}/u.test(text)
    if (hasDigit || text.includes(' ago')) text = P.counter.replace(text, '#')
    if (hasDigit) text = P.elapsed.replace(text, '#')
  }
  return text
}

/** Splits long text into lines, and lines over 400 characters into sentences. */
function textSegments(text: string): string[] {
  const parts: string[] = []
  for (const rawLine of text.split(' ⏎ ')) {
    const line = trim(rawLine)
    if (scalarCount(line) > 400) {
      parts.push(...P.sentenceBreak.split(line).filter((p) => trim(p) !== ''))
    } else if (line !== '') {
      parts.push(line)
    }
  }
  return parts
}

/** Five-word shingles of normalized text. */
function shingles(key: string): Set<string> {
  const words = P.shingleWord.allMatches(key)
  const out = new Set<string>()
  if (words.length < 8) return out
  for (let i = 0; i <= words.length - 5; i++) out.add(words.slice(i, i + 5).join(' '))
  return out
}

/** Link URLs (not page URLs): map coordinates and long opaque tails dropped. */
function shortURL(input: string): string {
  let url = P.mapsTail.replace(input, '$1')
  if (scalarCount(url) > 160) {
    let base = url
    const groups = P.urlBase.matchAtStart(url)
    if (groups) base = (groups[1] ?? '') + (groups[2] ?? '')
    url = scalarCount(base) > 140 ? scalarPrefix(base, 140) + '…' : base + '?…'
  }
  return url
}

function removingPercentEncoding(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** Unwraps Google redirect links and strips tracking parameters. */
function cleanURL(input: string): string {
  if (!input) return input
  let url = input
  const groups = P.googleRedirect.matchAtStart(url)
  if (groups && groups[1] !== undefined) {
    const target = groups[1]
    url = removingPercentEncoding(target) ?? target
  }
  url = P.tracking.replace(url, '$1')
  url = P.trailingQuerySeparators.replace(url, '').replaceAll('?&', '?')
  url = P.repeatedAmpersands.replace(url, '&')
  url = P.statusSubpage.replace(url, '$1')
  return url
}

/** Ratcliff/Obershelp similarity from 0 to 1, as in the Swift port. */
function similarity(aText: string, bText: string): number {
  const a = Array.from(aText)
  const b = Array.from(bText)
  if (a.length === 0 && b.length === 0) return 1

  const matchingCount = (aLow: number, aHigh: number, bLow: number, bHigh: number): number => {
    let bestI = aLow
    let bestJ = bLow
    let bestSize = 0
    let previous = new Array<number>(Math.max(0, bHigh - bLow + 1)).fill(0)
    for (let i = aLow; i < aHigh; i++) {
      const current = new Array<number>(Math.max(0, bHigh - bLow + 1)).fill(0)
      for (let j = bLow; j < bHigh; j++) {
        if (a[i] !== b[j]) continue
        const size = previous[j - bLow] + 1
        current[j - bLow + 1] = size
        if (size > bestSize) {
          bestI = i - size + 1
          bestJ = j - size + 1
          bestSize = size
        }
      }
      previous = current
    }
    if (bestSize <= 0) return 0
    return (
      bestSize +
      matchingCount(aLow, bestI, bLow, bestJ) +
      matchingCount(bestI + bestSize, aHigh, bestJ + bestSize, bHigh)
    )
  }

  return (2 * matchingCount(0, a.length, 0, b.length)) / (a.length + b.length)
}

// MARK: - Screen items

/** One line of a screen-text snapshot or diff. */
interface ScreenItem {
  /** `+` added, `~` changed, undefined in a full snapshot. */
  mark?: string
  id: string
  role: string
  label: string
  states: string
  value: string
  placeholder?: string
  url: string
  /** "words" or "values" when several short pieces were joined into one. */
  run?: string
}

function parseItems(body: string | undefined | null): ScreenItem[] {
  if (body === undefined || body === null) return []
  const items: ScreenItem[] = []
  for (const line of body.split('\n')) {
    const g = P.screenLine.matchAtStart(line)
    if (!g || g[3] === undefined) continue
    items.push({
      mark: g[1],
      id: g[2] ?? '',
      role: g[3],
      label: g[4] ?? '',
      states: g[5] ?? '',
      value: g[6] ?? '',
      placeholder: g[7],
      url: g[8] ?? '',
    })
  }
  return items
}

/** Rejoins a sentence that a chat app split around inline code or links. */
function gluingInlinePieces(items: ScreenItem[]): ScreenItem[] {
  const isPlain = (item: ScreenItem) =>
    item.role === 'statictext' && item.url === '' && item.label === '' && trim(item.value) !== ''
  const continues = (item: ScreenItem) => isPlain(item) && P.continuation.matchesStart(item.value)

  const out: ScreenItem[] = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const next = index + 1 < items.length ? items[index + 1] : null
    const previous = out.length > 0 ? out[out.length - 1] : null
    if (
      previous &&
      isPlain(previous) &&
      isPlain(item) &&
      (continues(item) ||
        (scalarCount(item.value) <= 25 && !P.sentenceEnd.search(previous.value) && next !== null && continues(next)))
    ) {
      out[out.length - 1] = { ...previous, value: trimTrailingWhitespace(previous.value) + ' ' + trim(item.value) }
      continue
    }
    out.push({ ...item })
  }
  return out
}

/** Joins runs of short text pieces that belong to one sentence or one row. */
function mergingShortRuns(items: ScreenItem[]): ScreenItem[] {
  const out: ScreenItem[] = []
  let run: ScreenItem[] = []
  let afterRow = false

  const isPiece = (item: ScreenItem) =>
    item.role === 'statictext' && item.url === '' && item.label === '' && scalarCount(item.value) <= 25

  const closeRun = () => {
    const texts = run.map((i) => i.value).filter((v) => trim(v) !== '')
    const words = texts.filter((t) => P.threeLetters.search(t))
    const bare = texts.filter((t) => !trim(t).includes(' ')).length
    let isStream = texts.length >= 6 && bare >= 0.8 * texts.length && words.length >= 3
    isStream = isStream || (texts.length >= 3 && texts.includes('`'))
    const isValues = texts.length >= 3 && words.length > 0 && texts.some((t) => P.digit.search(t)) && !afterRow
    if ((isStream || isValues) && !afterRow) {
      const lead: ScreenItem = { ...run[0] }
      lead.value = texts.join(' ')
      lead.run = isValues ? 'values' : 'words'
      const last = out.length > 0 ? out[out.length - 1] : null
      if (isValues && last && last.role === 'popupbutton' && last.label !== '') {
        lead.value = last.label + ': ' + lead.value
      }
      out.push(lead)
    } else {
      out.push(...run)
    }
    run = []
  }

  for (const item of items) {
    if (isPiece(item)) {
      run.push(item)
      continue
    }
    if (run.length > 0) closeRun()
    if (item.role === 'row') {
      afterRow = true
    } else if (!['cell', 'column', 'table'].includes(item.role)) {
      afterRow = false
    }
    out.push(item)
  }
  if (run.length > 0) closeRun()
  return out
}

// MARK: - Condenser

/** What has been written in one 15-minute window, for deciding what is new. */
class CondenserWindow {
  readonly start: number
  lines: string[] = []
  seen = new Set<string>()
  shingles = new Set<string>()
  urls = new Set<string>()
  /** Every normalized text written, newline-separated, in chunks of whole entries. Keys never
   * contain "\n", so a key found in the blob always lies within one entry, and searching the
   * chunks one by one finds exactly what a search of the whole blob would. */
  private chunks: string[] = ['']
  private blobLength = 0

  constructor(start: number) {
    this.start = start
  }

  addToBlob(key: string): void {
    const last = this.chunks.length - 1
    if (this.chunks[last].length > 65_536) this.chunks.push(key + '\n')
    else this.chunks[last] += key + '\n'
    this.blobLength += utf8Length(key) + 1
  }

  blobContains(key: string): boolean {
    if (key.length === 0) return true
    if (utf8Length(key) > this.blobLength) return false
    for (const chunk of this.chunks) if (chunk.includes(key)) return true
    return false
  }
}

interface FieldKey {
  app: string
  field: string
}

function fk(key: FieldKey): string {
  return key.app + '\u0000' + key.field
}

interface SpeakerTag {
  who: string
  message: number | null
}

interface PendingSubmit {
  time: number
  app: string
  field: string
  text: string
  reads: string[]
  seenBefore: Set<string>
  draft: string
  window: CondenserWindow
  lineIndex: number
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function clock(time: number): string {
  const d = new Date(time)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** "h:mm a" in en_US_POSIX, e.g. "2:31 PM". */
function bubbleTime(time: number): string {
  const d = new Date(time)
  const h = d.getHours()
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`
}

function isAllNumbers(s: string): boolean {
  return /^\p{N}*$/u.test(s)
}

class Condenser {
  private readonly titleJunk: Pattern
  private readonly windowMinutes = 15
  private readonly vocabularyWindows = 2

  private window: CondenserWindow | null = null
  private windows: CondenserWindow[] = []
  private currentApp: string | null = null
  private currentTitle: string | null = null
  private lastHeader: { app: string; slot: number } | null = null
  private fieldValue = new Map<string, string>()
  private pendingTyping: { key: FieldKey; time: number; text: string }[] = []
  private pendingSubmits: PendingSubmit[] = []
  private speaker = new Map<string, SpeakerTag>()
  private pages = new Map<string, { title: string; url: string }>()
  private vocabulary = new Map<string, Set<number>>()
  private box = new Map<string, string>()
  private placeholders = new Map<string, Set<string>>()
  private attached = new Map<string, string>()
  private elementText = new Map<string, string>()
  private highestMessage = new Map<string, number>()
  private messageLines = new Map<string, Set<string>>()
  private queued = new Map<string, string[]>()

  constructor(titleJunkPattern: Pattern) {
    this.titleJunk = titleJunkPattern
  }

  run(events: A11yEvent[]): string {
    for (const event of events) this.handle(event)
    this.closeWindow()
    return trim(this.windows.flatMap((w) => w.lines).join('\n'))
  }

  // MARK: Window bookkeeping

  /** The window for `time`, opening a new one at each 15-minute boundary. */
  private windowFor(time: number): CondenserWindow {
    const d = new Date(time)
    const start = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      Math.floor(d.getMinutes() / this.windowMinutes) * this.windowMinutes,
    ).getTime()

    if (this.window && this.window.start === start) return this.window
    this.closeWindow()
    const newWindow = new CondenserWindow(start)
    this.window = newWindow
    this.windows.push(newWindow)
    this.lastHeader = null
    this.speaker = new Map()
    if (this.currentApp) {
      newWindow.lines.push(clock(time) + ' (in ' + this.currentApp + ': ' + (this.currentTitle ?? '') + ')')
    }
    return newWindow
  }

  private closeWindow(): void {
    if (!this.window) return
    this.flushTyping()
    this.resolveSubmits(null, true)
  }

  private emit(line: string): void {
    this.window?.lines.push(line)
  }

  // MARK: Deciding what is new

  /** The part of `text` not yet written in this window, or null when all of it was. */
  private newText(text: string, exact = false): string | null {
    const window = this.window
    if (!window) return text
    const key = normalized(text)
    if (window.seen.has(key)) return null
    if (exact) {
      window.seen.add(key)
      window.addToBlob(key)
      return text
    }
    if (scalarCount(key) >= 4 && window.blobContains(key)) {
      window.seen.add(key)
      return null
    }
    const keyShingles = shingles(key)
    if (keyShingles.size >= 4) {
      let have = 0
      for (const s of keyShingles) if (window.shingles.has(s)) have++
      const needed = (keyShingles.size >= 40 ? 0.9 : 1.0) * keyShingles.size
      if (have >= needed) {
        window.seen.add(key)
        return null
      }
    }
    if (scalarCount(text) >= 120) {
      const kept: string[] = []
      for (const segment of textSegments(text)) {
        const segmentKey = normalized(segment)
        if (scalarCount(segmentKey) < 3) continue
        if (window.seen.has(segmentKey)) continue
        if (scalarCount(segmentKey) >= 25 && window.blobContains(segmentKey)) continue
        const segmentShingles = shingles(segmentKey)
        if (segmentShingles.size >= 4 && [...segmentShingles].every((s) => window.shingles.has(s))) continue
        for (const s of segmentShingles) window.shingles.add(s)
        window.seen.add(segmentKey)
        kept.push(segment)
      }
      window.seen.add(key)
      if (kept.length === 0) return null
      const out = kept.join(' ⏎ ')
      window.addToBlob(normalized(out))
      return out
    }
    window.seen.add(key)
    for (const s of keyShingles) window.shingles.add(s)
    window.addToBlob(key)
    return text
  }

  // MARK: Screen reads

  private screen(event: A11yEvent): void {
    const app = event.app ?? ''
    const items = parseItems(nonEmpty(event.diff) ?? event.tree)
    const title = this.titleJunk.replace(event.window ?? '', '')
    if (title !== '' && this.currentApp === null) {
      // The log starts mid-session with no window event: name the window being read.
      this.currentApp = app
      this.currentTitle = title
      this.emit(clock(event.time) + ' (in ' + app + ': ' + title + ')')
    } else if (title !== '' && app === this.currentApp && title !== this.currentTitle) {
      // The title changed without a window event (tab switch, page load in place).
      this.currentTitle = title
      this.emit(clock(event.time) + ' → ' + app + ': ' + title)
    }

    const rendered = this.renderItems(app, items)
    if (rendered.length === 0) return
    const slot = Math.floor(Math.trunc(event.time / 1000) / 20)
    if (this.lastHeader?.app !== app || this.lastHeader?.slot !== slot) {
      this.emit(clock(event.time) + ' ' + app + ' screen:')
      this.lastHeader = { app, slot }
    }
    for (const line of rendered) this.emit('  ' + line)
  }

  private renderItems(app: string, rawItems: ScreenItem[]): string[] {
    const window = this.window
    if (!window) return []
    const out: string[] = []
    let lastContent: number | null = null
    let pendingSpeaker: string | null = null
    let messageNumber: number | null = null
    let groupSpeaker: string | null = null
    let row: { label: string; index: number | null; cells: string[] } | null = null
    let lastLabel: { text: string; index: number | null } | null = null
    let nextStatus: string | null = null
    let anchor = ''
    let table: string | null = null
    let tableLabels = new Set<string>()
    const items = mergingShortRuns(gluingInlinePieces(rawItems))

    const flushRow = () => {
      const current = row
      if (current && current.cells.length > 0) {
        const full = current.label + ' | ' + current.cells.join(' | ')
        const alreadySeen = window.seen.has(normalized(current.label + ' ' + current.cells.join(' ')))
        if (!alreadySeen) {
          const nw = this.newText(full)
          if (nw !== null) {
            if (current.index !== null && current.index < out.length && out[current.index] === current.label) {
              out[current.index] = nw
            } else {
              out.push(nw)
            }
          }
        }
      }
      row = null
    }

    const sessionKey = () => app + '\u0001' + (this.pages.get(app)?.title ?? '')

    for (const item of items) {
      const role = item.role
      const label = item.label
      const value = item.value
      let url = cleanURL(item.url)
      if (item.placeholder) this.addPlaceholder(app, item.placeholder)
      if ((role === 'textarea' || role === 'textfield') && label !== '') {
        this.addPlaceholder(app, label)
        if (item.states.includes('focused') && value !== '') {
          this.box.set(fk({ app, field: label }), value) // the last text the box showed
        }
      }
      if (app === 'Claude' && role === 'group') {
        if (label === 'Currently streaming message') {
          groupSpeaker = 'CLAUDE'
          continue
        }
        if (P.messageGroup.matchesStart(label)) {
          groupSpeaker = '?'
          const n = label.split(' ').filter((s) => s !== '')[1] ?? ''
          messageNumber = /^[+-]?[0-9]+$/.test(n) ? parseInt(n, 10) : null
          continue
        }
        if (['Environment', 'Background tasks', 'Sessions'].includes(label)) {
          groupSpeaker = null
          messageNumber = null
        }
      }
      if (app === 'Claude' && role === 'webarea') {
        groupSpeaker = null
        messageNumber = null
      }
      const labelAndValue = [label, value].filter((s) => s !== '').join(' = ')
      const lowered = trim(labelAndValue.toLowerCase())
      let isBubble = false

      const youSaidButton = 'Show message actions for You said: '
      if (role === 'button' && (app === 'Claude' || P.browsers.has(app)) && label.startsWith(youSaidButton)) {
        // claude.ai puts this button after the user's message text, with no heading before it.
        const said = scalarPrefix(normalized(droppingFirst(label, scalarCount(youSaidButton)), false), 40)
        const index: number | null = lastContent
        if (
          said !== '' &&
          index !== null &&
          normalized(out[index], false).startsWith(said) &&
          !(index > 0 && out[index - 1].startsWith('--- YOU'))
        ) {
          out.splice(index, 0, '--- YOU:')
          lastContent = index + 1
          this.speaker.set(app, { who: 'YOU', message: null })
          pendingSpeaker = '--- CLAUDE:'
        }
        continue
      }
      if ((role === 'button' || role === 'heading') && label !== '' && scalarCount(label) < 80) {
        anchor = label
      }
      if (P.chatApps.has(app) && (lowered.includes('attached link, ') || lowered.startsWith('attachment'))) {
        this.attached.set(app, labelAndValue)
      }

      // Tables: each row is written as "label | cell | cell".
      if (role === 'table') {
        flushRow()
        table = 'start'
        tableLabels = new Set()
        continue
      }
      if (role === 'row') {
        flushRow()
        table = 'row'
        continue
      }
      if (table !== null && ['statictext', 'cell', 'text'].includes(role) && url === '') {
        const tableState: string = table
        const isShort = scalarCount(labelAndValue) > 0 && scalarCount(labelAndValue) < 60
        if (!isShort) {
          flushRow()
          table = null
        } else if (tableLabels.has(normalized(labelAndValue)) && tableState !== 'flat') {
          flushRow()
          table = 'flat' // the same table again as loose text
          continue
        } else if (tableState === 'flat') {
          continue
        } else if (tableState === 'cells' && row !== null) {
          ;(row as { cells: string[] }).cells.push(labelAndValue)
          continue
        } else if (tableState === 'row' || tableState === 'start') {
          tableLabels.add(normalized(labelAndValue))
          flushRow()
          const nw = this.newText(labelAndValue)
          if (nw !== null) {
            out.push(nw)
            lastContent = out.length - 1
          }
          row = { label: labelAndValue, index: nw !== null ? lastContent : null, cells: [] }
          table = 'cells'
          continue
        }
      } else if (table !== null && !['row', 'cell', 'column', 'group'].includes(role)) {
        flushRow()
        table = null
      }

      // Value cells and row statuses join the label before them.
      const previousLabel = lastLabel as { text: string; index: number | null } | null
      if (
        ['statictext', 'cell', 'text', 'button', 'link'].includes(role) &&
        url === '' &&
        previousLabel !== null &&
        scalarCount(labelAndValue) < 40 &&
        ((P.value.matchesStart(labelAndValue) && !P.counter.search(labelAndValue)) ||
          P.rowStatus.has(trim(labelAndValue)) ||
          (row !== null && (row as { cells: string[] }).cells.length > 0 && P.plainValue.matchesStart(labelAndValue)))
      ) {
        const currentRow = row as { label: string } | null
        if (currentRow === null || currentRow.label !== previousLabel.text) {
          flushRow()
          row = { label: previousLabel.text, index: previousLabel.index, cells: [] }
        }
        ;(row as unknown as { cells: string[] }).cells.push(labelAndValue)
        continue
      }
      if (role === 'statictext' && P.nextStatus.has(lowered)) {
        nextStatus = labelAndValue
        continue
      }
      if (P.chatApps.has(app) && (role === 'statictext' || role === 'heading') && P.divider.matchesStart(labelAndValue)) {
        flushRow()
        const nw = this.newText('-- ' + labelAndValue + ' --')
        if (nw !== null) out.push(nw)
        continue
      }
      if (app === 'Messages' && (role === 'group' || role === 'statictext') && label.startsWith('Message, ')) {
        continue // the composer's mirror of the text box
      }
      if (P.dropRoles.has(role) && label === '') continue
      let text = labelAndValue
      if (text === '' && url === '') continue
      if (['menuitem', 'radiobutton', 'checkbox'].includes(role) && item.states.includes('disabled')) {
        text += ' (disabled)'
      }

      // Page identity.
      if (role === 'webarea') {
        if (url.startsWith('about:') || url.startsWith('file:') || url.startsWith('chrome:')) continue
        this.pages.set(app, { title: label, url })
        let line = url === '' ? 'PAGE ' + label : 'PAGE ' + label + ' <' + url + '>'
        if (app === 'Claude' && label.endsWith(' - Claude Code')) {
          line = 'SESSION ' + droppingLast(label, 14) + ' <' + url + '>'
        }
        if (this.newText(line) !== null) out.push(line)
        continue
      }

      // Interface chrome.
      if (role === 'window') continue
      if (role === 'statictext' && value === '' && label === '') continue
      if (P.metric.matchesStart(text) && url === '') continue
      const isSelected = item.states.includes('selected')
      if (P.controlRoles.has(role) && P.uiWords.has(text.toLowerCase())) continue
      if (role === 'slider') continue
      if (
        P.controlRoles.has(role) &&
        role !== 'popupbutton' &&
        role !== 'combobox' &&
        scalarCount(text) < 80 &&
        !isSelected &&
        !P.clockTime.search(text)
      ) {
        const vocabularyKey = app + '\u0001' + normalized(text)
        const seenIn = this.vocabulary.get(vocabularyKey) ?? new Set<number>()
        let others = 0
        for (const s of seenIn) if (s !== window.start) others++
        const isKnown = others >= this.vocabularyWindows
        seenIn.add(window.start)
        this.vocabulary.set(vocabularyKey, seenIn)
        if (isKnown) continue
      }
      if (P.durationOnly.matchesStart(text)) continue
      if (
        P.dateToken.count(text) >= 4 &&
        scalarCount(trimChars(P.dateToken.replace(text, ''), ' ,?')) < 0.3 * scalarCount(text)
      ) {
        continue // date-picker grids
      }
      if (app === 'Claude' && P.claudeUI.matchesStart(text)) continue
      if (role === 'heading' && value !== '' && isAllNumbers(value)) {
        text = label
      }
      if (role === 'radiobutton' && P.memoryTab.search(text)) continue
      if (role === 'textfield' && P.addressFields.has(label)) {
        if (value === '') continue
        text = 'address bar = ' + shortURL(cleanURL(value))
      }
      if (P.uiWords.has(text.toLowerCase())) continue

      if (P.browsers.has(app)) {
        text = P.gmailUnread.replace(text, '[unread] ')
      }
      if (scalarCount(text) >= 20 && app !== 'Slack') {
        text = P.metricPhrase.replace(text, '').replaceAll(' Verified account', '')
        text = trimChars(P.doubleSpace.replace(text, ' '), ' ,·')
      }

      // Per-app rewriting.
      if (app === 'Messages' && ['group', 'button', 'statictext', 'link'].includes(role)) {
        const groups = P.messageBubble.matchAtStart(text)
        if (groups && ['group', 'button', 'link'].includes(role)) {
          const sender = groups[1] ?? ''
          const who = sender.startsWith('Your ') ? 'Me' : sender
          const body = P.reaction.replace(groups[2] ?? '', '')
          text = who + ': ' + body + ' (' + (groups[3] ?? '') + ')'
          isBubble = true
        } else if (role === 'statictext' && text.includes(', Unread, ')) {
          text = '[unread] ' + text.replaceAll(', Pinned', '')
        }
      }
      if (P.sendFailure.search(text)) {
        text = '[SEND FAILED] ' + text
      }
      if (app === 'Slack') {
        text = P.slackReactions.replace(text, '')
        if (role === 'link' && url !== '' && P.slackPermalink.search(url) && P.slackTimestampLabel.matchesStart(label)) {
          if (lastContent !== null && !out[lastContent].includes('<')) out[lastContent] += ' <' + url + '>'
          continue
        }
      }
      if (
        P.browsers.has(app) &&
        role === 'link' &&
        url !== '' &&
        P.xStatus.search(url) &&
        P.metric.matchesStart(label.split('.')[0] ?? '')
      ) {
        if (lastContent !== null && !out[lastContent].includes('<')) out[lastContent] += ' <' + url + '>'
        continue
      }
      if (role === 'heading' && (app === 'Claude' || P.browsers.has(app))) {
        const groups = P.chatHeading.matchAtStart(label)
        if (groups) {
          groupSpeaker = groups[1] === 'You said' ? 'YOU' : 'CLAUDE'
          const said = trim(droppingFirst(label, scalarCount(groups[0] ?? '')))
          if (groupSpeaker === 'YOU' && said !== '') {
            const saidStart = scalarPrefix(normalized(said, false), 40)
            const list = this.queued.get(app)
            const index = saidStart !== '' && list ? list.findIndex((q) => includes(q, saidStart)) : -1
            if (index >= 0 && list) {
              list.splice(index, 1)
              out.push('(queued message now sent: "' + said + '")')
            }
            if (window.seen.has(normalized(said)) && this.newText('you said: ' + said) !== null) {
              // The text was already written (as an option chip or a draft); record that it was sent.
              this.speaker.set(app, { who: 'YOU', message: messageNumber })
              out.push(messageNumber !== null ? `--- YOU (message ${messageNumber}):` : '--- YOU:')
              out.push(said)
            }
          }
          continue
        }
      }
      if (app === 'Claude' && role === 'button' && label.startsWith('Show message actions')) continue

      // Links: label plus destination.
      let line: string
      if (role === 'link' && url !== '') {
        const page = this.pages.get(app)?.url ?? ''
        const bareURL = trimTrailingSlashes(url.split('://').pop() ?? '')
        if (url === page || url.startsWith('javascript:') || url === '#') {
          url = ''
        } else if (text !== '' && includes(text, bareURL)) {
          url = ''
        }
        if (url !== '') url = shortURL(url)
        line = url === '' ? text : text + ' <' + url + '>'
      } else {
        line = text
      }
      if (['textarea', 'textfield', 'combobox', 'searchfield'].includes(role) && item.states.includes('focused')) {
        if (value === '') continue
        line = '[input focused] ' + line
        groupSpeaker = null
      }
      if (role === 'link' && P.browsers.has(app) && url !== '' && this.isRedundantLink(text, url)) continue
      if (nextStatus !== null) {
        line = '[' + nextStatus + '] ' + line
        nextStatus = null
      }
      if (line !== '' && role !== 'popupbutton') {
        flushRow()
        lastLabel = { text: line, index: null }
      }

      let nw: string | null
      if (item.run === 'values') {
        nw = this.newText(line + ' @' + anchor) !== null ? line : null
      } else {
        nw = this.newText(line, isBubble || role === 'popupbutton' || (item.mark === '~' && scalarCount(line) < 60))
        const elementKey = app + '\u0001' + item.id
        const previous = this.elementText.get(elementKey)
        this.elementText.set(elementKey, line)
        if (
          nw === null &&
          item.mark === '~' &&
          previous !== undefined &&
          previous !== '' &&
          previous !== line &&
          P.statusLine.matchesStart(line)
        ) {
          nw = line // a status that changed back to text seen earlier
        }
        if (messageNumber !== null && groupSpeaker === 'YOU') {
          // In the user's newest message, a line repeats only within that message.
          const number = messageNumber
          const session = sessionKey()
          if (number >= (this.highestMessage.get(session) ?? 0) - 1) {
            const messageKey = session + '\u0001' + String(number)
            const mine = this.messageLines.get(messageKey) ?? new Set<string>()
            const key = normalized(line)
            if (nw === null && !mine.has(key) && ![...mine].some((m) => includes(m, key))) nw = line
            mine.add(key)
            this.messageLines.set(messageKey, mine)
          }
        }
      }

      if (nw === null || nw === '') continue
      if (app === 'Claude' && groupSpeaker === null) this.speaker.delete(app)
      if (groupSpeaker !== null && (app === 'Claude' || P.browsers.has(app))) {
        // A message group with no "You said" heading is Claude's (streaming or tool output).
        const who = groupSpeaker === '?' ? 'CLAUDE' : groupSpeaker
        const tag: SpeakerTag = { who, message: messageNumber }
        const currentTag = this.speaker.get(app)
        if (!currentTag || currentTag.who !== tag.who || currentTag.message !== tag.message) {
          this.speaker.set(app, tag)
          pendingSpeaker = '--- ' + who + ':'
          if (messageNumber !== null) {
            const number = messageNumber
            const session = sessionKey()
            const top = this.highestMessage.get(session) ?? 0
            if (number < top - 1) {
              pendingSpeaker = `--- ${who} (message ${number}, earlier, scrolled back into view):`
            } else {
              pendingSpeaker = `--- ${who} (message ${number}):`
            }
            this.highestMessage.set(session, Math.max(top, number))
          }
        }
      }
      if (pendingSpeaker !== null) {
        out.push(pendingSpeaker)
        pendingSpeaker = null
      }
      out.push(nw)
      lastContent = out.length - 1
      const lbl = lastLabel as { text: string; index: number | null } | null
      if (lbl !== null && lbl.text === line) lastLabel = { text: line, index: lastContent }
    }
    flushRow()
    return out
  }

  private addPlaceholder(app: string, text: string): void {
    let set = this.placeholders.get(app)
    if (!set) {
      set = new Set()
      this.placeholders.set(app, set)
    }
    set.add(text)
  }

  /** A link adds nothing when its label is already written and its URL is a profile or
   * section page (one path segment), or the URL was written. */
  private isRedundantLink(text: string, url: string): boolean {
    const window = this.window
    if (!window) return false
    const bareURL = url.split('://').pop() ?? ''
    if (window.urls.has(bareURL)) return true
    const path = trimChars(P.urlHost.replace(bareURL.split('?')[0] ?? '', ''), '/')
    if (!path.includes('/')) {
      const key = normalized(text)
      if (key === '' || window.blobContains(key) || scalarCount(key) < 30) return true
    }
    window.urls.add(bareURL)
    return false
  }

  // MARK: Actions

  /** Writes every draft still waiting, in the order the fields were first typed into. */
  private flushTyping(): void {
    const drafts = this.pendingTyping
    this.pendingTyping = []
    for (const draft of drafts) {
      const added = this.addedText(draft.key, draft.text)
      if (trim(added) !== '') {
        this.emit(
          clock(draft.time) + ' you typed in ' + draft.key.app + ' "' + draft.key.field + '" (draft): "' + added + '"',
        )
      }
    }
  }

  private removePendingTyping(key: FieldKey): { time: number; text: string } | null {
    const index = this.pendingTyping.findIndex((p) => p.key.app === key.app && p.key.field === key.field)
    if (index < 0) return null
    const [entry] = this.pendingTyping.splice(index, 1)
    return { time: entry.time, text: entry.text }
  }

  private setPendingTyping(key: FieldKey, time: number, text: string): void {
    const index = this.pendingTyping.findIndex((p) => p.key.app === key.app && p.key.field === key.field)
    if (index >= 0) this.pendingTyping[index] = { key, time, text }
    else this.pendingTyping.push({ key, time, text })
  }

  /** For fields that hold a whole buffer (terminals), only what was added. */
  private addedText(key: FieldKey, text: string): string {
    const previous = this.fieldValue.get(fk(key))
    this.fieldValue.set(fk(key), text)
    if (previous !== undefined && scalarCount(previous) > 200) {
      const previousLines = new Set(previous.split(' ⏎ ').map((l) => normalized(l)))
      const added = text.split(' ⏎ ').filter((l) => !previousLines.has(normalized(l)))
      return added.slice(Math.max(0, added.length - 40)).join(' ⏎ ')
    }
    return text
  }

  /** Gives each waiting Return the screen reads from the 2.2 seconds after it, then writes
   * its line once that time has passed. */
  private resolveSubmits(event: A11yEvent | null, force = false): void {
    const keep: PendingSubmit[] = []
    for (const submit of this.pendingSubmits) {
      if (
        event &&
        event.app === submit.app &&
        (event.kind === 'diff' || event.kind === 'snapshot') &&
        (event.time - submit.time) / 1000 <= 2.2
      ) {
        submit.reads.push(nonEmpty(event.diff) ?? nonEmpty(event.tree) ?? '')
      }
      if (force || event === null || (event.time - submit.time) / 1000 > 2.2) {
        const line = this.submitLine(submit)
        if (line !== null) {
          const window = this.window
          if (window && submit.window === window && submit.lineIndex <= window.lines.length) {
            window.lines.splice(submit.lineIndex, 0, line)
          } else {
            this.emit(line)
          }
        }
      } else {
        keep.push(submit)
      }
    }
    this.pendingSubmits = keep
  }

  /** Messages: the user's own new bubble that appeared after Return. */
  private sentBubble(app: string, reads: string[], seenBefore: Set<string>, typed: string, time: number): string | null {
    if (app !== 'Messages') return null
    const minutes = new Set([bubbleTime(time), bubbleTime(time + 60_000)])
    let candidates: string[] = []
    for (const body of reads) {
      for (const item of parseItems(body)) {
        if (!['group', 'button', 'link'].includes(item.role)) continue
        const groups = P.ownBubble.matchAtStart(item.label)
        if (!groups) continue
        const stamp = groups[3] ?? ''
        const shown = P.reaction.replace(groups[2] ?? '', '')
        if (seenBefore.has(normalized('Me: ' + shown + ' (' + stamp + ')'))) continue
        if (!minutes.has(P.whitespace.replace(stamp, ' ').toUpperCase())) continue
        const message = trim(P.replyDecoration.replace(shown, ''))
        if (message !== '' && !candidates.includes(message)) candidates.push(message)
      }
    }
    if (typed !== '') {
      // A sticker, photo or attachment bubble is not the text that was in the box.
      candidates = candidates.filter((c) => !P.nonTextBubble.matchesStart(c))
    }
    if (candidates.length === 0) return null
    const last = candidates[candidates.length - 1]
    if (candidates.length === 1 || typed === '') return last
    const typedKey = normalized(typed, false)
    // Swift max(by:): the first of the most similar.
    let best = candidates[0]
    let bestScore = similarity(normalized(best, false), typedKey)
    for (const c of candidates.slice(1)) {
      const score = similarity(normalized(c, false), typedKey)
      if (bestScore < score) {
        best = c
        bestScore = score
      }
    }
    return best
  }

  private submitLine(submit: PendingSubmit): string | null {
    const time = clock(submit.time)
    const app = submit.app
    const field = submit.field
    const key: FieldKey = { app, field }
    const bubble = this.sentBubble(app, submit.reads, submit.seenBefore, nonEmpty(submit.text) ?? submit.draft, submit.time)
    if (bubble !== null) {
      this.fieldValue.set(fk(key), '')
      return time + ' you SENT in ' + app + ' "' + field + '": "' + bubble + '"'
    }
    let text = submit.text
    if (trim(text) === '' && trim(submit.draft) !== '' && !P.terminals.has(app)) {
      text = submit.draft // Return read back nothing; the last draft is what was in the field
    }
    const shown = text === '' ? '' : this.addedText(key, text)
    if (P.addressFields.has(field)) {
      return time + ' you went to (in ' + app + '): "' + shown + '"'
    }

    const body = submit.reads.join('\n')
    const bodyLines = body.split('\n')
    const addedLines = bodyLines.filter((l) => trim(l).startsWith('+'))
    const parts = text.split(' ⏎ ')
    const lastLine = parts[parts.length - 1] ?? ''
    const typedStart = normalized(scalarPrefix(trim(lastLine), 60), false)

    let isStillInBox = false
    let wasCleared = false
    for (const line of bodyLines) {
      const groups = P.focusedField.firstMatch(line)
      if (!groups) continue
      const states = nonEmpty(groups[3])
      if (states === null || !states.includes('focused')) continue
      const fieldText = nonEmpty(groups[4])
      if (fieldText !== null) {
        if (typedStart !== '' && includes(normalized(fieldText, false), typedStart)) isStillInBox = true
      } else {
        wasCleared = true
      }
    }
    const youSaid =
      typedStart !== '' &&
      addedLines.some(
        (l) => l.includes('heading "You said: ') && includes(normalized(l, false), scalarPrefix(typedStart, 40)),
      )
    const isQueued = body.includes('Cancel and edit message') && body.includes('Send now') && !youSaid
    const appeared =
      typedStart !== '' &&
      addedLines
        .filter((l) => !l.includes('focused'))
        .some((l) => {
          const pieces = l.split(']')
          const afterId = pieces.length > 1 ? pieces[1] : ''
          return includes(normalized(l, false), typedStart) && !scalarPrefix(afterId, 10).includes('textarea')
        })

    let status = 'pressed Return (outcome not seen)'
    if (isStillInBox) {
      status = 'pressed Return, text still in box (not sent)'
    } else if (isQueued) {
      status = 'QUEUED (shown with Send now / Cancel, the assistant was still answering the previous message)'
    } else if (appeared || wasCleared || youSaid) {
      status = 'SENT (box cleared' + (appeared ? ', message shown)' : ')')
    }
    if (isQueued && text !== '') {
      const list = this.queued.get(app) ?? []
      list.push(normalized(text, false))
      this.queued.set(app, list)
    }

    if (text === '') {
      if (P.terminals.has(app) || P.noteApps.has(app)) return null
      const attachment = this.attached.get(app)
      if (attachment !== undefined) {
        this.attached.delete(app)
        return time + ' you pressed Return in ' + app + ' "' + field + '" with ' + attachment + ' (text not read)'
      }
      return time + ' you pressed Return in ' + app + (field !== 'field' ? ' "' + field + '"' : '') + ' (text not read)'
    }
    if (P.terminals.has(app)) {
      return time + ' you ran in ' + app + ': "' + shown + '"'
    }
    if (P.noteApps.has(app)) {
      return null // Return is a line break; the typed text is recorded separately
    }
    return time + ' you ' + status + ' in ' + app + ' "' + field + '": "' + shown + '"'
  }

  // MARK: Events

  private handle(event: A11yEvent): void {
    const kind = event.kind
    const app = event.app ?? ''
    if (kind === 'session_start' || kind === 'session_stop') return
    const window = this.windowFor(event.time)
    if (this.pendingSubmits.length > 0) this.resolveSubmits(event)
    const time = clock(event.time)
    if (event.blocked === true) {
      this.emit(time + ' ' + app + ': blocked app, nothing recorded')
      return
    }

    switch (kind) {
      case 'window': {
        const title = this.titleJunk.replace(event.window ?? '', '')
        if (app !== this.currentApp || title !== this.currentTitle) {
          this.currentApp = app
          this.currentTitle = title
          this.emit(time + ' → ' + app + ': ' + title)
        }
        return
      }
      case 'snapshot':
      case 'diff':
        this.screen(event)
        return
      case 'text': {
        const key: FieldKey = { app, field: nonEmpty(event.field) ?? 'field' }
        const text = event.text ?? ''
        const appPlaceholders = this.placeholders.get(app) ?? new Set<string>()
        if (P.upToThreeDigits.matchesWhole(text) && P.endsWithDigit.search(key.field) && !appPlaceholders.has(key.field)) {
          return // a counter or heading level read as a field value, not typing
        }
        if (trim(text) === '' || text === key.field || appPlaceholders.has(text)) {
          const pending = this.removePendingTyping(key)
          if (
            (pending !== null && trim(pending.text) !== '') ||
            trim(this.fieldValue.get(fk(key)) ?? '') !== '' ||
            trim(this.box.get(fk(key)) ?? '') !== ''
          ) {
            this.fieldValue.set(fk(key), '')
            this.box.set(fk(key), '')
            this.emit(time + ' you cleared ' + app + ' "' + key.field + '" (draft deleted, not sent)')
          }
          return
        }
        this.setPendingTyping(key, event.time, text)
        return
      }
      case 'submit': {
        const field = nonEmpty(event.field) ?? 'field'
        const key: FieldKey = { app, field }
        const pending = this.removePendingTyping(key)
        const draft = pending
          ? pending.text
          : (nonEmpty(this.box.get(fk(key))) ?? nonEmpty(this.fieldValue.get(fk(key))) ?? '')
        this.box.set(fk(key), '')
        this.pendingSubmits.push({
          time: event.time,
          app,
          field,
          text: event.text ?? '',
          reads: [],
          seenBefore: new Set(window.seen),
          draft,
          window,
          lineIndex: window.lines.length,
        })
        return
      }
      case 'click':
      case 'drag':
      case 'context_menu': {
        this.flushTyping()
        let target = nonEmpty(event.target) ?? '(unknown)'
        if (target.includes('(no label)') || target === '(unknown)') return
        if (P.ignoredClickTarget.matchesStart(target)) return
        if (scalarCount(target) > 160) target = scalarPrefix(target, 160) + '…'
        const verb = ({ click: 'clicked', drag: 'dragged', context_menu: 'context menu' } as Record<string, string>)[kind] ?? kind
        this.emit(time + ' you ' + verb + ' in ' + app + ': ' + target)
        return
      }
      case 'shortcut': {
        const keys = event.keys ?? ''
        if (P.ignoredShortcuts.has(keys)) return
        if (P.flushShortcuts.has(keys)) this.flushTyping()
        this.emit(time + ' you pressed ' + keys + ' in ' + app)
        return
      }
      default:
        return // escape and anything newer say nothing worth writing
    }
  }
}
