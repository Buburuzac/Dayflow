import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/db.ts'
import { dayRange } from '../src/main/time.ts'
import {
  conversationTitle,
  isMissingSessionError,
  joinAfterTool,
  normalizeAutoMemoryBlob,
  normalizeMemoryForSave,
  parseMetadata,
  toolSummary,
  updateSuggestionHistory,
  visibleStreamingText,
} from '../src/main/chat/metadata.ts'
import { boolArg, executeTool, MAX_RANGE_DAYS, MAX_TOOL_PAYLOAD_BYTES, positiveIntArg, TIMELINE_SOFT_LIMIT_BYTES } from '../src/main/chat/tools.ts'
import { handleRpc } from '../src/main/chat/mcp-server.ts'
import { ChatStorage } from '../src/main/chat/storage.ts'
import { cliExitError, codexArgs, handleClaudeLine, handleCodexLine, tomlString } from '../src/main/chat/runner-cli.ts'
import type { Emit, StreamEvent } from '../src/main/chat/runner.ts'
import { GeminiChatRunner, parseSsePayload } from '../src/main/chat/runner-gemini.ts'
import { OpenAIChatRunner, parseTextToolRequest, ThinkFilter } from '../src/main/chat/runner-openai.ts'
import { buildFlatPrompt, buildSystemInstruction, categoryColorsSection, cliSystemPrompt, geminiSystemPrompt, languageSection } from '../src/main/chat/prompts.ts'
import { ChatService, type ConversationState, TURN_IN_PROGRESS_ERROR } from '../src/main/chat/service.ts'
import { sanitizeColor, splitMessageBlocks, validateChart } from '../src/renderer/src/features/chat/charts.ts'
import type { ChatEvent } from '../src/shared/chat-types.ts'
import type { Settings } from '../src/shared/types.ts'

// ---------------- metadata ----------------

test('parseMetadata strips strict suggestions + memory blocks', () => {
  const raw = 'Pulled today.\n- **Morning:** coding\n\n```suggestions\n["What next?", "How long on X?"]\n```\n\n```memory\nProfile: dev\nStyle: brief\n```\n'
  const p = parseMetadata(raw)
  assert.equal(p.cleanedText, 'Pulled today.\n- **Morning:** coding')
  assert.deepEqual(p.suggestions, ['What next?', 'How long on X?'])
  assert.equal(p.memory, 'Profile: dev\nStyle: brief')
})

test('parseMetadata handles headings, loose forms and invalid JSON', () => {
  const p = parseMetadata('Answer\n\n### Suggestions\n["A?", "B?"]\n\nMemory:\nProfile: p1\nStyle: s1')
  assert.equal(p.cleanedText, 'Answer')
  assert.deepEqual(p.suggestions, ['A?', 'B?'])
  assert.equal(p.memory, 'Profile: p1\nStyle: s1')

  const bad = parseMetadata('Hi\n```suggestions\nnot json\n```')
  assert.equal(bad.cleanedText, 'Hi')
  assert.deepEqual(bad.suggestions, [])
  assert.equal(bad.memory, null)

  // A memory block without Profile/Style is removed but ignored.
  const m = parseMetadata('Ok\n```memory\nnothing useful\n```')
  assert.equal(m.cleanedText, 'Ok')
  assert.equal(m.memory, null)

  // Charts survive.
  const c = parseMetadata('```chart type=bar\n{"title":"t","x":["a"],"y":[1]}\n```\n```memory\nStyle: x\n```')
  assert.ok(c.cleanedText.startsWith('```chart type=bar'))
  assert.equal(c.memory, 'Style: x')
})

test('normalizeAutoMemoryBlob keeps the last Profile/Style values', () => {
  assert.equal(normalizeAutoMemoryBlob('profile: a\r\nStyle: b\nPROFILE: c'), 'Profile: c\nStyle: b')
  assert.equal(normalizeAutoMemoryBlob('random'), null)
})

test('visibleStreamingText hides metadata and partial fences', () => {
  assert.equal(visibleStreamingText('Hello\n```sugg'), 'Hello')
  assert.equal(visibleStreamingText('Hello\n```suggestions\n["a"'), 'Hello')
  assert.equal(visibleStreamingText('Hello\n  ```memory\nProfile'), 'Hello')
  assert.equal(visibleStreamingText('Hello world'), 'Hello world')
  assert.equal(visibleStreamingText('Hi\n```chart type=bar'), 'Hi\n```chart type=bar')
})

test('memory save normalization, suggestion history, tool summaries, titles', () => {
  assert.equal(normalizeMemoryForSave('  a\r\n\r\n\r\n\r\nb  '), 'a\n\nb')
  assert.equal(normalizeMemoryForSave('x'.repeat(12_000)).length, 10_000)
  const h = updateSuggestionHistory(['One', 'Two'], ['one', ' Three ', ''])
  assert.deepEqual(h, ['Two', 'one', 'Three'])
  assert.equal(updateSuggestionHistory([], Array.from({ length: 20 }, (_, i) => `s${i}`)).length, 12)

  assert.equal(toolSummary('fetchTimeline {}', null, null), 'Running data fetch…')
  assert.equal(toolSummary('fetchTimeline {}', 'Fetched 3 timeline cards for Sat, Nov 7.', 0), 'Fetched 3 timeline cards for Sat, Nov 7.')
  assert.equal(toolSummary('fetchObservations {}', 'x', 1), 'Data fetch failed (exit 1)')
  assert.equal(toolSummary('sqlite3 db "select"', 'a\nb\n', 0), 'Database query returned 2 rows')
  assert.equal(toolSummary('ls', '', 0), 'Tool completed')

  assert.equal(conversationTitle('  Hello\nworld '), 'Hello world')
  assert.equal(conversationTitle(''), 'New chat')
  assert.equal(conversationTitle('x'.repeat(100)).length, 80)
  assert.equal(joinAfterTool('Grabbed.', 'Now'), 'Grabbed. Now')
  assert.equal(joinAfterTool('Grabbed. ', 'Now'), 'Grabbed. Now')
  assert.ok(isMissingSessionError('Error: No conversation found with session ID abc'))
  assert.ok(isMissingSessionError('no rollout found for thread id 123'))
})

