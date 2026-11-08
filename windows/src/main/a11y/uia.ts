// Host for the UI Automation helper: one long-lived hidden PowerShell process that compiles the
// C# in uia-helper.cs.ts with Add-Type and then answers line commands (same pattern as
// foreground.ts). Requests carry an id; input-hook events arrive unsolicited on the same pipe.
// No npm dependencies, no native modules.
//
// Nothing is run from disk: the bootstrap goes in via -EncodedCommand and the C# source as the
// first stdin line, compiled in memory on every start (about a second). A cached script or
// assembly in a user-writable folder could be swapped for one that keeps the input hooks and
// logs keystrokes, so there is none.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UIA_HELPER_CS } from './uia-helper.cs.ts'

export type HelperEvent =
  | { ev: 'md' | 'mu'; x: number; y: number; r: number }
  | { ev: 'kd'; k: 'ret' | 'esc' | 'key' }
  /** Shortcut candidate: virtual key, modifier bits (keys.ts MOD_*), numpad key (1/0). */
  | { ev: 'kd'; k: 'sc'; vk: number; m: number; np: number }
  | { ev: 'wheel' }
  | { ev: 'fg' }
  | { ev: 'ready' }

export interface FgInfo {
  hwnd: number
  pid: number
  /** Process name without .exe */
  process: string
  path: string
  /** FileDescription of the exe, e.g. "Google Chrome" */
  description: string
  title: string
  windowClass: string
  locked: boolean
}

export interface SnapItem {
  depth: number
  key: string
  text: string
  noId: boolean
}

export interface SnapResult {
  title: string
  ms: number
  truncated: boolean
  items: SnapItem[]
}

export interface FocusResult {
  blocked: boolean
  pid: number
  process: string
  role: string
  label: string
  value: string | null
  secure: boolean
}

export interface HitResult {
  own: boolean
  blocked: boolean
  pid: number
  process: string
  description: string | null
}

type Json = Record<string, unknown>

/** How long the helper may take to compile and report ready before it is killed. */
const READY_TIMEOUT_MS = 30_000

