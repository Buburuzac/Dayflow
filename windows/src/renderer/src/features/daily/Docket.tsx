import { useEffect, useState } from 'react'
import {
  DISMISS_REASONS,
  type BriefAction,
  type DailyBrief,
  type DailySettings,
  type DocketItem,
  type HandoffAgent,
  type HandoffMethod,
} from '../../../../shared/daily-types.ts'
import { dailyApi } from './api.ts'
import { docketStatus, itemKey, lastHandoff, STATUS_LABELS } from './brief-view.ts'

const METHOD_LABELS: Record<HandoffMethod, string> = {
  terminal: 'Open in terminal',
  copy: 'Copy prompt',
  run: 'Run in background',
}

export function Docket({
  brief,
  settings,
  act,
  onSettings,
}: {
  brief: DailyBrief
  settings: DailySettings
  act: (a: BriefAction) => Promise<void>
  onSettings: (patch: Partial<DailySettings>) => void
}) {
  const items = brief.content.docket ?? []
  const st = brief.userState
  const [folders, setFolders] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [newTask, setNewTask] = useState('')

  useEffect(() => {
    void dailyApi.recentFolders().then(setFolders)
  }, [brief.day])

  // Background runs finish on their own; poll while any is in progress.
  const anyRunning = items.some((i) => docketStatus(lastHandoff(st, i.title)) === 'inProgress')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => void dailyApi.refreshRuns(brief.day), 15_000)
    return () => clearInterval(t)
  }, [anyRunning, brief.day])

  const open = items.filter((i) => docketStatus(lastHandoff(st, i.title)) === 'new')
  const stack = settings.docketShowsList ? items : open
  const current = stack[Math.min(index, Math.max(0, stack.length - 1))]

  return (
    <div className="dl-docket">
      <div className="dl-docket-bar">
        <label>
          Agent
          <select value={settings.docketAgent} onChange={(e) => onSettings({ docketAgent: e.target.value as HandoffAgent })}>
            <option value="claude">Claude Code</option>
            <option value="chatgpt">Codex (ChatGPT)</option>
          </select>
        </label>
        <label>
          Hand-off
          <select
            value={settings.docketHandoffMethod}
            onChange={(e) => onSettings({ docketHandoffMethod: e.target.value as HandoffMethod })}
          >
            {(Object.keys(METHOD_LABELS) as HandoffMethod[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <div className="dl-seg">
          <button className={!settings.docketShowsList ? 'on' : ''} onClick={() => onSettings({ docketShowsList: false })}>
            Cards
          </button>
          <button className={settings.docketShowsList ? 'on' : ''} onClick={() => onSettings({ docketShowsList: true })}>
            List
          </button>
        </div>
      </div>

      {settings.docketShowsList ? (
        <div className="dl-docket-list">
          {items.map((it) => (
            <DocketCard key={it.title} item={it} brief={brief} settings={settings} folders={folders} act={act} />
          ))}
        </div>
      ) : current ? (
        <div className="dl-stack">
          <DocketCard key={current.title} item={current} brief={brief} settings={settings} folders={folders} act={act} />
          <div className="dl-stack-nav">
            <button className="icon-btn" disabled={index <= 0} onClick={() => setIndex((i) => i - 1)}>
              ‹
            </button>
            <span>
              {Math.min(index, stack.length - 1) + 1} of {stack.length} open
            </span>
            <button className="icon-btn" disabled={index >= stack.length - 1} onClick={() => setIndex((i) => i + 1)}>
              ›
            </button>
          </div>
        </div>
      ) : (
        <div className="dl-empty-small">
          You've handled every task on today's docket.{' '}
          <button className="link-btn" onClick={() => onSettings({ docketShowsList: true })}>
            Show all
          </button>
        </div>
      )}

      <div className="dl-added">
        {st.addedTasks.map((t) => {
          const checked = st.checkedItemKeys.includes(itemKey('docket', t.title))
          return (
            <div key={t.id} className={`dl-added-row ${checked ? 'checked' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => void act({ type: 'toggleCheck', section: 'docket', title: t.title })}
              />
              <span>{t.title}</span>
              <button className="link-btn" onClick={() => void act({ type: 'removeTask', id: t.id })} title="Remove">
                ✕
              </button>
            </div>
          )
        })}
        <form
          className="dl-add-task"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newTask.trim()) return
            void act({ type: 'addTask', title: newTask })
            setNewTask('')
          }}
        >
          <input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="Add your own task…" />
        </form>
      </div>
    </div>
  )
}

function DocketCard({
  item,
  brief,
  settings,
  folders,
  act,
}: {
  item: DocketItem
  brief: DailyBrief
  settings: DailySettings
  folders: string[]
  act: (a: BriefAction) => Promise<void>
}) {
  const st = brief.userState
  const entry = lastHandoff(st, item.title)
  const status = docketStatus(entry)
  const [showPrompt, setShowPrompt] = useState(false)
  const [prompt, setPrompt] = useState(st.promptEdits[item.title] ?? item.prompt ?? '')
  const [askReason, setAskReason] = useState(false)
  const folder = st.folders[item.title] ?? ''
  const edited = st.promptEdits[item.title] !== undefined

  return (
    <article className={`dl-task status-${status}`}>
      <header>
        <h4>{item.title}</h4>
        <span className={`dl-status ${status}`}>{STATUS_LABELS[status]}</span>
      </header>
      {item.detail && <p className="dl-task-detail">{item.detail}</p>}
      <div className="dl-task-meta">
        {item.due && <span className="dl-chip">Due {item.due}</span>}
        {item.agent === false && <span className="dl-chip">Needs you</span>}
        {item.people?.map((p) => (
          <span key={p.name} className="dl-chip" title={p.note}>
            {p.name}
          </span>
        ))}
        {item.links?.map((l) =>
          l.url ? (
            <a key={l.title} className="dl-chip link" href={l.url} target="_blank" rel="noreferrer">
              {l.app ? `${l.app} · ` : ''}
              {l.title}
            </a>
          ) : (
            <span key={l.title} className="dl-chip">
              {l.app ? `${l.app} · ` : ''}
              {l.title}
            </span>
          ),
        )}
      </div>
      {(item.feedbackSummary || item.feedback?.length) && (
        <div className="dl-feedback">
          {item.feedbackSummary ? (
            <p>
              {item.feedbackSummary}{' '}
              {item.feedbackUrl && (
                <a href={item.feedbackUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              )}
            </p>
          ) : (
            item.feedback?.map((f, i) => (
              <blockquote key={i}>
                “{f.text}” <cite>— {f.name}{f.source ? `, ${f.source}` : ''}</cite>{' '}
                {f.url && (
                  <a href={f.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                )}
              </blockquote>
            ))
          )}
        </div>
      )}

      <button
        className="link-btn"
        onClick={() => {
          setShowPrompt((s) => !s)
          if (!showPrompt) void dailyApi.feedback(brief.day, 'docket', item.title, 'expanded')
        }}
      >
        {showPrompt ? 'Hide prompt' : `Show prompt${edited ? ' (edited)' : ''}`}
      </button>
      {showPrompt && (
        <textarea
          className="dl-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => void act({ type: 'setPromptEdit', title: item.title, prompt })}
        />
      )}

      <div className="dl-task-actions">
        {status === 'dismissed' ? (
          <>
            <button className="btn ghost" onClick={() => void act({ type: 'undoDismissDocket', title: item.title })}>
              Undo dismiss
            </button>
            {entry && (
              <select
                value={entry.reason ?? ''}
                onChange={(e) => void act({ type: 'setDismissReason', title: item.title, reason: e.target.value })}
              >
                <option value="">Why? (optional)</option>
                {DISMISS_REASONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            )}
          </>
        ) : (
          <>
            <select
              className="dl-folder"
              value={folder}
              title="Folder the agent works in"
              onChange={async (e) => {
                const v = e.target.value
                if (v === '__pick') {
                  const picked = await dailyApi.pickFolder()
                  if (picked) await act({ type: 'setFolder', title: item.title, folder: picked })
                } else await act({ type: 'setFolder', title: item.title, folder: v })
              }}
            >
              <option value="">No folder</option>
              {[...new Set([folder, ...folders].filter(Boolean))].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
              <option value="__pick">Choose a folder…</option>
            </select>
            <button
              className="btn"
              onClick={async () => {
                if (showPrompt) await act({ type: 'setPromptEdit', title: item.title, prompt })
                await act({ type: 'handoff', title: item.title, agent: settings.docketAgent, method: settings.docketHandoffMethod })
              }}
            >
              {METHOD_LABELS[settings.docketHandoffMethod]}
            </button>
            {entry?.method === 'run' && entry.outputFile && (status === 'ready' || status === 'failed') && (
              <button className="btn ghost" onClick={() => void act({ type: 'openResult', title: item.title })}>
                Open result
              </button>
            )}
            <button
              className="btn ghost"
              onClick={() => {
                setAskReason(true)
                void act({ type: 'dismissDocket', title: item.title })
              }}
            >
              Dismiss
            </button>
          </>
        )}
      </div>
      {askReason && status === 'dismissed' && !entry?.reason && (
        <div className="dl-reasons">
          {DISMISS_REASONS.map((r) => (
            <button
              key={r}
              className="dl-chip"
              onClick={() => {
                setAskReason(false)
                void act({ type: 'setDismissReason', title: item.title, reason: r })
              }}
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}
