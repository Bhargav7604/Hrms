import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Badge, Button, cn, Drawer, Empty, ErrorBox, Input, PageHeader, Select, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import {
  chartLink, clockState, erKey, hm, liveMinutes, losState, useErSettings, useNow, type RolePerms, type VisitSummary,
} from './api'
import { MoveBedDialog } from './dialogs'
import { ACTIONS, ActionGlyph, Flags, StateBadge, TimeInEr, TRIAGE_BORDER, TriagePill, UnmappedBadge, type ActionDef } from './ui'

interface Tile {
  id: string; bed_no: string; category?: string | null; status: string; status_since?: string | null; minutes?: number | null
  block_reason?: string | null; visit: VisitSummary | null
}
interface Board {
  generated_at: string
  wards: { id: string; code: string; name: string }[]
  ward_id: string | null
  beds: Tile[]
  unbedded: VisitSummary[]
  counts: { occupied: number; vacant: number; cleaning: number; reserved: number; blocked: number; total: number; active_visits: number; waiting_for_bed: number }
  permissions: RolePerms
}

/** Which board actions a role can use (strict visibility). */
export function actionAllowed(key: string, p: RolePerms): boolean {
  switch (key) {
    case 'add_details': return p.details
    case 'order_medicine': return p.orders
    case 'investigations': return p.orders || p.view_clinical
    case 'patient_movement': return p.move_bed
    case 'doctor_visit': return p.treatment
    case 'documents': return p.documents || p.view_clinical
    default: return p.view_clinical
  }
}

function actionHref(a: string, id: string): string | null {
  switch (a) {
    case 'assessment': return chartLink(id, 'doctor-assessment')
    case 'discharge_summary': return `/er/visits/${id}/print?doc=discharge-summary`
    case 'lab_reports': return chartLink(id, 'lab')
    case 'pacs': return chartLink(id, 'radiology')
    case 'admission_notes': return chartLink(id, 'disposition')
    case 'add_details': return chartLink(id, 'registration', { edit: 'details' })
    case 'order_medicine': return chartLink(id, 'medicines')
    case 'investigations': return chartLink(id, 'investigations')
    case 'doctor_visit': return chartLink(id, 'treatment', { type: 'Doctor visit' })
    case 'initial_assessment': return chartLink(id, 'nursing-assessment')
    case 'documents': return chartLink(id, 'documents')
    default: return null
  }
}

const BED_STATUS_STYLE: Record<string, string> = {
  Vacant: 'border-dashed border-emerald-300 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-500/5',
  Cleaning: 'border-amber-300 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10',
  Reserved: 'border-violet-300 bg-violet-50/60 dark:border-violet-500/30 dark:bg-violet-500/10',
  Blocked: 'border-red-300 bg-red-50/60 dark:border-red-500/30 dark:bg-red-500/10',
  Maintenance: 'border-slate-300 bg-slate-100 dark:border-slate-500/30 dark:bg-slate-500/10',
}

function matches(v: VisitSummary | null | undefined, bed: string, q: string) {
  if (!q) return true
  return [bed, v?.patient.name, v?.patient.uhid, v?.code, v?.doctor?.name, v?.chief_complaint].some((x) => x?.toLowerCase().includes(q))
}