// ---------------- prompts ----------------

test('prompts include charts, colors, language and memory', () => {
  const ctx = {
    now: new Date(2026, 10, 8, 15, 5),
    categories: [{ name: 'Work', color: '#B984FF', description: '' }],
    language: 'German',
  }
  const g = geminiSystemPrompt(ctx)
  assert.ok(g.includes('Current date: Sunday, November 8, 2026'))
  assert.ok(g.includes('Current time: 3:05 PM'))
  assert.ok(g.includes('## INLINE CHARTS'))
  assert.ok(g.includes('- Work: #B984FF'))
  assert.ok(g.includes('The user only speaks German.'))
  const c = cliSystemPrompt(ctx, 'claude')
  assert.ok(c.includes('mcp__dayflow__fetchTimeline'))
  assert.ok(c.includes('## MEMORY CONTRACT (REQUIRED)'))
  assert.ok(c.includes('Current Dayflow day: 2026-11-08'))
  assert.ok(!c.includes('sqlite3'))
  // Before 4 AM the Dayflow day is still the previous date.
  assert.ok(cliSystemPrompt({ ...ctx, now: new Date(2026, 10, 8, 2, 0) }, 'codex').includes('Current Dayflow day: 2026-11-07'))
  assert.equal(languageSection('English'), '')
  assert.equal(categoryColorsSection([]), '')
  const sys = buildSystemInstruction('BASE', 'Profile: x', ['a', 'b'])
  assert.equal(sys, 'BASE\n\n## User Memory\nProfile: x\n\n## Recent Suggestions To Avoid\n- a\n- b')
  const flat = buildFlatPrompt('SYS', '', [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Yo' },
    { role: 'user', content: 'Q' },
  ])
  assert.equal(flat, 'SYS\n\nUser: Hi\n\nAssistant: Yo\n\nUser: Q\n\nAssistant:')
})

// ---------------- charts ----------------

test('chart blocks: valid charts parsed, invalid stay as text', () => {
  const msg =
    'Intro\n```chart type=bar\n{"title":"T","x":["a","b"],"y":[1,2],"color":"F96E00"}\n```\nMiddle\n```chart type=line\n{"title":"bad","x":["a"],"y":[1,2]}\n```\n'
  const blocks = splitMessageBlocks(msg)
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].kind, 'text')
  assert.equal(blocks[1].kind, 'chart')
  if (blocks[1].kind === 'chart') {
    assert.equal(blocks[1].chart.type, 'bar')
    assert.equal((blocks[1].chart as { color: string }).color, '#F96E00')
  }
  assert.equal(blocks[2].kind, 'text')
  assert.ok(blocks[2].kind === 'text' && blocks[2].text.includes('```chart type=line'))
})

test('chart validation rules per type', () => {
  assert.equal(validateChart('bar', { x: ['a'], y: [1] }), null) // title required
  assert.equal(validateChart('bar', { title: 't', x: [], y: [] }), null)
  assert.equal(validateChart('bar', { title: 't', x: ['a'], y: ['1'] }), null)
  assert.equal(validateChart('radar', { title: 't' }), null)
  const sb = validateChart('stacked_bar', {
    title: 't',
    x: ['a', 'b'],
    series: [
      { name: 'ok', values: [1, 2] },
      { name: 'short', values: [1] },
      { name: 'empty', values: [] },
    ],
  })
  assert.ok(sb && sb.type === 'stacked_bar' && sb.series.length === 1)
  assert.equal(validateChart('stacked_bar', { title: 't', x: ['a'], series: [{ name: 'x', values: [1, 2] }] }), null)
  const pie = validateChart('pie', { title: 't', labels: ['a', 'b'], values: [1, 2], colors: ['#000000'] })
  assert.ok(pie && pie.type === 'donut' && pie.colors === null)
  const donut = validateChart('donut', { title: 't', labels: ['a', 'b'], values: [1, 2], colors: ['#000000', 'zz'] })
  assert.ok(donut && donut.type === 'donut' && donut.colors?.[0] === '#000000' && donut.colors[1] === '#1F6FEB')
  assert.ok(validateChart('heatmap', { title: 't', x: ['a', 'b'], y: ['r'], values: [[1, 2]] }))
  assert.equal(validateChart('heatmap', { title: 't', x: ['a', 'b'], y: ['r'], values: [[1]] }), null)
  assert.equal(validateChart('heatmap', { title: 't', x: ['a'], y: ['r', 's'], values: [[1]] }), null)
  const g = validateChart('gantt', {
    title: 't',
    items: [
      { label: 'a', start: 9, end: 10.5 },
      { label: 'b', start: 11, end: 11 },
    ],
  })
  assert.ok(g && g.type === 'gantt' && g.items.length === 1)
  assert.equal(validateChart('gantt', { title: 't', items: [{ label: 'b', start: 2, end: 1 }] }), null)
  assert.equal(sanitizeColor(' #f96e00 '), '#F96E00')
  assert.equal(sanitizeColor('80F96E00'), '#F96E0080') // AARRGGBB → #RRGGBBAA
  assert.equal(sanitizeColor('#abc'), null)
  assert.equal(sanitizeColor(12), null)
})

// ---------------- tools (temp DB) ----------------

