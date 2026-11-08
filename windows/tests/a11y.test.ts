import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { condense, icu, trimmed } from '../src/main/a11y/condenser.ts'
import { A11yLogStore, decodeEvent, encodeEvent, isoLocal } from '../src/main/a11y/store.ts'
import { TreeIds, clip, ranges } from '../src/main/a11y/tree.ts'
import type { A11yEvent } from '../src/main/a11y/types.ts'
import { MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_WIN, shortcutName } from '../src/main/a11y/keys.ts'
import { A11yRecorder } from '../src/main/a11y/recorder.ts'
import { UiaHelper, bootstrapScript, encodedCommand, type HelperEvent } from '../src/main/a11y/uia.ts'

// Fixtures use local wall-clock times so the HH:mm:ss output doesn't depend on the time zone.
const at = (h: number, m: number, s: number, ms = 0) => new Date(2026, 9, 28, h, m, s, ms).getTime()

test('condenser: Slack snapshot, typed text sent, click and shortcuts', () => {
  const events: A11yEvent[] = [
    { time: at(14, 30, 0), kind: 'session_start' },
    { time: at(14, 30, 0), kind: 'window', app: 'Slack', bundleId: 'slack.exe', window: 'general (Channel) - Acme - Slack' },
    {
      time: at(14, 30, 1),
      kind: 'snapshot',
      app: 'Slack',
      window: 'general (Channel) - Acme - Slack',
      trigger: 'window',
      tree: [
        '[1] window "general (Channel) - Acme - Slack"',
        ' [2] webarea "Slack" <https://app.slack.com/client/T1/C1>',
        '  [3] heading "general"',
        '  [4] statictext = "Alice"',
        '  [5] statictext = "Shipped the fix for the login bug"',
        '  [6] textarea "Message #general" (focused)',
      ].join('\n'),
    },
    { time: at(14, 30, 5), kind: 'text', app: 'Slack', field: 'Message #general', text: 'on it' },
    { time: at(14, 30, 6), kind: 'submit', app: 'Slack', field: 'Message #general', text: 'on it' },
    {
      time: at(14, 30, 6, 300),
      kind: 'diff',
      app: 'Slack',
      window: 'general (Channel) - Acme - Slack',
      trigger: 'submit +250ms',
      diff: '+ [7] statictext = "on it"\n~ [6] textarea "Message #general" (focused)\n- removed: 9',
    },
    { time: at(14, 30, 10), kind: 'click', app: 'Slack', target: 'button "Send"' },
    { time: at(14, 30, 11), kind: 'click', app: 'Slack', target: 'group (no label)' },
    { time: at(14, 30, 12), kind: 'shortcut', app: 'Slack', keys: 'Ctrl+K' },
    { time: at(14, 30, 13), kind: 'shortcut', app: 'Slack', keys: 'Alt+Tab' },
    { time: at(14, 30, 14), kind: 'escape', app: 'Slack' },
    { time: at(14, 30, 20), kind: 'session_stop' },
  ]
  assert.equal(
    condense(events, 'Jane Doe'),
    [
      '14:30:00 → Slack: general (Channel) - Acme - Slack',
      '14:30:01 Slack screen:',
      '  PAGE Slack <https://app.slack.com/client/T1/C1>',
      '  general',
      '  Alice',
      '  Shipped the fix for the login bug',
      '14:30:06 you SENT (box cleared, message shown) in Slack "Message #general": "on it"',
      '  on it',
      '14:30:10 you clicked in Slack: button "Send"',
      '14:30:12 you pressed Ctrl+K in Slack',
    ].join('\n'),
  )
})

