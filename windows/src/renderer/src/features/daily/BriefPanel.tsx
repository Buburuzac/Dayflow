import { useCallback, useEffect, useState } from 'react'
import type {
  BriefAction,
  BriefPart,
  BriefSectionKey,
  BriefViewState,
  CompletedDayGroup,
  DailyBrief,
  DailyBriefRangeSummary,
  DailySettings,
  SummaryRange,
} from '../../../../shared/daily-types.ts'
import { dailyApi, errorText } from './api.ts'
import { hostOf, itemKey, longDate, orderedKinds, SECTION_TITLES } from './brief-view.ts'
import { Docket } from './Docket.tsx'

export function BriefPanel({
  settings,
  onSettings,
}: {
  settings: DailySettings
  onSettings: (patch: Partial<DailySettings>) => void
}) {
  const [state, setState] = useState<BriefViewState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [view, setView] = useState<'brief' | 'completed'>('brief')

  useEffect(() => {
    void dailyApi.brief().then(setState)
    return window.dayflow.on('daily:brief-state', (s) => setState(s as BriefViewState))
  }, [])

  const brief = state?.brief ?? null
  useEffect(() => {
    if (!brief) return
    void dailyApi.briefShown(brief.day)
    return () => void dailyApi.briefShown(null)
  }, [brief?.day])

  const act = useCallback(
    async (a: BriefAction) => {
      if (!brief) return
      const r = await dailyApi.briefAction(brief.day, a)
      if (r.brief) setState((s) => (s ? { ...s, brief: r.brief } : s))
      if (r.message) {
        setMessage(r.message)
        setTimeout(() => setMessage(null), 4000)
      }
    },
    [brief?.day],
  )

  if (!state) return null

  if (!state.enabled) {
    return (
      <section className="dl-card dl-brief-off">
        <h2 className="serif">Daily Brief</h2>
        <p>
          A morning page built from yesterday's timeline: a docket of tasks an AI agent can take off your plate, what you
          completed, things to keep tracking and, with Claude Code, related reading and news.
        </p>
        <p className="dl-sub">
          Runs with {state.engineLabel}. {state.engine === 'connectors'
            ? 'Two Claude runs of up to 20 minutes each, once a day; your connectors are used read-only.'
            : 'Switch the AI provider to Claude Code in Settings to let the brief use the web and your connectors.'}
        </p>
        <button className="btn" onClick={() => onSettings({ briefEnabled: true })}>
          Turn on Daily Brief
        </button>
      </section>
    )
  }

  const running = state.run.kind === 'running'
  const isToday = brief?.day === state.today

  if (view === 'completed') return <CompletedView onBack={() => setView('brief')} />

  return (
    <section className="dl-brief">
      <header className="dl-daybreak">
        <div>
          <div className="dl-eyebrow">Daybreak</div>
          <h2 className="serif">{brief ? longDate(brief.day) : longDate(state.today)}</h2>
          {brief && !isToday && <div className="dl-sub">This is your latest brief; today's isn't ready yet.</div>}
        </div>
        <div className="dl-actions">
          <button className="btn ghost" onClick={() => setView('completed')}>
            Everything you completed
          </button>
          {running ? (
            <button className="btn ghost" onClick={() => void dailyApi.cancelBrief()}>
              Stop
            </button>
          ) : (
            <button className="btn ghost" onClick={() => void dailyApi.generateBrief().then(setState)}>
              {brief && isToday ? 'Regenerate' : 'Generate now'}
            </button>
          )}
        </div>
      </header>

      {running && (
        <div className="dl-running">
          Writing your brief<span className="dl-dots" /> <span className="dl-sub">This can take several minutes.</span>
        </div>
      )}
      {state.run.kind === 'failed' && (
        <div className="notice err dl-notice">
          {state.run.message}{' '}
          <button className="link-btn" onClick={() => void dailyApi.generateBrief().then(setState)}>
            Retry
          </button>
        </div>
      )}
      {message && <div className="notice ok dl-notice">{message}</div>}

      {brief ? (
        <BriefSections brief={brief} settings={settings} act={act} onSettings={onSettings} />
      ) : (
        !running && (
          <div className="dl-empty-small">
            No brief yet. It's written automatically each morning once yesterday has at least an hour of activity.
          </div>
        )
      )}

      <BriefFooter state={state} settings={settings} onSettings={onSettings} />
    </section>
  )
}