function seedDb(): { dir: string; store: Store; day: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-chat-'))
  const store = new Store(join(dir, 'chunks.sqlite'))
  const day = '2026-11-07'
  const base = dayRange(day).start + 5 * 3600 // 9:00 AM
  const b = store.createBatch(base, base + 4 * 3600, [])
  store.replaceCardsInRange(
    base,
    base + 4 * 3600,
    [
      { startTime: '9:00 AM', endTime: '10:30 AM', category: 'Work', subcategory: 'Coding', title: 'Fixed CSV export', summary: 'Debugged', detailedSummary: 'detail one' },
      { startTime: '10:30 AM', endTime: '11:00 AM', category: 'Distraction', subcategory: '', title: 'YouTube', summary: 'Shorts', detailedSummary: '', distractions: [{ startTime: '10:30 AM', endTime: '10:40 AM', title: 'X', summary: 'x' }], appSites: { primary: 'youtube.com' } },
    ],
    b,
  )
  // One observation at 2:30 AM of the next calendar day (still Nov 7's Dayflow day), one on Nov 8.
  const late = dayRange(day).end - 90 * 60
  store.saveObservations(
    b,
    [
      { startTs: base, endTs: base + 600, observation: 'Editing export.py' },
      { startTs: late, endTs: late + 300, observation: 'Late night reading' },
      { startTs: dayRange('2026-11-08').start + 3600, endTs: dayRange('2026-11-08').start + 4000, observation: 'Next day' },
    ],
    'test',
  )
  return { dir, store, day }
}

test('fetchTimeline: date mode, payload shape, limit and flags', () => {
  const { dir, store, day } = seedDb()
  try {
    const r = executeTool(store.db, 'fetchTimeline', { date: day })
    assert.equal(r.error, undefined)
    assert.equal(r.summary, 'Fetched 2 timeline cards for Sat, Nov 7.')
    assert.equal(r.itemCount, 2)
    assert.equal(r.truncated, false)
    assert.deepEqual(r.request, { mode: 'date', date: day, startDate: null, endDate: null, includeDetailedSummary: true, limit: null })
    const items = r.items as Array<Record<string, unknown>>
    assert.equal(items[0].startTime, '9:00 AM')
    assert.equal(items[0].detailedSummary, 'detail one')
    assert.equal(items[1].distractionsCount, 1)
    assert.deepEqual(items[1].appSites, { primary: 'youtube.com', secondary: null })
    assert.equal('detailedSummary' in items[1], false)

    const r2 = executeTool(store.db, 'fetchTimeline', JSON.stringify({ date: day, includeDetailedSummary: 'no', limit: '1' }))
    assert.equal(r2.itemCount, 1)
    assert.equal('detailedSummary' in (r2.items as Array<Record<string, unknown>>)[0], false)
    assert.equal((r2.request as { limit: number }).limit, 1)

    const range = executeTool(store.db, 'fetchTimeline', { startDate: '2026-11-01', endDate: day })
    assert.equal(range.summary, 'Fetched 2 timeline cards for Nov 1 to Nov 7.')
    const same = executeTool(store.db, 'fetchTimeline', { startDate: day, endDate: day })
    assert.equal(same.summary, 'Fetched 2 timeline cards for Nov 7.')
    const none = executeTool(store.db, 'fetchTimeline', { date: '2026-10-01' })
    assert.equal(none.summary, 'Fetched 0 timeline cards for Thu, Oct 1.')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetchTimeline drops detailed summaries above the soft limit', () => {
  const { dir, store, day } = seedDb()
  try {
    store.db.prepare('UPDATE timeline_cards SET detailed_summary = ?').run('x'.repeat(TIMELINE_SOFT_LIMIT_BYTES))
    const r = executeTool(store.db, 'fetchTimeline', { date: day })
    assert.equal(r.truncated, true)
    assert.ok(String(r.summary).endsWith('Detailed summaries were omitted due to payload size.'))
    assert.ok((r.items as Array<Record<string, unknown>>).every((i) => !('detailedSummary' in i)))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetchObservations groups by 4 AM day', () => {
  const { dir, store, day } = seedDb()
  try {
    const r = executeTool(store.db, 'fetchObservations', { date: day })
    assert.equal(r.summary, 'Fetched 2 observations for Sat, Nov 7 across 1 day.')
    const groups = r.items as Array<{ day: string; observations: Array<{ startTime: string; observation: string }> }>
    assert.equal(groups.length, 1)
    assert.equal(groups[0].day, day)
    assert.equal(groups[0].observations[1].startTime, '2:30 AM')
    const both = executeTool(store.db, 'fetchObservations', { startDate: day, endDate: '2026-11-08', limit: 10 })
    assert.equal(both.dayCount, 2)
    assert.equal(both.summary, 'Fetched 3 observations for Nov 7 to Nov 8 across 2 days.')
    const empty = executeTool(store.db, 'fetchObservations', { date: '2026-01-01' })
    assert.equal(empty.summary, 'Fetched 0 observations for Thu, Jan 1.')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool validation and unknown tools', () => {
  const { dir, store } = seedDb()
  try {
    const both = executeTool(store.db, 'fetchTimeline', { date: '2026-11-07', startDate: '2026-11-01' })
    assert.deepEqual(both.error, { code: 'validation_error', message: 'Provide either {date} OR {startDate, endDate}.' })
    assert.equal(executeTool(store.db, 'fetchTimeline', {}).error?.code, 'validation_error')
    assert.equal(executeTool(store.db, 'fetchTimeline', { date: '11/07/2026' }).summary, "Invalid date format '11/07/2026'. Use YYYY-MM-DD.")
    assert.equal(executeTool(store.db, 'fetchTimeline', { date: '2026-02-30' }).error?.code, 'validation_error')
    assert.equal(
      executeTool(store.db, 'fetchObservations', { startDate: '2026-11-08', endDate: '2026-11-01' }).summary,
      'startDate must be less than or equal to endDate.',
    )
    assert.deepEqual(executeTool(store.db, 'deleteEverything', {}), {
      summary: "Unknown tool 'deleteEverything'.",
      error: { code: 'unknown_tool', message: "Unknown tool 'deleteEverything'." },
    })
    assert.equal(boolArg({ v: 0 }, 'v'), false)
    assert.equal(boolArg({ v: 'YES' }, 'v'), true)
    assert.equal(boolArg({ v: 'maybe' }, 'v'), null)
    assert.equal(positiveIntArg({ v: 3.9 }, 'v'), 3)
    assert.equal(positiveIntArg({ v: '0' }, 'v'), null)
    assert.equal(positiveIntArg({ v: -2 }, 'v'), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP server handles initialize, tools/list and tools/call', () => {
  const { dir, store, day } = seedDb()
  try {
    const getDb = () => store.db
    const init = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, getDb) as {
      result: { protocolVersion: string; serverInfo: { name: string } }
    }
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'dayflow')
    assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, getDb), null)
    const list = handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, getDb) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, { type: string }> } }> }
    }
    assert.deepEqual(list.result.tools.map((t) => t.name), ['fetchTimeline', 'fetchObservations'])
    assert.equal(list.result.tools[0].inputSchema.type, 'object')
    assert.equal(list.result.tools[0].inputSchema.properties.includeDetailedSummary.type, 'boolean')
    const call = handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetchTimeline', arguments: { date: day } } }, getDb) as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    assert.equal(call.result.isError, false)
    assert.equal(JSON.parse(call.result.content[0].text).itemCount, 2)
    const bad = handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fetchTimeline', arguments: {} } }, getDb) as {
      result: { isError: boolean }
    }
    assert.equal(bad.result.isError, true)
    const unknown = handleRpc({ jsonrpc: '2.0', id: 5, method: 'nope' }, getDb) as { error: { code: number } }
    assert.equal(unknown.error.code, -32601)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------- storage ----------------

