// Claude Code and Codex CLI chat runners (ChatCLIRunner.swift), using the dayflow stdio MCP
// server for data instead of sqlite3. Prompts go through stdin (Windows command-line limit).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLI_TIMEOUT_MS,
  CMD_NOT_FOUND_EXIT,
  type CliRunInput,
  type Emit,
  streamProcess,
  stripAnsi,
  summarizeToolText,
} from './runner.ts'

/** How a CLI launches the MCP server: electron.exe (ELECTRON_RUN_AS_NODE=1) + script + db path. */
export interface McpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface CliConfig {
  command: string
  model: string | null
  /** Working directory (<dataDir>/chatcli) */
  cwd: string
  mcp: McpLaunch
}

const CLAUDE_TOOLS = ['mcp__dayflow__fetchTimeline', 'mcp__dayflow__fetchObservations']

function stripToolPrefix(name: string): string {
  return name.replace(/^mcp__dayflow__/, '').replace(/^dayflow[.:/]/, '')
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('')
  }
  return ''
}

/** Error for a finished CLI run, or null on success. Exported for tests. */
export function cliExitError(tool: string, login: string, code: number | null, stderr: string, timedOut: boolean): string | null {
  if (timedOut) return `CLI process timed out after ${CLI_TIMEOUT_MS / 1000} seconds`
  if (code === 0) return null
  // cmd.exe reports a missing command with exit code 9009 and a message in the OEM codepage
  // (localized, often garbled as UTF-8), so the exit code is the reliable signal; 127 is POSIX sh.
  const notFound =
    (process.platform === 'win32' && code === CMD_NOT_FOUND_EXIT) ||
    (process.platform !== 'win32' && code === 127) ||
    /not recognized as an internal or external command|command not found|ENOENT/i.test(stderr)
  if (notFound) return `${tool} CLI not found. Please install it and run '${login}' in a terminal.`
  const s = stderr.trim()
  return s ? stripAnsi(s).slice(-2000) : `${tool} exited with code ${code}`
}

// ---------------- Claude ----------------

export function claudeArgs(cfg: CliConfig, mcpConfigPath: string, sessionId: string | null): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]
  if (sessionId) args.push('--resume', sessionId)
  args.push(
    '--model', cfg.model || 'sonnet',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', CLAUDE_TOOLS.join(','),
    '--tools', '',
  )
  return args
}

export function writeClaudeMcpConfig(cfg: CliConfig): string {
  mkdirSync(cfg.cwd, { recursive: true })
  const file = join(cfg.cwd, 'dayflow-mcp.json')
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { dayflow: { type: 'stdio', command: cfg.mcp.command, args: cfg.mcp.args, env: cfg.mcp.env } } }, null, 2),
  )
  return file
}

/** Parses one Claude stream-json line. `state` tracks whether text deltas were seen. */
export function handleClaudeLine(line: string, emit: Emit, state: { sawDelta: boolean; tools: Map<string, string> }): void {
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(stripAnsi(line).trim()) as Record<string, unknown>
  } catch {
    return
  }
  const type = ev.type
  if (type === 'system' && typeof ev.session_id === 'string') {
    emit({ type: 'session', id: ev.session_id })
    return
  }
  if (type === 'stream_event') {
    const e = ev.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined
    if (e?.type === 'content_block_delta') {
      if (e.delta?.type === 'text_delta' && e.delta.text) {
        state.sawDelta = true
        emit({ type: 'textDelta', text: e.delta.text })
      } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
        emit({ type: 'thinking', text: e.delta.thinking })
      }
    }
    return
  }
  if (type === 'assistant') {
    const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? []
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        const name = stripToolPrefix(String(block.name ?? 'tool'))
        const cmd = `${name} ${JSON.stringify(block.input ?? {})}`
        const id = typeof block.id === 'string' && block.id ? block.id : undefined
        if (id) state.tools.set(id, cmd)
        emit({ type: 'toolStart', command: cmd, ...(id ? { id } : {}) })
      }
    }
    return
  }
  if (type === 'user') {
    const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? []
    if (!Array.isArray(content)) return
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') {
        const text = contentText(block.content)
        const s = summarizeToolText(text)
        emit({ type: 'debug', kind: 'TOOL RESULT', content: text.slice(0, 4000) })
        const id = typeof block.tool_use_id === 'string' && block.tool_use_id ? block.tool_use_id : undefined
        emit({ type: 'toolEnd', output: s.summary, exitCode: block.is_error || s.isError ? 1 : 0, ...(id ? { id } : {}) })
      }
    }
    return
  }
  if (type === 'result') {
    const result = typeof ev.result === 'string' ? ev.result : ''
    if (ev.is_error) {
      const errors = Array.isArray(ev.errors) ? (ev.errors as unknown[]).map(String).join('\n') : ''
      emit({ type: 'error', message: result || errors || 'Claude could not complete the request.' })
    } else if (result.trim()) {
      emit({ type: 'complete', text: result })
    }
  }
}

export async function runClaude(cfg: CliConfig, input: CliRunInput, emit: Emit): Promise<void> {
  const mcpFile = writeClaudeMcpConfig(cfg)
  const args = claudeArgs(cfg, mcpFile, input.sessionId)
  emit({ type: 'debug', kind: 'INFO', content: `${cfg.command} ${args.join(' ')}` })
  const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input.prompt }] } }) + '\n'
  const state = { sawDelta: false, tools: new Map<string, string>() }
  let sawError = false
  const wrapped: Emit = (ev) => {
    if (ev.type === 'error') sawError = true
    emit(ev)
  }
  const res = await streamProcess({
    command: cfg.command,
    args,
    stdin,
    cwd: cfg.cwd,
    signal: input.signal,
    onLine: (line) => handleClaudeLine(line, wrapped, state),
  })
  if (!sawError) {
    const err = cliExitError('Claude', 'claude login', res.code, res.stderr, res.timedOut)
    if (err) emit({ type: 'error', message: err })
  }
}