test('condenser: 15-minute windows, drafts flushed on close, blocked apps, cleared drafts', () => {
  const events: A11yEvent[] = [
    { time: at(14, 44, 50), kind: 'window', app: 'Notepad', window: 'notes.txt - Notepad' },
    { time: at(14, 44, 55), kind: 'text', app: 'Notepad', field: 'Text editor', text: 'hello world' },
    { time: at(14, 45, 5), kind: 'window', app: 'Google Chrome', window: 'Inbox - Gmail - Google Chrome' },
    { time: at(14, 46, 0), kind: 'window', app: 'KeePassXC', bundleId: 'keepassxc.exe', blocked: true },
    { time: at(14, 46, 10), kind: 'text', app: 'Google Chrome', field: 'Search mail', text: 'invoice' },
    { time: at(14, 46, 12), kind: 'text', app: 'Google Chrome', field: 'Search mail', text: '' },
    { time: at(14, 46, 20), kind: 'shortcut', app: 'Google Chrome', keys: '⌘C' },
    { time: at(14, 46, 21), kind: 'click', app: 'Google Chrome', target: 'webarea "Inbox"' },
    { time: at(14, 46, 22), kind: 'window', app: 'Google Chrome', window: 'Docs - Jane - Google Chrome' },
    { time: at(14, 46, 23), kind: 'window', app: 'Microsoft Edge', window: 'News - Personal - Microsoft\u200B Edge' },
  ]
  assert.equal(
    condense(events, 'Jane Doe'),
    [
      '14:44:50 → Notepad: notes.txt - Notepad',
      '14:44:55 you typed in Notepad "Text editor" (draft): "hello world"',
      '14:45:05 (in Notepad: notes.txt - Notepad)',
      '14:45:05 → Google Chrome: Inbox - Gmail',
      '14:46:00 KeePassXC: blocked app, nothing recorded',
      '14:46:12 you cleared Google Chrome "Search mail" (draft deleted, not sent)',
      '14:46:20 you pressed ⌘C in Google Chrome',
      '14:46:22 → Google Chrome: Docs',
      '14:46:23 → Microsoft Edge: News - Personal',
    ].join('\n'),
  )
})

test('condenser: address bar, tracking params, links, metrics and repeats', () => {
  const events: A11yEvent[] = [
    { time: at(14, 31, 0), kind: 'window', app: 'Google Chrome', window: 'Example - Google Chrome' },
    {
      time: at(14, 31, 1),
      kind: 'snapshot',
      app: 'Google Chrome',
      window: 'Example - Google Chrome',
      tree: [
        '[1] window "Example - Google Chrome"',
        ' [2] textfield "Address and search bar" = "https://example.com/page?utm_source=x&id=5"',
        ' [3] webarea "Example" <https://example.com/page?utm_source=x&id=5>',
        '  [4] link "Read the docs" <https://docs.example.com/guide/intro?ref=home>',
        '  [5] button "Send"',
        '  [6] statictext = "12 likes"',
      ].join('\n'),
    },
    { time: at(14, 31, 5), kind: 'submit', app: 'Google Chrome', field: 'Address and search bar', text: 'github.com/acme' },
    {
      time: at(14, 31, 6),
      kind: 'diff',
      app: 'Google Chrome',
      window: 'Example - Google Chrome',
      diff: [
        '~ [4] link "Read the docs" <https://docs.example.com/guide/intro?ref=home>',
        '+ [7] statictext = "Welcome to the guide. This page explains how to set up the project."',
        '+ [8] statictext = "Alice posted a photo 5 minutes ago"',
      ].join('\n'),
    },
    {
      time: at(14, 31, 9),
      kind: 'diff',
      app: 'Google Chrome',
      window: 'Example - Google Chrome',
      diff: '~ [8] statictext = "Alice posted a photo 6 minutes ago"\n+ [9] statictext = "Zażółć gęślą jaźń"',
    },
  ]
  assert.equal(
    condense(events, ''),
    [
      '14:31:00 → Google Chrome: Example',
      '14:31:01 Google Chrome screen:',
      '  address bar = https://example.com/page?id=5',
      '  PAGE Example <https://example.com/page?id=5>',
      '  Read the docs <https://docs.example.com/guide/intro>',
      '14:31:05 you went to (in Google Chrome): "github.com/acme"',
      '  Welcome to the guide. This page explains how to set up the project.',
      '  Alice posted a photo 5 minutes ago',
      '  Zażółć gęślą jaźń',
    ].join('\n'),
  )
})

test('condenser: Return with text still in the box, and terminals', () => {
  const events: A11yEvent[] = [
    { time: at(14, 32, 0), kind: 'window', app: 'Microsoft Teams', window: 'Chat | Microsoft Teams' },
    { time: at(14, 32, 2), kind: 'submit', app: 'Microsoft Teams', field: 'Type a message', text: 'hello team' },
    {
      time: at(14, 32, 3),
      kind: 'diff',
      app: 'Microsoft Teams',
      diff: '~ [9] textarea "Type a message" (focused) = "hello team"',
    },
    { time: at(14, 32, 10), kind: 'window', app: 'Windows Terminal', window: 'PowerShell' },
    { time: at(14, 32, 15), kind: 'submit', app: 'Windows Terminal', field: 'Terminal', text: 'PS C:\\> npm test' },
    { time: at(14, 32, 16), kind: 'submit', app: 'Notepad', field: 'Text editor', text: 'a line' },
  ]
  assert.equal(
    condense(events, ''),
    [
      '14:32:00 → Microsoft Teams: Chat | Microsoft Teams',
      '14:32:02 you pressed Return, text still in box (not sent) in Microsoft Teams "Type a message": "hello team"',
      '14:32:03 Microsoft Teams screen:',
      '  [input focused] Type a message = hello team',
      '14:32:10 → Windows Terminal: PowerShell',
      '14:32:15 you ran in Windows Terminal: "PS C:\\> npm test"',
    ].join('\n'),
  )
})

