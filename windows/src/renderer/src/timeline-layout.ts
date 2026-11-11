/** Split local and synced cards into lanes only where their time intervals overlap. */
export function crossDeviceOverlapIds<T extends { id: number; startTs: number; endTs: number; remote?: boolean }>(cards: T[]): Set<number> {
  const ids = new Set<number>()
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i]
    for (let j = i + 1; j < cards.length; j++) {
      const b = cards[j]
      if (!!a.remote === !!b.remote) continue
      if (a.startTs < b.endTs && b.startTs < a.endTs) {
        ids.add(a.id)
        ids.add(b.id)
      }
    }
  }
  return ids
}