// ---------------- Codex ----------------

/** TOML string literal; single-quoted (no escapes) unless the value contains a quote. */
export function tomlString(s: string): string {
  if (!s.includes("'")) return `'${s}'`
  return JSON.stringify(s.replace(/\\/g, '/'))
}

export function codexArgs(cfg: CliConfig, sessionId: string | null): string[] {
  const args = ['exec']
  if (sessionId) args.push('resume', sessionId)
  args.push(
    '--skip-git-repo-check',
    '--json',
    '--ignore-user-config',
    '-c', "sandbox_mode='read-only'",
    '-c', "model_reasoning_effort='low'",
    '-c', "web_search='disabled'",
    '-c', `mcp_servers.dayflow.command=${tomlString(cfg.mcp.command)}`,
    '-c', `mcp_servers.dayflow.args=[${cfg.mcp.args.map(tomlString).join(',')}]`,
    '-c', `mcp_servers.dayflow.env={${Object.entries(cfg.mcp.env).map(([k, v]) => `${k}=${tomlString(v)}`).join(',')}}`,
  )
  if (cfg.model) args.push('-m', cfg.model)
  args.push('-')
  return args
}

function nestedMessage(msg: string): string {
  try {
    const v = JSON.parse(msg) as { error?: { message?: string }; message?: string }
    return v.error?.message ?? v.message ?? msg
  } catch {
    return msg
  }
}

/** Parses one Codex --json line. */
export function handleCodexLine(line: string, emit: Emit, state: { messages: number }): void {
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(stripAnsi(line).trim()) as Record<string, unknown>
  } catch {
    return
  }
  const type = String(ev.type ?? '')
  if (type === 'thread.started' && typeof ev.thread_id === 'string') {
    emit({ type: 'session', id: ev.thread_id })
    return
  }
  if (type === 'error' || type === 'turn.failed') {
    const err = ev.error as { message?: string } | undefined
    const raw = err?.message ?? (typeof ev.message === 'string' ? ev.message : '') ?? ''
    emit({ type: 'error', message: raw ? nestedMessage(raw) : 'Codex could not complete the request.' })
    return
  }
  if (!type.startsWith('item.')) return
  const item = ev.item as Record<string, unknown> | undefined
  if (!item) return
  const itemType = item.type
  const ids = typeof item.id === 'string' && item.id ? { id: item.id } : {}
  const started = type === 'item.started'
  const completed = type === 'item.completed'
  if (itemType === 'reasoning' && completed && typeof item.text === 'string' && item.text) {
    emit({ type: 'thinking', text: item.text })
  } else if (itemType === 'command_execution') {
    if (started) emit({ type: 'toolStart', command: String(item.command ?? ''), ...ids })
    else if (completed) {
      emit({
        type: 'toolEnd',
        output: String(item.aggregated_output ?? ''),
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        ...ids,
      })
    }
  } else if (itemType === 'mcp_tool_call') {
    const cmd = `${stripToolPrefix(String(item.tool ?? 'tool'))} ${JSON.stringify(item.arguments ?? {})}`
    if (started) emit({ type: 'toolStart', command: cmd, ...ids })
    else if (completed) {
      const result = item.result as { content?: unknown; is_error?: boolean } | null
      const err = item.error as { message?: string } | string | null
      if (result) {
        const text = contentText(result.content)
        const s = summarizeToolText(text)
        emit({ type: 'debug', kind: 'TOOL RESULT', content: text.slice(0, 4000) })
        emit({ type: 'toolEnd', output: s.summary, exitCode: item.status === 'failed' || result.is_error || s.isError ? 1 : 0, ...ids })
      } else {
        const msg = typeof err === 'string' ? err : (err?.message ?? 'Tool call failed')
        emit({ type: 'toolEnd', output: msg, exitCode: 1, ...ids })
      }
    }
  } else if (itemType === 'agent_message' && completed && typeof item.text === 'string' && item.text) {
    emit({ type: 'textDelta', text: state.messages > 0 ? `\n\n${item.text}` : item.text })
    state.messages++
  } else if (itemType === 'error' && completed) {
    emit({ type: 'debug', kind: 'INFO', content: String(item.message ?? '') })
  }
}

export async function runCodex(cfg: CliConfig, input: CliRunInput, emit: Emit): Promise<void> {
  mkdirSync(cfg.cwd, { recursive: true })
  const args = codexArgs(cfg, input.sessionId)
  emit({ type: 'debug', kind: 'INFO', content: `${cfg.command} ${args.join(' ')}` })
  const state = { messages: 0 }
  let sawError = false
  const wrapped: Emit = (ev) => {
    if (ev.type === 'error') sawError = true
    emit(ev)
  }
  const res = await streamProcess({
    command: cfg.command,
    args,
    stdin: input.prompt,
    cwd: cfg.cwd,
    signal: input.signal,
    onLine: (line) => handleCodexLine(line, wrapped, state),
  })
  if (!sawError) {
    const err = cliExitError('Codex', 'codex login', res.code, res.stderr, res.timedOut)
    if (err) emit({ type: 'error', message: err })
  }
}