test('chat storage: conversations, messages, memory', () => {
  const { dir, store } = seedDb()
  try {
    const s = new ChatStorage(store.db)
    new ChatStorage(store.db) // idempotent schema
    const msgs = [
      { id: 'M1', role: 'user' as const, content: 'Hi', createdAt: 1 },
      { id: 'M2', role: 'assistant' as const, content: 'Hello', createdAt: 2 },
    ]
    s.saveConversation({ id: 'C1', title: 'Hi', provider: 'claude_cli', cliSessionId: 'sess', createdAt: 100, messages: msgs })
    s.saveConversation({ id: 'C1', title: 'Hi', provider: 'claude_cli', cliSessionId: 'sess2', createdAt: 999, messages: [...msgs, { id: 'M3', role: 'user', content: 'More', createdAt: 3 }] })
    s.saveConversation({ id: 'C2', title: 'Empty', provider: 'gemini', cliSessionId: null, createdAt: 5, messages: [] })
    const list = s.listConversations()
    assert.equal(list.length, 1)
    const c = s.loadConversation('C1')!
    assert.equal(c.createdAt, 100)
    assert.equal(c.cliSessionId, 'sess2')
    assert.deepEqual(c.messages.map((m) => m.id), ['M1', 'M2', 'M3'])
    s.deleteConversation('C1')
    assert.equal(s.loadConversation('C1'), null)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()!.n, 0)

    assert.deepEqual(s.loadMemory(), { text: '', updatedAt: null })
    const m = s.saveMemory('Profile: a\n\n\n\nStyle: b')
    assert.equal(m.text, 'Profile: a\n\nStyle: b')
    assert.ok(m.updatedAt)
    assert.equal(s.saveMemory('   ').text, '')
    assert.equal(s.loadMemory().updatedAt, null)
    store.updateBatch(1, 'analyzed')
    assert.equal(s.analyzedBatchCount(), 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------- CLI stream parsing ----------------

test('Claude stream-json parsing', () => {
  const evs: StreamEvent[] = []
  const state = { sawDelta: false, tools: new Map<string, string>() }
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'S1' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__dayflow__fetchTimeline', input: { date: '2026-11-07' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '{"summary":"Fetched 2 timeline cards for Sat, Nov 7."}' }] }] } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
    { type: 'result', subtype: 'success', result: 'Hello', is_error: false },
  ]
  for (const l of lines) handleClaudeLine(JSON.stringify(l), (e) => evs.push(e), state)
  handleClaudeLine('not json', (e) => evs.push(e), state)
  const kinds = evs.filter((e) => e.type !== 'debug').map((e) => e.type)
  assert.deepEqual(kinds, ['session', 'thinking', 'toolStart', 'toolEnd', 'textDelta', 'complete'])
  assert.deepEqual(evs.find((e) => e.type === 'toolStart'), { type: 'toolStart', command: 'fetchTimeline {"date":"2026-11-07"}', id: 'tu1' })
  assert.deepEqual(evs.find((e) => e.type === 'toolEnd'), { type: 'toolEnd', output: 'Fetched 2 timeline cards for Sat, Nov 7.', exitCode: 0, id: 'tu1' })
  const err: StreamEvent[] = []
  handleClaudeLine(JSON.stringify({ type: 'result', is_error: true, result: 'No conversation found with session ID x' }), (e) => err.push(e), state)
  assert.equal(err[0].type, 'error')
})

test('Codex --json parsing and args', () => {
  const evs: StreamEvent[] = []
  const state = { messages: 0 }
  const lines = [
    { type: 'thread.started', thread_id: 'T1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Checking.' } },
    { type: 'item.started', item: { type: 'mcp_tool_call', server: 'dayflow', tool: 'fetchTimeline', arguments: { date: 'd' }, result: null, status: 'in_progress' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'dayflow', tool: 'fetchTimeline', arguments: { date: 'd' }, result: { content: [{ type: 'text', text: '{"summary":"Bad","error":{"code":"validation_error"}}' }] }, status: 'completed' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    { type: 'turn.failed', error: { message: '{"error":{"message":"nested"}}' } },
  ]
  for (const l of lines) handleCodexLine(JSON.stringify(l), (e) => evs.push(e), state)
  const visible = evs.filter((e) => e.type !== 'debug')
  assert.deepEqual(visible[0], { type: 'session', id: 'T1' })
  assert.deepEqual(visible[1], { type: 'textDelta', text: 'Checking.' })
  assert.deepEqual(visible[3], { type: 'toolEnd', output: 'Bad', exitCode: 1 })
  assert.deepEqual(visible[4], { type: 'textDelta', text: '\n\nDone.' })
  assert.deepEqual(visible[5], { type: 'error', message: 'nested' })

  const args = codexArgs(
    { command: 'codex', model: null, cwd: 'x', mcp: { command: 'C:\\Program Files\\Dayflow\\Dayflow.exe', args: ['C:\\a\\mcp-server.js', 'C:\\db.sqlite'], env: { ELECTRON_RUN_AS_NODE: '1' } } },
    'T1',
  )
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'T1'])
  assert.ok(args.includes("mcp_servers.dayflow.command='C:\\Program Files\\Dayflow\\Dayflow.exe'"))
  assert.ok(args.includes("mcp_servers.dayflow.args=['C:\\a\\mcp-server.js','C:\\db.sqlite']"))
  assert.ok(args.includes("mcp_servers.dayflow.env={ELECTRON_RUN_AS_NODE='1'}"))
  assert.equal(args[args.length - 1], '-')
  assert.equal(tomlString("C:\\Users\\O'Brien"), '"C:/Users/O\'Brien"')
})

// ---------------- HTTP runners against mock servers ----------------

async function withServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void, fn: (url: string) => Promise<void>) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => handler(req, body, res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await fn(url)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}

