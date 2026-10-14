import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ColumnChooser, ExportMenu, Pager } from '@/components/list'
import { Button, cn, Empty, ErrorBox, Input, PageHeader, Select } from '@/components/ui'
import { api } from '@/lib/api'
import { todayISO } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { usePref } from '@/lib/prefs'
import { useShortcuts } from '@/lib/shortcuts'
import { format } from 'date-fns'
import {
  chartLink, erKey, liveMinutes, losState, useErSettings, useNow, type RolePerms, type TriageBrief, type VisitSummary,
} from './api'
import { Flags, StateBadge, TimeInEr, TRIAGE_DOT, TriagePill, UnmappedBadge } from './ui'

interface Tracking {
  generated_at: string
  kpis: { active: number; awaiting_billing: number; closed_today: number; breached: number }
  triage_counts: (TriageBrief & { count: number })[]
  not_triaged: number
  rows: VisitSummary[]
  total: number
  doctors: { id: string; name: string }[]
  outcomes: { value: string; label: string }[]
  permissions: RolePerms
}

const COLUMNS = [
  { key: 'sno', label: 'S.No' }, { key: 'bed', label: 'Bed' }, { key: 'er_no', label: 'ER no' }, { key: 'bill_no', label: 'Bill no' },
  { key: 'patient', label: 'Patient' }, { key: 'age_sex', label: 'Age / sex' }, { key: 'arrived', label: 'Arrived' },
  { key: 'time_in_er', label: 'Time in ER' }, { key: 'triage', label: 'Triage' }, { key: 'doctor', label: 'Doctor' },
  { key: 'current_step', label: 'Current step' }, { key: 'mlc', label: 'MLC' }, { key: 'status', label: 'Status' },
]

const blank = { state: '', triage: '', doctor: '', mlc: '', mapped: '', outcome: '', date_from: '', date_to: '' }
type Filters = typeof blank

const arrived = (iso?: string | null) => (iso ? format(new Date(iso), 'dd-MMM-yyyy hh:mm a') : '—')

