import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns'

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 })

export const money = (v: unknown, whole = false) =>
  v === null || v === undefined || v === '' ? '—' : (whole ? inr0 : inr).format(Number(v))

/** ₹12.4L style for tiles. */
export function moneyShort(v: unknown): string {
  const n = Number(v ?? 0)
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`
  return inr0.format(n)
}

export const number = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : num.format(Number(v)))
export const compactNumber = (v: unknown) => compact.format(Number(v ?? 0))

function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = typeof v === 'string' ? parseISO(v) : new Date(v as number)
  return isValid(d) ? d : null
}

export const date = (v: unknown) => { const d = toDate(v); return d ? format(d, 'dd MMM yyyy') : '—' }
export const dateTime = (v: unknown) => { const d = toDate(v); return d ? format(d, 'dd MMM yyyy, HH:mm') : '—' }
export const time = (v: unknown) => { const d = toDate(v); return d ? format(d, 'HH:mm') : '—' }
export const ago = (v: unknown) => { const d = toDate(v); return d ? `${formatDistanceToNowStrict(d)} ago` : '—' }

export function age(dob: unknown): string {
  const d = toDate(dob)
  if (!d) return ''
  const now = new Date()
  let y = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) y--
  if (y >= 1) return `${y}y`
  const months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth()
  return months >= 1 ? `${months}m` : `${Math.max(0, Math.floor((now.getTime() - d.getTime()) / 864e5))}d`
}

export const todayISO = () => format(new Date(), 'yyyy-MM-dd')
export const nowLocal = () => format(new Date(), "yyyy-MM-dd'T'HH:mm")

export function minutes(v: unknown): string {
  const n = Number(v)
  if (v === null || v === undefined || Number.isNaN(n)) return '—'
  if (n < 60) return `${Math.round(n)} min`
  return `${Math.floor(n / 60)}h ${Math.round(n % 60)}m`
}

export function kpiValue(value: unknown, fmt: string): string {
  switch (fmt) {
    case 'currency': return moneyShort(value)
    case 'percent': return `${number(value)}%`
    case 'minutes': return minutes(value)
    default: return number(value)
  }
}

export const initials = (name?: string) =>
  (name ?? '?').replace(/^(Dr|Mr|Mrs|Ms)\.?\s+/i, '').split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('')
