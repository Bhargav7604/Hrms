import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { RecordFormModal, TransitionDialog, useEntity } from '@/components/records'
import {
  Badge, Button, cn, Drawer, Empty, ErrorBox, FieldWrap, Input, KeyValue, Select, Spinner, StatusBadge, Textarea, toneVariant,
  type BadgeTone,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useMeta, useRegistry } from '@/lib/auth'
import { dateTime, minutes, money, time } from '@/lib/format'
import type { Rec, TransitionDef } from '@/lib/types'
import type { BespokeProps } from './index'

type BedStatus = 'Vacant' | 'Occupied' | 'Reserved' | 'Cleaning' | 'Blocked' | 'Maintenance'
type Flag = 'discharge' | 'mlc' | 'isolation' | 'allergy' | 'critical' | 'transfer'

interface BoardBed {
  id: string
  bed_no: string
  room?: string | null
  category?: string | null
  rate?: number | null
  status: BedStatus
  status_since?: string | null
  minutes?: number | null
  patient: { id: string; name: string; uhid: string; age?: number | null; gender?: string | null } | null
  admission: {
    id: string; code: string; status: string; started_at?: string; los_days?: number | null; doctor?: string | null
    payer?: string | null; diagnosis?: string | null; isolation?: string | null; expected_los?: number | null; critical_results: number
  } | null
  flags: Flag[]
  allergies: string[]
  transfer?: { id: string; code: string; to_bed?: string; to_bed_no?: string; type?: string } | null
  reserved_for?: { id: string; name: string; uhid: string } | null
  reserved_ref?: string | null
  reserved_reason?: string | null
  turnaround?: { id: string; code: string; status: string; priority?: string } | null
  block_reason?: string | null
}

interface BoardWard {
  id: string; code: string; name: string; floor?: string | null; block?: string | null; ward_type?: string | null
  beds: BoardBed[]; counts: Partial<Record<BedStatus, number>>; occupancy_pct: number
}

interface Board {
  generated_at: string
  wards: BoardWard[]
  totals: {
    beds: number; by_status: Record<BedStatus, number>; usable: number; occupied: number; vacant: number; occupancy_pct: number
    discharges_pending: number; bed_requests_pending: number; avg_cleaning_minutes: number | null
  }
  filters: { wards: { id: string; code: string; name: string }[]; categories: string[] }
}

const STATUSES: BedStatus[] = ['Vacant', 'Occupied', 'Reserved', 'Cleaning', 'Blocked', 'Maintenance']

const TILE: Record<BedStatus, string> = {
  Vacant: 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-500/10',
  Occupied: 'border-sky-300 bg-sky-50/70 dark:border-sky-500/40 dark:bg-sky-500/10',
  Reserved: 'border-violet-300 bg-violet-50/70 dark:border-violet-500/40 dark:bg-violet-500/10',
  Cleaning: 'border-amber-300 bg-amber-50/80 dark:border-amber-500/40 dark:bg-amber-500/10',
  Blocked: 'border-red-300 bg-red-50/70 dark:border-red-500/40 dark:bg-red-500/10',
  Maintenance: 'border-slate-300 bg-slate-100 dark:border-slate-500/40 dark:bg-slate-500/15',
}
const DOT: Record<BedStatus, string> = {
  Vacant: 'bg-emerald-500', Occupied: 'bg-sky-500', Reserved: 'bg-violet-500', Cleaning: 'bg-amber-500', Blocked: 'bg-red-500', Maintenance: 'bg-slate-500',
}
const FLAG: Record<Flag, { short: string; label: string; tone: BadgeTone }> = {
  critical: { short: 'CRIT', label: 'Critical result awaiting acknowledgement', tone: 'red' },
  allergy: { short: 'ALG', label: 'Allergies recorded', tone: 'amber' },
  isolation: { short: 'ISO', label: 'Isolation precautions', tone: 'violet' },
  mlc: { short: 'MLC', label: 'Medico-legal case', tone: 'gray' },
  discharge: { short: 'DC', label: 'Discharge initiated', tone: 'blue' },
  transfer: { short: 'TRF', label: 'Transfer pending', tone: 'cyan' },
}
const FLAG_ORDER: Flag[] = ['critical', 'allergy', 'isolation', 'mlc', 'discharge', 'transfer']
const DISINFECTANTS = ['Detergent & water', 'Sodium hypochlorite 1%', 'Sodium hypochlorite 0.5%', 'Quaternary ammonium compound', 'Hydrogen peroxide', '70% alcohol']

