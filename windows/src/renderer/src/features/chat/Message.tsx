// Transcript pieces: message bubbles (markdown + charts), the work status card and
// follow-up suggestion chips.

import { memo, useMemo, useState } from 'react'
import type { ChatStage, ToolRun } from '../../../../shared/chat-types.ts'
import { ChartView } from './Charts.tsx'
import { splitMessageBlocks } from './charts.ts'
import { Markdown } from './Markdown.tsx'
import { Icon } from './icons.tsx'

export const AssistantContent = memo(function AssistantContent({ text }: { text: string }) {
  const blocks = useMemo(() => splitMessageBlocks(text), [text])
  return (
    <>
      {blocks.map((b, i) => (b.kind === 'text' ? <Markdown key={i} text={b.text} /> : <ChartView key={i} chart={b.chart} />))}
    </>
  )
})

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="cm-row user">
      <div className="cm-bubble user">{text}</div>
    </div>
  )
}

export function AssistantBubble({ text, streaming }: { text: string; streaming?: boolean }) {
  const [rated, setRated] = useState<'up' | 'down' | null>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="cm-row assistant">
      <div className="cm-bubble assistant">
        <AssistantContent text={text} />
      </div>
      {!streaming && (
        <div className="cm-footer">
          <button
            className="cm-foot-btn"
            title="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          <button
            className={`cm-foot-btn${rated === 'up' ? ' on' : ''}`}
            title="Good answer"
            onClick={() => {
              setRated('up')
              setTimeout(() => setRated((r) => (r === 'up' ? null : r)), 1600)
            }}
          >
            <Icon name="thumbUp" />
          </button>
          <button className={`cm-foot-btn${rated === 'down' ? ' on' : ''}`} title="Bad answer" onClick={() => setRated('down')}>
            <Icon name="thumbDown" />
          </button>
          {rated === 'up' && <span className="cm-thanks">Thanks</span>}
          {rated === 'down' && <span className="cm-thanks">Thanks, noted</span>}
        </div>
      )}
    </div>
  )
}

export interface WorkStatus {
  stage: ChatStage
  tools: ToolRun[]
  thinking: string
  error: string | null
}

const STAGE_LABEL: Record<ChatStage, string> = {
  thinking: 'Thinking',
  runningTools: 'Running tools',
  answering: 'Answering',
  error: 'Something went wrong',
}

function clip(s: string, lines: number): string {
  const all = s.split('\n')
  return all.length > lines ? `${all.slice(0, lines).join('\n')}\n…` : s
}

export function WorkStatusCard({ work, active }: { work: WorkStatus; active: boolean }) {
  const [open, setOpen] = useState(false)
  const hasDetails = work.thinking.trim().length > 0 || work.tools.some((t) => t.output)
  return (
    <div className={`cm-work${work.stage === 'error' ? ' error' : ''}`}>
      <div className="cm-work-head">
        <span>
          {STAGE_LABEL[work.stage]}
          {active && work.stage !== 'error' && <span className="cm-dots" />}
        </span>
        {hasDetails && (
          <button className="link-btn" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>
      {work.tools.map((t) => (
        <div key={t.id} className={`cm-tool ${t.state}`}>
          <span className="cm-tool-icon">
            {t.state === 'running' ? <span className="spinner" /> : t.state === 'done' ? <Icon name="check" /> : <Icon name="x" />}
          </span>
          <div className="cm-tool-body">
            <div>{t.summary}</div>
            {open && (
              <>
                <pre className="cm-tool-cmd">{clip(t.command, 3)}</pre>
                {t.output && <pre className="cm-tool-out">{clip(t.output, 6)}</pre>}
              </>
            )}
          </div>
        </div>
      ))}
      {open && work.thinking.trim() && <pre className="cm-thinking">{work.thinking.trim()}</pre>}
      {work.error && <div className="cm-work-error">{work.error}</div>}
    </div>
  )
}

export function Suggestions({ items, onPick }: { items: string[]; onPick: (s: string) => void }) {
  if (!items.length) return null
  return (
    <div className="cm-suggest">
      <div className="cm-suggest-label">Follow up</div>
      <div className="cm-chips">
        {items.map((s, i) => (
          <button key={i} className="cm-chip" onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
