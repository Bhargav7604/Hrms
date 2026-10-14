import { useMemo } from 'react'
import { qrPath } from './qr'

/** Scannable QR (always black on white, also in dark mode). */
export function QrCode({ value, size = 160, title, className }: { value: string; size?: number; title?: string; className?: string }) {
  const q = useMemo(() => {
    try { return qrPath(value) } catch { return null }
  }, [value])
  if (!q) return <span className="text-xs text-red-600">Link is too long for a QR code</span>
  return (
    <svg role="img" aria-label={title ?? `QR code: ${value}`} viewBox={`0 0 ${q.size} ${q.size}`} width={size} height={size}
      shapeRendering="crispEdges" className={className}>
      <rect width={q.size} height={q.size} fill="#ffffff" />
      <path d={q.path} fill="#000000" />
    </svg>
  )
}
