// Runs `claude -p` with a JSON schema for the Daily Brief and the range summary
// (spec-daily.md §3b.4/§3b.5). The prompt goes on stdin; JSON arguments are passed to the real
// claude.exe without a shell (see spawn.ts).

import type { DailyBriefRunStats } from '../../shared/daily-types.ts'
import {
  classifyClaudeFailure,
  classifyErrorText,
  isSuccessEnvelope,
  parseClaudeEvents,
  resultEnvelope,
  SHAPE_ERROR,
  statsFromEvents,
  structuredFromEnvelope,
  transcriptText,
} from './brief-logic.ts'
import { CommandNotFoundError, runCommand } from './spawn.ts'

export interface ClaudeRunOptions {
  command: string
  prompt: string
  schema: object
  name: string
  /** Built-in tools available, e.g. "Read,WebSearch" or "" for none. */
  tools: string
  allowedTools: string[]
  disallowedTools?: string[]
  /** JSON settings (string) or a path to a settings file. */
  settings?: string
  mcpConfig?: string
  strictMcp: boolean
  model: string
  cwd: string
  timeoutMs: number
  timeoutMessage: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export interface ClaudeRunResult {
  value: Record<string, unknown> | null
  error: string | null
  stats: Partial<DailyBriefRunStats>
  transcript: string
}

export async function runClaudeStructured(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [
    '-p',
    '--output-format', 'json',
    '--verbose',
    '--disable-slash-commands',
    '--prompt-suggestions', 'false',
    '--tools', o.tools,
    '--json-schema', JSON.stringify(o.schema),
    '--name', o.name,
    '--no-session-persistence',
    // Never inherit a bypass/acceptEdits default mode from the user's settings.
    '--permission-mode', 'default',
  ]
  if (o.settings) args.push('--settings', o.settings)
  if (o.mcpConfig) args.push('--mcp-config', o.mcpConfig)
  if (o.strictMcp) args.push('--strict-mcp-config')
  if (o.disallowedTools?.length) args.push('--disallowedTools', ...o.disallowedTools)
  if (o.allowedTools.length) args.push('--allowedTools', ...o.allowedTools)
  args.push('--model', o.model, '--')

  const env = { ...(o.env ?? process.env) }
  delete env.MAX_THINKING_TOKENS
  let stdout = ''
  let stderr = ''
  try {
    const res = await runCommand(o.command, args, {
      cwd: o.cwd,
      stdin: o.prompt,
      timeoutMs: o.timeoutMs,
      timeoutMessage: o.timeoutMessage,
      env,
      signal: o.signal,
    })
    stdout = res.stdout
    stderr = res.stderr
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const error =
      err instanceof CommandNotFoundError
        ? "Claude Code isn't installed. Install it with `npm i -g @anthropic-ai/claude-code`, then sign in with `claude`."
        : msg === o.timeoutMessage || msg === 'Cancelled'
          ? msg
          : classifyErrorText(msg)
    return { value: null, error, stats: {}, transcript: transcriptText(o.prompt, [], `${stderr}\n${msg}`, stdout) }
  }
  const events = parseClaudeEvents(stdout)
  const env2 = resultEnvelope(events)
  const stats = statsFromEvents(events, o.model)
  const transcript = transcriptText(o.prompt, events, stderr, stdout)
  if (!env2 || !isSuccessEnvelope(env2)) {
    return { value: null, error: classifyClaudeFailure(env2, stderr, stdout), stats, transcript }
  }
  const value = structuredFromEnvelope(env2)
  if (!value) return { value: null, error: SHAPE_ERROR, stats, transcript }
  return { value, error: null, stats, transcript }
}

let readiness: Promise<string | null> | null = null

/** `claude --help` check (cached for the process lifetime when it passes). Returns an error message or null. */
export function claudeReadiness(command: string): Promise<string | null> {
  if (readiness) return readiness
  const p = (async () => {
    try {
      const res = await runCommand(command, ['--help'], { cwd: process.cwd(), timeoutMs: 60_000 })
      const out = res.stdout + res.stderr
      if (res.code !== 0 && !out.includes('--print')) {
        return "Claude Code isn't installed. Install it with `npm i -g @anthropic-ai/claude-code`, then sign in with `claude`."
      }
      if (!out.includes('--json-schema')) return 'Your Claude Code is too old for the Daily Brief. Run `claude update`.'
      return null
    } catch {
      return "Claude Code isn't installed. Install it with `npm i -g @anthropic-ai/claude-code`, then sign in with `claude`."
    }
  })()
  readiness = p
  void p.then((r) => {
    if (r) readiness = null
  })
  return p
}
