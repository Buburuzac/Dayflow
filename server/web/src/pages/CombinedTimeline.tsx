import { useState } from 'react'
import { api } from '../api/client.ts'
import type { DeviceInfo } from '../api/types.ts'
import { canViewTimeline, useApp } from '../app-context.ts'
import { Empty, ErrorBox, Loading } from '../components/ui.tsx'
import { useAsync } from '../lib/hooks.ts'
import { DeviceIcon, TimelineView, type TimelineData } from './MyTime.tsx'

export function CombinedTimeline() {
  const { workspace, isAdmin, me } = useApp()
  const members = useAsync(() => workspace && isAdmin ? api.members(workspace.id) : Promise.resolve([]), [workspace?.id, isAdmin])
  const [selectedUsers, setSelectedUsers] = useState<string[]>([me.user.id])
  const [excludedDevices, setExcludedDevices] = useState<string[]>([])

  if (!workspace) return <Empty title="No workspace yet">Ask a workspace owner to invite you.</Empty>
  if (!isAdmin) return <Empty title="Admins only">Combined timelines are available to workspace admins and owners.</Empty>
  if (members.error) return <div className="pad"><ErrorBox error={members.error} onRetry={members.reload} /></div>
  if (!members.data) return <Loading />

  const people = members.data.filter((person) => canViewTimeline(workspace.role, person.role))
  const selected = people.filter((person) => selectedUsers.includes(person.userId))
  const personNames = new Map(people.map((person) => [person.userId, person.name || person.email]))
  const wsId = workspace.id

  return (
    <TimelineView
      deps={[wsId, selected.map((person) => person.userId).join(',')]}
      excludeDevices={excludedDevices}
      hideDeviceFilter
      totalLabel="Selected time"
      emptyText={() => selected.length ? 'Nothing synced from the selected computers for this period.' : 'Select at least one person to compare timelines.'}
      load={async (from, to): Promise<TimelineData> => {
        if (!selected.length) return { cards: [], devices: [], categories: [], selectionDevices: [] }
        const timelines = await Promise.all(selected.map((person) => api.memberTimeline(wsId, person.userId, from, to)))
        const selectionDevices: { userId: string; device: DeviceInfo }[] = []
        const devices: DeviceInfo[] = []
        const cards: TimelineData['cards'] = []
        // Each person keeps their own palette; the merged list (first wins per name) colours the totals.
        const deviceCategories: Record<string, TimelineData['categories']> = {}
        const categories: TimelineData['categories'] = []
        for (const [index, timeline] of timelines.entries()) {
          const person = selected[index]
          for (const device of timeline.devices) {
            selectionDevices.push({ userId: person.userId, device })
            devices.push({ ...device, name: `${person.name || person.email} · ${device.name}` })
            deviceCategories[device.id] = timeline.categories
          }
          for (const card of timeline.cards) {
            cards.push(card)
            deviceCategories[card.deviceId] ??= timeline.categories
          }
          for (const cat of timeline.categories)
            if (!categories.some((c) => c.name.trim().toLowerCase() === cat.name.trim().toLowerCase())) categories.push(cat)
        }
        return { cards, devices, categories, deviceCategories, selectionDevices }
      }}
      head={(data) => {
        const selectableDevices = (data?.selectionDevices ?? []).filter(({ userId }) => selectedUsers.includes(userId))
        return (
          <div className="combined-head">
            <h1>Combined timeline</h1>
            <p className="muted small">Compare selected people and computers on one time axis. Times use this browser’s time zone. Card durations are summed across lanes, so overlaps count more than once.</p>
            <div className="combined-selectors">
              <div className="combined-selector">
                <strong>People</strong>
                <div className="combined-options">
                  {people.map((person) => (
                    <label key={person.userId} className="combined-option" title={person.email}>
                      <input
                        type="checkbox"
                        checked={selectedUsers.includes(person.userId)}
                        onChange={(event) => setSelectedUsers((ids) => event.target.checked ? [...ids, person.userId] : ids.filter((id) => id !== person.userId))}
                      />
                      {person.name || person.email}{person.userId === me.user.id ? ' (you)' : ''}
                    </label>
                  ))}
                </div>
              </div>
              <div className="combined-selector">
                <strong>Computers</strong>
                <div className="combined-options">
                  {selectableDevices.length ? selectableDevices.map(({ userId, device }) => (
                    <label key={device.id} className="combined-option">
                      <input
                        type="checkbox"
                        checked={!excludedDevices.includes(device.id)}
                        onChange={(event) => setExcludedDevices((ids) => event.target.checked ? ids.filter((id) => id !== device.id) : [...ids, device.id])}
                      />
                      <DeviceIcon platform={device.platform} />
                      {personNames.get(userId)} · {device.name}
                    </label>
                  )) : <span className="muted small">Select a person to see their computers.</span>}
                </div>
              </div>
            </div>
            <p className="muted small">Workspace sharing rules apply to every person. Views of another person’s timeline appear in their Account history.</p>
          </div>
        )}}
    />
  )
}
