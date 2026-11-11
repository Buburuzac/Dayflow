// Side panels: conversation history, memory editor and debug log.

import { useState } from 'react'
import type { ChatDebugKind, ChatMemory, ConversationSummary } from '../../../../shared/chat-types.ts'
import type { ProviderId } from '../../../../shared/types.ts'
import { Icon } from './icons.tsx'

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: 'Gemini',
  openai_compatible: 'Local model',
  claude_cli: 'Claude',
  codex_cli: 'Codex',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export type HistoryGroup = 'TODAY' | 'YESTERDAY' | 'THIS WEEK' | 'EARLIER'

export function historyGroup(updatedAtSec: number, now = new Date()): HistoryGroup {
  const t = updatedAtSec * 1000
  const today = startOfDay(now)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  if (t >= today) return 'TODAY'
  if (t >= yesterday) return 'YESTERDAY'
  if (now.getTime() - t < 7 * 86400_000) return 'THIS WEEK'
  return 'EARLIER'
}

function rowTime(updatedAtSec: number, group: HistoryGroup): string {
  const d = new Date(updatedAtSec * 1000)
  if (group === 'TODAY' || group === 'YESTERDAY') return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export function HistoryPanel(props: {
  conversations: ConversationSummary[]
  currentId: string | null
  disabled: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
}) {
  const groups: HistoryGroup[] = ['TODAY', 'YESTERDAY', 'THIS WEEK', 'EARLIER']
  const byGroup = new Map<HistoryGroup, ConversationSummary[]>()
  for (const c of props.conversations) {
    const g = historyGroup(c.updatedAt)
    byGroup.set(g, [...(byGroup.get(g) ?? []), c])
  }
  return (
    <aside className="cp-panel">
      <div className="cp-head">
        <h3>History</h3>
        <button className="btn ghost small" onClick={props.onNew} disabled={props.disabled}>
          New chat
        </button>
      </div>
      <div className="cp-scroll">
        {props.conversations.length === 0 && <div className="cp-empty">No saved chats yet</div>}
        {groups.map((g) => {
          const items = byGroup.get(g)
          if (!items?.length) return null
          return (
            <div key={g} className="cp-group">
              <div className="cp-group-title">{g}</div>
              {items.map((c) => (
                <div
                  key={c.id}
                  className={`cp-conv${c.id === props.currentId ? ' current' : ''}${props.disabled ? ' disabled' : ''}`}
                  onClick={() => !props.disabled && c.id !== props.currentId && props.onSelect(c.id)}
                >
                  <div className="cp-conv-text">
                    <div className="cp-conv-title">{c.title}</div>
                    <div className="cp-conv-sub">
                      {rowTime(c.updatedAt, g)} · {PROVIDER_LABEL[c.provider]}
                    </div>
                  </div>
                  <button
                    className="cp-trash"
                    title="Delete conversation"
                    disabled={props.disabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onDelete(c.id)
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function fmtUpdated(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

export function MemoryPanel(props: {
  stored: ChatMemory
  draft: string
  onDraft: (s: string) => void
  onSave: () => void
  onReload: () => void
  onClear: () => void
}) {
  return (
    <aside className="cp-panel">
      <div className="cp-head">
        <h3>Memory</h3>
        <span className="muted small">{props.draft.length}/10000</span>
      </div>
      <p className="cp-caption">Auto-updated from assistant replies. You can edit this manually.</p>
      <textarea className="cp-memory" value={props.draft} maxLength={10000} onChange={(e) => props.onDraft(e.target.value)} />
      <div className="cp-caption">
        {props.stored.updatedAt ? `Last updated: ${fmtUpdated(props.stored.updatedAt)}` : 'Not saved yet'}
      </div>
      <div className="cp-actions">
        <button className="btn small" onClick={props.onSave} disabled={props.draft.trim() === props.stored.text}>
          Save
        </button>
        <button className="btn ghost small" onClick={props.onReload}>
          Reload
        </button>
        <button className="btn ghost small" onClick={props.onClear}>
          Clear
        </button>
      </div>
    </aside>
  )
}

export interface DebugEntry {
  at: number
  kind: ChatDebugKind
  content: string
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function formatDebug(e: DebugEntry): string {
  return `[${stamp(e.at)}] ${e.kind}\n${e.content}`
}

export function DebugPanel({ entries, onClear }: { entries: DebugEntry[]; onClear: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <aside className="cp-panel wide">
      <div className="cp-head">
        <h3>Debug Log</h3>
        <div className="cp-actions">
          <button
            className="btn ghost small"
            onClick={() => {
              void navigator.clipboard.writeText(entries.map(formatDebug).join('\n\n---\n\n'))
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? 'Copied' : 'Copy all'}
          </button>
          <button className="btn ghost small" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>
      <div className="cp-scroll">
        {entries.length === 0 && <div className="cp-empty">No entries</div>}
        {entries.map((e, i) => (
          <pre key={i} className={`cp-debug ${e.kind.replace(/\s/g, '-').toLowerCase()}`}>
            {formatDebug(e)}
          </pre>
        ))}
      </div>
    </aside>
  )
}
