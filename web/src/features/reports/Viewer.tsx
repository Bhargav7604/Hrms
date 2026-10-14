/**
 * Generic report viewer: filters (period presets, from/to, search, doctor, department, payer, status…),
 * summary tiles (lakh / crore), table or chart, density, column chooser (show / hide / reorder — hidden
 * columns are left out of exports and prints), saved views, copy link (filters live in the URL),
 * CSV / Excel / PDF export, print, schedule and favourite.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown, ArrowLeft, ArrowUp, Bookmark, CalendarClock, ChevronDown, ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight, Columns3, Copy,
  Download, GripVertical, Maximize2, Minimize2, Play, Printer, RefreshCw, Star, Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, cn, Drawer, Empty, ErrorBox, Input, MenuItem, Modal, Popover, Select, Spinner, StatusBadge, Switch } from '@/components/ui'
import { api, apiUrl, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { date, dateTime, money, moneyShort, number } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { usePref } from '@/lib/prefs'
import { ChartView, chartTable, fmtValue, MiniTable } from '@/features/dashboards/kit'
import { useFavouriteReport } from './Hub'
import type { ColDef, FilterDef, ReportMeta, RunResult, Schedule, ViewState } from './types'

const NUMERIC = new Set(['number', 'money', 'percent', 'minutes', 'days'])
const CONTROL = new Set(['page', 'limit', 'sort', 'view', 'density'])

function cellValue(v: unknown, type: string): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-ink-3">—</span>
  switch (type) {
    case 'money': return money(v)
    case 'number': return number(v)
    case 'percent': return `${number(v)}%`
    case 'minutes': return fmtValue(v, 'minutes')
    case 'days': return `${number(v)}`
    case 'date': return date(v)
    case 'datetime': return dateTime(v)
    case 'bool': return v === true || v === 'Yes' ? 'Yes' : 'No'
    case 'status': return <StatusBadge status={String(v)} />
    case 'code': return <span className="font-mono text-[12px]">{String(v)}</span>
    default: return String(v)
  }
}

function tileValue(v: number | null, fmt: string) {
  if (v === null || v === undefined) return '—'
  if (fmt === 'money') return moneyShort(v)
  if (fmt === 'percent') return `${number(v)}%`
  if (fmt === 'minutes') return fmtValue(v, 'minutes')
  return number(v)
}

/** Filters in the URL — so "Copy link" shares exactly this view. */
function useReportUrl(meta?: ReportMeta) {
  const [sp, setSp] = useSearchParams()
  const applied: Record<string, string> = {}
  sp.forEach((v, k) => { if (!CONTROL.has(k) && v) applied[k] = v })
  const sort = sp.get('sort') ?? meta?.default_sort ?? ''
  const page = Math.max(1, Number(sp.get('page') ?? 1))
  const limit = Number(sp.get('limit') ?? 25)
  const view = (sp.get('view') as 'table' | 'chart') ?? 'table'
  const patch = (p: Record<string, string | number | null | undefined>, resetPage = true) => setSp((prev) => {
    const n = new URLSearchParams(prev)
    for (const [k, v] of Object.entries(p)) { if (v === null || v === undefined || v === '') n.delete(k); else n.set(k, String(v)) }
    if (resetPage && !('page' in p)) n.delete('page')
    return n
  }, { replace: true })
  const replaceFilters = (f: Record<string, string>) => setSp((prev) => {
    const n = new URLSearchParams()
    prev.forEach((v, k) => { if (CONTROL.has(k) && k !== 'page') n.set(k, v) })
    for (const [k, v] of Object.entries(f)) if (v) n.set(k, v)
    return n
  }, { replace: true })
  return { applied, sort, page, limit, view, patch, replaceFilters }
}

