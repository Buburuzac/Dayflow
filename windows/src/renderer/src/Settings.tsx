import { useState } from 'react'
import type { AppStatus, Category, ProviderId, SecretsUpdate, Settings, SettingsWithSecrets } from '../../shared/types.ts'
import { fmtBytes } from './dates.ts'
import { SyncSettingsPanel } from './features/Sync.tsx'
import { toggleExcluded, withRenamedExclusions } from '../../shared/sync-categories.ts'

export const PROVIDERS: { id: ProviderId; name: string; blurb: string }[] = [
  { id: 'gemini', name: 'Gemini', blurb: 'Google Gemini with your own API key. Best quality per cost; data goes to Google.' },
  {
    id: 'openai_compatible',
    name: 'Local (Ollama / LM Studio)',
    blurb: 'Runs on your machine through an OpenAI-compatible server. Fully private; needs a vision model.',
  },
  { id: 'claude_cli', name: 'Claude Code CLI', blurb: 'Uses your logged-in `claude` CLI and its subscription.' },
  { id: 'codex_cli', name: 'ChatGPT (Codex CLI)', blurb: 'Uses your logged-in `codex` CLI and its subscription.' },
]

/** Strips Electron's "Error invoking remote method '…': Error:" prefix from IPC errors. */
export function ipcErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

export function ProviderForm({
  settings,
  onSettings,
}: {
  settings: SettingsWithSecrets
  onSettings: (s: SettingsWithSecrets) => void
}) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [secrets, setSecrets] = useState<SecretsUpdate>({})
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const save = async () => {
    let saved: SettingsWithSecrets
    try {
      saved = await window.dayflow.saveSettings(
      {
        provider: draft.provider,
        geminiModel: draft.geminiModel,
        openaiBaseUrl: draft.openaiBaseUrl,
        openaiModel: draft.openaiModel,
        cliModel: draft.cliModel,
        claudeCommand: draft.claudeCommand,
        codexCommand: draft.codexCommand,
        outputLanguage: draft.outputLanguage,
      },
      secrets,
    )
    } catch (err) {
      setTest({ ok: false, message: ipcErrorMessage(err) })
      return null
    }
    setSecrets({})
    onSettings(saved)
    return saved
  }

  const runTest = async () => {
    setBusy(true)
    setTest(null)
    try {
      if (!(await save())) return
      setTest(await window.dayflow.testProvider())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form">
      <div className="provider-grid">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={`provider ${draft.provider === p.id ? 'active' : ''}`}
            onClick={() => set('provider', p.id)}
          >
            <b>{p.name}</b>
            <span>{p.blurb}</span>
          </button>
        ))}
      </div>

      {draft.provider === 'gemini' && (
        <>
          <label>
            API key {settings.hasGeminiKey && <em>(saved — leave empty to keep)</em>}
            <input
              type="password"
              placeholder={settings.hasGeminiKey ? '••••••••' : 'AIza…'}
              value={secrets.geminiApiKey ?? ''}
              onChange={(e) => setSecrets((s) => ({ ...s, geminiApiKey: e.target.value }))}
            />
            <small>
              Get a free key at{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                aistudio.google.com/apikey
              </a>
              . Stored encrypted with Windows DPAPI.
            </small>
          </label>
          <label>
            Model
            <input value={draft.geminiModel} onChange={(e) => set('geminiModel', e.target.value)} />
          </label>
        </>
      )}

      {draft.provider === 'openai_compatible' && (
        <>
          <label>
            Server URL
            <input value={draft.openaiBaseUrl} onChange={(e) => set('openaiBaseUrl', e.target.value)} />
            <small>Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1</small>
          </label>
          <label>
            Vision model
            <input value={draft.openaiModel} onChange={(e) => set('openaiModel', e.target.value)} />
            <small>e.g. qwen2.5vl:7b, gemma3:12b, llava. The model must accept images.</small>
          </label>
          <label>
            API key (optional) {settings.hasOpenaiKey && <em>(saved)</em>}
            <input
              type="password"
              value={secrets.openaiApiKey ?? ''}
              onChange={(e) => setSecrets((s) => ({ ...s, openaiApiKey: e.target.value }))}
            />
          </label>
        </>
      )}

      {(draft.provider === 'claude_cli' || draft.provider === 'codex_cli') && (
        <>
          <label>
            Command
            <input
              value={draft.provider === 'claude_cli' ? draft.claudeCommand : draft.codexCommand}
              onChange={(e) => set(draft.provider === 'claude_cli' ? 'claudeCommand' : 'codexCommand', e.target.value)}
            />
            <small>
              Name on PATH or full path. Install with{' '}
              <code>{draft.provider === 'claude_cli' ? 'npm i -g @anthropic-ai/claude-code' : 'npm i -g @openai/codex'}</code>{' '}
              and sign in once in a terminal.
            </small>
          </label>
          <label>
            Model (optional)
            <input
              value={draft.cliModel}
              placeholder={draft.provider === 'claude_cli' ? 'sonnet' : 'default'}
              onChange={(e) => set('cliModel', e.target.value)}
            />
          </label>
        </>
      )}

      <label>
        Output language
        <input
          value={draft.outputLanguage}
          placeholder="English"
          onChange={(e) => set('outputLanguage', e.target.value)}
        />
        <small>Cards are written in this language, e.g. "Russian" or "Polish".</small>
      </label>

      <div className="row">
        <button className="btn" onClick={() => void save()}>
          Save
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void runTest()}>
          {busy ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {test && <div className={test.ok ? 'notice ok' : 'notice err'}>{test.message}</div>}
    </div>
  )
}