export default function TrackingBoard({ embedded = false }: { embedded?: boolean }) {
  const settings = useErSettings()
  const nav = useNavigate()
  const now = useNow(30_000)
  const [f, setF] = useState<Filters>(blank)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const searchRef = useRef<HTMLInputElement>(null)
  const query = useMemo(() => ({ ...f, q: q.trim() || undefined }), [f, q])
  const data = useQuery({
    queryKey: erKey('tracking', query),
    queryFn: () => api<Tracking>('/er/visits', { query }),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  })
  const defaultCols = settings.data?.board.columns ?? COLUMNS.map((c) => c.key)
  const [cols, setCols] = usePref<string[] | null>('cols:er.tracking', null)
  const shown = (cols ?? defaultCols).filter((k) => COLUMNS.some((c) => c.key === k))
  useEffect(() => setPage(1), [query])
  const p = data.data?.permissions
  useShortcuts('ER tracking board', [
    { keys: '/', label: 'Search by ER no, UHID or name', run: () => searchRef.current?.focus() },
    { keys: 'r', label: 'Refresh', run: () => data.refetch() },
    ...(p?.register ? [{ keys: 'n', label: 'Register an ER patient', run: () => nav('/er/register') }] : []),
  ])

  const set = (k: keyof Filters, v: string) => setF((x) => ({ ...x, [k]: x[k] === v && (k === 'state' || k === 'triage') ? '' : v }))
  const rows = data.data?.rows ?? []
  const pageRows = rows.slice((page - 1) * limit, page * limit)
  const k = data.data?.kpis

  return (
    <div className="space-y-3">
      {!embedded && (
        <PageHeader icon="ClipboardList" title="Tracking board" subtitle="Every ER visit — where it is in the workflow, how long it has been, and what is pending."
          actions={<>
            {p?.board && <Link to="/er/board"><Button size="sm" icon="Siren">Ward board</Button></Link>}
            {p?.register && <Link to="/er/register"><Button size="sm" variant="primary" icon="UserPlus">Register patient</Button></Link>}
          </>} />
      )}
      {embedded && p?.register && (
        <div className="flex justify-end"><Link to="/er/register"><Button size="sm" variant="primary" icon="UserPlus">Register patient</Button></Link></div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon="Activity" label="Active" value={k?.active} active={f.state === 'Active'} onClick={() => set('state', 'Active')} />
        <Kpi icon="IndianRupee" label="Awaiting billing" value={k?.awaiting_billing} active={f.state === 'Awaiting billing'} onClick={() => set('state', 'Awaiting billing')} />
        <Kpi icon="CircleCheck" label="Closed today" value={k?.closed_today} active={f.state === 'Closed'}
          onClick={() => setF((x) => (x.state === 'Closed' ? { ...x, state: '', date_from: '', date_to: '' } : { ...x, state: 'Closed', date_from: todayISO(), date_to: todayISO() }))} />
        <Kpi icon="TimerOff" label="Waiting past triage target" value={k?.breached} alert={!!k?.breached} />
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Triage levels">
        {data.data?.triage_counts.map((t) => (
          <button key={t.key} type="button" onClick={() => set('triage', t.key)} aria-pressed={f.triage === t.key}
            className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
              f.triage === t.key ? 'border-brand-700 bg-brand-50 text-brand-900 dark:bg-brand-500/15 dark:text-brand-100' : 'border-line bg-surface text-ink-2 hover:text-ink')}>
            <span className={cn('size-2.5 rounded-full', TRIAGE_DOT[t.color ?? t.key])} />{t.label}<b className="tabular-nums text-ink">{t.count}</b>
          </button>
        ))}
        {!!data.data?.not_triaged && (
          <button type="button" onClick={() => set('triage', 'none')} aria-pressed={f.triage === 'none'}
            className={cn('rounded-full border px-3 py-1 text-xs font-medium', f.triage === 'none' ? 'border-brand-700 bg-brand-50' : 'border-line bg-surface text-ink-2')}>
            Not triaged <b className="text-ink">{data.data.not_triaged}</b>
          </button>
        )}
      </div>

      <section className="rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by ER no, UHID or name…  ( / )" className="pl-8" />
          </div>
          <Filter label="Status" value={f.state} onChange={(v) => setF({ ...f, state: v })} options={['Active', 'Awaiting billing', 'Closed']} />
          <Filter label="Triage" value={f.triage} onChange={(v) => setF({ ...f, triage: v })}
            options={[...(data.data?.triage_counts ?? []).map((t) => ({ value: t.key, label: t.label })), { value: 'none', label: 'Not triaged' }]} />
          <Filter label="Doctor" value={f.doctor} onChange={(v) => setF({ ...f, doctor: v })} options={(data.data?.doctors ?? []).map((d) => ({ value: d.id, label: d.name }))} />
          <Filter label="MLC" value={f.mlc} onChange={(v) => setF({ ...f, mlc: v })} options={[{ value: 'yes', label: 'MLC' }, { value: 'no', label: 'Non-MLC' }]} />
          <Filter label="UHID" value={f.mapped} onChange={(v) => setF({ ...f, mapped: v })} options={[{ value: 'yes', label: 'Mapped' }, { value: 'no', label: 'Not mapped' }]} />
          <Filter label="Outcome" value={f.outcome} onChange={(v) => setF({ ...f, outcome: v })} options={(data.data?.outcomes ?? []).map((o) => ({ value: o.value, label: o.label }))} />
          <label className="text-xs text-ink-2">
            <span className="mb-1 block font-medium">Arrived from</span>
            <Input type="date" className="h-9 w-38" value={f.date_from} max={f.date_to || undefined} onChange={(e) => setF({ ...f, date_from: e.target.value })} />
          </label>
          <label className="text-xs text-ink-2">
            <span className="mb-1 block font-medium">to</span>
            <Input type="date" className="h-9 w-38" value={f.date_to} min={f.date_from || undefined} onChange={(e) => setF({ ...f, date_to: e.target.value })} />
          </label>
          <Button size="sm" className="h-9" onClick={() => setF({ ...f, date_from: todayISO(), date_to: todayISO() })}>Today</Button>
          {JSON.stringify(f) !== JSON.stringify(blank) && <Button size="sm" variant="ghost" className="h-9" onClick={() => setF(blank)}>Clear</Button>}
          <div className="ml-auto flex items-center gap-2">
            <ExportMenu path="/er/visits" query={query} printTitle="ER tracking board" subtitle={f.date_from ? `${f.date_from} – ${f.date_to || f.date_from}` : 'Open visits and today'} />
            <ColumnChooser all={COLUMNS} value={shown} onChange={setCols} onReset={() => setCols(null)} />
          </div>
        </div>

        {data.error ? <div className="p-3"><ErrorBox error={data.error} /></div> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-ink-3">
                <tr>{shown.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-semibold">{COLUMNS.find((x) => x.key === c)?.label}</th>)}</tr>
              </thead>
              <tbody className={cn('divide-y divide-line', data.isFetching && 'opacity-80')}>
                {data.isLoading && Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>{shown.map((c) => <td key={c} className="px-3 py-3"><div className="h-3 animate-pulse rounded bg-surface-2" /></td>)}</tr>
                ))}
                {pageRows.map((v, i) => (
                  <tr key={v.id} tabIndex={0} onClick={() => nav(chartLink(v.id))} onKeyDown={(e) => { if (e.key === 'Enter') nav(chartLink(v.id)) }}
                    className="cursor-pointer hover:bg-surface-2 focus:bg-surface-2 focus:outline-none">
                    {shown.map((c) => <td key={c} className="whitespace-nowrap px-3 py-2">{cell(c, v, (page - 1) * limit + i + 1, now)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.isLoading && rows.length === 0 && (
              <Empty icon="ClipboardList" title="No ER visits match">Change the filters or the date range — without dates the board shows open visits and today's arrivals.</Empty>
            )}
          </div>
        )}
        <Pager page={page} limit={limit} total={rows.length} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1) }} fetching={data.isFetching} />
      </section>
    </div>
  )
}

