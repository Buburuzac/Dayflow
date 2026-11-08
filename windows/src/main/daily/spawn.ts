// Process helpers for the Daily features. npm installs CLIs as `.cmd` shims; long JSON arguments
// (--json-schema, --settings) do not survive cmd.exe quoting, so the shim is resolved to the real
// executable (claude.exe, or node + codex.js) and spawned without a shell. If a shim can't be
// parsed, it falls back to cmd.exe with conservative quoting.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'

export interface ResolvedCommand {
  file: string
  prefixArgs: string[]
  viaShell: boolean
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    // App execution aliases (e.g. WindowsApps\wt.exe) are reparse points that stat() can't follow.
    try {
      return !lstatSync(p).isDirectory()
    } catch {
      return false
    }
  }
}

/** Finds `name` on PATH, honouring PATHEXT. Returns the full path or null. */
export function which(name: string): string | null {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasExt = !!extname(name)
  const candidates = (dir: string) => (hasExt ? [join(dir, name)] : [...exts.map((e) => join(dir, name + e.toLowerCase())), join(dir, name)])
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    for (const c of hasExt ? [name] : [...exts.map((e) => name + e.toLowerCase()), name]) if (isFile(c)) return c
    return null
  }
  const dirs = (process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean)
  // npm's global folder is often missing from the PATH Electron inherits when started at login.
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
  for (const d of dirs) for (const c of candidates(d)) if (isFile(c)) return c
  return null
}

export function resolveCommand(command: string): ResolvedCommand | null {
  const found = which(command)
  if (!found) return null
  const ext = extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { file: found, prefixArgs: [], viaShell: false }
  if (ext === '.cmd' || ext === '.bat') {
    let text = ''
    try {
      text = readFileSync(found, 'utf8')
    } catch {
      return { file: found, prefixArgs: [], viaShell: true }
    }
    const dir = dirname(found)
    const exe = /"%dp0%\\([^"]+?\.exe)"/i.exec(text)
    if (exe && !/node\.exe$/i.test(exe[1])) {
      const p = join(dir, exe[1])
      if (existsSync(p)) return { file: p, prefixArgs: [], viaShell: false }
    }
    const js = /"%dp0%\\([^"]+?\.(?:c|m)?js)"/i.exec(text)
    if (js) {
      const script = join(dir, js[1])
      const localNode = join(dir, 'node.exe')
      const node = existsSync(localNode) ? localNode : which('node')
      if (node && existsSync(script)) return { file: node, prefixArgs: [script], viaShell: false }
    }
    return { file: found, prefixArgs: [], viaShell: true }
  }
  return { file: found, prefixArgs: [], viaShell: true }
}

function cmdQuote(arg: string): string {
  if (arg === '') return '""'
  if (/^[\w\-.:=/\\]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export interface RunOptions {
  cwd: string
  stdin?: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMessage?: string
}

export interface RunOutput {
  stdout: string
  stderr: string
  code: number | null
}

export class CommandNotFoundError extends Error {}

/** Spawns a resolved command, collects stdout/stderr, and enforces a timeout. */
export function runCommand(command: string, args: string[], opts: RunOptions): Promise<RunOutput> {
  const resolved = resolveCommand(command)
  if (!resolved) return Promise.reject(new CommandNotFoundError(`${command} is not installed or not on PATH`))
  // A signal that fired before we got here never sees an 'abort' event: don't spawn at all.
  if (opts.signal?.aborted) return Promise.reject(new Error('Cancelled'))
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    const env = { ...(opts.env ?? process.env), NO_COLOR: '1' }
    if (resolved.viaShell) {
      child = spawn([cmdQuote(resolved.file), ...args.map(cmdQuote)].join(' '), { cwd: opts.cwd, shell: true, windowsHide: true, env })
    } else {
      child = spawn(resolved.file, [...resolved.prefixArgs, ...args], { cwd: opts.cwd, windowsHide: true, env })
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const kill = () => {
      try {
        // Kill the whole tree (CLIs spawn helpers and MCP servers).
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill()
      } catch {
        child.kill()
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish(() => reject(new Error(opts.timeoutMessage ?? `${command} timed out`)))
    }, opts.timeoutMs)
    const onAbort = () => {
      kill()
      finish(() => reject(new Error('Cancelled')))
    }
    opts.signal?.addEventListener('abort', onAbort)
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout += d))
    child.stderr?.setEncoding('utf8').on('data', (d) => (stderr += d))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })))
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.stdin ?? '', 'utf8')
  })
}
