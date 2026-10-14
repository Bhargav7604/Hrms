/**
 * Dashboard header bar shared by the Command Centre and every dashboard: greeting, branch, active
 * range; period presets with a custom range; comparison (previous period / same period last year /
 * none) with the exact comparison window; "Updated hh:mm", manual refresh, auto-refresh, TV
 * (full-screen kiosk) mode and print. State lives in the URL so a dashboard view can be shared.
 */
import { CalendarDays, ChevronDown, Maximize2, Minimize2, Printer, RefreshCw, Building2, LayoutGrid } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router'
import { Button, cn, Input, Popover, Select } from '@/components/ui'
import { useAuth, useMeta } from '@/lib/auth'
import { usePref } from '@/lib/prefs'
import type { CompareInfo, RangeInfo } from './types'

export const PRESETS: { key: string; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' }, { key: 'last_month', label: 'Last month' }, { key: 'this_fy', label: 'This FY' },
  { key: 'custom', label: 'Custom range' },
]
export const COMPARES = [
  { key: 'previous', label: 'vs previous period' }, { key: 'last_year', label: 'vs same period last year' }, { key: 'none', label: 'No comparison' },
]
export const AUTO = [{ s: 0, label: 'Auto-refresh off' }, { s: 30, label: 'Every 30 s' }, { s: 60, label: 'Every 1 min' }, { s: 300, label: 'Every 5 min' }]

export interface DashParams { preset: string; from?: string; to?: string; compare: string }

/** Period / comparison held in the URL (?preset=&from=&to=&compare=). */
export function useDashParams(defaultPreset = 'this_month') {
  const [sp, setSp] = useSearchParams()
  const preset = sp.get('preset') || (sp.get('from') ? 'custom' : defaultPreset)
  const params: DashParams = {
    preset, compare: sp.get('compare') || 'previous',
    ...(preset === 'custom' ? { from: sp.get('from') || undefined, to: sp.get('to') || undefined } : {}),
  }
  const set = useCallback((patch: Partial<DashParams> & { tab?: string }) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === '') n.delete(k)
        else n.set(k, String(v))
      }
      if (patch.preset && patch.preset !== 'custom') { n.delete('from'); n.delete('to') }
      return n
    }, { replace: true })
  }, [setSp])
  return { params, set, tab: sp.get('tab') || 'overview' }
}

export const queryOf = (p: DashParams) => ({ preset: p.preset, compare: p.compare, from: p.from, to: p.to })

/** Persisted auto-refresh interval (seconds; 0 = off) → TanStack `refetchInterval`. */
export function useAutoRefresh(key = 'dash:auto-refresh') {
  const [secs, setSecs] = usePref<number>(key, 0)
  return { secs: AUTO.some((a) => a.s === secs) ? secs : 0, setSecs, interval: secs ? secs * 1000 : false as const }
}

/** TV / kiosk mode: a full-screen overlay (hides the app shell) using the Fullscreen API when available. */
export function useTvMode(ref: RefObject<HTMLElement | null>) {
  const [tv, setTv] = useState(false)
  useEffect(() => {
    const h = () => { if (!document.fullscreenElement) setTv(false) }
    document.addEventListener('fullscreenchange', h)
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setTv(false) }
    window.addEventListener('keydown', k)
    return () => { document.removeEventListener('fullscreenchange', h); window.removeEventListener('keydown', k) }
  }, [])
  const toggle = useCallback(() => {
    setTv((on) => {
      const next = !on
      if (next) void ref.current?.requestFullscreen?.().catch(() => { /* overlay still works */ })
      else if (document.fullscreenElement) void document.exitFullscreen()
      return next
    })
  }, [ref])
  return { tv, toggle }
}

export function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const hhmm = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—')