function FilterBar({ meta, applied, onApply }: { meta: ReportMeta; applied: Record<string, string>; onApply: (f: Record<string, string>) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(applied)
  const key = JSON.stringify(applied)
  useEffect(() => { setDraft(JSON.parse(key)) }, [key])
  const set = (k: string, v: string | null) => setDraft((d) => { const n = { ...d }; if (v) n[k] = v; else delete n[k]; return n })
  const hasPeriod = meta.filters.some((f) => f.type === 'period')
  const period = draft.period ?? (draft.from || draft.to ? 'custom' : meta.default_period)
  const ctrl = (f: FilterDef): ReactNode => {
    if (f.type === 'period') return null
    if (f.type === 'text') return <Input value={draft[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} className="h-9" />
    if (f.type === 'ref' && f.ref) return <RefPicker refName={f.ref} value={draft[f.key] ?? null} filter={f.ref_filter} onChange={(id) => set(f.key, id)} placeholder={f.placeholder} />
    return (
      <Select value={draft[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
        <option value="">{f.placeholder ?? 'All'}</option>
        {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    )
  }
  return (
    <form className="no-print rounded-xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
      onSubmit={(e) => { e.preventDefault(); onApply(draft) }}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-4 xl:grid-cols-6">
        {hasPeriod && (
          <>
            <label className="min-w-0"><span className="mb-1 block text-xs font-medium text-ink-2">Period</span>
              <Select value={period} onChange={(e) => setDraft((d) => { const n: Record<string, string> = { ...d, period: e.target.value }; if (e.target.value !== 'custom') { delete n.from; delete n.to } return n })}>
                {meta.periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Select></label>
            <label className="min-w-0"><span className="mb-1 block text-xs font-medium text-ink-2">From date</span>
              <Input type="date" value={draft.from ?? ''} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value, period: 'custom' }))} /></label>
            <label className="min-w-0"><span className="mb-1 block text-xs font-medium text-ink-2">To date</span>
              <Input type="date" value={draft.to ?? ''} min={draft.from} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value, period: 'custom' }))} /></label>
          </>
        )}
        {meta.filters.filter((f) => f.type !== 'period').map((f) => (
          <div key={f.key} className="min-w-0"><span className="mb-1 block text-xs font-medium text-ink-2">{f.label}</span>{ctrl(f)}</div>
        ))}
        <div className="col-span-2 flex items-end gap-2 md:col-span-1">
          <Button type="submit" variant="primary" icon="Play">Apply</Button>
          <Button type="button" onClick={() => { setDraft({}); onApply({}) }}>Reset</Button>
        </div>
      </div>
    </form>
  )
}

function ColumnChooser({ open, onClose, columns, visible, onChange }: { open: boolean; onClose: () => void; columns: ColDef[]; visible: string[]; onChange: (v: string[] | null) => void }) {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const ordered = [...visible.map((k) => byKey.get(k)!).filter(Boolean), ...columns.filter((c) => !visible.includes(c.key))]
  const [drag, setDrag] = useState<number | null>(null)
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ordered.length) return
    const arr = [...ordered]
    const [x] = arr.splice(from, 1)
    arr.splice(to, 0, x)
    onChange(arr.filter((c) => visible.includes(c.key)).map((c) => c.key))
  }
  return (
    <Drawer open={open} onClose={onClose} title="Columns" width="max-w-sm"
      subtitle="Tick to show, drag (or use the arrows) to reorder. Hidden columns are left out of exports and prints too.">
      <div className="flex gap-2 border-b border-line px-4 py-2">
        <Button size="xs" onClick={() => onChange(columns.map((c) => c.key))} icon="Eye">Show all</Button>
        <Button size="xs" onClick={() => onChange(null)} icon="RotateCcw">Reset to report default</Button>
      </div>
      <ul className="divide-y divide-line">
        {ordered.map((c, i) => {
          const on = visible.includes(c.key)
          return (
            <li key={c.key} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null) }}
              className={cn('flex items-center gap-2 px-4 py-1.5 text-sm', drag === i && 'opacity-50')}>
              <GripVertical className="size-4 cursor-grab text-ink-3" aria-hidden />
              <input type="checkbox" checked={on} aria-label={`Show ${c.label}`} className="size-4 accent-brand-700"
                onChange={() => onChange(on ? visible.filter((k) => k !== c.key) : [...visible, c.key])} />
              <span className="flex-1 text-ink">{c.label} {!c.default && <span className="ml-1 text-[10px] font-semibold uppercase text-ink-3">Extra</span>}</span>
              <button type="button" onClick={() => move(i, i - 1)} disabled={!on || i === 0} aria-label={`Move ${c.label} up`} className="rounded p-0.5 text-ink-3 hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
              <button type="button" onClick={() => move(i, i + 1)} disabled={!on || i >= visible.length - 1} aria-label={`Move ${c.label} down`} className="rounded p-0.5 text-ink-3 hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
            </li>
          )
        })}
      </ul>
    </Drawer>
  )
}