/** The PowerShell bootstrap: reads the C# source (base64 UTF-8) from the first stdin line. */
export function bootstrapScript(ownPid: number): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$src = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadLine()))
Add-Type -TypeDefinition $src -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Xaml
[DfA11y]::Run(${Math.trunc(ownPid)})
`
}

export function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Removes the .ps1/.cs/.dll files earlier versions cached in `dir`; they are never loaded now. */
export function removeLegacyFiles(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (/^dayflow-uia-.*\.(ps1|cs|dll|tmp)$/i.test(name)) rmSync(join(dir, name), { force: true })
    }
  } catch {
    /* no folder, or a file in use: nothing to do */
  }
}

export interface UiaHelperOptions {
  /** Folder where earlier versions cached .ps1/.cs/.dll files; cleaned on start. */
  scriptDir?: string
  /** Ready timeout (tests). */
  readyTimeoutMs?: number
  /** Replaces the PowerShell command line (tests). */
  command?: [string, ...string[]]
  /** PID whose windows are never read (Dayflow's main process). */
  ownPid?: number
  onEvent?: (e: HelperEvent) => void
  onExit?: (code: number | null) => void
}

export class UiaHelper {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private waiters = new Map<number, (v: Json | null) => void>()
  private ready: Promise<boolean> | null = null
  private readonly opts: UiaHelperOptions
  private hooksWanted = false
  private blockList = ''

  constructor(opts: UiaHelperOptions = {}) {
    this.opts = opts
  }

  /** PID of the helper process, when running. */
  get pid(): number | null {
    return this.running ? (this.child?.pid ?? null) : null
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed
  }

  /** Starts the helper if needed; resolves false when it could not start. */
  start(): Promise<boolean> {
    if (this.running && this.ready) return this.ready
    if (this.opts.scriptDir) removeLegacyFiles(this.opts.scriptDir)
    const [file, ...args] = this.opts.command ?? [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand(bootstrapScript(this.opts.ownPid ?? process.pid)),
    ]
    const child = spawn(file, args, { windowsHide: true })
    this.child = child
    // A helper that died leaves a broken pipe; the exit handler deals with it.
    child.stdin.on('error', () => {})
    try {
      child.stdin.write(Buffer.from(UIA_HELPER_CS, 'utf8').toString('base64') + '\n')
    } catch {
      /* the exit/error handler below reports it */
    }
    let buffer = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-4000)
    })
    this.ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Never leave a half-started helper behind: kill it and forget it, so the next start()
        // spawns a fresh one. Its exit still reaches onExit, which retries with backoff.
        resolve(false)
        if (this.child === child) {
          this.child = null
          this.ready = null
        }
        console.error('[a11y] helper not ready after', this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS, 'ms; killing it', stderr.trim().slice(-400))
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }, this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS)
      const onLine = (line: string) => {
        let msg: Json
        try {
          msg = JSON.parse(line) as Json
        } catch {
          return
        }
        if (msg.ev === 'ready') {
          clearTimeout(timer)
          resolve(true)
          return
        }
        if (typeof msg.id === 'number') {
          const w = this.waiters.get(msg.id)
          this.waiters.delete(msg.id)
          w?.(msg)
          return
        }
        if (typeof msg.ev === 'string') this.opts.onEvent?.(msg as unknown as HelperEvent)
      }
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line.startsWith('{')) onLine(line)
        }
      })
      const fail = (code: number | null) => {
        clearTimeout(timer)
        resolve(false)
        for (const w of this.waiters.values()) w(null)
        this.waiters.clear()
        if (this.child === child) {
          this.child = null
          this.ready = null
        }
        if (code !== 0 && code !== null && stderr.trim()) console.error('[a11y] helper exited', code, stderr.trim().slice(-800))
        this.opts.onExit?.(code)
      }
      child.on('exit', (code) => fail(code))
      child.on('error', () => fail(-1))
    })
    const ready = this.ready
    void ready.then(async (ok) => {
      if (!ok || this.child !== child) return
      // Restore state after a restart.
      if (this.blockList) await this.send(`block|${this.blockList}`, 2000)
      if (this.hooksWanted) await this.send('hooks|1', 4000)
    })
    return this.ready
  }

  private async send(cmd: string, timeoutMs: number): Promise<Json | null> {
    const child = this.child
    if (!child || !this.ready || !(await this.ready) || this.child !== child) return null
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A late answer is dropped: the id no longer has a waiter.
        this.waiters.delete(id)
        resolve(null)
      }, timeoutMs)
      this.waiters.set(id, (v) => {
        clearTimeout(timer)
        resolve(v)
      })
      try {
        child.stdin.write(`${id}|${cmd.replace(/[\r\n]/g, ' ')}\n`)
      } catch {
        clearTimeout(timer)
        this.waiters.delete(id)
        resolve(null)
      }
    })
  }

  async setHooks(on: boolean): Promise<void> {
    this.hooksWanted = on
    if (!this.running) return
    const r = await this.send(`hooks|${on ? 1 : 0}`, 4000)
    if (on && r && (r.kb !== true || r.mouse !== true)) console.error('[a11y] input hooks not installed, error', r.err)
  }

  /** Process names (no .exe) whose elements are never read. */
  async setBlocked(names: string[]): Promise<void> {
    this.blockList = names
      .map((n) => n.trim().replace(/\.exe$/i, '').replace(/[|,]/g, ''))
      .filter(Boolean)
      .join(',')
    if (!this.running) return
    await this.send(`block|${this.blockList}`, 2000)
  }

  async foreground(): Promise<FgInfo | null> {
    const r = await this.send('fg', 2000)
    if (!r || r.ok !== true) return null
    return {
      hwnd: Number(r.hwnd ?? 0),
      pid: Number(r.pid ?? 0),
      process: String(r.p ?? ''),
      path: String(r.path ?? ''),
      description: String(r.desc ?? ''),
      title: String(r.t ?? ''),
      windowClass: String(r.c ?? ''),
      locked: r.locked === true,
    }
  }

  async snapshot(hwnd: number, webShaped: boolean, rootKey: string, budgetMs = 1500, subtree = false): Promise<SnapResult | null> {
    const key = rootKey.replace(/[|\r\n]/g, '_') || 'app'
    const r = await this.send(`snap|${hwnd}|${webShaped ? 1 : 0}|${key}|${budgetMs}|${subtree ? 1 : 0}`, budgetMs + 3500)
    if (!r || r.ok !== true || !Array.isArray(r.items)) return null
    return {
      title: String(r.title ?? ''),
      ms: Number(r.ms ?? 0),
      truncated: r.trunc === true,
      items: (r.items as unknown[][]).map((a) => ({
        depth: Number(a[0]),
        key: String(a[1]),
        text: String(a[2]),
        noId: a[3] === 1,
      })),
    }
  }

  async focusedField(): Promise<FocusResult | null> {
    const r = await this.send('focus', 2000)
    if (!r || r.ok !== true || r.none === true) return null
    return {
      blocked: r.blocked === true,
      pid: Number(r.pid ?? 0),
      process: String(r.p ?? ''),
      role: String(r.role ?? ''),
      label: String(r.label ?? ''),
      value: typeof r.value === 'string' ? r.value : null,
      secure: r.secure === true,
    }
  }

  async describeElement(x: number, y: number): Promise<HitResult | null> {
    const r = await this.send(`hit|${Math.round(x)}|${Math.round(y)}`, 2000)
    if (!r || r.ok !== true || r.none === true) return null
    return {
      own: r.own === true,
      blocked: r.blocked === true,
      pid: Number(r.pid ?? 0),
      process: String(r.p ?? ''),
      description: typeof r.desc === 'string' ? r.desc : null,
    }
  }

  dispose(): void {
    const child = this.child
    this.child = null
    this.ready = null
    if (!child) return
    try {
      child.stdin.end('0|quit\n')
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 1000).unref()
  }
}