test('condenser: trimmed keeps action lines first', () => {
  const a = 'A'.repeat(60)
  const b = 'B'.repeat(60)
  const s = (n: number) => '  ' + String(n).repeat(38)
  const text = [a, s(1), s(2), s(3), b, s(4), s(5), s(6)].join('\n')
  assert.equal(trimmed(text, 10_000), text)
  assert.equal(trimmed(text, 300), [a, s(1), b, '(5 more lines of screen text left out to keep this log short)'].join('\n'))
  assert.equal(trimmed(text, 40), '(the rest of this stretch is left out to keep this log short)')
})

test('icu regex translation keeps Unicode word semantics', () => {
  const word = new RegExp('^' + icu(String.raw`\w+`) + '$', 'u')
  assert.ok(word.test('zażółć'))
  const boundary = new RegExp(icu(String.raw`\bgęś\b`), 'u')
  assert.ok(boundary.test('gęś x'))
  assert.ok(!boundary.test('gęśl'))
  const dollar = new RegExp(icu('a$'), 'u')
  assert.ok(dollar.test('a\n'))
  assert.ok(!dollar.test('a\nb'))
})

test('tree: ids, diff and ranges', () => {
  const ids = new TreeIds()
  const one = ids.build(
    [
      { depth: 0, key: 'w', text: 'window "Doc"', noId: false },
      { depth: 1, key: 'a', text: 'button "Save"', noId: false },
      { depth: 1, key: 'b', text: 'statictext = "Hi"', noId: false },
      { depth: 1, key: 'c', text: 'statictext = "Bye"', noId: false },
      { depth: 1, key: 'm', text: '… 3 more', noId: true },
    ],
    'Doc',
    5,
  )
  assert.equal(one.lines.map((l) => l.text).join('\n'), '[1] window "Doc"\n [2] button "Save"\n [3] statictext = "Hi"\n [4] statictext = "Bye"\n … 3 more')
  const two = ids.build(
    [
      { depth: 0, key: 'w', text: 'window "Doc"', noId: false },
      { depth: 1, key: 'a', text: 'button "Save" (disabled)', noId: false },
      { depth: 1, key: 'd', text: 'statictext = "New"', noId: false },
    ],
    'Doc',
    5,
  )
  assert.equal(ids.diff(one, two), '~ [2] button "Save" (disabled)\n+ [5] statictext = "New"\n- removed: 3-4')
  assert.equal(ids.diff(two, two), null)
  assert.equal(ranges([3, 4, 5, 9, 11, 12]), '3-5,9,11-12')
  assert.equal(clip('a\r\nb\nc'), 'a ⏎ b ⏎ c')
  assert.equal(clip('x'.repeat(10_005)), 'x'.repeat(10_000) + '…(+5)')
})