const FREQS = ['Daily', 'Weekly', 'Monthly']
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const SCHED_PERIODS = [['yesterday', 'Yesterday'], ['today', 'Today'], ['last_7', 'Last 7 days'], ['this_week', 'This week'], ['this_month', 'Month to date'],
  ['last_month', 'Last month'], ['last_30', 'Last 30 days'], ['this_fy', 'Financial year to date']]

function ScheduleModal({ meta, open, onClose, state }: { meta: ReportMeta; open: boolean; onClose: () => void; state: ViewState }) {
  const qc = useQueryClient()
  const roles = useMeta().data?.roles ?? {}
  const [f, setF] = useState({ name: `${meta.name} — daily`, schedule: 'Daily', schedule_time: '08:00', weekday: 'Monday', month_day: 1, period: '', format: 'Excel', recipients: '', roles: [] as string[] })
  const save = useMutation({
    mutationFn: () => api(`/reports/${meta.code}/schedules`, { method: 'POST', body: {
      name: f.name, schedule: f.schedule, schedule_time: f.schedule_time, weekday: f.schedule === 'Weekly' ? f.weekday : null,
      month_day: f.schedule === 'Monthly' ? f.month_day : null, period: f.period || null, format: f.format,
      recipients: f.recipients.split(/[,\s;]+/).filter(Boolean), recipient_roles: f.roles, state,
    } }),
    onSuccess: () => { toast.success('Schedule saved'); qc.invalidateQueries({ queryKey: ['reports', 'meta', meta.code] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const act = useMutation({
    mutationFn: ({ s, op }: { s: Schedule; op: 'run' | 'Active' | 'Paused' | 'Archived' }) => op === 'run'
      ? api<{ status: string; messages: number; rows: number }>(`/reports/schedules/${s.id}/run`, { method: 'POST' })
      : api(`/reports/schedules/${s.id}/status`, { method: 'POST', body: { status: op } }),
    onSuccess: (r, v) => {
      toast.success(v.op === 'run' ? `Delivered: ${(r as { messages: number }).messages} message(s), ${(r as { rows: number }).rows} rows` : 'Schedule updated')
      qc.invalidateQueries({ queryKey: ['reports', 'meta', meta.code] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title={`Schedule · ${meta.name}`} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} icon="CalendarClock">Save schedule</Button></>}>
      <p className="mb-3 text-sm text-ink-2">The report is rendered with the current filters and columns, attached as a file and delivered through the message outbox. Roles without access to this report are skipped.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className="mb-1 block text-xs font-medium text-ink-2">Name</span><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label><span className="mb-1 block text-xs font-medium text-ink-2">Frequency</span>
          <Select value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })}>{FREQS.map((x) => <option key={x}>{x}</option>)}</Select></label>
        <label><span className="mb-1 block text-xs font-medium text-ink-2">Send at</span><Input type="time" value={f.schedule_time} onChange={(e) => setF({ ...f, schedule_time: e.target.value })} /></label>
        {f.schedule === 'Weekly' && <label><span className="mb-1 block text-xs font-medium text-ink-2">Day of week</span>
          <Select value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>{WEEKDAYS.map((x) => <option key={x}>{x}</option>)}</Select></label>}
        {f.schedule === 'Monthly' && <label><span className="mb-1 block text-xs font-medium text-ink-2">Day of month</span>
          <Input type="number" min={1} max={28} value={f.month_day} onChange={(e) => setF({ ...f, month_day: Number(e.target.value) })} /></label>}
        <label><span className="mb-1 block text-xs font-medium text-ink-2">Report period</span>
          <Select value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>
            <option value="">Default ({f.schedule === 'Daily' ? 'yesterday' : f.schedule === 'Weekly' ? 'last 7 days' : 'last month'})</option>
            {SCHED_PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select></label>
        <label><span className="mb-1 block text-xs font-medium text-ink-2">Format</span>
          <Select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>{['Excel', 'CSV', 'PDF'].map((x) => <option key={x}>{x}</option>)}</Select></label>
        <label className="sm:col-span-2"><span className="mb-1 block text-xs font-medium text-ink-2">Email recipients</span>
          <Input value={f.recipients} onChange={(e) => setF({ ...f, recipients: e.target.value })} placeholder="cfo@hospital.in, accounts@hospital.in" /></label>
        <div className="sm:col-span-2"><span className="mb-1 block text-xs font-medium text-ink-2">Send to roles</span>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(roles).filter(([k]) => k !== 'employee').map(([k, label]) => (
              <button key={k} type="button" aria-pressed={f.roles.includes(k)} onClick={() => setF({ ...f, roles: f.roles.includes(k) ? f.roles.filter((r) => r !== k) : [...f.roles, k] })}
                className={cn('rounded-full border px-2.5 py-0.5 text-xs', f.roles.includes(k) ? 'border-brand-700 bg-brand-700 text-white' : 'border-line text-ink-2 hover:bg-surface-2')}>{label}</button>
            ))}
          </div></div>
      </div>
      {meta.schedules.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-1.5 text-sm font-semibold text-ink">Schedules for this report</h4>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {meta.schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{s.name} <StatusBadge status={s.status} /></p>
                  <p className="text-xs text-ink-3">{s.schedule} at {s.schedule_time}{s.weekday ? ` · ${s.weekday}` : ''}{s.month_day ? ` · day ${s.month_day}` : ''} · {s.format} · to {[...(s.recipients ?? []), ...(s.recipient_roles ?? [])].join(', ') || '—'}</p>
                  <p className="text-xs text-ink-3">Next {s.next_run_at ? dateTime(s.next_run_at) : '—'}{s.last_status ? ` · last: ${s.last_status}` : ''}{!s.mine && s.owner_name ? ` · by ${s.owner_name}` : ''}</p>
                </div>
                <Button size="xs" onClick={() => act.mutate({ s, op: 'run' })} disabled={act.isPending}><Play className="size-3" /> Run now</Button>
                <Button size="xs" onClick={() => act.mutate({ s, op: s.status === 'Active' ? 'Paused' : 'Active' })}>{s.status === 'Active' ? 'Pause' : 'Resume'}</Button>
                <Button size="xs" variant="ghost" onClick={() => act.mutate({ s, op: 'Archived' })} aria-label="Delete schedule"><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

function ViewsMenu({ meta, state, onApply }: { meta: ReportMeta; state: ViewState; onApply: (s: ViewState) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const save = useMutation({
    mutationFn: () => api(`/reports/${meta.code}/views`, { method: 'POST', body: { name, shared, state } }),
    onSuccess: () => { toast.success('View saved'); setName(''); qc.invalidateQueries({ queryKey: ['reports', 'meta', meta.code] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({
    mutationFn: (id: string) => api(`/reports/views/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports', 'meta', meta.code] }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Popover align="right" className="w-72" trigger={({ toggle }) => <Button size="sm" onClick={toggle}><Bookmark className="size-4" /> Views{meta.views.length ? ` (${meta.views.length})` : ''}</Button>}>
      {(close) => (
        <div>
          {meta.views.length ? meta.views.map((v) => (
            <div key={v.id} className="flex items-center">
              <MenuItem icon="Bookmark" onClick={() => { onApply(v.state); close() }} hint={v.shared ? 'shared' : undefined}>{v.name}</MenuItem>
              {v.mine && <button type="button" onClick={() => del.mutate(v.id)} className="mr-2 rounded p-1 text-ink-3 hover:text-red-600" aria-label={`Delete view ${v.name}`}><Trash2 className="size-3.5" /></button>}
            </div>
          )) : <p className="px-3 py-2 text-xs text-ink-3">No saved views yet.</p>}
          <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate() }}>
            <p className="mb-1 text-xs font-medium text-ink-2">Save current filters, columns and sort</p>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="View name" className="h-8" />
            <label className="mt-2 flex items-center gap-2 text-xs text-ink-2"><Switch checked={shared} onChange={setShared} size="sm" label="Share with my role" /> Share with my role</label>
            <Button size="sm" type="submit" variant="primary" className="mt-2 w-full" disabled={!name.trim()} loading={save.isPending}>Save view</Button>
          </form>
        </div>
      )}
    </Popover>
  )
}

interface PrintData { columns: ColDef[]; rows: Record<string, unknown>[]; totals: Record<string, number>; summary: RunResult['summary']; filters: string }

export default function ReportViewer() {
  const { code = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const metaQ = useQuery({ queryKey: ['reports', 'meta', code], queryFn: () => api<ReportMeta>(`/reports/${code}`), staleTime: 60_000 })
  const meta = metaQ.data
  const url = useReportUrl(meta)
  const [colPref, setColPref] = usePref<string[] | null>(`report:cols:${code}`, null)
  const [density, setDensity] = usePref<'comfortable' | 'compact'>('report:density', 'comfortable')
  const [chooser, setChooser] = useState(false)
  const [sched, setSched] = useState(false)
  const [full, setFull] = useState(false)
  const [printData, setPrintData] = useState<PrintData | null>(null)
  const [fresh, setFresh] = useState(0)
  const fav = useFavouriteReport()
  const cols = meta?.columns ?? []
  const visible = useMemo(() => {
    const valid = (colPref ?? []).filter((k) => cols.some((c) => c.key === k))
    return valid.length ? valid : cols.filter((c) => c.default).map((c) => c.key)
  }, [colPref, cols])
  const shown = visible.map((k) => cols.find((c) => c.key === k)!).filter(Boolean)
  const runQ = useQuery({
    queryKey: ['reports', 'run', code, url.applied, url.sort, url.page, url.limit, fresh],
    queryFn: () => api<RunResult>(`/reports/${code}/run`, { query: { ...url.applied, sort: url.sort, page: url.page, limit: url.limit, fresh: fresh ? 1 : undefined } }),
    enabled: !!meta,
    placeholderData: (p) => p,
  })
  const run = runQ.data
  useEffect(() => {
    if (!printData) return
    const t = setTimeout(() => { window.print(); setPrintData(null) }, 150)
    return () => clearTimeout(t)
  }, [printData])

  if (metaQ.isLoading) return <Spinner />
  if (metaQ.error || !meta) return <div className="space-y-3"><Link to="/reports" className="text-sm text-brand-700">← Reports Hub</Link><ErrorBox error={metaQ.error ?? 'Report not found'} /></div>

  const state: ViewState = { filters: url.applied, columns: visible, sort: url.sort || undefined, density, view: url.view }
  const applyView = (s: ViewState) => {
    url.replaceFilters(s.filters ?? {})
    if (s.columns?.length) setColPref(s.columns)
    if (s.density) setDensity(s.density)
    url.patch({ sort: s.sort ?? null, view: s.view ?? null })
  }
  const exportHref = (format: string) => apiUrl(`/reports/${code}/export`, { ...url.applied, format, cols: visible.join(','), sort: url.sort || undefined }, true)
  const doPrint = async () => {
    try {
      const d = await api<PrintData>(`/reports/${code}/export`, { query: { ...url.applied, format: 'json', cols: visible.join(','), sort: url.sort || undefined } })
      setPrintData(d)
    } catch (e) { toast.error(errorMessage(e)) }
  }
  const sortBy = (k: string) => url.patch({ sort: url.sort === k ? `-${k}` : url.sort === `-${k}` ? null : k })
  const pages = run ? Math.max(1, Math.ceil(run.total / run.limit)) : 1
  const pad = density === 'compact' ? 'py-1' : 'py-2'

  const table = run && (
    <div className={cn('overflow-auto scroll-thin', full ? 'max-h-[calc(100vh-140px)]' : 'max-h-[65vh]')}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-[1] bg-surface-2 text-[11px] uppercase tracking-wide text-ink-2">
          <tr>{shown.map((c) => (
            <th key={c.key} className={cn('whitespace-nowrap px-3 py-2 font-semibold', NUMERIC.has(c.type) ? 'text-right' : 'text-left')}
              aria-sort={url.sort === c.key ? 'ascending' : url.sort === `-${c.key}` ? 'descending' : 'none'}>
              <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 uppercase hover:text-ink">
                {c.label}{url.sort === c.key ? <ArrowUp className="size-3" /> : url.sort === `-${c.key}` ? <ArrowDown className="size-3" /> : null}
              </button>
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {run.rows.map((r, i) => (
            <tr key={i} className={cn('border-t border-line', typeof r._link === 'string' && 'cursor-pointer hover:bg-surface-2')}
              onClick={typeof r._link === 'string' ? () => nav(r._link as string) : undefined}>
              {shown.map((c) => <td key={c.key} className={cn('whitespace-nowrap px-3 text-ink', pad, NUMERIC.has(c.type) && 'text-right tabular-nums')}>{cellValue(r[c.key], c.type)}</td>)}
            </tr>
          ))}
          {!run.rows.length && <tr><td colSpan={shown.length} className="px-3 py-10 text-center text-ink-3">No rows for these filters.</td></tr>}
        </tbody>
        {run.rows.length > 0 && Object.keys(run.totals).some((k) => visible.includes(k)) && (
          <tfoot className="sticky bottom-0 bg-surface-2 font-semibold">
            <tr className="border-t-2 border-line-2">{shown.map((c, i) => (
              <td key={c.key} className={cn('whitespace-nowrap px-3 py-2 text-ink', NUMERIC.has(c.type) && 'text-right tabular-nums')}>
                {c.key in run.totals ? cellValue(run.totals[c.key], c.type) : i === 0 ? `Total (${number(run.total)} rows)` : ''}
              </td>
            ))}</tr>
          </tfoot>
        )}
      </table>
    </div>
  )

  return (
    <>
      <div className="space-y-3 print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Link to="/reports" className="mt-1 rounded-md p-1 text-ink-2 hover:bg-surface-2" aria-label="Back to Reports Hub"><ArrowLeft className="size-5" /></Link>
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><Icon name={meta.icon} className="size-5" /></span>
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">{meta.name}
                <button type="button" onClick={() => fav.mutate(meta.code, { onSuccess: () => qc.invalidateQueries({ queryKey: ['reports', 'meta', code] }) })}
                  aria-pressed={meta.favourite} aria-label={meta.favourite ? 'Remove from favourites' : 'Add to favourites'} className="text-ink-3 hover:text-amber-500">
                  <Star className={cn('size-5', meta.favourite && 'fill-amber-400 text-amber-500')} /></button>
                <Badge tone="gray" className="font-mono">{meta.code}</Badge></h1>
              <p className="mt-0.5 max-w-4xl text-sm text-ink-2">{meta.description}</p>
            </div>
          </div>
          <div className="no-print flex flex-wrap items-center gap-2">
            <ViewsMenu meta={meta} state={state} onApply={applyView} />
            <Button size="sm" onClick={() => navigator.clipboard?.writeText(window.location.href).then(() => toast.success('Link copied — it opens this report with these filters'))}><Copy className="size-4" /> Copy link</Button>
            <Button size="sm" onClick={() => setFresh((n) => n + 1)} loading={runQ.isFetching}><RefreshCw className="size-4" /> Refresh</Button>
            <Popover align="right" trigger={({ toggle }) => <Button size="sm" onClick={toggle}><Download className="size-4" /> Export <ChevronDown className="size-3.5" /></Button>}>
              {(close) => <>
                <a href={exportHref('csv')} onClick={close} download className="block"><MenuItem icon="FileText">CSV</MenuItem></a>
                <a href={exportHref('xlsx')} onClick={close} download className="block"><MenuItem icon="FileSpreadsheet">Excel (.xlsx, with totals)</MenuItem></a>
                <a href={exportHref('pdf')} onClick={close} download className="block"><MenuItem icon="FileDown">PDF</MenuItem></a>
              </>}
            </Popover>
            <Button size="sm" onClick={() => setSched(true)}><CalendarClock className="size-4" /> Schedule…</Button>
            <Button size="sm" onClick={doPrint}><Printer className="size-4" /> Print</Button>
          </div>
        </div>

        {meta.filters.length > 0 && <FilterBar meta={meta} applied={url.applied} onApply={(f) => url.replaceFilters(f)} />}
        {runQ.error && <ErrorBox error={runQ.error} />}
        {run && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
            {run.summary.map((s) => (
              <div key={s.label} className={cn('rounded-xl border border-line px-3 py-2', s.format === 'money' ? 'bg-emerald-50/60 dark:bg-emerald-500/5' : 'bg-surface')}>
                <p className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-3">{s.label}</p>
                <p className="text-lg font-semibold tabular-nums text-ink">{tileValue(s.value, s.format)}</p>
              </div>
            ))}
          </div>
        )}
        {run?.note && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">{run.note}</p>}

        <section className={cn('rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]', full && 'fixed inset-2 z-[60] flex flex-col')}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <p className="text-xs text-ink-2">{run ? <>Showing <b>{run.total ? (run.page - 1) * run.limit + 1 : 0}–{Math.min(run.total, run.page * run.limit)}</b> of <b>{number(run.total)}</b> rows · {run.period.label}</> : 'Loading…'}</p>
            <div className="flex flex-wrap items-center gap-2">
              {run?.chart && (
                <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5">
                  {(['table', 'chart'] as const).map((v) => <button key={v} type="button" aria-pressed={url.view === v} onClick={() => url.patch({ view: v === 'table' ? null : v }, false)}
                    className={cn('rounded-md px-2.5 py-1 text-xs font-medium capitalize', url.view === v ? 'bg-brand-900 text-white' : 'text-ink-2')}>{v}</button>)}
                </div>
              )}
              <Select value={density} onChange={(e) => setDensity(e.target.value as 'comfortable' | 'compact')} className="h-8 w-auto py-0 text-xs" aria-label="Row density">
                <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
              </Select>
              <Button size="sm" onClick={() => setChooser(true)}><Columns3 className="size-4" /> Columns {visible.length}/{cols.length}</Button>
              <button type="button" onClick={() => setFull(!full)} aria-label={full ? 'Exit full screen' : 'Full screen'} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2">
                {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
            </div>
          </div>
          {!run && runQ.isLoading && <Spinner />}
          {run && url.view === 'chart' && run.chart ? (
            <div className="p-4">
              <ChartView spec={run.chart} height={360} />
              {run.chart.truncated && <p className="mt-2 text-xs text-ink-3">Chart shows the first 60 rows.</p>}
              <details className="mt-3"><summary className="cursor-pointer text-xs text-ink-2">Chart data as a table</summary>
                <MiniTable {...chartTable(run.chart)} /></details>
            </div>
          ) : table}
          {run && run.total > run.limit && url.view !== 'chart' && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-3 py-2 text-xs text-ink-2">
              <span>Rows per page</span>
              <Select value={String(url.limit)} onChange={(e) => url.patch({ limit: e.target.value })} className="h-7 w-auto py-0 text-xs">{[25, 50, 100, 250].map((n) => <option key={n}>{n}</option>)}</Select>
              <span>Page {url.page} of {pages}</span>
              {[[ChevronsLeft, 1, 'First page'], [ChevronLeft, url.page - 1, 'Previous page'], [ChevronRight, url.page + 1, 'Next page'], [ChevronsRight, pages, 'Last page']].map(([I, p, l]) => {
                const Ico = I as typeof ChevronLeft
                const target = p as number
                return <button key={l as string} type="button" aria-label={l as string} disabled={target < 1 || target > pages || target === url.page}
                  onClick={() => url.patch({ page: target }, false)} className="rounded p-1 hover:bg-surface-2 disabled:opacity-30"><Ico className="size-4" /></button>
              })}
            </div>
          )}
        </section>
        {!run && !runQ.isLoading && !runQ.error && <Empty icon="FileBarChart" title="No data" />}
      </div>

      <ColumnChooser open={chooser} onClose={() => setChooser(false)} columns={cols} visible={visible} onChange={(v) => setColPref(v)} />
      {sched && <ScheduleModal meta={meta} open={sched} onClose={() => setSched(false)} state={state} />}

      {printData && (
        <div className="hidden print:block">
          <h1 className="text-lg font-bold">{meta.code} · {meta.name}</h1>
          <p className="text-xs">{meta.hospital} · {printData.filters} · {printData.rows.length} rows</p>
          <div className="my-2 flex flex-wrap gap-4 text-xs">{printData.summary.map((s) => <span key={s.label}><b>{s.label}:</b> {tileValue(s.value, s.format)}</span>)}</div>
          <table className="w-full border-collapse text-[10px]">
            <thead><tr>{printData.columns.map((c) => <th key={c.key} className={cn('border-b border-black px-1 py-0.5', NUMERIC.has(c.type) ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr></thead>
            <tbody>{printData.rows.map((r, i) => <tr key={i}>{printData.columns.map((c) => <td key={c.key} className={cn('border-b border-gray-300 px-1 py-0.5', NUMERIC.has(c.type) && 'text-right')}>{cellValue(r[c.key], c.type === 'status' ? 'text' : c.type)}</td>)}</tr>)}</tbody>
            {Object.keys(printData.totals).length > 0 && <tfoot><tr>{printData.columns.map((c, i) => <td key={c.key} className={cn('border-t border-black px-1 py-0.5 font-bold', NUMERIC.has(c.type) && 'text-right')}>
              {c.key in printData.totals ? cellValue(printData.totals[c.key], c.type) : i === 0 ? 'Total' : ''}</td>)}</tr></tfoot>}
          </table>
          <p className="mt-2 text-[9px]">Printed {new Date().toLocaleString('en-IN')}</p>
        </div>
      )}
    </>
  )
}
