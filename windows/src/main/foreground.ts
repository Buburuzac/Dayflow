// Windows helper process. One long-lived PowerShell process answers line commands with one
// JSON line each:
//   "fg"                      → {"p":"chrome","t":"Inbox - Gmail","locked":false}
//   "cap|<path>|<h>|<q>|<x>|<y>" → {"ok":true,"w":1920,"h":1080} — GDI capture of the screen containing
//                               point (x, y), scaled to height h, saved as JPEG quality q
// It is the Windows stand-in for the macOS app's active-app tracking, and a fallback for
// screen capture when Chromium's desktopCapturer returns an empty image.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DfWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DfWin]::SetProcessDPIAware()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Node writes UTF-8; without this, non-ASCII paths (e.g. a Cyrillic user name) arrive garbled.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    if ($line -eq 'fg') {
      $h = [DfWin]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][DfWin]::GetWindowText($h, $sb, 512)
      $procId = [uint32]0
      [void][DfWin]::GetWindowThreadProcessId($h, [ref]$procId)
      $name = ''
      try { $name = (Get-Process -Id $procId).ProcessName } catch {}
      $sid = (Get-Process -Id $PID).SessionId
      # No foreground window at all means this session's desktop is unavailable (locked, or a
      # disconnected remote session): capture would fail, so report it like a lock.
      $locked = ($h -eq [IntPtr]::Zero) -or ($null -ne (Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sid }))
      Out-Json @{ p = $name; t = $sb.ToString(); locked = $locked }
    } elseif ($line.StartsWith('cap|')) {
      $a = $line.Split('|')
      $path = $a[1]; $targetH = [int]$a[2]; $q = [long]$a[3]
      $pt = New-Object System.Drawing.Point ([int]$a[4]), ([int]$a[5])
      $b = [System.Windows.Forms.Screen]::FromPoint($pt).Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try { $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size) } finally { $g.Dispose() }
      $h2 = [Math]::Min($targetH, $b.Height); $w2 = [int][Math]::Round($b.Width * $h2 / $b.Height)
      $out = New-Object System.Drawing.Bitmap $w2, $h2
      $g2 = [System.Drawing.Graphics]::FromImage($out)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, $w2, $h2); $g2.Dispose(); $bmp.Dispose()
      $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $q
      $out.Save($path, $jpeg, $ep); $out.Dispose()
      Out-Json @{ ok = $true; w = $w2; h = $h2 }
    } else {
      Out-Json @{ ok = $false; err = 'unknown command' }
    }
  } catch {
    Out-Json @{ ok = $false; err = $_.Exception.Message }
  }
}
`

export interface ForegroundInfo {
  process: string
  title: string
  locked: boolean
}

type Waiter = (v: Record<string, unknown> | null) => void

export class ForegroundProbe {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private waiters: Waiter[] = []

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
    )
    // A dead helper must not turn a pending write into an uncaught EPIPE.
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (!line.startsWith('{')) continue
        const waiter = this.waiters.shift()
        try {
          waiter?.(JSON.parse(line) as Record<string, unknown>)
        } catch {
          waiter?.(null)
        }
      }
    })
    const fail = () => {
      for (const w of this.waiters.splice(0)) w(null)
      this.child = null
    }
    child.on('exit', fail)
    child.on('error', fail)
    this.child = child
    return child
  }

  private send(cmd: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let done = false
      const finish = (v: Record<string, unknown> | null) => {
        if (done) return
        done = true
        resolve(v)
      }
      const waiter: Waiter = (v) => {
        clearTimeout(timer)
        finish(v)
      }
      const timer = setTimeout(() => {
        // Keep a placeholder so a late answer is not handed to the next command.
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters[i] = () => {}
        finish(null)
      }, timeoutMs)
      this.waiters.push(waiter)
      try {
        this.ensure().stdin.write(cmd + '\n')
      } catch {
        clearTimeout(timer)
        finish(null)
      }
    })
  }

  /** Resolves within 3 s (first call may take longer while PowerShell starts); null when unavailable. */
  async query(): Promise<ForegroundInfo | null> {
    const r = await this.send('fg', this.child ? 3000 : 15000)
    if (!r) return null
    return { process: String(r.p ?? ''), title: String(r.t ?? ''), locked: r.locked === true }
  }

  /** GDI capture fallback. Throws with the helper's error message on failure. */
  async capture(path: string, height: number, quality: number, x: number, y: number): Promise<void> {
    if (path.includes('|')) throw new Error('Invalid capture path')
    const r = await this.send(`cap|${path}|${height}|${quality}|${Math.round(x)}|${Math.round(y)}`, 15000)
    if (!r) throw new Error('Capture helper did not respond')
    if (r.ok !== true) throw new Error(`GDI capture failed: ${String(r.err ?? 'unknown error')}`)
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
  }
}
