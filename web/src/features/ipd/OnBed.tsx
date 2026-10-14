import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useDebounced } from '@/components/fields'
import { ExportMenu } from '@/components/list'
import { Badge, Button, cn, Empty, ErrorBox, Input, PageHeader, Select, Spinner, StatTile } from '@/components/ui'
import { api } from '@/lib/api'
import { date, moneyShort, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import { K, type TabKey } from './api'
import { Amount, ConditionPill } from './ui'

interface Row {
  id: string; code: string; status: string; discharging: boolean
  bed: { id: string; bed_no: string; category?: string | null }; ward: { id: string | null; name: string | null; floor?: string | null; block?: string | null }
  patient: { id: string; name: string; uhid: string; gender?: string | null; age?: number | null }
  started_at: string; los_days: number | null; doctor?: string | null; doctor_department?: string | null; condition: string; payer: string
  isolation?: string | null; accepted: boolean; billed?: number; collected?: number; balance?: number
}
interface Data {
  generated_at: string; rows: Row[]; count: number; money: boolean
  kpis: { on_bed: number; discharging: number; critical: number; awaiting_acceptance: number; billed?: number; collected?: number; balance_to_collect?: number; advance_held?: number }
  filters: { wards: { id: string; name: string; floor?: string | null }[]; floors: string[] }
  can: { tabs: Record<TabKey, boolean>; bill: boolean }
}

type SortKey = 'ward' | 'stay' | 'balance' | 'patient'

/** On Bed — every occupied bed right now, with stay, consultant, acuity and (for billing roles) the money position. */
export default function OnBed() {
  const [ward, setWard] = useState('')
  const [floor, setFloor] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('ward')
  const [only, setOnly] = useState<'' | 'discharging' | 'critical' | 'due'>('')
  const dq = useDebounced(q, 250)
  const search = useRef<HTMLInputElement>(null)
  const query = { ward, floor, q: dq }
  const res = useQuery({ queryKey: K.onBed(query), queryFn: () => api<Data>('/ipchart/on-bed', { query }), placeholderData: (p) => p, refetchInterval: 60_000 })
  useShortcuts('On bed', [{ keys: '/', label: 'Search', run: () => search.current?.focus() }, { keys: 'r', label: 'Refresh', run: () => res.refetch() }])
  const d = res.data
  const rows = useMemo(() => {
    let out = d?.rows ?? []
    if (only === 'discharging') out = out.filter((r) => r.discharging)
    if (only === 'critical') out = out.filter((r) => r.condition === 'Critical')
    if (only === 'due') out = out.filter((r) => (r.balance ?? 0) > 0)
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      ward: (a, b) => `${a.ward.name}`.localeCompare(`${b.ward.name}`) || a.bed.bed_no.localeCompare(b.bed.bed_no, undefined, { numeric: true }),
      stay: (a, b) => (b.los_days ?? 0) - (a.los_days ?? 0),
      balance: (a, b) => (b.balance ?? 0) - (a.balance ?? 0),
      patient: (a, b) => a.patient.name.localeCompare(b.patient.name),
    }
    return [...out].sort(by[sort])
  }, [d, only, sort])
  const wardsForFloor = (d?.filters.wards ?? []).filter((w) => !floor || String(w.floor) === floor)
  const th = (key: SortKey | null, label: string, right = false) => (
    <th className={cn('whitespace-nowrap px-3 py-2 font-semibold', right ? 'text-right' : 'text-left')}>
      {key ? <button type="button" className={cn('uppercase hover:text-ink', sort === key && 'text-ink underline')} onClick={() => setSort(key)}>{label}</button> : label}
    </th>
  )

  return (
    <div className="space-y-4">
      <PageHeader icon="Bed" title="On bed" subtitle="Patients physically occupying a bed right now."
        actions={<>
          <ExportMenu path="/ipchart/lists/on-bed" query={query} printTitle="On bed census" />
          <Button size="sm" icon="RefreshCw" loading={res.isFetching} onClick={() => res.refetch()}>Refresh</Button>
        </>} />
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-56" value={ward} onChange={(e) => setWard(e.target.value)} aria-label="Ward">
          <option value="">All wards</option>{wardsForFloor.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
        <Select className="w-36" value={floor} onChange={(e) => { setFloor(e.target.value); setWard('') }} aria-label="Floor">
          <option value="">All floors</option>{d?.filters.floors.map((f) => <option key={f} value={f}>{f === 'G' ? 'Ground' : `Floor ${f}`}</option>)}
        </Select>
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Patient, UHID, IP no, bed, consultant…  ( / )" className="pl-8" aria-label="Search" />
        </div>
        <Badge tone="blue">{d ? `${rows.length} on bed` : '…'}</Badge>
      </div>
      <div className={cn('grid gap-3', d?.money ? 'grid-cols-2 lg:grid-cols-6' : 'grid-cols-2 lg:grid-cols-4')}>
        <StatTile icon="BedDouble" label="On bed" value={d?.kpis.on_bed ?? '—'} onClick={() => setOnly('')} />
        <StatTile icon="LogOut" label="Discharging" value={d?.kpis.discharging ?? '—'} onClick={() => setOnly(only === 'discharging' ? '' : 'discharging')} />
        <StatTile icon="Siren" label="Critical" value={d?.kpis.critical ?? '—'} tone={d?.kpis.critical ? 'alert' : 'default'} onClick={() => setOnly(only === 'critical' ? '' : 'critical')} />
        <StatTile icon="UserCheck" label="Awaiting ward acceptance" value={d?.kpis.awaiting_acceptance ?? '—'} />
        {d?.money && <>
          <StatTile icon="Receipt" label="Billed" value={moneyShort(d.kpis.billed)} hint={`Collected ${moneyShort(d.kpis.collected)}`} />
          <StatTile icon="IndianRupee" label="Balance to collect" value={<span className="text-red-700 dark:text-red-300">{moneyShort(d.kpis.balance_to_collect)}</span>}
            hint={`Advance held ${moneyShort(d.kpis.advance_held)}`} onClick={() => setOnly(only === 'due' ? '' : 'due')} />
        </>}
      </div>
      {only && <div className="text-xs text-ink-2">Showing only <b>{only === 'due' ? 'patients with a balance due' : only}</b> · <button className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => setOnly('')}>show all</button></div>}

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="max-h-[70vh] overflow-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-[1] border-b border-line bg-surface-2 text-[11px] uppercase tracking-wide text-ink-3">
              <tr>
                {th('ward', 'Ward · bed')}{th('patient', 'Patient')}{th(null, 'IP no')}{th('stay', 'Stay')}{th(null, 'Consultant')}{th(null, 'Acuity')}
                {d?.money && <>{th(null, 'Bill total', true)}{th(null, 'Collected', true)}{th('balance', 'Balance', true)}</>}
                {th(null, 'Go to')}
              </tr>
            </thead>
            <tbody className={cn(res.isFetching && 'opacity-80')}>
              {rows.map((r) => (
                <tr key={r.id} className={cn('border-b border-line last:border-0 hover:bg-sky-50/60 dark:hover:bg-sky-500/5', r.condition === 'Critical' && 'border-l-4 border-l-red-500')}>
                  <td className="px-3 py-2"><span className="block max-w-56 truncate text-xs font-semibold uppercase text-ink" title={r.ward.name ?? ''}>{r.ward.name}</span>
                    <span className="text-xs text-ink-3">{[r.ward.floor ? `Floor ${r.ward.floor}` : null, `Bed ${r.bed.bed_no}`, r.bed.category].filter(Boolean).join(' · ')}</span></td>
                  <td className="px-3 py-2"><Link to={`/ip/admissions/${r.id}`} className="block font-medium text-ink hover:underline">{r.patient.name}</Link>
                    <span className="text-xs text-ink-3">{[r.patient.uhid, `${r.patient.age ?? '—'}${r.patient.age != null ? 'y' : ''} ${r.patient.gender?.[0] ?? ''}`].join(' · ')}</span></td>
                  <td className="whitespace-nowrap px-3 py-2"><span className="font-mono text-xs">{r.code}</span>
                    {r.discharging && <Badge tone="violet" className="ml-1">discharging</Badge>}
                    {r.isolation && r.isolation !== 'None' && <Badge tone="red" className="ml-1">{r.isolation}</Badge>}</td>
                  <td className="whitespace-nowrap px-3 py-2"><span className="block text-ink">{r.los_days === 0 ? 'today' : `${r.los_days} day${r.los_days === 1 ? '' : 's'}`}</span><span className="text-xs text-ink-3">from {date(r.started_at)}</span></td>
                  <td className="max-w-48 px-3 py-2"><span className="block truncate text-ink">{r.doctor ?? '—'}</span><span className="block truncate text-xs text-ink-3">{r.doctor_department}</span></td>
                  <td className="px-3 py-2">{r.condition === 'Not assessed' ? <span className="text-xs italic text-ink-3">not assessed</span> : <ConditionPill condition={r.condition} />}</td>
                  {d?.money && <>
                    <td className="px-3 py-2 text-right"><Amount v={r.billed} /></td>
                    <td className="px-3 py-2 text-right"><Amount v={r.collected} tone="paid" /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {(r.balance ?? 0) > 0 ? <Amount v={r.balance} tone="due" className="font-semibold" />
                        : (r.balance ?? 0) < 0 ? <span className="font-semibold text-sky-700 dark:text-sky-300">Adv <Amount v={-(r.balance ?? 0)} tone="adv" /></span>
                        : <Amount v={0} />}
                    </td>
                  </>}
                  <td className="whitespace-nowrap px-3 py-1"><GoTo r={r} can={d!.can} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.isLoading && <Spinner label="Loading census…" />}
          {res.error && <div className="p-4"><ErrorBox error={res.error} /></div>}
          {d && rows.length === 0 && <Empty icon="Bed" title="No occupied beds match">Change the ward, floor or search.</Empty>}
        </div>
        {d && <div className="border-t border-line px-3 py-2 text-xs text-ink-3">Updated {time(d.generated_at)} · refreshes every minute{d.money ? ' · Balance = billed − (payments on the stay\'s bills + unused advance)' : ''}</div>}
      </div>
    </div>
  )
}

function GoTo({ r, can }: { r: Row; can: Data['can'] }) {
  const base = `/ip/admissions/${r.id}`
  const links: { to: string; icon: string; label: string; cls: string; show: boolean }[] = [
    { to: base, icon: 'Stethoscope', label: 'Chart overview', cls: 'text-teal-700 dark:text-teal-300', show: true },
    { to: `${base}?tab=monitoring`, icon: 'HeartPulse', label: 'Monitoring & vitals', cls: 'text-pink-600 dark:text-pink-300', show: can.tabs.monitoring },
    { to: `${base}?tab=nursing`, icon: 'Activity', label: 'Nursing', cls: 'text-emerald-700 dark:text-emerald-300', show: can.tabs.nursing },
    { to: `${base}?tab=order_desk`, icon: 'ClipboardList', label: 'Order desk', cls: 'text-violet-700 dark:text-violet-300', show: can.tabs.order_desk },
    { to: `${base}?tab=investigations`, icon: 'FlaskConical', label: 'Investigations', cls: 'text-emerald-700 dark:text-emerald-300', show: can.tabs.investigations },
    { to: `/m/billing/billing-desk?patient=${r.patient.id}`, icon: 'Receipt', label: 'Bill', cls: 'text-orange-600 dark:text-orange-300', show: can.bill },
    { to: `/messages?compose=1&patient=${r.patient.id}&encounter=${r.id}`, icon: 'MessageSquare', label: 'Message about this patient', cls: 'text-ink-3', show: true },
  ]
  return (
    <span className="inline-flex items-center gap-0.5">
      {links.filter((l) => l.show).map((l) => (
        <Link key={l.label} to={l.to} title={l.label} aria-label={l.label} className={cn('grid size-7 place-items-center rounded-md hover:bg-surface-2', l.cls)}>
          <Icon name={l.icon} className="size-4" />
        </Link>
      ))}
    </span>
  )
}
