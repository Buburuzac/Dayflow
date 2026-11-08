import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

// ---- Hash router (works whatever the server does with unknown paths) ----

function subscribe(fn: () => void) {
  window.addEventListener('hashchange', fn)
  return () => window.removeEventListener('hashchange', fn)
}
const snapshot = () => window.location.hash

export interface Route {
  /** path segments, e.g. ['projects', 'abc', 'report'] */
  parts: string[]
  query: URLSearchParams
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '')
  const [path, q = ''] = h.split('?')
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) }
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot)
  return parseHash(hash)
}

export function navigate(path: string, replace = false): void {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`
  if (replace) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${target}`)
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
  else window.location.hash = target
}

// ---- Async data ----

export interface Async<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
  setData: (fn: (d: T | undefined) => T | undefined) => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true })
  const [tick, setTick] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, error: undefined }))
    fn().then(
      (data) => id === seq.current && setState({ data, loading: false }),
      (error) => id === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  const setData = useCallback((f: (d: T | undefined) => T | undefined) => setState((s) => ({ ...s, data: f(s.data) })), [])
  return { data: state.data, error: state.error, loading: state.loading, reload, setData }
}

/** Element content width via ResizeObserver (charts size themselves to their card). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect()
    ro.current = null
    if (!el) return
    ro.current = new ResizeObserver(() => setW(el.clientWidth))
    ro.current.observe(el)
    setW(el.clientWidth)
  }, [])
  return [ref, w]
}