function RangePicker({ params, range, onChange }: { params: DashParams; range?: RangeInfo; onChange: (p: Partial<DashParams>) => void }) {
  const [from, setFrom] = useState(params.from ?? range?.from ?? '')
  const [to, setTo] = useState(params.to ?? range?.to ?? '')
  const label = PRESETS.find((p) => p.key === params.preset)?.label ?? 'Custom range'
  return (
    <Popover align="right" className="w-72 p-2" trigger={({ toggle, open }) => (
      <button type="button" onClick={toggle} aria-expanded={open} aria-haspopup="dialog"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-2.5 text-sm text-ink shadow-sm hover:bg-surface-2">
        <CalendarDays className="size-4 text-ink-3" /> <span className="font-medium">{label}</span>
        {range && <span className="hidden text-ink-2 md:inline">{range.label}</span>}
        <ChevronDown className="size-3.5 text-ink-3" />
      </button>
    )}>
      {(close) => (
        <div>
          <div className="grid grid-cols-2 gap-1">
            {PRESETS.filter((p) => p.key !== 'custom').map((p) => (
              <button key={p.key} type="button" onClick={() => { onChange({ preset: p.key }); close() }}
                className={cn('rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2', params.preset === p.key && 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-500/10 dark:text-brand-200')}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <p className="mb-1 text-xs font-medium text-ink-2">Custom range</p>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" className="h-8 px-2 text-xs" />
              <span className="text-ink-3">–</span>
              <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" className="h-8 px-2 text-xs" />
            </div>
            <Button size="sm" variant="primary" className="mt-2 w-full" disabled={!from || !to || from > to}
              onClick={() => { onChange({ preset: 'custom', from, to }); close() }}>Apply range</Button>
          </div>
        </div>
      )}
    </Popover>
  )
}

export function DashboardBar({ chip, chipIcon = 'LayoutGrid', title, params, onChange, range, compare, updatedAt, fetching, onRefresh, auto, onAuto, tv, onTv, extra }: {
  chip: string; chipIcon?: string; title?: ReactNode; params: DashParams; onChange: (p: Partial<DashParams>) => void
  range?: RangeInfo; compare?: CompareInfo | null; updatedAt?: number; fetching?: boolean; onRefresh: () => void
  auto: number; onAuto: (s: number) => void; tv: boolean; onTv: () => void; extra?: ReactNode
}) {
  const meta = useMeta()
  const { user } = useAuth()
  const name = (meta.data?.user.name ?? user?.name ?? '').split(' (')[0]
  const branch = meta.data?.hospital.branch_name ?? meta.data?.hospital.name
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          {chipIcon === 'LayoutGrid' ? <LayoutGrid className="size-3.5" /> : null}{chip}
        </span>
        <h1 className="text-base font-semibold text-ink">{title ?? `${greeting()}, ${name}`}</h1>
        {branch && <span className="inline-flex items-center gap-1 text-xs text-ink-2"><Building2 className="size-3.5" />{branch}</span>}
        {range && <span className="inline-flex items-center gap-1 text-xs text-ink-2"><CalendarDays className="size-3.5" />{range.label}</span>}
      </div>
      <div className="no-print flex flex-wrap items-center gap-2">
        {extra}
        <RangePicker key={`${params.preset}${params.from}${params.to}`} params={params} range={range} onChange={onChange} />
        <Select value={params.compare} onChange={(e) => onChange({ compare: e.target.value })} aria-label="Comparison" className="h-8 w-auto py-0 text-sm">
          {COMPARES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </Select>
        {compare && <span className="text-xs text-ink-3">comparing with {compare.label}</span>}
        <span className="text-xs text-ink-3" aria-live="polite">Updated {hhmm(updatedAt)}</span>
        <button type="button" onClick={onRefresh} title="Refresh now" aria-label="Refresh now"
          className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink"><RefreshCw className={cn('size-4', fetching && 'animate-spin')} /></button>
        <Select value={String(auto)} onChange={(e) => onAuto(Number(e.target.value))} aria-label="Auto-refresh" className="h-8 w-auto py-0 text-sm">
          {AUTO.map((a) => <option key={a.s} value={a.s}>{a.label}</option>)}
        </Select>
        <button type="button" onClick={onTv} title={tv ? 'Exit TV mode (Esc)' : 'TV / full-screen mode'} aria-pressed={tv} aria-label="TV mode"
          className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink">{tv ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
        <button type="button" onClick={() => window.print()} title="Print" aria-label="Print"
          className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink"><Printer className="size-4" /></button>
      </div>
    </div>
  )
}

/** Wrapper that turns into a full-screen overlay in TV mode. */
export function TvFrame({ tv, frameRef, children }: { tv: boolean; frameRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return (
    <div ref={frameRef} className={cn(tv && 'fixed inset-0 z-[60] overflow-y-auto bg-plane p-4 md:p-6')}>
      {children}
    </div>
  )
}