test('store: JSONL format, reading a range, pruning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-a11y-'))
  try {
    const store = new A11yLogStore(dir)
    // Files are matched by creation/modification time, so work around "now".
    const d = new Date()
    const base = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), Math.floor(d.getMinutes() / 10) * 10).getTime()
    const t = base + 7123
    const next = base + 10 * 60_000
    store.append({ time: t, kind: 'window', app: 'Slack', bundleId: 'slack.exe', window: 'a/b "c"' })
    store.append({ time: t + 1000, kind: 'click', app: 'Slack', target: 'button "Send"' })
    store.append({ time: next, kind: 'diff', app: 'Slack', diff: '+ [1] x', snapshotMs: 84 })
    store.close()
    const file = store.filePath(t)
    const nextFile = store.filePath(next)
    assert.notEqual(file, nextFile)
    assert.match(basename(file), /^\d\d[0-5]0\.jsonl$/)
    assert.match(basename(join(file, '..')), /^\d{4}-\d\d-\d\d$/)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(lines[0], `{"time":"${isoLocal(t)}","kind":"window","app":"Slack","bundle_id":"slack.exe","window":"a/b \\"c\\""}`)
    assert.match(isoLocal(at(14, 31, 7, 123)), /^2026-10-28T14:31:07\.123[+-]\d\d:\d\d$/)
    assert.ok(existsSync(nextFile))

    // Unreadable lines are skipped; times without fractions are accepted.
    const plain = new Date(t + 2000).toISOString().replace(/\.\d+Z$/, 'Z')
    writeFileSync(file, readFileSync(file, 'utf8') + `{"time":"bad","kind":"x"}\n{"kind":"x"}\nnot json\n{"time":"${plain}","kind":"escape"}\n`, 'utf8')
    assert.equal(decodeEvent('{"time":"2026-10-28T14:31:07+01:00","kind":"x","snapshot_ms":"1"}'), null)
    assert.deepEqual(decodeEvent(encodeEvent({ time: t, kind: 'diff', diff: 'd', snapshotMs: 3 })), { time: t, kind: 'diff', diff: 'd', snapshotMs: 3 })
    const events = store.loadEvents(base, next + 60_000)
    assert.deepEqual(events.map((e) => e.kind), ['window', 'click', 'escape', 'diff'])
    assert.deepEqual(store.loadEvents(base, next).map((e) => e.kind), ['window', 'click', 'escape'])

    store.saveCondensedLog('log text', 42, base)
    const txt = join(file, '..', `${String(new Date(base).getHours()).padStart(2, '0')}${String(new Date(base).getMinutes()).padStart(2, '0')}-batch42.txt`)
    assert.equal(readFileSync(txt, 'utf8'), 'log text')

    // Windows that ended before the cutoff go; later ones stay. Old .txt files go by mtime.
    utimesSync(txt, new Date(base - 3600_000), new Date(base - 3600_000))
    store.prune(next + 5 * 60_000)
    assert.ok(!existsSync(file))
    assert.ok(!existsSync(txt))
    assert.ok(existsSync(nextFile))
    mkdirSync(join(dir, '.helper'))
    store.prune(next + 60 * 60_000)
    assert.ok(!existsSync(join(nextFile, '..')))
    assert.ok(existsSync(join(dir, '.helper')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keys: only allowlisted shortcuts, never AltGr / Alt codes / character keys', () => {
  const C = MOD_CTRL, A = MOD_ALT, S = MOD_SHIFT, W = MOD_WIN
  const k = (ch: string) => ch.charCodeAt(0)
  assert.equal(shortcutName(k('C'), C, false), 'Ctrl+C')
  assert.equal(shortcutName(k('V'), C, false), 'Ctrl+V')
  assert.equal(shortcutName(k('T'), C | S, false), 'Ctrl+Shift+T')
  assert.equal(shortcutName(0x09, C, false), 'Ctrl+Tab')
  assert.equal(shortcutName(0x09, A, false), 'Alt+Tab')
  assert.equal(shortcutName(0x09, A | S, false), 'Alt+Shift+Tab')
  assert.equal(shortcutName(0x09, C | A, false), 'Ctrl+Alt+Tab')
  assert.equal(shortcutName(0x73, A, false), 'Alt+F4')
  assert.equal(shortcutName(0x74, C, false), 'Ctrl+F5')
  assert.equal(shortcutName(0x25, A, false), 'Alt+Left')
  assert.equal(shortcutName(0x27, C | S, false), 'Ctrl+Shift+Right')
  assert.equal(shortcutName(k('D'), W, false), 'Win+D')
  assert.equal(shortcutName(k('S'), S | W, false), 'Shift+Win+S')
  // AltGr (Ctrl+Alt, either Alt) types characters: ą ę ł @ € …
  for (const ch of 'AELQZXSCN7') assert.equal(shortcutName(k(ch), C | A, false), null, ch)
  assert.equal(shortcutName(k('A'), C | A | S, false), null)
  assert.equal(shortcutName(0xbe, C | A, false), null)
  // Alt codes: Alt + numpad digits (NumLock on: VK_NUMPADn; off: navigation keys without the extended flag).
  for (let vk = 0x60; vk <= 0x69; vk++) assert.equal(shortcutName(vk, A, false), null)
  assert.equal(shortcutName(0x64, A, true), null)
  assert.equal(shortcutName(0x25, A, true), null)
  assert.equal(shortcutName(0x2d, A, true), null)
  // Alt + character keys, Ctrl + keys off the list, OEM keys, no modifier.
  assert.equal(shortcutName(k('F'), A, false), null)
  assert.equal(shortcutName(k('5'), A, false), null)
  assert.equal(shortcutName(k('K'), C, false), null)
  assert.equal(shortcutName(k('1'), C, false), null)
  assert.equal(shortcutName(0xba, C, false), null)
  assert.equal(shortcutName(k('C'), 0, false), null)
  assert.equal(shortcutName(k('C'), S, false), null)
  assert.equal(shortcutName(Number.NaN, C, false), null)
})