export function SettingsView({
  settings,
  onSettings,
  status,
}: {
  settings: SettingsWithSecrets
  onSettings: (s: SettingsWithSecrets) => void
  status: AppStatus | null
}) {
  const update = async (patch: Partial<Settings>) => {
    try {
      onSettings(await window.dayflow.saveSettings(patch))
    } catch (err) {
      alert(ipcErrorMessage(err))
    }
  }

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="panel">
        <h2>AI provider</h2>
        <ProviderForm settings={settings} onSettings={onSettings} />
      </section>

      <section className="panel">
        <h2>Recording</h2>
        <div className="form">
          <label>
            Screenshot every
            <select
              value={settings.captureIntervalSeconds}
              onChange={(e) => void update({ captureIntervalSeconds: Number(e.target.value) })}
            >
              {[5, 10, 20, 30, 60].map((s) => (
                <option key={s} value={s}>
                  {s >= 60 ? `${s / 60} min` : `${s} sec`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Resolution
            <select value={settings.captureHeight} onChange={(e) => void update({ captureHeight: Number(e.target.value) })}>
              <option value={720}>720p</option>
              <option value={1080}>1080p</option>
            </select>
          </label>
          <label>
            Never capture these apps
            <input
              defaultValue={settings.excludedApps.join(', ')}
              placeholder="KeePassXC, 1Password"
              onBlur={(e) =>
                void update({
                  excludedApps: e.target.value
                    .split(',')
                    .map((s) => s.trim().replace(/\.exe$/i, ''))
                    .filter(Boolean),
                })
              }
            />
            <small>Process names, comma-separated. No frame is saved while one of them is in the foreground.</small>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!settings.accessibilityCaptureEnabled}
              onChange={(e) => void update({ accessibilityCaptureEnabled: e.target.checked })}
            />
            Record on-screen text, clicks and typing (accessibility log)
          </label>
          <small className="muted">
            Experimental, used with Claude and ChatGPT (Codex). Stays on this PC; password fields and the apps above are
            never read; kept at most 7 days.
          </small>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(e) => void update({ launchAtLogin: e.target.checked })}
            />
            Start Dayflow when I sign in to Windows
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Storage</h2>
        <div className="form">
          <p className="muted">Screenshots currently use {status ? fmtBytes(status.storageBytes) : '…'}.</p>
          <label>
            Disk limit
            <select value={settings.storageLimitGB} onChange={(e) => void update({ storageLimitGB: Number(e.target.value) })}>
              {[1, 2, 5, 10, 20, 50].map((g) => (
                <option key={g} value={g}>
                  {g} GB
                </option>
              ))}
            </select>
          </label>
          <label>
            Keep screenshots for
            <select value={settings.retentionDays} onChange={(e) => void update({ retentionDays: Number(e.target.value) })}>
              {[1, 3, 7, 14, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d} day{d > 1 ? 's' : ''}
                </option>
              ))}
            </select>
            <small>Timeline cards are kept; only the raw screenshots are deleted.</small>
          </label>
          <div className="row">
            <button className="btn ghost" onClick={() => void window.dayflow.openDataFolder()}>
              Open data folder
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Sync & team</h2>
        <SyncSettingsPanel />
        <SyncPrivacy settings={settings} onSave={(patch) => void update(patch)} />
      </section>

      <section className="panel">
        <h2>Categories</h2>
        <CategoryEditor
          categories={settings.categories}
          onSave={(categories, renames) => {
            // A renamed category keeps its "never upload" mark (Settings → Sync & team): the new name
            // is added and the old one kept, since existing cards still carry the old name.
            const excluded = withRenamedExclusions(
              settings.syncExcludedCategories ?? ['Personal'],
              [...renames.entries()],
              categories.map((c) => c.name),
            )
            void update({ categories, syncExcludedCategories: excluded })
          }}
        />
      </section>
    </div>
  )
}

