// In-process fan-out for /api/sync/stream. One server instance, so no external broker is needed.

export type HubListener = (event: string, data: unknown) => void

export class Hub {
  private readonly byUser = new Map<string, Set<HubListener>>()

  subscribe(userId: string, fn: HubListener): () => void {
    let set = this.byUser.get(userId)
    if (!set) this.byUser.set(userId, (set = new Set()))
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.byUser.delete(userId)
    }
  }

  publish(userIds: Iterable<string>, event: string, data: unknown = {}): void {
    for (const u of new Set(userIds)) {
      for (const fn of this.byUser.get(u) ?? []) {
        try {
          fn(event, data)
        } catch {
          /* a broken stream is cleaned up by its close handler */
        }
      }
    }
  }

  connections(): number {
    let n = 0
    for (const s of this.byUser.values()) n += s.size
    return n
  }
}
