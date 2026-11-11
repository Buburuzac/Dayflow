import { useEffect, useState } from 'react'
import type { AppStatus, SettingsWithSecrets } from '../../shared/types.ts'
import { SettingsView } from './Settings.tsx'
import { TimelineView } from './Timeline.tsx'
import { Onboarding } from './Onboarding.tsx'
import { WeeklyView } from './features/Weekly.tsx'
import { ChatView } from './features/Chat.tsx'
import { DailyView } from './features/Daily.tsx'
import { FlowView } from './features/Flow.tsx'
import { ReviewView } from './features/Review.tsx'
import { TeamView } from './features/Team.tsx'
import { useSyncStatus } from './features/Sync.tsx'
import { clock24 } from './dates.ts'

type Tab = 'timeline' | 'daily' | 'weekly' | 'chat' | 'flow' | 'team' | 'review' | 'settings'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'timeline', label: 'Timeline', icon: '◷' },
  { id: 'daily', label: 'Daily', icon: '☀' },
  { id: 'weekly', label: 'Weekly', icon: '▦' },
  { id: 'chat', label: 'Chat', icon: '✦' },
  { id: 'flow', label: 'Flow', icon: '◎' },
  { id: 'team', label: 'Team', icon: '⚑' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
]

export function App() {
  const [tab, setTab] = useState<Tab>('timeline')
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [settings, setSettings] = useState<SettingsWithSecrets | null>(null)
  const [reviewDay, setReviewDay] = useState<string | undefined>(undefined)
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('onboarded') === '1')

  useEffect(() => {
    void window.dayflow.getStatus().then(setStatus)
    void window.dayflow.getSettings().then(setSettings)
    const offStatus = window.dayflow.onStatus(setStatus)
    const offDaily = window.dayflow.on('daily:open', () => setTab('daily'))
    const offNav = window.dayflow.on('app:navigate', (route) => setTab(route as Tab))
    // Categories pulled from another device.
    const offSettings = window.dayflow.on('settings:changed', () => void window.dayflow.getSettings().then(setSettings))
    return () => {
      offStatus()
      offDaily()
      offNav()
      offSettings()
    }
  }, [])

  if (!settings) return null

  if (!onboarded) {
    return (
      <Onboarding
        settings={settings}
        onSettings={setSettings}
        onDone={() => {
          localStorage.setItem('onboarded', '1')
          setOnboarded(true)
        }}
      />
    )
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="logo">Dayflow</div>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'nav active' : 'nav'} onClick={() => setTab(t.id)} title={t.label}>
            <span className="nav-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
        <button className="nav" onClick={() => void window.dayflow.call('sync:openDashboard').catch((err: unknown) => alert(String(err)))} title="Open Dashboard in your browser">
          <span className="nav-icon">↗</span>
          <span>Dashboard</span>
        </button>
        <div className="sidebar-spacer" />
        {status && <RecorderPill status={status} />}
      </nav>
      <main className="content">
        {tab === 'timeline' && (
          <TimelineView
            settings={settings}
            status={status}
            onReview={(day) => {
              setReviewDay(day)
              setTab('review')
            }}
          />
        )}
        {tab === 'flow' && <FlowView settings={settings} />}
        {tab === 'review' && <ReviewView settings={settings} day={reviewDay} onClose={() => setTab('timeline')} />}
        {tab === 'daily' && <DailyView settings={settings} />}
        {tab === 'weekly' && <WeeklyView settings={settings} />}
        {tab === 'chat' && <ChatView settings={settings} />}
        {tab === 'team' && <TeamView />}
        {tab === 'settings' && <SettingsView settings={settings} onSettings={setSettings} status={status} />}
      </main>
    </div>
  )
}

function RecorderPill({ status }: { status: AppStatus }) {
  const [open, setOpen] = useState(false)
  const [sync] = useSyncStatus()
  const label =
    status.recorder === 'recording'
      ? 'Recording'
      : status.recorder === 'paused'
        ? status.pausedUntil
          ? `Paused · ${clock24(status.pausedUntil / 1000)}`
          : 'Paused'
        : status.recorder === 'locked'
          ? 'Screen locked'
          : status.recorder === 'error'
            ? 'Capture error'
            : 'Stopped'
  const recording = status.recorder === 'recording' || status.recorder === 'locked'
  return (
    <div className="pill-wrap">
      <button
        className={`pill ${status.recorder}`}
        title={status.lastError ?? undefined}
        onClick={() => (recording ? setOpen((o) => !o) : void window.dayflow.resume())}
      >
        <span className="dot" />
        {label}
        {!recording && <span className="pill-action">Resume</span>}
      </button>
      {sync?.signedIn && <div className="recording-identity"><span title={sync.user?.email}>{sync.user?.email}</span><span title={sync.deviceName}>{sync.deviceName}</span></div>}
      {open && recording && (
        <div className="pill-menu" onMouseLeave={() => setOpen(false)}>
          {[
            ['15 minutes', 15],
            ['30 minutes', 30],
            ['1 hour', 60],
            ['Until I resume', null],
          ].map(([l, m]) => (
            <button
              key={String(l)}
              onClick={() => {
                setOpen(false)
                void window.dayflow.pause(m as number | null)
              }}
            >
              Pause {String(l).startsWith('Until') ? '' : 'for '}
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