function matches(b: BoardBed, q: string) {
  if (!q) return true
  return [b.bed_no, b.patient?.name, b.patient?.uhid, b.admission?.code, b.reserved_for?.name, b.admission?.doctor]
    .some((v) => v?.toLowerCase().includes(q))
}

export default function BedBoard(_: BespokeProps) {
  const [ward, setWard] = useState('')
  const [category, setCategory] = useState('')
  const [statuses, setStatuses] = useState<Set<BedStatus>>(new Set())
  const [flagOnly, setFlagOnly] = useState<Flag | ''>('')
  const [q, setQ] = useState('')
  const dq = useDeferredValue(q.trim().toLowerCase())
  const [openId, setOpenId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const board = useQuery({
    queryKey: ['x', 'ipd', 'board'],
    queryFn: () => api<Board>('/adt/board'),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  })

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const wards = useMemo(() => {
    const data = board.data?.wards ?? []
    return data
      .filter((w) => !ward || w.id === ward)
      .map((w) => ({
        ...w,
        shown: w.beds.filter((b) => (!category || b.category === category) && (!statuses.size || statuses.has(b.status))
          && (!flagOnly || b.flags.includes(flagOnly)) && matches(b, dq)),
      }))
      .filter((w) => w.shown.length > 0)
  }, [board.data, ward, category, statuses, flagOnly, dq])

  const bed = useMemo(() => {
    if (!openId) return null
    for (const w of board.data?.wards ?? []) {
      const b = w.beds.find((x) => x.id === openId)
      if (b) return { bed: b, ward: w }
    }
    return null
  }, [board.data, openId])

  const toggleStatus = (s: BedStatus) => setStatuses((cur) => {
    const n = new Set(cur)
    if (n.has(s)) n.delete(s); else n.add(s)
    return n
  })

  if (board.isLoading) return <Spinner label="Loading bed board…" />
  if (board.error) return <ErrorBox error={board.error} />
  const t = board.data!.totals
  const shownCount = wards.reduce((s, w) => s + w.shown.length, 0)

  return (
    <div className="space-y-4">
      <OccupancyStrip t={t} active={statuses} onToggle={toggleStatus}
        onDischarges={() => { setStatuses(new Set()); setFlagOnly('discharge') }} />

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8"
            placeholder="Bed, patient, UHID, IP no.  ( / )" aria-label="Search beds" />
        </div>
        <div className="w-56">
          <Select value={ward} onChange={(e) => setWard(e.target.value)} aria-label="Ward">
            <option value="">All wards</option>
            {board.data!.filters.wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </div>
        <div className="w-44">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Bed category">
            <option value="">All categories</option>
            {board.data!.filters.categories.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </div>
        <div className="w-56">
          <Select value={flagOnly} onChange={(e) => setFlagOnly(e.target.value as Flag | '')} aria-label="Flag">
            <option value="">Any flag</option>
            {FLAG_ORDER.map((f) => <option key={f} value={f}>{FLAG[f].label}</option>)}
          </Select>
        </div>
        {(statuses.size > 0 || flagOnly || ward || category || q) && (
          <Button size="sm" variant="ghost" icon="X" onClick={() => { setStatuses(new Set()); setFlagOnly(''); setWard(''); setCategory(''); setQ('') }}>Clear filters</Button>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-ink-3">
        <span>{shownCount} bed{shownCount === 1 ? '' : 's'} shown · flags: {FLAG_ORDER.map((f) => `${FLAG[f].short} = ${FLAG[f].label.toLowerCase()}`).join(' · ')}</span>
        <span className={cn('inline-flex items-center gap-1', board.isFetching && 'text-brand-700')}>
          <span className={cn('size-1.5 rounded-full', board.isFetching ? 'animate-pulse bg-brand-600' : 'bg-emerald-500')} />
          Live · updated {time(board.data!.generated_at)}
        </span>
      </div>

      {wards.length === 0 && <Empty icon="BedDouble" title="No beds match the filters" />}
      {wards.map((w) => (
        <section key={w.id || 'none'} className="rounded-xl border border-line bg-surface" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 320px' }}>
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-ink">{w.name} <span className="font-mono text-xs font-normal text-ink-3">{w.code}</span></h3>
              <p className="text-xs text-ink-3">{[w.ward_type, w.floor && `Floor ${w.floor}`, w.block && `Block ${w.block}`].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex items-center gap-3 text-xs text-ink-2">
              {STATUSES.filter((s) => w.counts[s]).map((s) => (
                <span key={s} className="inline-flex items-center gap-1"><span className={cn('size-2 rounded-full', DOT[s])} />{s} {w.counts[s]}</span>
              ))}
              <span className="inline-flex items-center gap-2 font-medium text-ink">
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line">
                  <span className="block h-full bg-sky-500" style={{ width: `${Math.min(100, w.occupancy_pct)}%` }} />
                </span>
                {w.occupancy_pct}%
              </span>
            </div>
          </header>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-1.5 p-2">
            {w.shown.map((b) => <BedTile key={b.id} bed={b} onOpen={setOpenId} />)}
          </div>
        </section>
      ))}

      {openId && (bed ? <BedPanel bed={bed.bed} wardName={bed.ward.name} onClose={() => setOpenId(null)} /> : null)}
    </div>
  )
}

function OccupancyStrip({ t, active, onToggle, onDischarges }: {
  t: Board['totals']; active: Set<BedStatus>; onToggle: (s: BedStatus) => void; onDischarges: () => void
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-ink-2">Occupancy</div>
          <div className="text-2xl font-semibold tracking-tight text-ink tabular">{t.occupancy_pct}%
            <span className="ml-2 text-sm font-normal text-ink-2">{t.occupied} of {t.usable} usable beds</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <button type="button" onClick={onDischarges} className="text-left hover:underline">
            <span className="text-xs text-ink-2">Discharges pending</span> <b className="tabular text-ink">{t.discharges_pending}</b>
          </button>
          <span><span className="text-xs text-ink-2">Bed requests waiting</span> <b className={cn('tabular', t.bed_requests_pending ? 'text-red-700 dark:text-red-300' : 'text-ink')}>{t.bed_requests_pending}</b></span>
          <span><span className="text-xs text-ink-2">Avg cleaning wait</span> <b className={cn('tabular', (t.avg_cleaning_minutes ?? 0) > 60 ? 'text-red-700 dark:text-red-300' : 'text-ink')}>{t.avg_cleaning_minutes != null ? minutes(t.avg_cleaning_minutes) : '—'}</b></span>
        </div>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line" role="img"
        aria-label={STATUSES.map((s) => `${s} ${t.by_status[s] ?? 0}`).join(', ')}>
        {STATUSES.map((s) => (t.by_status[s] ? (
          <span key={s} className={DOT[s]} style={{ width: `${(t.by_status[s] / Math.max(1, t.beds)) * 100}%` }} title={`${s}: ${t.by_status[s]}`} />
        ) : null))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Bed status legend — click to filter">
        {STATUSES.map((s) => (
          <button key={s} type="button" onClick={() => onToggle(s)} aria-pressed={active.has(s)}
            className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
              active.has(s) ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
            <span className={cn('size-2 rounded-full', DOT[s])} />{s}
            <span className="tabular opacity-80">{t.by_status[s] ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

const BedTile = memo(function BedTile({ bed: b, onOpen }: { bed: BoardBed; onOpen: (id: string) => void }) {
  const p = b.patient
  let line2: ReactNode = null
  let line3: ReactNode = null
  if (p) {
    line2 = <span className="block truncate font-medium text-ink">{p.name}</span>
    line3 = <span className="text-ink-2">D{b.admission?.los_days ?? 0}{p.age != null ? ` · ${p.age}y` : ''}{p.gender ? ` ${p.gender[0]}` : ''}</span>
  } else if (b.status === 'Reserved') {
    line2 = <span className="block truncate text-ink-2">for {b.reserved_for?.name ?? '—'}</span>
    line3 = <span className="text-ink-3">{b.reserved_ref ?? ''}</span>
  } else if (b.status === 'Cleaning') {
    line2 = <span className="block truncate text-amber-800 dark:text-amber-300">{b.turnaround ? b.turnaround.status : 'Awaiting'} · {minutes(b.minutes ?? 0)}</span>
    line3 = <span className="text-ink-3">{b.category}</span>
  } else if (b.status === 'Blocked' || b.status === 'Maintenance') {
    line2 = <span className="block truncate text-ink-2" title={b.block_reason ?? undefined}>{b.block_reason ?? '—'}</span>
    line3 = <span className="text-ink-3">{b.category}</span>
  } else {
    line2 = <span className="block truncate text-ink-3">{b.category}</span>
    line3 = <span className="text-ink-3">{b.rate ? money(b.rate, true) : ''}</span>
  }
  const critical = b.flags.includes('critical')
  return (
    <button type="button" onClick={() => onOpen(b.id)}
      aria-label={`Bed ${b.bed_no}, ${b.status}${p ? `, ${p.name}` : ''}`}
      className={cn('flex h-[72px] min-w-0 flex-col justify-between rounded-lg border px-2 py-1.5 text-left text-xs transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-600',
        TILE[b.status], critical && 'ring-2 ring-red-500/70')}>
      <span className="flex items-center justify-between gap-1">
        <span className="truncate font-mono text-[11px] font-semibold text-ink">{b.bed_no}</span>
        <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-2">
          <span className={cn('size-1.5 rounded-full', DOT[b.status])} />{b.status}
        </span>
      </span>
      {line2}
      <span className="flex items-center justify-between gap-1">
        <span className="truncate">{line3}</span>
        {b.flags.length > 0 && (
          <span className="flex shrink-0 gap-0.5">
            {FLAG_ORDER.filter((f) => b.flags.includes(f)).slice(0, 3).map((f) => (
              <span key={f} title={FLAG[f].label} className={cn('rounded px-1 text-[9px] font-bold leading-4',
                f === 'critical' ? 'bg-red-600 text-white' : f === 'allergy' ? 'bg-amber-500 text-white' : f === 'isolation' ? 'bg-violet-600 text-white'
                  : f === 'discharge' ? 'bg-sky-700 text-white' : f === 'transfer' ? 'bg-cyan-700 text-white' : 'bg-slate-600 text-white')}>
                {FLAG[f].short}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  )
})

// ------------------------------------------------------------------ side panel

function BedPanel({ bed: b, wardName, onClose }: { bed: BoardBed; wardName: string; onClose: () => void }) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const role = useMeta().data?.user.role ?? ''
  const admissions = useEntity('ipd.admissions')
  const transfers = useEntity('ipd.transfers')
  const [admit, setAdmit] = useState(false)
  const [transfer, setTransfer] = useState(false)
  const [tr, setTr] = useState<TransitionDef | null>(null)
  const canAdmit = reg.canEntity('ipd.admissions', 'write')
  const canBeds = reg.canEntity('ipd.beds', 'write') || role === 'admin'
  const canClean = ['support', 'nurse', 'front_office', 'admin'].includes(role)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['x', 'ipd'] }); qc.invalidateQueries({ queryKey: ['m', 'ipd'] }) }

  const adm = useQuery({
    queryKey: ['m', 'ipd', 'admissions', 'one', b.admission?.id],
    queryFn: () => api<Rec>(`/m/ipd/admissions/${b.admission!.id}`),
    enabled: !!b.admission,
  })

  return (
    <Drawer open onClose={onClose} width="max-w-xl"
      title={<span className="flex items-center gap-2">Bed {b.bed_no} <StatusBadge status={b.status} /></span>}
      subtitle={`${wardName}${b.room ? ` · Room ${b.room}` : ''} · ${b.category ?? ''}${b.rate ? ` · ${money(b.rate, true)}/day` : ''}`}>
      <div className="space-y-5 p-5">
        <p className="text-xs text-ink-3">In this status since {dateTime(b.status_since)}{b.minutes != null ? ` (${minutes(b.minutes)})` : ''}</p>

        {b.patient && b.admission && (
          <OccupiedSection bed={b} onTransfer={() => setTransfer(true)} onTransition={setTr} rec={adm.data} loading={adm.isLoading} canAdmit={canAdmit} refresh={refresh} />
        )}

        {(b.status === 'Vacant' || b.status === 'Reserved') && (
          <div className="space-y-3">
            {b.status === 'Reserved' && (
              <div className="rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm dark:border-violet-500/40 dark:bg-violet-500/10">
                Reserved for <b>{b.reserved_for?.name ?? 'a patient'}</b> {b.reserved_for?.uhid && <span className="font-mono text-xs">({b.reserved_for.uhid})</span>}
                <div className="mt-1 text-xs text-ink-2">{b.reserved_reason} {b.reserved_ref} — cancel that request to release the bed.</div>
              </div>
            )}
            {canAdmit && admissions && (
              <Button variant="primary" icon="UserPlus" onClick={() => setAdmit(true)}>
                Admit {b.status === 'Reserved' && b.reserved_for ? b.reserved_for.name : 'patient'} to {b.bed_no}
              </Button>
            )}
          </div>
        )}

        {b.status === 'Cleaning' && <CleaningSection bed={b} canClean={canClean} onDone={refresh} />}
        {(b.status === 'Vacant' || b.status === 'Cleaning' || b.status === 'Blocked' || b.status === 'Maintenance') && canBeds && (
          <ServiceSection bed={b} onDone={refresh} />
        )}
      </div>

      {admissions && admit && (
        <RecordFormModal entity={admissions} open onClose={() => setAdmit(false)} title={`Admit to bed ${b.bed_no}`}
          fixed={{ bed_id: b.id, ...(b.status === 'Reserved' && b.reserved_for ? { patient_id: b.reserved_for.id } : {}) }}
          onSaved={() => { refresh(); onClose() }} />
      )}
      {transfers && transfer && b.admission && b.patient && (
        <RecordFormModal entity={transfers} open onClose={() => setTransfer(false)} title={`Transfer ${b.patient.name} from ${b.bed_no}`}
          fixed={{ patient_id: b.patient.id, encounter_id: b.admission.id }} onSaved={() => refresh()} />
      )}
      {admissions && tr && adm.data && (
        <TransitionDialog entity={admissions} rec={adm.data} t={tr} onClose={() => setTr(null)}
          onDone={() => { setTr(null); refresh(); qc.invalidateQueries({ queryKey: ['m', 'ipd', 'admissions', 'one', b.admission?.id] }) }} />
      )}
    </Drawer>
  )
}

function OccupiedSection({ bed: b, rec, loading, onTransfer, onTransition, canAdmit, refresh }: {
  bed: BoardBed; rec?: Rec; loading: boolean; onTransfer: () => void; onTransition: (t: TransitionDef) => void; canAdmit: boolean; refresh: () => void
}) {
  const p = b.patient!
  const a = b.admission!
  const trf = useMutation({
    mutationFn: (to: 'Completed' | 'Cancelled') => api(`/m/ipd/transfers/${b.transfer!.id}/transition`, { method: 'POST', body: { to } }),
    onSuccess: (_, to) => { toast.success(to === 'Completed' ? `Moved to ${b.transfer?.to_bed_no ?? 'new bed'} — ${b.bed_no} sent for cleaning` : 'Transfer cancelled'); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const transitions = (rec?._transitions ?? []).filter((t) => t.to !== 'Discharged')
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-surface-2 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <Link to={`/patients/${p.id}`} className="text-base font-semibold text-ink hover:underline">{p.name}</Link>
            <div className="text-xs text-ink-2"><span className="font-mono">{p.uhid}</span>{p.age != null && ` · ${p.age}y`}{p.gender && ` ${p.gender}`}</div>
          </div>
          <StatusBadge status={a.status} />
        </div>
        {b.flags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {FLAG_ORDER.filter((f) => b.flags.includes(f)).map((f) => (
              <Badge key={f} tone={FLAG[f].tone}>{f === 'critical' ? `${a.critical_results} critical result${a.critical_results === 1 ? '' : 's'}` : f === 'isolation' && a.isolation && a.isolation !== 'None' ? `Isolation: ${a.isolation}` : FLAG[f].label}</Badge>
            ))}
          </div>
        )}
        {b.allergies.length > 0 && <p className="mt-2 text-xs font-medium text-red-700 dark:text-red-300">Allergies: {b.allergies.join(', ')}</p>}
      </div>
      <KeyValue cols={2} items={[
        { label: 'Admission', value: <Link className="font-mono text-brand-700 hover:underline dark:text-brand-300" to={`/ip/admissions/${a.id}`}>{a.code}</Link> },
        { label: 'Admitted', value: `${dateTime(a.started_at)} · day ${a.los_days ?? 0}${a.expected_los ? ` of ~${a.expected_los}` : ''}` },
        { label: 'Consultant', value: a.doctor ?? '—' },
        { label: 'Payer', value: a.payer ?? '—' },
        { label: 'Provisional diagnosis', value: a.diagnosis ?? '—', full: true },
      ]} />
      {b.transfer && (
        <div className="rounded-lg border border-cyan-300 bg-cyan-50 p-3 text-sm dark:border-cyan-500/40 dark:bg-cyan-500/10">
          <div><b>{b.transfer.code}</b> · {b.transfer.type} → bed <b>{b.transfer.to_bed_no ?? '—'}</b> (held)</div>
          {canAdmit && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="success" loading={trf.isPending && trf.variables === 'Completed'} onClick={() => trf.mutate('Completed')}>Complete transfer</Button>
              <Button size="sm" variant="ghost" loading={trf.isPending && trf.variables === 'Cancelled'} onClick={() => trf.mutate('Cancelled')}>Cancel</Button>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Link to={`/ip/admissions/${a.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-700 px-3 text-sm font-medium text-white shadow-sm hover:bg-brand-800">Open IP chart</Link>
        <Link to={`/m/orders/cpoe?patient=${p.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink shadow-sm hover:bg-surface-2">Order tests</Link>
        {a.status === 'Discharge Initiated' && (
          <Link to="/m/discharge/discharge-board" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink shadow-sm hover:bg-surface-2">Discharge board</Link>
        )}
        {canAdmit && a.status === 'Admitted' && !b.transfer && <Button size="sm" icon="ArrowRightLeft" onClick={onTransfer}>Transfer</Button>}
        {loading && <Spinner className="py-0" label="" />}
        {canAdmit && transitions.map((t) => (
          <Button key={t.to + t.label} size="sm" variant={toneVariant(t.tone)} onClick={() => onTransition(t)}>{t.label}</Button>
        ))}
      </div>
    </div>
  )
}

function CleaningSection({ bed: b, canClean, onDone }: { bed: BoardBed; canClean: boolean; onDone: () => void }) {
  const [disinfectant, setDisinfectant] = useState('Sodium hypochlorite 1%')
  const [remarks, setRemarks] = useState('')
  const clean = useMutation({
    mutationFn: () => api<{ requests: { code: string; turnaround_minutes?: number }[] }>(`/adt/beds/${b.id}/mark-clean`, {
      method: 'POST', body: { disinfectant, remarks: remarks || undefined },
    }),
    onSuccess: (r) => {
      const m = r.requests[0]?.turnaround_minutes
      toast.success(`Bed ${b.bed_no} is ready${m != null ? ` · turnaround ${minutes(m)}` : ''}`)
      onDone()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
      <div className="text-sm text-ink">
        Awaiting turnaround for <b>{minutes(b.minutes ?? 0)}</b>
        {b.turnaround && <> · <Link className="font-mono text-brand-700 hover:underline dark:text-brand-300" to={`/m/housekeeping/requests?r=${b.turnaround.id}`}>{b.turnaround.code}</Link> <StatusBadge status={b.turnaround.status} /></>}
      </div>
      {canClean ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <FieldWrap label="Disinfectant used">
              <Select value={disinfectant} onChange={(e) => setDisinfectant(e.target.value)}>
                {DISINFECTANTS.map((d) => <option key={d}>{d}</option>)}
              </Select>
            </FieldWrap>
            <FieldWrap label="Remarks"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" /></FieldWrap>
          </div>
          <Button variant="success" icon="CheckCheck" loading={clean.isPending} onClick={() => clean.mutate()}>Mark cleaned — bed ready</Button>
        </>
      ) : <p className="text-xs text-ink-2">Housekeeping or nursing staff mark the bed as cleaned.</p>}
    </div>
  )
}

function ServiceSection({ bed: b, onDone }: { bed: BoardBed; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'Blocked' | 'Maintenance'>('Blocked')
  const run = useMutation({
    mutationFn: (status: 'Vacant' | 'Blocked' | 'Maintenance') => api(`/adt/beds/${b.id}/status`, { method: 'POST', body: { status, reason: reason || undefined } }),
    onSuccess: (_, status) => { toast.success(status === 'Vacant' ? `Bed ${b.bed_no} released` : `Bed ${b.bed_no} marked ${status.toLowerCase()}`); setReason(''); onDone() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (b.status === 'Blocked' || b.status === 'Maintenance') {
    return (
      <div className="space-y-2 rounded-lg border border-line p-3">
        <p className="text-sm text-ink">Out of service: <b>{b.block_reason ?? '—'}</b></p>
        <Button size="sm" variant="primary" icon="LockOpen" loading={run.isPending} onClick={() => run.mutate('Vacant')}>Return to service</Button>
      </div>
    )
  }
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium text-ink-2">Take bed out of service…</summary>
      <div className="mt-3 space-y-2">
        <div className="flex gap-2">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'Blocked' | 'Maintenance')} className="max-w-40 shrink-0" aria-label="Mode">
            <option>Blocked</option><option>Maintenance</option>
          </Select>
          <Textarea rows={1} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required) — e.g. oxygen port leaking" />
        </div>
        <Button size="sm" variant="warning" loading={run.isPending} disabled={!reason.trim()} onClick={() => run.mutate(mode)}>Mark {mode.toLowerCase()}</Button>
      </div>
    </details>
  )
}