test('parseSsePayload handles objects, arrays and concatenation', () => {
  assert.equal(parseSsePayload('{"a":1}').length, 1)
  assert.equal(parseSsePayload('[{"a":1},{"b":2}]').length, 2)
  assert.equal(parseSsePayload('{"a":"}{"}{"b":2}').length, 2)
  assert.equal(parseSsePayload('[DONE]').length, 0)
})

test('Gemini runner: function-calling loop over SSE replays call parts', async () => {
  const { dir, store, day } = seedDb()
  const bodies: Array<Record<string, unknown>> = []
  try {
    await withServer(
      (req, body, res) => {
        const json = JSON.parse(body) as Record<string, unknown>
        bodies.push(json)
        if (json.generationConfig && (json.generationConfig as Record<string, unknown>).thinkingConfig) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Unknown name "thinkingConfig"' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (bodies.filter((b) => !(b.generationConfig as Record<string, unknown>).thinkingConfig).length === 1) {
          const part = { functionCall: { name: 'fetchTimeline', args: { date: day } }, thoughtSignature: 'SIG' }
          res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`)
        } else {
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'You coded ' }] } }] })}\n\n`)
          res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'all morning.' }] } }] })}\n\n`)
        }
        void req
      },
      async (url) => {
        const evs: StreamEvent[] = []
        const runner = new GeminiChatRunner('KEY', 'test-model', { endpoint: url, models: ['test-model'] })
        await runner.run(
          {
            system: 'SYS',
            history: [{ role: 'user', content: 'What did I do?' }],
            executeTool: (n, a) => executeTool(store.db, n, a),
            signal: new AbortController().signal,
          },
          (e) => evs.push(e),
        )
        const visible = evs.filter((e) => e.type !== 'debug')
        assert.deepEqual(visible.map((e) => e.type), ['toolStart', 'toolEnd', 'textDelta', 'textDelta', 'complete'])
        assert.deepEqual(visible[4], { type: 'complete', text: 'You coded all morning.' })
        const last = bodies[bodies.length - 1] as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
        assert.equal(last.contents[1].role, 'model')
        assert.equal(last.contents[1].parts[0].thoughtSignature, 'SIG')
        const fr = last.contents[2].parts[0].functionResponse as { name: string; response: { itemCount: number } }
        assert.equal(fr.name, 'fetchTimeline')
        assert.equal(fr.response.itemCount, 2)
      },
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenAI runner: native tool loop with streamed tool_calls', async () => {
  const { dir, store, day } = seedDb()
  let n = 0
  try {
    await withServer(
      (_req, body, res) => {
        const json = JSON.parse(body) as { messages: Array<Record<string, unknown>>; tools?: unknown[] }
        assert.ok(json.tools)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (n++ === 0) {
          const d1 = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'fetchTimeline', arguments: '{"date":' } }] } }] }
          const d2 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"${day}"}` } }] } }] }
          res.end(`data: ${JSON.stringify(d1)}\n\ndata: ${JSON.stringify(d2)}\n\ndata: [DONE]\n\n`)
        } else {
          const tool = json.messages.find((m) => m.role === 'tool')!
          assert.equal(JSON.parse(String(tool.content)).itemCount, 2)
          const parts = ['<think>plan</think>Two ', 'cards.']
          res.end(parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n')
        }
      },
      async (url) => {
        const evs: StreamEvent[] = []
        await new OpenAIChatRunner(url, 'm', '').run(
          { system: 'S', history: [{ role: 'user', content: 'q' }], executeTool: (a, b) => executeTool(store.db, a, b), signal: new AbortController().signal },
          (e) => evs.push(e),
        )
        const v = evs.filter((e) => e.type !== 'debug')
        assert.deepEqual(v.map((e) => e.type), ['toolStart', 'toolEnd', 'thinking', 'textDelta', 'textDelta', 'complete'])
        assert.deepEqual(v[v.length - 1], { type: 'complete', text: 'Two cards.' })
      },
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenAI runner falls back to the text tool protocol when tools are rejected', async () => {
  const { dir, store, day } = seedDb()
  let plain = 0
  try {
    await withServer(
      (_req, body, res) => {
        const json = JSON.parse(body) as { messages: Array<{ role: string; content: string }>; tools?: unknown[] }
        if (json.tools) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"model does not support tools"}}')
          return
        }
        assert.ok(json.messages[0].content.includes('HOW TO CALL TOOLS'))
        res.writeHead(200, { 'content-type': 'application/json' })
        if (plain++ === 0) {
          res.end(JSON.stringify({ choices: [{ message: { content: `{"tool": "fetchTimeline", "arguments": {"date": "${day}"}}` } }] }))
        } else {
          assert.ok(json.messages[json.messages.length - 1].content.startsWith('TOOL RESULT (fetchTimeline)'))
          res.end(JSON.stringify({ choices: [{ message: { content: 'Coding, then YouTube.' } }] }))
        }
      },
      async (url) => {
        const evs: StreamEvent[] = []
        await new OpenAIChatRunner(url, 'm', '').run(
          { system: 'S', history: [{ role: 'user', content: 'q' }], executeTool: (a, b) => executeTool(store.db, a, b), signal: new AbortController().signal },
          (e) => evs.push(e),
        )
        const v = evs.filter((e) => e.type !== 'debug')
        assert.deepEqual(v.map((e) => e.type), ['toolStart', 'toolEnd', 'textDelta', 'complete'])
        assert.equal((v[1] as { output: string }).output, 'Fetched 2 timeline cards for Sat, Nov 7.')
      },
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('text tool request parsing and think filter', () => {
  assert.deepEqual(parseTextToolRequest('{"tool":"fetchTimeline","arguments":{"date":"2026-11-07"}}'), { name: 'fetchTimeline', args: { date: '2026-11-07' } })
  assert.deepEqual(parseTextToolRequest('```json\n{"name":"fetchObservations","args":"{\\"date\\":\\"x\\"}"}\n```'), { name: 'fetchObservations', args: { date: 'x' } })
  assert.equal(parseTextToolRequest('Here is {"tool":"x"}'), null)
  assert.equal(parseTextToolRequest('{"title":"chart"}'), null)
  let text = ''
  let think = ''
  const f = new ThinkFilter((t) => (text += t), (t) => (think += t))
  for (const c of ['a<th', 'ink>b', 'c</thi', 'nk>d', '<']) f.push(c)
  f.end()
  assert.equal(text, 'ad<')
  assert.equal(think, 'bc')
})

