import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { ExportMenu, Pager } from '@/components/list'
import { Avatar, Badge, Button, cn, CopyButton, Empty, ErrorBox, Input, PageHeader, Select, Spinner, StatusBadge } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { date, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import { K, type AdmissionRow } from './api'
import { ConditionPill, FilterTile } from './ui'

interface ListData {
  rows: AdmissionRow[]; total: number; page: number; limit: number
  kpis: { total: number; admitted: number; discharge_initiated: number; discharged: number; cancelled: number; critical: number; awaiting_acceptance: number }
  filters: { wards: { id: string; name: string }[]; sponsors: { id: string; name: string }[]; conditions: string[] }
  can: { admit: boolean; accept: boolean; documents: boolean; money: boolean }
}

const TILES = [
  { key: '', label: 'Total', icon: 'Users', tone: 'brand', kpi: 'total' },
  { key: 'Admitted', label: 'Admitted', icon: 'BedDouble', tone: 'green', kpi: 'admitted' },
  { key: 'Discharge Initiated', label: 'Discharge initiated', icon: 'Clock', tone: 'amber', kpi: 'discharge_initiated' },
  { key: 'Discharged', label: 'Discharged', icon: 'DoorOpen', tone: 'navy', kpi: 'discharged' },
] as const

/** Admissions (IP list): KPI filter tiles, filters, exports, ward acceptance and row actions. */
export default function AdmissionsList({ embedded = false }: { embedded?: boolean }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const dq = useDebounced(q, 300)
  const [f, setF] = useState({
    status: params.get('status') ?? '', ward: params.get('ward') ?? '', sponsor: params.get('sponsor') ?? '', acceptance: params.get('acceptance') ?? '',
    condition: params.get('condition') ?? '', date_from: params.get('from') ?? '', date_to: params.get('to') ?? '',
  })
  const [sort, setSort] = useState('-started_at')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => { setPage(1) }, [dq, f, sort, limit])
  useEffect(() => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ q: dq, status: f.status, ward: f.ward, sponsor: f.sponsor, acceptance: f.acceptance, condition: f.condition, from: f.date_from, to: f.date_to })) if (v) p.set(k, v)
    setParams(p, { replace: true })
  }, [dq, f, setParams])
  const query = { q: dq, ...f, sort, page, limit }
  const list = useQuery({ queryKey: K.list(query), queryFn: () => api<ListData>('/ipchart/admissions', { query }), placeholderData: (p) => p })
  const accept = useMutation({
    mutationFn: (id: string) => api(`/ipchart/admissions/${id}/accept`, { method: 'POST', body: {} }),
    onSuccess: () => { toast.success('Patient accepted on the ward'); qc.invalidateQueries({ queryKey: ['x', 'ipd'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  useShortcuts('Admissions', [
    { keys: '/', label: 'Search', run: () => search.current?.focus() },
    ...(list.data?.can.admit ? [{ keys: 'n', label: 'New admission', run: () => nav('/ip/admissions/new') }] : []),
  ])
  const d = list.data
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const sortBtn = (key: string, label: string) => (
    <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-ink" onClick={() => setSort(sort === `-${key}` ? key : `-${key}`)}>
      {label}{sort === key ? ' ↑' : sort === `-${key}` ? ' ↓' : ' ⇅'}
    </button>
  )
  const exportQuery = { q: dq, ...f, sort }

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader icon="BedDouble" title="Admissions" subtitle="Admit, track and discharge in-patients."
          actions={<>
            <Link to="/ip/on-bed" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2"><Icon name="Bed" className="size-4" /> On bed</Link>
            {d?.can.admit && <Button variant="primary" icon="Plus" onClick={() => nav('/ip/admissions/new')}>Admit patient</Button>}
          </>} />
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {TILES.map((t) => (
          <FilterTile key={t.label} label={t.label} icon={t.icon} tone={t.tone} value={d ? d.kpis[t.kpi] : '—'} active={f.status === t.key && !f.condition && !f.acceptance}
            onClick={() => setF((x) => ({ ...x, status: t.key, condition: '', acceptance: '' }))} />
        ))}
        <FilterTile label="Critical now" icon="Siren" tone="red" value={d?.kpis.critical ?? '—'} active={f.condition === 'Critical'}
          onClick={() => setF((x) => ({ ...x, condition: x.condition === 'Critical' ? '' : 'Critical', status: '' }))} />
        <FilterTile label="Awaiting ward acceptance" icon="UserCheck" tone="amber" value={d?.kpis.awaiting_acceptance ?? '—'} active={f.acceptance === 'pending'}
          onClick={() => setF((x) => ({ ...x, acceptance: x.acceptance === 'pending' ? '' : 'pending', status: '' }))} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search admission no, UHID, name, mobile…  ( / )" className="pl-8" aria-label="Search admissions" />
        </div>
        <Select className="w-44" value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">All statuses</option>{['Admitted', 'Discharge Initiated', 'Discharged', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Select className="w-48" value={f.ward} onChange={(e) => set('ward', e.target.value)} aria-label="Ward">
          <option value="">All wards</option>{d?.filters.wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
        <Select className="w-44" value={f.sponsor} onChange={(e) => set('sponsor', e.target.value)} aria-label="Sponsor">
          <option value="">All sponsors</option><option value="self">Self-pay / no sponsor</option>
          {d?.filters.sponsors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select className="w-44" value={f.acceptance} onChange={(e) => set('acceptance', e.target.value)} aria-label="Ward acceptance">
          <option value="">Acceptance: all</option><option value="accepted">Accepted</option><option value="pending">Awaiting acceptance</option>
        </Select>
        <Select className="w-40" value={f.condition} onChange={(e) => set('condition', e.target.value)} aria-label="Condition">
          <option value="">Any condition</option>{d?.filters.conditions.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <div className="flex items-center gap-1 text-xs text-ink-2">
          <Input type="date" value={f.date_from} onChange={(e) => set('date_from', e.target.value)} className="w-36" aria-label="Admitted from" />
          <span>–</span>
          <Input type="date" value={f.date_to} onChange={(e) => set('date_to', e.target.value)} className="w-36" aria-label="Admitted to" />
          <Button size="sm" variant="ghost" onClick={() => { const t = new Date().toISOString().slice(0, 10); setF((x) => ({ ...x, date_from: t, date_to: t })) }}>Today</Button>
        </div>
        <ExportMenu path="/ipchart/lists/admissions" query={exportQuery} printTitle="IP admissions" />
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left">S.No</th>
                <th className="px-3 py-2 text-left">{sortBtn('code', 'Admission no')}</th>
                <th className="px-3 py-2 text-left">{sortBtn('patient', 'Patient')}</th>
                <th className="px-3 py-2 text-left">{sortBtn('ward', 'Ward / bed')}</th>
                <th className="px-3 py-2 text-left">{sortBtn('payer', 'Category')}</th>
                <th className="px-3 py-2 text-left">Sponsor</th>
                <th className="px-3 py-2 text-left">{sortBtn('started_at', 'Admitted')}</th>
                <th className="px-3 py-2 text-left">Condition</th>
                <th className="px-3 py-2 text-left">{sortBtn('status', 'Status')}</th>
                <th className="px-3 py-2 text-left">Ward acceptance</th>
                <th className="px-3 py-2 text-right"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className={cn(list.isFetching && 'opacity-70')}>
              {d?.rows.map((r, i) => {
                const open = r.status === 'Admitted' || r.status === 'Discharge Initiated'
                return (
                  <tr key={r.id} className={cn('border-b border-line last:border-0 hover:bg-surface-2', r.condition === 'Critical' && open && 'border-l-4 border-l-red-500 bg-red-50/40 dark:bg-red-500/5')}>
                    <td className="px-3 py-2 text-ink-3 tabular-nums">{(page - 1) * limit + i + 1}</td>
                    <td className="whitespace-nowrap px-3 py-2"><span className="inline-flex items-center gap-1"><Link to={`/ip/admissions/${r.id}`} className="font-mono text-xs font-medium text-ink hover:underline">{r.code}</Link><CopyButton value={r.code} label="Copy admission no" /></span></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar name={r.patient.name} size="sm" />
                        <div className="min-w-0">
                          <Link to={`/ip/admissions/${r.id}`} className="block truncate font-medium text-ink hover:underline">{r.patient.name}</Link>
                          <span className="block truncate text-xs text-ink-3">{[r.patient.uhid, r.patient.age != null ? `${r.patient.age}y` : null, r.patient.gender?.[0], r.patient.phone].filter(Boolean).join(' · ')}</span>
                        </div>
                      </div>
                    </td>
                    <td className="max-w-52 px-3 py-2"><span className="block truncate text-ink" title={r.ward.name ?? ''}>{r.ward.name ?? '—'}</span><span className="text-xs text-ink-3">{r.bed_no ? `Bed ${r.bed_no}` : '—'}</span></td>
                    <td className="px-3 py-2"><Badge tone={r.payer === 'Cash' ? 'gray' : r.payer === 'Corporate' ? 'violet' : 'blue'}>{r.payer_label}</Badge></td>
                    <td className="max-w-44 truncate px-3 py-2 text-ink-2" title={r.sponsor?.name}>{r.sponsor?.name ?? 'Self-pay'}</td>
                    <td className="whitespace-nowrap px-3 py-2"><span className="block text-ink">{date(r.started_at)}</span><span className="text-xs text-ink-3">{time(r.started_at)}{r.los_days != null ? ` · ${r.los_days === 0 ? 'today' : `${r.los_days}d`}` : ''}</span></td>
                    <td className="px-3 py-2">{open ? <ConditionPill condition={r.condition} /> : <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} />{r.discharge_type && r.discharge_type !== 'Routine' && <Badge tone="red" className="ml-1">{r.discharge_type}</Badge>}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.accepted_at ? (
                        <span><Badge tone="green"><Icon name="Check" className="size-3" /> Accepted</Badge><span className="mt-0.5 block text-[11px] text-ink-3">by {r.accepted_by} · {time(r.accepted_at)}</span></span>
                      ) : open && d.can.accept ? (
                        <Button size="xs" variant="secondary" icon="UserCheck" loading={accept.isPending && accept.variables === r.id} onClick={() => accept.mutate(r.id)}>Accept patient</Button>
                      ) : open ? <Badge tone="amber">Awaiting</Badge> : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-0.5">
                        <IconLink to={`/ip/admissions/${r.id}`} icon="FileHeart" label="Open IP chart" />
                        {d.can.documents && <IconLink to={`/ip/admissions/${r.id}?tab=documents`} icon="FolderUp" label="Documents" />}
                        <a href={`/ip/admissions/${r.id}/print/wristband`} target="_blank" rel="noreferrer" title="Print wristband (QR)" aria-label="Print wristband"
                          className="grid size-7 place-items-center rounded-md text-violet-700 hover:bg-surface-2 dark:text-violet-300"><Icon name="QrCode" className="size-4" /></a>
                        <a href={`/ip/admissions/${r.id}/print/face-sheet`} target="_blank" rel="noreferrer" title="Print face sheet" aria-label="Print face sheet"
                          className="grid size-7 place-items-center rounded-md text-emerald-700 hover:bg-surface-2 dark:text-emerald-300"><Icon name="FileText" className="size-4" /></a>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {list.isLoading && <Spinner />}
        {list.error && <div className="p-4"><ErrorBox error={list.error} /></div>}
        {d && d.rows.length === 0 && <Empty icon="BedDouble" title="No admissions match these filters">Clear a filter or widen the date range.</Empty>}
        {d && <Pager page={page} limit={limit} total={d.total} onPage={setPage} onLimit={setLimit} fetching={list.isFetching} />}
      </div>
    </div>
  )
}

function IconLink({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <Link to={to} title={label} aria-label={label} className="grid size-7 place-items-center rounded-md text-brand-700 hover:bg-surface-2 dark:text-brand-300">
      <Icon name={icon} className="size-4" />
    </Link>
  )
}