function BriefSections({
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
  const kinds = orderedKinds(brief.content)
  if (kinds.length === 0) return <div className="dl-empty-small">A quiet day: nothing cleared the bar for today's brief.</div>
  const st = brief.userState
  const visible = (section: BriefSectionKey, title: string) => !st.dismissedItemKeys.includes(itemKey(section, title))
  const Controls = ({ section, title }: { section: BriefSectionKey; title: string }) => {
    const checked = st.checkedItemKeys.includes(itemKey(section, title))
    return (
      <span className="dl-item-ctl">
        <button className={`dl-check ${checked ? 'on' : ''}`} title="Mark as useful" onClick={() => void act({ type: 'toggleCheck', section, title })}>
          ✓
        </button>
        <button className="dl-x" title="Not useful" onClick={() => void act({ type: 'dismissItem', section, title })}>
          ✕
        </button>
      </span>
    )
  }
  const opened = (section: BriefSectionKey, title: string) => void dailyApi.feedback(brief.day, section, title, 'opened')
  const c = brief.content

  return (
    <div className="dl-sections">
      {kinds.map((k) => (
        <div key={k} className={`dl-bsec dl-bsec-${k}`}>
          <h3 className="dl-bsec-title">{SECTION_TITLES[k]}</h3>
          {k === 'docket' && <Docket brief={brief} settings={settings} act={act} onSettings={onSettings} />}
          {k === 'keep_tracking' &&
            c.keep_tracking!.filter((i) => visible(k, i.label)).map((i) => (
              <div key={i.label} className="dl-row">
                <div className="dl-row-main">
                  <b>{i.label}</b>
                  <div>{i.status}</div>
                  <div className="dl-sub">
                    {[i.app, i.asOf && `as of ${i.asOf}`].filter(Boolean).join(' · ')}{' '}
                    {i.url && (
                      <a href={i.url} target="_blank" rel="noreferrer" onClick={() => opened(k, i.label)}>
                        Open
                      </a>
                    )}
                  </div>
                </div>
                <Controls section={k} title={i.label} />
              </div>
            ))}
          {k === 'completed_yesterday' && (
            <div className="dl-completed">
              {c.completed_yesterday!.filter((i) => visible(k, i.title)).map((i) => (
                <div key={i.title} className="dl-completed-item">
                  {i.imageFile && <BriefImage day={brief.day} file={i.imageFile} />}
                  <div className="dl-row">
                    <div className="dl-row-main">
                      {i.project && <div className="dl-eyebrow">{i.project}</div>}
                      <b>{i.title}</b>
                      {i.apps?.length ? <div className="dl-sub">{i.apps.join(', ')}</div> : null}
                    </div>
                    <Controls section={k} title={i.title} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {k === 'team_decisions' &&
            c.team_decisions!.filter((i) => visible(k, i.decision)).map((i) => (
              <div key={i.decision} className="dl-row">
                <div className="dl-row-main">
                  <b>{i.decision}</b>
                  <div className="dl-sub">
                    {[i.people?.join(', '), i.place, i.app, i.date].filter(Boolean).join(' · ')}{' '}
                    {i.url && (
                      <a href={i.url} target="_blank" rel="noreferrer" onClick={() => opened(k, i.decision)}>
                        Open
                      </a>
                    )}
                  </div>
                </div>
                <Controls section={k} title={i.decision} />
              </div>
            ))}
          {k === 'related_reading' && (
            <>
              {c.related_reading_intro && <p className="dl-intro">{c.related_reading_intro}</p>}
              <div className="dl-reading">
                {c.related_reading!.filter((i) => visible(k, i.title)).map((i) => (
                  <div key={i.url} className="dl-reading-item">
                    <a href={i.url} target="_blank" rel="noreferrer" onClick={() => opened(k, i.title)}>
                      {i.title}
                    </a>
                    <div className="dl-sub">{i.source || hostOf(i.url)}</div>
                    {i.reason && <div>{i.reason}</div>}
                    <Controls section={k} title={i.title} />
                  </div>
                ))}
              </div>
            </>
          )}
          {k === 'industry_news' &&
            c.industry_news!.filter((i) => visible(k, i.headline)).map((i) => (
              <div key={i.url} className="dl-row">
                <div className="dl-row-main">
                  <a href={i.url} target="_blank" rel="noreferrer" onClick={() => opened(k, i.headline)}>
                    {i.headline}
                  </a>
                  <div className="dl-sub">{[i.source || hostOf(i.url), i.published].filter(Boolean).join(' · ')}</div>
                </div>
                <Controls section={k} title={i.headline} />
              </div>
            ))}
          {k === 'site_seeing' && (
            <div className="dl-gallery">
              {c.site_seeing!.filter((i) => visible(k, i.caption ?? i.file)).map((i) => (
                <figure key={i.file}>
                  <BriefImage day={brief.day} file={i.file} enlarge onSave={() => void act({ type: 'saveImage', file: i.file, caption: i.caption })} />
                  {i.caption && <figcaption>{i.caption}</figcaption>}
                </figure>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function BriefImage({ day, file, enlarge, onSave }: { day: string; file: string; enlarge?: boolean; onSave?: () => void }) {
  const [src, setSrc] = useState<string | null>(null)
  const [big, setBig] = useState(false)
  useEffect(() => {
    // "<day>/images/x.jpg" (range summaries) or "images/x.jpg" (brief-relative)
    const m = /^(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(file)
    void dailyApi
      .briefImage(m ? m[1] : day, m ? m[2] : file)
      .then(setSrc)
      .catch(() => setSrc(null))
  }, [day, file])
  if (!src) return null
  return (
    <>
      <img className="dl-shot" src={src} alt="" onClick={() => enlarge && setBig(true)} />
      {big && (
        <div className="dl-lightbox" onClick={() => setBig(false)}>
          <img src={src} alt="" />
          {onSave && (
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation()
                onSave()
              }}
            >
              Save image
            </button>
          )}
        </div>
      )}
    </>
  )
}

function BriefFooter({
  state,
  settings,
  onSettings,
}: {
  state: BriefViewState
  settings: DailySettings
  onSettings: (patch: Partial<DailySettings>) => void
}) {
  const [panel, setPanel] = useState<'none' | 'override' | 'prompt' | 'transcript'>('none')
  const [part, setPart] = useState<BriefPart>('docket')
  const [override, setOverride] = useState(settings.briefOverrideInstructions)
  const [prompt, setPrompt] = useState('')
  const [transcript, setTranscript] = useState<string | null>(null)
  const stats = state.brief?.stats ?? null
  const failed = state.lastFailedRunStats

  useEffect(() => {
    if (panel !== 'prompt') return
    const existing = part === 'docket' ? settings.briefPromptOverrideDocket : settings.briefPromptOverrideExtras
    if (existing.trim()) setPrompt(existing)
    else void dailyApi.defaultPrompt(part).then(setPrompt)
  }, [panel, part])

  useEffect(() => {
    if (panel !== 'transcript' || !state.brief) return
    void dailyApi.transcript(state.brief.day, part).then(setTranscript)
  }, [panel, part, state.brief?.day])

  const s = stats ?? failed
  const tools = s?.toolCalls ? Object.entries(s.toolCalls).map(([k, v]) => `${k.replace(/^mcp__/, '')} ×${v}`).join(', ') : ''

  return (
    <footer className="dl-brief-footer">
      {s && (
        <div className="dl-stats">
          {[
            s.durationSeconds ? `${Math.round(s.durationSeconds / 60)} min` : null,
            s.model,
            s.costUSD !== undefined ? `$${s.costUSD.toFixed(2)}` : null,
            s.inputTokens !== undefined ? `${((s.inputTokens + (s.cacheReadTokens ?? 0)) / 1000).toFixed(0)}k in / ${((s.outputTokens ?? 0) / 1000).toFixed(1)}k out` : null,
            s.numTurns !== undefined ? `${s.numTurns} turns` : null,
            s.cardCount !== undefined ? `${s.cardCount} cards` : null,
            s.candidateImageCount !== undefined ? `${s.candidateImageCount} screenshots` : null,
            s.trigger,
          ]
            .filter(Boolean)
            .join(' · ')}
          {tools && <div>Tools: {tools}</div>}
          {s.failedParts &&
            Object.entries(s.failedParts).map(([p, m]) => (
              <div key={p} className="dl-failed">
                {p === 'docket' ? 'Docket' : 'Other sections'} failed: {m}
              </div>
            ))}
        </div>
      )}
      <div className="dl-footer-links">
        <span className="dl-sub">Engine: {state.engineLabel}</span>
        <button className="link-btn" onClick={() => setPanel(panel === 'override' ? 'none' : 'override')}>
          Override instructions{settings.briefOverrideInstructions.trim() ? ' (on)' : ''}
        </button>
        <button className="link-btn" onClick={() => setPanel(panel === 'prompt' ? 'none' : 'prompt')}>
          Edit prompt
          {settings.briefPromptOverrideDocket.trim() || settings.briefPromptOverrideExtras.trim() ? ' (custom)' : ''}
        </button>
        {state.brief && (
          <button className="link-btn" onClick={() => setPanel(panel === 'transcript' ? 'none' : 'transcript')}>
            Transcripts
          </button>
        )}
        <button className="link-btn danger" onClick={() => onSettings({ briefEnabled: false })}>
          Turn off
        </button>
      </div>

      {panel === 'override' && (
        <div className="dl-editor">
          <p className="dl-sub">Preferences for the brief, e.g. "Skip industry news. Focus the docket on client work."</p>
          <textarea value={override} onChange={(e) => setOverride(e.target.value)} rows={4} />
          <div className="row end">
            <button className="btn" onClick={() => onSettings({ briefOverrideInstructions: override })}>
              Save
            </button>
          </div>
        </div>
      )}
      {(panel === 'prompt' || panel === 'transcript') && (
        <div className="dl-seg">
          <button className={part === 'docket' ? 'on' : ''} onClick={() => setPart('docket')}>
            Docket
          </button>
          <button className={part === 'extras' ? 'on' : ''} onClick={() => setPart('extras')}>
            Other sections
          </button>
        </div>
      )}
      {panel === 'prompt' && (
        <div className="dl-editor">
          <p className="dl-sub">
            Placeholders: {'{{USER_NAME}} {{TODAY_LONG}} {{YESTERDAY_LONG}} {{TIMEZONE}} {{YESTERDAY_CARDS}} {{CATEGORIES_WITH_DESCRIPTIONS}} {{FEEDBACK_DAYS}} {{FEEDBACK_SUMMARY}} {{RECENT_BRIEF_ITEMS}} {{OVERRIDE_INSTRUCTIONS}}'}
            {part === 'extras' ? ' {{CANDIDATES_DIR}}' : ''}
          </p>
          <textarea className="dl-mono" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={16} />
          <div className="row end">
            <button
              className="btn ghost"
              onClick={() => {
                onSettings(part === 'docket' ? { briefPromptOverrideDocket: '' } : { briefPromptOverrideExtras: '' })
                void dailyApi.defaultPrompt(part).then(setPrompt)
              }}
            >
              Reset to default
            </button>
            <button
              className="btn"
              onClick={() => onSettings(part === 'docket' ? { briefPromptOverrideDocket: prompt } : { briefPromptOverrideExtras: prompt })}
            >
              Save
            </button>
          </div>
        </div>
      )}
      {panel === 'transcript' && <pre className="dl-transcript">{transcript ?? 'No transcript for this part.'}</pre>}
    </footer>
  )
}

const RANGES: { id: SummaryRange; label: string }[] = [
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'quarter_to_date', label: 'Quarter to date' },
  { id: 'year_to_date', label: 'Year to date' },
]

function CompletedView({ onBack }: { onBack: () => void }) {
  const [groups, setGroups] = useState<CompletedDayGroup[]>([])
  const [range, setRange] = useState<SummaryRange>('last_7_days')
  const [summary, setSummary] = useState<DailyBriefRangeSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void dailyApi.completed().then(setGroups)
  }, [])
  useEffect(() => {
    void dailyApi.summary(range).then(setSummary)
  }, [range])

  return (
    <section className="dl-brief">
      <header className="dl-daybreak">
        <div>
          <button className="link-btn" onClick={onBack}>
            ‹ Back to the brief
          </button>
          <h2 className="serif">Everything you completed</h2>
        </div>
        <div className="dl-actions">
          <select value={range} onChange={(e) => setRange(e.target.value as SummaryRange)}>
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                setSummary(await dailyApi.summarize(range))
              } catch (err) {
                setError(errorText(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? (
              <span>
                Summarizing<span className="dl-dots" />
              </span>
            ) : (
              'Summarize for my review'
            )}
          </button>
        </div>
      </header>
      {error && <div className="notice err dl-notice">{error}</div>}
      {summary && (
        <div className="dl-card dl-summary">
          <div className="dl-sub">
            {summary.startDay} – {summary.endDay}
          </div>
          <p>{summary.overview}</p>
          {summary.milestones.length > 0 && (
            <>
              <h3>Milestones</h3>
              <ul>
                {summary.milestones.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          {summary.projects.map((p) => (
            <div key={p.title} className="dl-summary-project">
              <h3>{p.title}</h3>
              {p.imageFile && <BriefImage day="" file={p.imageFile} />}
              <ul>
                {p.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {p.impact && <p className="dl-sub">{p.impact}</p>}
            </div>
          ))}
        </div>
      )}
      {groups.length === 0 ? (
        <div className="dl-empty-small">Completed work from your briefs will collect here.</div>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="dl-bsec">
            <h3 className="dl-bsec-title">{longDate(g.sourceDay || g.day)}</h3>
            <div className="dl-completed">
              {g.items.map((i) => (
                <div key={i.title} className="dl-completed-item">
                  {i.imageFile && <BriefImage day={g.day} file={i.imageFile} />}
                  {i.project && <div className="dl-eyebrow">{i.project}</div>}
                  <b>{i.title}</b>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  )
}
