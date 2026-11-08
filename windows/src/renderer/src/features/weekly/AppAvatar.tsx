import { hex } from './util.ts'

/** Privacy-first favicon stand-in: the app's initial on its deterministic colour. Nothing is fetched. */
export function AppAvatar({ name, colorHex, size = 14, radius = 3 }: { name: string; colorHex: string; size?: number; radius?: number }) {
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  const c = colorHex.replace('#', '')
  const lum = (0.299 * parseInt(c.slice(0, 2), 16) + 0.587 * parseInt(c.slice(2, 4), 16) + 0.114 * parseInt(c.slice(4, 6), 16)) / 255
  const fg = lum > 0.72 ? '#4a4a4a' : '#fff'
  return (
    <span
      className="wk-avatar"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: hex(colorHex),
        color: fg,
        fontSize: Math.max(7, Math.round(size * 0.58)),
      }}
      aria-hidden
    >
      {letter}
    </span>
  )
}