function fakeRecorder(field: { secure: boolean } | null) {
  const events: A11yEvent[] = []
  let focusReads = 0
  const fg = { hwnd: 10, pid: 4242, process: 'notepad', path: 'notepad.exe', description: 'Notepad', title: 'x - Notepad', windowClass: 'Notepad', locked: false }
  const helper = {
    start: async () => true,
    setBlocked: async () => {},
    setHooks: async () => {},
    foreground: async () => fg,
    snapshot: async () => null,
    describeElement: async () => null,
    focusedField: async () => {
      focusReads++
      return field && { blocked: false, pid: 4242, process: 'notepad', role: 'textfield', label: 'Password', value: field.secure ? '[secure field]' : 'abc', secure: field.secure }
    },
  }
  const store = { append: (e: A11yEvent) => events.push(e) }
  const rec = new A11yRecorder({
    helper: helper as unknown as UiaHelper,
    store: store as unknown as A11yLogStore,
    excludedApps: () => [],
    ownPid: 1,
  })
  return { rec, events, reads: () => focusReads }
}

test('recorder: shortcuts are dropped in password fields and AltGr counts as typing', async () => {
  function sc(vk: number, m: number, np = 0): HelperEvent {
    return { ev: 'kd', k: 'sc', vk, m, np }
  }
  {
    const { rec, events } = fakeRecorder({ secure: false })
    assert.equal(await rec.start(), true)
    await rec.idle()
    rec.onHelperEvent(sc(0x43, MOD_CTRL))
    rec.onHelperEvent(sc(0x51, MOD_CTRL | MOD_ALT)) // AltGr+Q = @ on German layouts
    rec.onHelperEvent(sc(0x61, MOD_ALT)) // Alt+Numpad1
    await rec.idle()
    rec.stop()
    await rec.idle()
    const shortcuts = events.filter((e) => e.kind === 'shortcut').map((e) => e.keys)
    assert.deepEqual(shortcuts, ['Ctrl+C'])
  }
  {
    const { rec, events } = fakeRecorder({ secure: true })
    await rec.start()
    await rec.idle()
    rec.onHelperEvent(sc(0x43, MOD_CTRL))
    rec.onHelperEvent(sc(0x09, MOD_ALT))
    await rec.idle()
    rec.stop()
    await rec.idle()
    assert.equal(events.filter((e) => e.kind === 'shortcut').length, 0)
  }
  {
    // Focus can't be read: fail closed.
    const { rec, events } = fakeRecorder(null)
    await rec.start()
    await rec.idle()
    rec.onHelperEvent(sc(0x43, MOD_CTRL))
    await rec.idle()
    rec.stop()
    await rec.idle()
    assert.equal(events.filter((e) => e.kind === 'shortcut').length, 0)
  }
})

test('uia host: nothing on disk, short command line, a helper that never gets ready is killed', async () => {
  const script = bootstrapScript(1234)
  assert.match(script, /\[DfA11y\]::Run\(1234\)/)
  assert.doesNotMatch(script, /\.ps1|\.dll|\.cs\b|OutputAssembly|LiteralPath/)
  const encoded = encodedCommand(script)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
  assert.ok(encoded.length < 8000)

  const dir = mkdtempSync(join(tmpdir(), 'dayflow-uia-'))
  try {
    for (const n of ['dayflow-uia-abc.ps1', 'dayflow-uia-abc.cs', 'dayflow-uia-abc.dll', 'keep.txt']) writeFileSync(join(dir, n), 'x')
    let exits = 0
    const helper = new UiaHelper({
      scriptDir: dir,
      readyTimeoutMs: 300,
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      onExit: () => exits++,
    })
    const origError = console.error
    console.error = () => {}
    try {
      assert.equal(await helper.start(), false)
      assert.equal(helper.running, false)
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(exits, 1) // killed, and the exit was reported (the feature retries from there)
      // The next start spawns a new process instead of returning the cached failure.
      assert.equal(await helper.start(), false)
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(exits, 2)
    } finally {
      console.error = origError
      helper.dispose()
    }
    assert.deepEqual(readdirSync(dir), ['keep.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