export default function WardBoard({ embedded = false }: { embedded?: boolean }) {
  const settings = useErSettings()
  const [ward, setWard] = useState('')
  const [q, setQ] = useState('')
  const dq = useDeferredValue(q.trim().toLowerCase())
  const [move, setMove] = useState<VisitSummary | null>(null)
  const [handover, setHandover] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const nav = useNavigate()
  const now = useNow(30_000)
  const refreshMs = (settings.data?.board.refresh_seconds ?? 60) * 1000
  const board = useQuery({
    queryKey: erKey('board', ward || 'default'),
    queryFn: () => api<Board>('/er/board', { query: { ward: ward || undefined } }),
    refetchInterval: refreshMs,
    placeholderData: (prev) => prev,
  })
  const p = board.data?.permissions
  useShortcuts('ER ward board', [
    { keys: '/', label: 'Search beds and patients', run: () => searchRef.current?.focus() },
    { keys: 'r', label: 'Refresh', run: () => board.refetch() },
    ...(p?.register ? [{ keys: 'n', label: 'Register an ER patient', run: () => nav('/er/register') }] : []),
  ])
  const actions = useMemo(() => {
    const enabled = settings.data?.board.actions ?? ACTIONS.map((a) => a.key)
    return ACTIONS.filter((a) => enabled.includes(a.key) && p && actionAllowed(a.key, p))
  }, [settings.data, p])

  if (board.isLoading) return <BoardSkeleton />
  if (board.error) return <ErrorBox error={board.error} />
  const d = board.data!
  const tiles = d.beds.filter((b) => matches(b.visit, b.bed_no, dq))
  const waiting = d.unbedded.filter((v) => matches(v, '', dq))

  const counters = (
    <div className="flex flex-wrap items-center gap-2">
      <Counter label="Occupied beds" value={d.counts.occupied} tone="sky" />
      <Counter label="Vacant beds" value={d.counts.vacant} tone="emerald" />
      {d.counts.cleaning > 0 && <Counter label="Cleaning" value={d.counts.cleaning} tone="amber" />}
      <Counter label="Waiting for a bed" value={d.counts.waiting_for_bed} tone="slate" />
    </div>
  )
  const buttons = (
    <>
      {p?.view_clinical && <Button size="sm" icon="ArrowLeftRight" onClick={() => setHandover(true)}>S-BAR handover</Button>}
      {p?.tracking && <Link to="/er/tracking"><Button size="sm" icon="ClipboardList">Tracking board</Button></Link>}
      {p?.settings && <Link to="/er/settings" aria-label="ER settings"><Button size="sm" variant="ghost" icon="Settings2"><span className="sr-only">Settings</span></Button></Link>}
      {p?.register && <Link to="/er/register"><Button size="sm" variant="primary" icon="UserPlus">Register patient</Button></Link>}
    </>
  )

  return (
    <div className="space-y-3">
      {!embedded && <PageHeader icon="Siren" title="Emergency" subtitle="Bed-wise ER board — triage, time in ER, current step and bedside actions." actions={buttons} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {counters}
        {embedded && <div className="flex flex-wrap items-center gap-2">{buttons}</div>}
      </div>

      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-ink-2" aria-label="Action legend">
          {actions.map((a) => (
            <span key={a.key} className="inline-flex items-center gap-1">
              <ActionGlyph a={a} className="text-brand-700 dark:text-brand-300 ring-1 ring-line" /> {a.label}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-56">
          <span className="mb-1 block text-xs font-medium text-ink-2">Ward</span>
          <Select value={ward || d.ward_id || ''} onChange={(e) => setWard(e.target.value)}>
            {d.wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </label>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bed, patient, UHID, ER no…  ( / )" className="pl-8" />
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          Updated {time(d.generated_at)}
          <Button size="sm" icon="RefreshCw" loading={board.isFetching} onClick={() => board.refetch()}>Refresh</Button>
        </div>
      </div>

      {d.wards.length === 0 ? (
        <Empty icon="Siren" title="No emergency ward configured">Create a ward of type Emergency with ER beds in Masters.</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {tiles.map((b) => b.visit
            ? <OccupiedTile key={b.id} bed={b} v={b.visit} now={now} actions={actions} onMove={() => setMove(b.visit)} />
            : <BedTile key={b.id} bed={b} canRegister={!!p?.register} />)}
          {tiles.length === 0 && <div className="col-span-full"><Empty icon="SearchX" title="No bed matches the search" /></div>}
        </div>
      )}

      {waiting.length > 0 && (
        <section className="rounded-xl border border-line bg-surface">
          <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Icon name="Armchair" className="size-4 text-brand-700" />In the ER without a bed <Badge>{waiting.length}</Badge></h3>
            <span className="text-xs text-ink-3">Triage area, trolleys and chairs</span>
          </header>
          <ul className="divide-y divide-line">
            {waiting.map((v) => {
              const mins = liveMinutes(v, now)
              return (
                <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
                  <Link to={chartLink(v.id)} className="min-w-48 font-medium text-ink hover:text-brand-700 hover:underline">{v.patient.name}</Link>
                  {v.patient.temporary && <UnmappedBadge />}
                  <span className="text-xs text-ink-3">{v.code} · {[v.patient.age !== null && v.patient.age !== undefined ? `${v.patient.age}y` : null, v.patient.gender?.[0]].filter(Boolean).join('/')}</span>
                  <TriagePill triage={v.triage} short />
                  <TimeInEr minutes={mins} state={losState(mins, v.los_target_minutes, v.state)} />
                  <span className="text-xs text-ink-2">Now: {v.current_step.label}</span>
                  <Flags flags={v.flags} />
                  <span className="ml-auto flex items-center gap-2">
                    {p?.move_bed && <Button size="xs" icon="BedDouble" onClick={() => setMove(v)}>Assign bed</Button>}
                    <Link to={chartLink(v.id)}><Button size="xs" variant="ghost" icon="ChevronRight">Open</Button></Link>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {move && <MoveBedDialog visit={move} open onClose={() => setMove(null)} />}
      {handover && <HandoverSheet onClose={() => setHandover(false)} />}
    </div>
  )
}

function Counter({ label, value, tone }: { label: string; value: number; tone: 'sky' | 'emerald' | 'amber' | 'slate' }) {
  const t = {
    sky: 'bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-200',
    emerald: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-200',
    slate: 'bg-surface-2 text-ink-2 ring-line',
  }[tone]
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-inset', t)}>
      {label} <span className="text-lg font-semibold tabular-nums">{value}</span>
    </span>
  )
}

function BedTile({ bed, canRegister }: { bed: Tile; canRegister: boolean }) {
  return (
    <div className={cn('flex min-h-36 flex-col justify-between rounded-xl border p-3', BED_STATUS_STYLE[bed.status] ?? 'border-line bg-surface')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-base font-semibold text-ink">{bed.bed_no}</span>
        <Badge tone={bed.status === 'Vacant' ? 'green' : bed.status === 'Cleaning' ? 'amber' : bed.status === 'Reserved' ? 'violet' : 'red'} dot>{bed.status}</Badge>
      </div>
      <div className="text-xs text-ink-3">
        {bed.status === 'Vacant' ? 'Ready for a patient' : bed.block_reason ?? (bed.minutes !== null && bed.minutes !== undefined ? `for ${hm(bed.minutes)}` : '')}
      </div>
      {bed.status === 'Vacant' && canRegister && (
        <Link to={`/er/register?bed=${bed.id}`} className="inline-flex items-center gap-1 self-start text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
          <Icon name="UserPlus" className="size-4" /> Register here
        </Link>
      )}
    </div>
  )
}

function OccupiedTile({ bed, v, now, actions, onMove }: { bed: Tile; v: VisitSummary; now: number; actions: ActionDef[]; onMove: () => void }) {
  const mins = liveMinutes(v, now)
  const los = losState(mins, v.los_target_minutes, v.state)
  const clock = clockState(v, now)
  const pct = Math.round((v.progress.done / v.progress.total) * 100)
  return (
    <article className={cn('flex flex-col rounded-xl border border-l-4 border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
      v.triage ? TRIAGE_BORDER[v.triage.color ?? v.triage.key] : 'border-l-slate-300')}>
      <Link to={chartLink(v.id)} className="block flex-1 rounded-t-xl p-3 hover:bg-surface-2/60">
        <div className="flex items-start justify-between gap-2">
          <span className="text-base font-semibold text-ink">{bed.bed_no}</span>
          <span className="flex flex-col items-end gap-1">
            <TriagePill triage={v.triage} short />
            <span className="text-xs text-ink-3">in ER <TimeInEr minutes={mins} state={los} className="text-sm" /></span>
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-ink">{v.patient.name}</span>
          {v.patient.temporary && <UnmappedBadge />}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-3">
          {[v.patient.age !== null && v.patient.age !== undefined ? `${v.patient.age}y` : null, v.patient.gender].filter(Boolean).join(' · ')} · {v.code}
          {v.doctor?.name && <> · {v.doctor.name}</>}
        </div>
        {v.chief_complaint && <div className="mt-1 line-clamp-1 text-xs text-ink-2">{v.chief_complaint}</div>}
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line">
            <span className="block h-full rounded-full bg-brand-700" style={{ width: `${pct}%` }} />
          </span>
          <span className="tabular-nums text-ink-3">{v.progress.done}/{v.progress.total}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
          <span className="text-xs text-ink-2">Now: <b className="font-medium text-ink">{v.current_step.label}</b></span>
          <span className="flex items-center gap-1">
            {clock === 'breached' && <Badge tone="red">Wait over target</Badge>}
            <Flags flags={v.flags} only={['mlc', 'allergy', 'critical']} />
          </span>
        </div>
      </Link>
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-0.5 border-t border-line px-1.5 py-1">
          {actions.map((a) => {
            const href = actionHref(a.key, v.id)
            const cls = 'grid size-7 place-items-center rounded-md text-ink-2 hover:bg-brand-50 hover:text-brand-800 dark:hover:bg-brand-500/15 dark:hover:text-brand-200'
            if (a.key === 'patient_movement') {
              return <button key={a.key} type="button" title={a.label} aria-label={`${a.label} — ${v.patient.name}`} onClick={onMove} className={cls}><ActionGlyph a={a} /></button>
            }
            if (!href) return null
            return (
              <Link key={a.key} to={href} title={a.label} aria-label={`${a.label} — ${v.patient.name}`} className={cls}
                target={a.key === 'discharge_summary' ? '_blank' : undefined}>
                <ActionGlyph a={a} />
              </Link>
            )
          })}
        </div>
      )}
    </article>
  )
}

function BoardSkeleton() {
  return (
    <div className="space-y-3" aria-busy>
      <div className="h-9 w-80 animate-pulse rounded-lg bg-surface-2" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-40 animate-pulse rounded-xl bg-surface-2" />)}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ S-BAR handover sheet

function HandoverSheet({ onClose }: { onClose: () => void }) {
  const now = useNow(60_000)
  const q = useQuery({ queryKey: erKey('handover'), queryFn: () => api<{ generated_at: string; rows: VisitSummary[] }>('/er/handover') })
  return (
    <Drawer open onClose={onClose} width="max-w-4xl" title="S-BAR shift handover" subtitle="Every patient in the ER with the last handover given"
      headerExtra={<Link to="/er/handover/print" target="_blank"><Button size="sm" icon="Printer">Print</Button></Link>}>
      {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !q.data?.rows.length ? (
        <Empty icon="Siren" title="No patients in the ER" />
      ) : (
        <ul className="divide-y divide-line">
          {q.data.rows.map((v) => {
            const h = v.last_handover
            const mins = liveMinutes(v, now)
            return (
              <li key={v.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{v.bed?.bed_no ?? 'No bed'}</span>
                  <Link to={chartLink(v.id, 'handover')} className="font-medium text-ink hover:text-brand-700 hover:underline">{v.patient.name}</Link>
                  <span className="text-xs text-ink-3">{v.code}</span>
                  <TriagePill triage={v.triage} short />
                  <StateBadge state={v.state} />
                  <span className="ml-auto text-xs text-ink-3">in ER {hm(mins)} · Now: {v.current_step.label}</span>
                </div>
                {h ? (
                  <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                    {(['situation', 'background', 'assessment', 'recommendation'] as const).map((k) => (
                      <div key={k}><dt className="text-[11px] font-semibold uppercase text-ink-3">{k[0].toUpperCase()} · {k}</dt><dd className="whitespace-pre-wrap text-ink">{h[k] || '—'}</dd></div>
                    ))}
                    <div className="text-xs text-ink-3 sm:col-span-2">{h.shift} shift · {dateTime(h.handover_at)} · {h.status}</div>
                  </dl>
                ) : <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">No handover recorded for this patient yet.</p>}
              </li>
            )
          })}
        </ul>
      )}
    </Drawer>
  )
}
