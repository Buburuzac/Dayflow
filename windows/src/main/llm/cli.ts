// Claude Code / Codex CLI providers. Uses the user's own CLI login, like the macOS app's
// ChatCLIProcessRunner. Prompts go through stdin so nothing long or sensitive lands on the
// command line; on Windows npm installs `.cmd` shims, so the CLIs are launched through the shell.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallLogger, Frame, LLMProvider } from './types.ts'

const TIMEOUT_MS = 10 * 60_000

/** Quotes one argument for cmd.exe. Arguments here are flags, model ids and file paths. */
function q(arg: string): string {
  if (arg === '') return '""'
  if (/^[\w\-.:=/\\]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Children started by runCli that are still running, so app quit can stop them. */
const activeChildren = new Set<ChildProcess>()

/**
 * Kills a process and all of its descendants. With `shell: true` the direct child is cmd.exe,
 * so `child.kill()` alone would leave the real claude/codex process running.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
  } catch {
    child.kill()
  }
}

/** Stops every running CLI child. Called on app quit. */
export function killAllCli(): void {
  for (const c of activeChildren) killTree(c)
  activeChildren.clear()
}

const commandCache = new Map<string, { ok: boolean; at: number }>()

/**
 * True when the command can be started: an existing absolute path, or a name `where.exe` finds
 * on PATH. Checked up front because cmd.exe reports a missing program only as exit code 1 with a
 * localized message, which can't be told apart from the CLI's own failures.
 */
export function commandExists(command: string): boolean {
  if (/^[a-zA-Z]:\\/.test(command)) return existsSync(command)
  const cached = commandCache.get(command)
  if (cached && Date.now() - cached.at < 60_000) return cached.ok
  const r = spawnSync('where.exe', [command], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
  const ok = r.status === 0
  commandCache.set(command, { ok, at: Date.now() })
  return ok
}

export function runCli(
  command: string,
  args: string[],
  stdin: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'))
      return
    }
    if (!commandExists(command)) {
      reject(new Error(`"${command}" was not found. Install it or set the full path in Settings.`))
      return
    }
    const child = spawn([q(command), ...args.map(q)].join(' '), {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      activeChildren.delete(child)
      fn()
    }
    const onAbort = () => {
      killTree(child)
      finish(() => reject(new Error('Cancelled')))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      killTree(child)
      finish(() => reject(new Error(`${command} timed out after ${TIMEOUT_MS / 60000} minutes`)))
    }, TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })))
    // If the command can't start, cmd.exe exits while we are still writing; the exit code
    // reports that, so a broken pipe here must not become an uncaught exception.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin, 'utf8')
  })
}

/** An empty working directory, so the CLI doesn't pick up project files or instructions. */
function scratchDir(): string {
  const dir = join(tmpdir(), 'dayflow-cli')
  mkdirSync(dir, { recursive: true })
  return dir
}

function label(f: Frame): string {
  const s = Math.max(0, Math.round(f.offsetSeconds))
  const t = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return f.label ? `[${t}] ${f.label}` : `[${t}]`
}

export class ClaudeCliProvider implements LLMProvider {
  readonly id = 'claude_cli'
  readonly model: string | null
  private readonly command: string
  private readonly log: CallLogger

  constructor(command: string, model: string, log: CallLogger) {
    this.command = command || 'claude'
    this.model = model || null
    this.log = log
  }

  async generateWithImages(prompt: string, frames: Frame[], operation: string, signal?: AbortSignal): Promise<string> {
    const content: unknown[] = [{ type: 'text', text: prompt }]
    for (const f of frames) {
      content.push({ type: 'text', text: label(f) })
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: (await readFile(f.path)).toString('base64') },
      })
    }
    return this.run(content, operation, signal)
  }

  generateText(prompt: string, operation: string, _expectJSON?: boolean, signal?: AbortSignal): Promise<string> {
    return this.run([{ type: 'text', text: prompt }], operation, signal)
  }

  private async run(content: unknown[], operation: string, signal?: AbortSignal): Promise<string> {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ]
    if (this.model) args.push('--model', this.model)
    const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
    const started = Date.now()
    try {
      const res = await runCli(this.command, args, stdin, scratchDir(), signal)
      let result: string | null = null
      let isError = false
      for (const line of res.stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'result') {
            result = typeof ev.result === 'string' ? ev.result : ''
            isError = Boolean(ev.is_error)
          }
        } catch {
          /* not JSON */
        }
      }
      if (result === null || isError) {
        throw new Error(
          `claude exited with code ${res.code}: ${(result || res.stderr || res.stdout).trim().slice(0, 400)}`,
        )
      }
      this.log({
        provider: this.id, model: this.model, operation, status: 'success',
        latencyMs: Date.now() - started, responseBody: result,
      })
      return result
    } catch (err) {
      this.log({
        provider: this.id, model: this.model, operation, status: 'failure',
        latencyMs: Date.now() - started, errorMessage: String(err),
      })
      throw err
    }
  }
}

export class CodexCliProvider implements LLMProvider {
  readonly id = 'codex_cli'
  readonly model: string | null
  private readonly command: string
  private readonly log: CallLogger

  constructor(command: string, model: string, log: CallLogger) {
    this.command = command || 'codex'
    this.model = model || null
    this.log = log
  }

  async generateWithImages(prompt: string, frames: Frame[], operation: string, signal?: AbortSignal): Promise<string> {
    // Codex attaches images in order; the prompt lists each image's label in the same order.
    const legend = frames.map((f, i) => `Image ${i + 1}: ${label(f)}`).join('\n')
    return this.run(`${prompt}\n\nAttached screenshots, in order:\n${legend}`, frames.map((f) => f.path), operation, signal)
  }

  generateText(prompt: string, operation: string, _expectJSON?: boolean, signal?: AbortSignal): Promise<string> {
    return this.run(prompt, [], operation, signal)
  }

  private async run(prompt: string, images: string[], operation: string, signal?: AbortSignal): Promise<string> {
    const outFile = join(tmpdir(), `dayflow-codex-${randomUUID()}.txt`)
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '-s', 'read-only',
      '-c', 'web_search=disabled',
      '-o', outFile,
    ]
    if (this.model) args.push('-m', this.model)
    for (const p of images) args.push('--image', p)
    args.push('-')
    const started = Date.now()
    try {
      const res = await runCli(this.command, args, prompt, scratchDir(), signal)
      let out = ''
      try {
        out = await readFile(outFile, 'utf8')
      } catch {
        /* no output file */
      }
      if (!out.trim()) {
        throw new Error(`codex exited with code ${res.code}: ${(res.stderr || res.stdout).trim().slice(-400)}`)
      }
      this.log({
        provider: this.id, model: this.model, operation, status: 'success',
        latencyMs: Date.now() - started, responseBody: out,
      })
      return out
    } catch (err) {
      this.log({
        provider: this.id, model: this.model, operation, status: 'failure',
        latencyMs: Date.now() - started, errorMessage: String(err),
      })
      throw err
    } finally {
      await rm(outFile, { force: true })
    }
  }
}
