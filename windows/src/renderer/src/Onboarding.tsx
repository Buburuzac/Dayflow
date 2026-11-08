import type { SettingsWithSecrets } from '../../shared/types.ts'
import { ProviderForm } from './Settings.tsx'

export function Onboarding({
  settings,
  onSettings,
  onDone,
}: {
  settings: SettingsWithSecrets
  onSettings: (s: SettingsWithSecrets) => void
  onDone: () => void
}) {
  return (
    <div className="onboarding">
      <div className="onb-card">
        <h1 className="serif">Welcome to Dayflow</h1>
        <p>
          Dayflow quietly takes a screenshot every few seconds and turns your day into a timeline of what you actually
          did. Everything is stored on this PC in <code>%APPDATA%\Dayflow</code>. Screenshots are only sent to the AI
          provider you pick below.
        </p>
        <p className="muted">
          Recording has already started — you can pause it any time from the tray icon or the button in the sidebar.
        </p>
        <h2>Choose how your day is analyzed</h2>
        <ProviderForm settings={settings} onSettings={onSettings} />
        <div className="row end">
          <button className="btn" onClick={onDone}>
            Start using Dayflow
          </button>
        </div>
      </div>
    </div>
  )
}