function CategoryEditor({
  categories,
  onSave,
}: {
  categories: Category[]
  /** `renames` maps old names to new names for categories renamed in this edit. */
  onSave: (c: Category[], renames: Map<string, string>) => void
}) {
  const [list, setList] = useState(categories)
  // Original name of each row (null for rows added here), kept index-aligned with `list`.
  const [origins, setOrigins] = useState<(string | null)[]>(() => categories.map((c) => c.name))
  const dirty = JSON.stringify(list) !== JSON.stringify(categories)
  const save = () => {
    const renames = new Map<string, string>()
    list.forEach((c, i) => {
      const o = origins[i]
      if (o && o !== c.name) renames.set(o, c.name)
    })
    onSave(list, renames)
    setOrigins(list.map((c) => c.name))
  }
  const patch = (i: number, p: Partial<Category>) => setList((l) => l.map((c, j) => (j === i ? { ...c, ...p } : c)))
  return (
    <div className="form">
      <p className="muted">The AI picks one of these for every card. Descriptions help it choose.</p>
      {list.map((c, i) => (
        <div key={i} className="cat-row">
          <input type="color" value={c.color} onChange={(e) => patch(i, { color: e.target.value })} />
          <input className="cat-name" value={c.name} disabled={c.isIdle} onChange={(e) => patch(i, { name: e.target.value })} />
          <input
            className="cat-desc"
            value={c.description}
            placeholder="What belongs here?"
            onChange={(e) => patch(i, { description: e.target.value })}
          />
          {!c.isIdle && (
            <button
              className="icon-btn small"
              title="Remove"
              onClick={() => {
                setList((l) => l.filter((_, j) => j !== i))
                setOrigins((o) => o.filter((_, j) => j !== i))
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="row">
        <button
          className="btn ghost"
          onClick={() => {
            const idleIdx = list.findIndex((c) => c.isIdle)
            const at = idleIdx >= 0 ? idleIdx : list.length
            const next = [...list]
            next.splice(at, 0, { name: 'New category', color: '#7BC47F', description: '' })
            const nextOrigins = [...origins]
            nextOrigins.splice(at, 0, null)
            setList(next)
            setOrigins(nextOrigins)
          }}
        >
          Add category
        </button>
        <button className="btn" disabled={!dirty || list.some((c) => !c.name.trim())} onClick={save}>
          Save categories
        </button>
      </div>
    </div>
  )
}

/** Settings → Sync & team → what may leave this PC. Filtering happens here, before upload. */
function SyncPrivacy({ settings, onSave }: { settings: SettingsWithSecrets; onSave: (p: Partial<Settings>) => void }) {
  const list = settings.syncExcludedCategories ?? ['Personal']
  const excluded = new Set(list.map((c) => c.toLowerCase()))
  // Only current categories are shown; names of renamed categories stay in the list (old cards keep them).
  const toggleCategory = (name: string, on: boolean) => onSave({ syncExcludedCategories: toggleExcluded(list, name, on, settings.categories.map((c) => c.name)) })
  return (
    <div className="form sync-privacy">
      <h3 className="sub">What leaves this PC</h3>
      <p className="muted">
        Checked before anything is uploaded. Screenshots, timelapses, the accessibility log and chat never leave this PC.
      </p>
      <label>Never upload cards in these categories</label>
      <div className="row wrap">
        {settings.categories
          .filter((c) => !c.isIdle)
          .map((c) => (
            <label key={c.name} className="check">
              <input type="checkbox" checked={excluded.has(c.name.toLowerCase())} onChange={(e) => toggleCategory(c.name, e.target.checked)} />
              {c.name}
            </label>
          ))}
      </div>
      <small>Cards marked private are never uploaded either. Copies already on the server are wiped.</small>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.syncOutOfScope ?? true}
          onChange={(e) => onSave({ syncOutOfScope: e.target.checked })}
        />
        Upload work without a confirmed project as "Out of scope" (time only)
      </label>
      <small>
        Only cards confirmed for a project upload with their title and details. Everything else shows on your other
        devices and the server as an "Out of scope" block, without what it was. Workspace admins see your timeline:
        project work at the level you share, everything else as time only. Your Account page in the web dashboard
        lists who opened it.
      </small>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.syncObservations ?? false}
          onChange={(e) => onSave({ syncObservations: e.target.checked })}
        />
        Upload observations (the AI's raw screen descriptions)
      </label>
      <small>Off by default. Turning it off removes the ones already uploaded from the server.</small>
    </div>
  )
}
