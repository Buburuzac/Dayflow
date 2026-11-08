// Provider-neutral chat stream contract (ChatStreamEvent in the macOS app) and a streaming
// child-process helper for the CLI runners.

import { commandExists } from '../llm/cli.ts'
import { spawn, spawnSync } from 'node:child_process'
import type { ChatDebugKind, ToolResponse } from '../../shared/chat-types.ts'
import type { HistoryTurn } from './prompts.ts'

export type StreamEvent =
  | { type: 'session'; id: string }
  | { type: 'thinking'; text: string }
  /** `id` is the provider's tool-call id (tool_use id, Codex item id, …) when it has one. */
  | { type: 'toolStart'; command: string; id?: string }
  | { type: 'toolEnd'; output: string; exitCode: number | null; id?: string }
  | { type: 'textDelta'; text: string }
  | { type: 'complete'; text: string }
  | { type: 'error'; message: string }
  | { type: 'debug'; kind: ChatDebugKind; content: string }

export type Emit = (ev: StreamEvent) => void

export interface ApiRunInput {
  /** Full system instruction (prompt + memory + recent suggestions) */
  system: string
  /** User/assistant turns, ending with the latest user message */
  history: HistoryTurn[]
  executeTool: (name: string, args: unknown) => ToolResponse
  signal: AbortSignal
}

export interface CliRunInput {
  /** Full flat prompt on a fresh session, only the latest user message when resuming */
  prompt: string
  sessionId: string | null
  signal: AbortSignal
}

export const MAX_TOOL_ROUNDS = 20
export const CLI_TIMEOUT_MS = 300_000
export const TOOL_ROUNDS_ERROR = 'The assistant exceeded the maximum tool-call rounds. Please try a narrower query.'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

/** Quotes one argument for cmd.exe (same rules as llm/cli.ts). */
export function quoteArg(arg: string): string {
  if (arg === '') return '""'
  if (/^[\w\-.:=/\\]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export interface StreamProcessOptions {
  command: string
  args: string[]
  stdin: string
  cwd: string
  env?: Record<string, string>
  signal: AbortSignal
  timeoutMs?: number
  onLine: (line: string) => void
}

export interface StreamProcessResult {
  code: number | null
  stderr: string
  timedOut: boolean
}

/** Shell child processes (cmd.exe on Windows) of running CLI turns. */
const liveChildren = new Set<number>()

/**
 * Kills a process and all its descendants. On Windows children outlive their parent, so the
 * whole tree (cmd.exe → node/claude/codex → MCP server) goes through `taskkill /T /F`.
 * `sync` waits for taskkill (used on app quit, where an async spawn may not get to run).
 */
export function killTree(pid: number | undefined, sync = false): void {
  if (!pid) return
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T', '/F']
    try {
      if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    } catch {
      /* ignore */
    }
  } else {
    try {
      // Detached children lead their own process group: kill the group, then the leader.
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }
}

/** Synchronously kills every live CLI process tree (app quit). */
export function killAllChildren(): void {
  for (const pid of [...liveChildren]) killTree(pid, true)
  liveChildren.clear()
}

/** cmd.exe exit code for "is not recognized as an internal or external command". */
export const CMD_NOT_FOUND_EXIT = 9009

/**
 * Spawns a CLI through the shell (npm installs `.cmd` shims on Windows), writes `stdin`,
 * and reports stdout line by line. Resolves on exit; rejects with CancelledError on abort.
 */
export function streamProcess(opts: StreamProcessOptions): Promise<StreamProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new CancelledError())
      return
    }
    // Through `shell: true`, cmd.exe reports a missing program as exit code 1 with a localized
    // message, so check up front and report the unambiguous "not found" code instead.
    if (process.platform === 'win32' && !commandExists(opts.command)) {
      resolve({ code: CMD_NOT_FOUND_EXIT, stderr: '', timedOut: false })
      return
    }
    const child = spawn([quoteArg(opts.command), ...opts.args.map(quoteArg)].join(' '), {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, NO_COLOR: '1', ...(opts.env ?? {}) },
    })
    const pid = child.pid
    if (pid) liveChildren.add(pid)
    let buf = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(pid)
    }, opts.timeoutMs ?? CLI_TIMEOUT_MS)
    const onAbort = () => {
      cancelled = true
      killTree(pid)
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) opts.onLine(line)
      }
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 100_000) stderr += d
    })
    child.on('error', (err) => {
      if (pid) liveChildren.delete(pid)
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      if (pid) liveChildren.delete(pid)
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      if (buf.trim()) opts.onLine(buf)
      if (cancelled) reject(new CancelledError())
      else resolve({ code, stderr, timedOut })
    })
    child.stdin.on('error', () => {
      /* CLI exited before reading stdin */
    })
    child.stdin.end(opts.stdin, 'utf8')
  })
}

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export function stripAnsi(s: string): string {
  return s.replace(OSC, '').replace(CSI, '')
}

/** Extracts the tool's own `summary` from an MCP text result, falling back to the raw text. */
export function summarizeToolText(text: string): { summary: string; isError: boolean } {
  try {
    const v = JSON.parse(text) as { summary?: unknown; error?: unknown }
    if (v && typeof v === 'object' && typeof v.summary === 'string') return { summary: v.summary, isError: Boolean(v.error) }
  } catch {
    /* not JSON */
  }
  return { summary: text.slice(0, 500), isError: false }
}
