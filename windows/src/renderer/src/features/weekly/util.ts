// Small helpers shared by the Weekly sections (colour maths, formatting, a width hook).

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

export const TITLE_COLOR = '#FF9A64'

export function hex(h: string | null | undefined, alpha = 1): string {
  const c = (h ?? 'BFB6AE').replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return `rgba(191,182,174,${alpha})`
  return alpha >= 1 ? `#${c}` : `rgba(${r},${g},${b},${alpha})`
}

function rgb(h: string): [number, number, number] {
  const c = h.replace('#', '')
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]
}

export function lerpColor(a: string, b: string, t: number): string {
  const x = rgb(a)
  const y = rgb(b)
  const m = x.map((v, i) => Math.round(v + (y[i] - v) * t))
  return `rgb(${m[0]},${m[1]},${m[2]})`
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Minute on the 240..1680 axis → locale short time. */
export function shortTime(minute: number): string {
  const m = Math.round(minute)
  const d = new Date(2000, 0, 1, Math.floor(m / 60) % 24, m % 60)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Tracks an element's content width. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** X-axis label offset per spec §3.11 (34px labels, edge-aligned at the ends). */
export function axisLabelStyle(progress: number, gridWidth: number): CSSProperties {
  const left = Math.max(0, Math.min(gridWidth - 34, progress * gridWidth - 17))
  const align = progress <= 0.001 ? 'left' : progress >= 0.999 ? 'right' : 'center'
  return { left, width: 34, textAlign: align }
}