function cell(c: string, v: VisitSummary, sno: number, now: number) {
  switch (c) {
    case 'sno': return <span className="text-ink-3">{sno}</span>
    case 'bed': return v.bed?.bed_no ?? '—'
    case 'er_no': return <span className="font-semibold text-ink">{v.code}</span>
    case 'bill_no': return v.bill?.code ?? '—'
    case 'patient': return (
      <span className="flex items-center gap-1.5">
        <span className="font-medium text-ink">{v.patient.name}</span>
        {v.patient.temporary && <UnmappedBadge />}
        <Flags flags={v.flags} only={['allergy', 'critical']} />
      </span>
    )
    case 'age_sex': return <span className="text-ink-2">{[v.patient.age !== null && v.patient.age !== undefined ? `${v.patient.age}Y` : null, v.patient.gender?.toUpperCase()].filter(Boolean).join('/') || '—'}</span>
    case 'arrived': return <span className="text-ink-2">{arrived(v.arrived_at)}</span>
    case 'time_in_er': {
      const m = liveMinutes(v, now)
      return <TimeInEr minutes={m} state={losState(m, v.los_target_minutes, v.state)} />
    }
    case 'triage': return <TriagePill triage={v.triage} />
    case 'doctor': return v.doctor?.name ?? '—'
    case 'current_step': return v.state === 'Closed' ? <span className="text-ink-2">{v.current_step.label}</span> : (
      <Link to={chartLink(v.id, panelFor(v.current_step.key))} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline dark:text-brand-300">{v.current_step.label}</Link>
    )
    case 'mlc': return v.mlc ? <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-300"><Icon name="ShieldAlert" className="size-3.5" />{v.mlc_no || 'MLC'}</span> : '—'
    case 'status': return <StateBadge state={v.state} />
    default: return null
  }
}

function panelFor(step: string | null): string | undefined {
  const map: Record<string, string> = {
    registration: 'registration', triage: 'triage', nursing_assessment: 'nursing-assessment', doctor_assignment: 'doctor-assignment',
    doctor_assessment: 'doctor-assessment', orders: 'investigations', treatment: 'treatment', disposition: 'disposition', billing: 'billing',
  }
  return step ? map[step] : undefined
}

function Kpi({ icon, label, value, active, onClick, alert }: { icon: string; label: string; value?: number; active?: boolean; onClick?: () => void; alert?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} aria-pressed={onClick ? active : undefined}
      className={cn('flex items-center gap-3 rounded-xl border bg-surface px-4 py-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
        active ? 'border-brand-700 ring-2 ring-brand-700/20' : alert ? 'border-red-300 dark:border-red-500/40' : 'border-line', onClick && 'hover:bg-surface-2')}>
      <span className={cn('grid size-9 place-items-center rounded-lg', alert ? 'bg-red-50 text-red-600 dark:bg-red-500/10' : 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300')}>
        <Icon name={icon} className="size-5" />
      </span>
      <span>
        <span className="block text-2xl font-semibold tabular-nums text-ink">{value ?? '—'}</span>
        <span className="text-xs text-ink-2">{label}</span>
      </span>
    </button>
  )
}

function Filter({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: (string | { value: string; label: string })[]
}) {
  return (
    <label className="text-xs text-ink-2">
      <span className="mb-1 block font-medium">{label}</span>
      <Select className="h-9 w-36" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </label>
  )
}