// ---------------- full service turn (OpenAI-compatible mock) ----------------

test('ChatService: a full turn streams, strips metadata, saves history and memory', async () => {
  const { dir, store, day } = seedDb()
  let n = 0
  try {
    await withServer(
      (_req, body, res) => {
        const json = JSON.parse(body) as { messages: Array<{ role: string; content: string }> }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (n++ === 0) {
          const d = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'fetchTimeline', arguments: JSON.stringify({ date: day }) } }] } }] }
          res.end(`data: ${JSON.stringify(d)}\n\ndata: [DONE]\n\n`)
          return
        }
        if (n === 3) assert.ok(json.messages[0].content.includes('## User Memory\nProfile: dev\nStyle: brief'))
        const reply = 'Pulled the cards.\n\n```suggestions\n["Deeper?", "Adjacent?", "Surprise?"]\n```\n\n```memory\nProfile: dev\nStyle: brief\n```'
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`)
      },
      async (url) => {
        const settings = {
          provider: 'openai_compatible',
          openaiBaseUrl: url,
          openaiModel: 'm',
          geminiModel: '',
          cliModel: '',
          claudeCommand: 'claude',
          codexCommand: 'codex',
          outputLanguage: '',
          categories: [],
        } as unknown as Settings
        const events: ChatEvent[] = []
        const svc = new ChatService({
          db: store.db,
          getSettings: () => settings,
          getSecret: () => '',
          broadcast: (e) => events.push(e),
          cliCwd: join(dir, 'chatcli'),
          mcp: { command: 'node', args: [], env: {} },
        })
        assert.equal(svc.status().available, true)
        const r = await svc.send({ turnId: 'T1', conversationId: null, text: 'What did I do?' })
        assert.equal(r.error, null)
        assert.deepEqual(r.suggestions, ['Deeper?', 'Adjacent?', 'Surprise?'])
        assert.equal(r.memory.text, 'Profile: dev\nStyle: brief')
        assert.deepEqual(r.messages.map((m) => [m.role, m.content]), [
          ['user', 'What did I do?'],
          ['assistant', 'Pulled the cards.'],
        ])
        assert.ok(events.some((e) => e.type === 'toolEnd' && e.tool.state === 'done'))
        const texts = events.filter((e): e is Extract<ChatEvent, { type: 'text' }> => e.type === 'text')
        assert.ok(texts.length > 0 && texts.every((t) => !t.visible.includes('```suggestions')))
        assert.ok(events.every((e) => e.turnId === 'T1'))

        const r2 = await svc.send({ turnId: 'T2', conversationId: r.conversationId, text: 'More' })
        assert.equal(r2.messages.length, 4)
        const list = svc.list()
        assert.equal(list.length, 1)
        assert.equal(list[0].title, 'What did I do?')
        assert.equal(list[0].provider, 'openai_compatible')
        const loaded = new ChatService({
          db: store.db,
          getSettings: () => settings,
          getSecret: () => '',
          broadcast: () => {},
          cliCwd: dir,
          mcp: { command: 'node', args: [], env: {} },
        }).load(r.conversationId)
        assert.equal(loaded?.messages.length, 4)
      },
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ChatService reports provider errors as an assistant message', async () => {
  const { dir, store } = seedDb()
  try {
    await withServer(
      (_req, _body, res) => {
        res.writeHead(500)
        res.end('boom')
      },
      async (url) => {
        const settings = { provider: 'openai_compatible', openaiBaseUrl: url, openaiModel: 'm', categories: [], outputLanguage: '' } as unknown as Settings
        const svc = new ChatService({
          db: store.db,
          getSettings: () => settings,
          getSecret: () => '',
          broadcast: () => {},
          cliCwd: dir,
          mcp: { command: 'node', args: [], env: {} },
        })
        const r = await svc.send({ turnId: 'E', conversationId: null, text: 'Hi' })
        assert.ok(r.error)
        assert.ok(r.messages[1].content.startsWith('I encountered an error: '))
        assert.equal(svc.list().length, 1)
      },
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------- tool caps ----------------

test('tools clamp long ranges to the most recent days and cap payload size', () => {
  const { dir, store, day } = seedDb()
  try {
    const r = executeTool(store.db, 'fetchTimeline', { startDate: '2026-01-01', endDate: day })
    assert.equal(r.error, undefined)
    assert.equal(r.rangeClamped, true)
    assert.equal(r.requestedStartDate, '2026-01-01')
    assert.equal((r.request as { startDate: string }).startDate, '2026-09-07')
    assert.ok(String(r.summary).includes(`clamped to the last ${MAX_RANGE_DAYS} days`))
    assert.equal(r.itemCount, 2)
    const o = executeTool(store.db, 'fetchObservations', { startDate: '2025-11-07', endDate: day })
    assert.equal(o.rangeClamped, true)
    assert.equal('rangeClamped' in executeTool(store.db, 'fetchTimeline', { startDate: '2026-11-01', endDate: day }), false)

    // Observations: 10 x 30 KB rows exceed the 200 KB cap; the kept prefix fits.
    const start = dayRange(day).start + 12 * 3600
    const b = store.createBatch(start, start + 3600, [])
    store.saveObservations(
      b,
      Array.from({ length: 10 }, (_, i) => ({ startTs: start + i * 60, endTs: start + i * 60 + 30, observation: 'y'.repeat(30_000) })),
      'test',
    )
    const big = executeTool(store.db, 'fetchObservations', { date: day })
    assert.equal(big.truncated, true)
    assert.ok(Number(big.itemCount) < 12)
    assert.ok(Buffer.byteLength(JSON.stringify(big.items)) <= MAX_TOOL_PAYLOAD_BYTES)
    assert.ok(String(big.summary).includes('size cap'))
    // An explicit small limit is honored in SQL and is not "truncated".
    const lim = executeTool(store.db, 'fetchObservations', { date: day, limit: 2 })
    assert.equal(lim.itemCount, 2)
    assert.equal(lim.truncated, false)

    // Timeline: two 150 KB summaries; detailed summaries go first, then rows.
    store.db.prepare('UPDATE timeline_cards SET summary = ?').run('z'.repeat(150_000))
    const t = executeTool(store.db, 'fetchTimeline', { date: day })
    assert.equal(t.truncated, true)
    assert.equal(t.itemCount, 1)
    assert.ok(Buffer.byteLength(JSON.stringify(t.items)) <= MAX_TOOL_PAYLOAD_BYTES)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI exit code 9009 (cmd.exe) means the CLI is missing, whatever the stderr text', () => {
  const garbled = '�� "claude" �� ������'
  if (process.platform === 'win32') {
    assert.equal(cliExitError('Claude', 'claude login', 9009, garbled, false), "Claude CLI not found. Please install it and run 'claude login' in a terminal.")
  } else {
    assert.equal(cliExitError('Codex', 'codex login', 127, '', false), "Codex CLI not found. Please install it and run 'codex login' in a terminal.")
  }
  assert.equal(cliExitError('Claude', 'claude login', 1, 'boom', false), 'boom')
  assert.equal(cliExitError('Claude', 'claude login', 0, '', false), null)
})

// ---------------- ChatService with a scripted runner ----------------

type Script = (conv: ConversationState, emit: Emit, signal: AbortSignal) => Promise<void>

class ScriptedService extends ChatService {
  scripts: Script[] = []
  protected async runProvider(_s: Settings, conv: ConversationState, emit: Emit, signal: AbortSignal): Promise<void> {
    const next = this.scripts.shift()
    if (!next) throw new Error('unexpected provider call')
    await next(conv, emit, signal)
  }
}

function scripted(store: Store, dir: string, provider: string, events: ChatEvent[]): ScriptedService {
  const settings = { provider, categories: [], outputLanguage: '', claudeCommand: 'claude', codexCommand: 'codex', cliModel: '' } as unknown as Settings
  return new ScriptedService({
    db: store.db,
    getSettings: () => settings,
    getSecret: () => '',
    broadcast: (e) => events.push(e),
    cliCwd: dir,
    mcp: { command: 'node', args: [], env: {} },
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}

test('ChatService: a running turn owns its conversation (load, concurrent send, re-attach, done)', async () => {
  const { dir, store } = seedDb()
  try {
    const events: ChatEvent[] = []
    const svc = scripted(store, dir, 'gemini', events)
    svc.scripts.push(async (_c, emit) => emit({ type: 'complete', text: 'First answer.' }))
    const r1 = await svc.send({ turnId: 'A', conversationId: null, text: 'One' })
    const id = r1.conversationId

    const g = gate()
    svc.scripts.push(async (_c, emit) => {
      emit({ type: 'toolStart', command: 'fetchTimeline {}', id: 'x' })
      emit({ type: 'toolEnd', output: 'ok', exitCode: 0, id: 'x' })
      emit({ type: 'textDelta', text: 'Partial' })
      await g.wait
      emit({ type: 'textDelta', text: ' answer.' })
      emit({ type: 'complete', text: 'Partial answer.' })
    })
    const p2 = svc.send({ turnId: 'B', conversationId: id, text: 'Two' })
    await sleep(120)

    // What a remounted view asks for: the running turn and its streamed state.
    const st = svc.status()
    assert.equal(st.activeTurn?.turnId, 'B')
    assert.equal(st.activeTurn?.conversationId, id)
    const live = svc.load(id)!
    assert.deepEqual(live.messages.map((m) => m.content), ['One', 'First answer.', 'Two'])
    assert.equal(live.activeTurn?.turnId, 'B')
    assert.equal(live.activeTurn?.visible, 'Partial')
    assert.equal(live.activeTurn?.stage, 'answering')
    assert.deepEqual(live.activeTurn?.tools.map((t) => t.state), ['done'])

    // A second turn on the same conversation is rejected, and changes nothing.
    await assert.rejects(svc.send({ turnId: 'C', conversationId: id, text: 'Nope' }), { message: TURN_IN_PROGRESS_ERROR })

    g.open()
    const r2 = await p2
    assert.deepEqual(r2.messages.map((m) => m.content), ['One', 'First answer.', 'Two', 'Partial answer.'])
    const done = events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.turnId === 'B')
    assert.deepEqual(done?.result, r2)
    assert.equal(svc.status().activeTurn, null)
    assert.equal(svc.load(id)?.activeTurn, null)

    // The load() during the turn did not drop anything from later saves.
    svc.scripts.push(async (_c, emit) => emit({ type: 'complete', text: 'Third answer.' }))
    await svc.send({ turnId: 'D', conversationId: id, text: 'Three' })
    assert.equal(svc.storage.loadConversation(id)?.messages.length, 6)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ChatService.dispose aborts running turns and refuses new ones', async () => {
  const { dir, store } = seedDb()
  try {
    const svc = scripted(store, dir, 'gemini', [])
    svc.scripts.push(
      (_c, _e, signal) =>
        new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    )
    const p = svc.send({ turnId: 'K', conversationId: null, text: 'Hi' })
    await sleep(10)
    assert.equal(svc.status().activeTurn?.turnId, 'K')
    svc.dispose()
    const r = await p
    assert.equal(r.cancelled, true)
    assert.equal(svc.status().activeTurn, null)
    await assert.rejects(svc.send({ turnId: 'L', conversationId: null, text: 'Again' }), /shutting down/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ChatService: the resume attempt error is hidden when the rebuild retry follows', async () => {
  const { dir, store } = seedDb()
  try {
    const events: ChatEvent[] = []
    const svc = scripted(store, dir, 'claude_cli', events)
    svc.scripts.push(async (_c, emit) => {
      emit({ type: 'session', id: 'S1' })
      emit({ type: 'complete', text: 'Hi.' })
    })
    const r1 = await svc.send({ turnId: '1', conversationId: null, text: 'a' })

    events.length = 0
    svc.scripts.push(async (c, emit) => {
      assert.equal(c.sessionId, 'S1')
      emit({ type: 'error', message: 'No conversation found with session ID S1' })
    })
    svc.scripts.push(async (c, emit) => {
      assert.equal(c.sessionId, null)
      emit({ type: 'session', id: 'S2' })
      emit({ type: 'complete', text: 'Rebuilt.' })
    })
    const r2 = await svc.send({ turnId: '2', conversationId: r1.conversationId, text: 'b' })
    assert.equal(r2.error, null)
    assert.equal(r2.messages[r2.messages.length - 1].content, 'Rebuilt.')
    assert.equal(events.filter((e) => e.type === 'error').length, 0)
    assert.ok(!events.some((e) => e.type === 'stage' && e.stage === 'error'))

    // Other errors on a resumed session still reach the UI.
    events.length = 0
    svc.scripts.push(async (_c, emit) => emit({ type: 'error', message: 'rate limited' }))
    const r3 = await svc.send({ turnId: '3', conversationId: r1.conversationId, text: 'c' })
    assert.equal(r3.error, 'rate limited')
    assert.equal(events.filter((e) => e.type === 'error').length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ChatService matches tool results to calls by id', async () => {
  const { dir, store } = seedDb()
  try {
    const events: ChatEvent[] = []
    const svc = scripted(store, dir, 'claude_cli', events)
    svc.scripts.push(async (_c, emit) => {
      emit({ type: 'toolStart', command: 'fetchTimeline {"date":"2026-11-07"}', id: 'a' })
      emit({ type: 'toolStart', command: 'fetchObservations {"date":"2026-11-07"}', id: 'b' })
      emit({ type: 'toolEnd', output: 'observations failed', exitCode: 1, id: 'b' })
      emit({ type: 'toolEnd', output: 'Fetched 2 timeline cards', exitCode: 0, id: 'a' })
      // Without ids: the oldest running call gets the result.
      emit({ type: 'toolStart', command: 'first {}' })
      emit({ type: 'toolStart', command: 'second {}' })
      emit({ type: 'toolEnd', output: 'one', exitCode: 0 })
      emit({ type: 'complete', text: 'ok' })
    })
    await svc.send({ turnId: 'T', conversationId: null, text: 'q' })
    const ends = events.filter((e): e is Extract<ChatEvent, { type: 'toolEnd' }> => e.type === 'toolEnd').map((e) => e.tool)
    assert.equal(ends.length, 3)
    assert.ok(ends[0].command.startsWith('fetchObservations'))
    assert.equal(ends[0].state, 'failed')
    assert.ok(ends[1].command.startsWith('fetchTimeline'))
    assert.equal(ends[1].state, 'done')
    assert.equal(ends[2].command, 'first {}')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gemini runner does not retry a stream that already showed text', async () => {
  let requests = 0
  await withServer(
    (_req, _body, res) => {
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Half an ans' }] } }] })}\n\n`)
      setTimeout(() => res.destroy(), 20)
    },
    async (url) => {
      const evs: StreamEvent[] = []
      const runner = new GeminiChatRunner('KEY', 'test-model', { endpoint: url, models: ['test-model'] })
      await assert.rejects(
        runner.run(
          { system: 'S', history: [{ role: 'user', content: 'q' }], executeTool: () => ({ summary: '' }), signal: new AbortController().signal },
          (e) => evs.push(e),
        ),
      )
      assert.equal(requests, 1)
      assert.equal(evs.filter((e) => e.type === 'textDelta').length, 1)
    },
  )
})
