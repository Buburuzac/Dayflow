import { useState } from 'react'
import type { TimelineCard } from '../../../shared/types.ts'
import { ipcErrorMessage } from '../Settings.tsx'
import { useProjects, useSyncStatus } from './Sync.tsx'
import './sync.css'

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)

/** Project chips inside a timeline card; an unconfirmed (AI) guess can be confirmed with a click. */
export function CardProjectChips({ card }: { card: TimelineCard }) {
  const list = card.projects ?? []
  if (!list.length) return null
  return (
    <span className="card-projects">
      {list.map((p) => (
        <span
          key={p.projectId}
          className={`proj-chip ${p.confirmed ? '' : 'unconfirmed'}`}
          style={{ ['--proj' as string]: p.color }}
          title={
            p.confirmed
              ? `${p.name}${p.share < 1 ? ` · ${Math.round(p.share * 100)}%` : ''} (${p.source})`
              : `Suggested by the AI (${Math.round(p.confidence * 100)}% sure). Click to confirm; open the card to change.`
          }
          onClick={(e) => {
            if (p.confirmed) return
            e.stopPropagation()
            void call('projects:confirmCard', card.id, p.projectId)
          }}
        >
          {p.name}
          {!p.confirmed && <b> ?</b>}
        </span>
      ))}
    </span>
  )
}

/** One unobtrusive project icon; the full time split is visible on hover. */
export function ProjectCluster({ card, onOpen }: { card: TimelineCard; onOpen: () => void }) {
  const list = card.projects ?? []
  if (!list.length) return null
  const title = list.map((p) => `${p.name}: ${Math.round(p.share * 100)}%${p.confirmed ? '' : ' · suggested'}`).join('\n')
  return <span className="project-cluster" role="button" tabIndex={0} aria-label={`Projects: ${title}`} title={title} onClick={(e) => { e.stopPropagation(); onOpen() }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
    <span className="project-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1.5 3.5h5l1.5 2h6.5v7h-13z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span>
  </span>
}

/** Card detail: project picker, confirm suggestions, private toggle. */
export function CardSyncSection({ card }: { card: TimelineCard }) {
  const projects = useProjects()
  const [status] = useSyncStatus()
  const [error, setError] = useState<string | null>(null)
  const assigned = card.projects ?? []
  const run = (p: Promise<unknown>) => p.catch((err: unknown) => setError(ipcErrorMessage(err)))
  const active = projects.filter((p) => !p.archived)
  const current = assigned.length === 1 ? assigned[0].projectId : ''

  return (
    <section className="card-sync">
      {(active.length > 0 || assigned.length > 0) && (
        <>
          <h3>Project</h3>
          {assigned.some((a) => !a.confirmed) && (
            <div className="notice warn small">
              {assigned
                .filter((a) => !a.confirmed)
                .map((a) => (
                  <div key={a.projectId} className="row">
                    <span>
                      Looks like <b>{a.name}</b> ({Math.round(a.confidence * 100)}% sure).
                    </span>
                    <button className="link-btn" onClick={() => void run(call('projects:confirmCard', card.id, a.projectId))}>
                      Confirm
                    </button>
                  </div>
                ))}
            </div>
          )}
          {assigned.length > 1 && (
            <div className="chips">
              {assigned.map((a) => (
                <span key={a.projectId} className="proj-chip" style={{ ['--proj' as string]: a.color }}>
                  {a.name} · {Math.round(a.share * 100)}%
                </span>
              ))}
            </div>
          )}
          <select
            className="project-picker"
            value={current}
            onChange={(e) => void run(call('projects:assignCard', card.id, e.target.value || null))}
          >
            <option value="">{assigned.length > 1 ? 'Split between projects — pick one to replace' : 'No project'}</option>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {assigned.length > 0 && (
            <small className="muted">
              {assigned.every((a) => a.source === 'manual')
                ? 'Chosen by you.'
                : assigned.some((a) => a.source === 'rule')
                  ? 'Matched by project rules.'
                  : 'Suggested by the AI.'}
            </small>
          )}
        </>
      )}
      {status?.signedIn && (
        <label className="check private-toggle">
          <input type="checkbox" checked={!!card.private} onChange={(e) => void run(call('sync:setCardPrivate', card.id, e.target.checked))} />
          Private — never leaves this PC (not synced to my other devices or the team)
        </label>
      )}
      {error && <div className="notice err">{error}</div>}
    </section>
  )
}
