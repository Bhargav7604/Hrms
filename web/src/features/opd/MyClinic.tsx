import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Eye, Hourglass, Printer, RefreshCw, Search, Stethoscope, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Pager } from '@/components/list'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Select, Spinner } from '@/components/ui'
import { ApiError, get } from '@/lib/api'
import { date as fmtDate, time, todayISO } from '@/lib/format'
import { usePref } from '@/lib/prefs'
import { useShortcuts } from '@/lib/shortcuts'
import {
  ageSex, AllergyChip, esc, GenderAvatar, OPK, openPrintWindow, ScreenHeader, StagePill, useClinicAccess, useClinicDoctors, useOpenEmr,
  writePrint, type Visit,
} from './clinic-shared'

interface ClinicData {
  date: string
  doctor: { id: string; name: string; department?: string | null } | null
  rows: Visit[]
  kpis: { booked: number; waiting: number; awaiting_vitals: number; with_doctor: number; seen: number; not_arrived: number }
  updated_at: string
  can_choose_doctor: boolean
}

type Access = ReturnType<typeof useClinicAccess>
type Filter = '' | 'waiting' | 'With doctor' | 'Seen' | 'Not arrived'
const REFRESH = [{ v: 0, label: 'Off' }, { v: 30, label: '30 s' }, { v: 60, label: '1 min' }, { v: 300, label: '5 min' }]
const PAGE = 50

const NOT_LINKED = 'Your login is not linked to a doctor profile — ask the administrator to link your employee record.'

/** My Clinic: the doctor's OP day — booked → awaiting vitals → waiting → with doctor → seen — with one click into the EMR. */
export default function MyClinic({ embedded = false }: { embedded?: boolean }) {
  const acc = useClinicAccess('my-clinic')
  if (!acc.ready) return <Spinner />
  if (!acc.page || !acc.view) {
    return <Empty icon="Lock" title="My Clinic is not available for your role">Ask an administrator if you need the OP clinic day view.</Empty>
  }
  if (acc.role === 'doctor' && !acc.employeeId) return <Empty icon="UserX" title="No doctor profile linked">{NOT_LINKED}</Empty>
  return <Clinic embedded={embedded} acc={acc} />
}

function Clinic({ embedded, acc }: { embedded: boolean; acc: Access }) {
  const [day, setDay] = useState(todayISO())
  const [doctor, setDoctor] = useState('')
  const [dept, setDept] = useState('')
  const [filter, setFilter] = useState<Filter>('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = usePref<number>('opd.my-clinic.refresh', 0)
  const searchRef = useRef<HTMLInputElement>(null)
  const query = { date: day, doctor_id: doctor || undefined, department_id: dept || undefined }
  const q = useQuery({
    queryKey: OPK.clinic(query),
    queryFn: () => get<ClinicData>('/opd/my-clinic', query),
    enabled: !!day,
    refetchInterval: refresh > 0 ? refresh * 1000 : false,
    placeholderData: (p) => p,
  })
  const d = q.data
  const canChoose = d?.can_choose_doctor ?? acc.role !== 'doctor'
  const doctors = useClinicDoctors(day)
  const departments = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of doctors.data ?? []) if (x.department_id) m.set(x.department_id, x.department ?? 'Department')
    for (const r of d?.rows ?? []) if (r.department_id) m.set(r.department_id, r.department ?? 'Department')
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [doctors.data, d])
  const open = useOpenEmr()

  const rows = useMemo(() => d?.rows ?? [], [d])
  const shown = useMemo(() => {
    const t = term.trim().toLowerCase()
    return rows.filter((r) => (!filter || (filter === 'waiting' ? r.stage === 'Awaiting vitals' || r.stage === 'Waiting' : r.stage === filter))
      && (!t || [r.patient, r.uhid, r.code, r.token_no, r.phone].some((x) => String(x ?? '').toLowerCase().includes(t))))
  }, [rows, filter, term])
  useEffect(() => { setPage(1) }, [filter, term, day, doctor, dept])
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE)

  useShortcuts('My Clinic', [
    { keys: '/', label: 'Search patients', run: () => searchRef.current?.focus() },
    { keys: 'r', label: 'Refresh', run: () => q.refetch() },
  ])

  const who = d?.doctor?.name ?? (doctor ? doctors.data?.find((x) => x.id === doctor)?.name : null) ?? 'All doctors'
  const today = day === todayISO()
  const print = () => {
    const w = openPrintWindow()
    if (!w) return
    const head = ['#', 'Token', 'Patient', 'UHID', 'Age / sex', 'Doctor', 'Department', 'Stage', 'Allergies', 'In', 'Wait'].map((h) => `<th>${h}</th>`).join('')
    const body = shown.map((r, i) => `<tr>${[i + 1, r.token_no ?? r.slot ?? '', r.patient, r.uhid, ageSex(r.age, r.gender), r.doctor ?? '', r.department ?? '', r.stage,
      r.allergies.join(', '), r.in_at ? time(r.in_at) : '', r.wait_min !== null && r.wait_min !== undefined ? `${r.wait_min} min` : '']
      .map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')
    const k = d?.kpis
    writePrint(w, `My Clinic ${day}`, `<h1>My Clinic · ${esc(who)}</h1>
      <div class="sub">${esc(fmtDate(day))} · booked ${k?.booked ?? 0} · waiting ${k?.waiting ?? 0} · with doctor ${k?.with_doctor ?? 0} · seen ${k?.seen ?? 0}</div>
      <table class="grid"><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td colspan="11">No patients</td></tr>'}</tbody></table>`)
  }

  const notLinked = q.error instanceof ApiError && q.error.status === 400 && /not linked/i.test(q.error.message)
  return (
    <div className="space-y-4">
      <ScreenHeader embedded={embedded} icon="Stethoscope" title="My Clinic" subtitle={`${who} · ${day}`}
        actions={<>
          {d && <span className="text-xs text-ink-3 tabular">Updated {time(d.updated_at)}</span>}
          <Button size="sm" variant="ghost" onClick={() => q.refetch()} title="Refresh (R)" aria-label="Refresh">
            <RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} />
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            Auto-refresh
            <Select className="h-8 w-24 text-xs" value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} aria-label="Auto-refresh interval">
              {REFRESH.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </Select>
          </label>
          <Button size="sm" variant="secondary" onClick={print} disabled={!d} title="Print today's list"><Printer className="size-4" /> Print</Button>
        </>} />

      <div className="flex flex-wrap items-end gap-2">
        <FieldWrap label="Date" className="w-40"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></FieldWrap>
        {canChoose && (
          <FieldWrap label="Doctor" className="w-60">
            <Select value={doctor} onChange={(e) => setDoctor(e.target.value)}>
              <option value="">All doctors</option>
              {(doctors.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.visits ? ` (${x.visits})` : ''}</option>)}
            </Select>
          </FieldWrap>
        )}
        <FieldWrap label="Department" className="w-56">
          <Select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All departments</option>
            {departments.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </FieldWrap>
      </div>

      {notLinked ? <Empty icon="UserX" title="No doctor profile linked">{NOT_LINKED}</Empty> : q.isLoading ? <Spinner label="Loading the clinic…" /> : q.error ? <ErrorBox error={q.error} /> : d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label={today ? 'Booked today' : 'Booked'} value={d.kpis.booked} icon={<Users className="size-4" />}
              hint={d.kpis.not_arrived ? `${d.kpis.not_arrived} not arrived yet` : undefined} active={!filter} onClick={() => setFilter('')} />
            <Tile label="Waiting" value={d.kpis.waiting} icon={<Hourglass className="size-4" />}
              hint={<>Registered and not yet with the doctor{d.kpis.awaiting_vitals ? ` · ${d.kpis.awaiting_vitals} awaiting vitals` : ''}</>}
              active={filter === 'waiting'} onClick={() => setFilter(filter === 'waiting' ? '' : 'waiting')} />
            <Tile label="With doctor" value={d.kpis.with_doctor} icon={<Stethoscope className="size-4" />}
              active={filter === 'With doctor'} onClick={() => setFilter(filter === 'With doctor' ? '' : 'With doctor')} />
            <Tile label="Seen" value={d.kpis.seen} icon={<CheckCircle2 className="size-4" />}
              active={filter === 'Seen'} onClick={() => setFilter(filter === 'Seen' ? '' : 'Seen')} />
          </div>

          <Card pad={false} title={<span className="flex items-center gap-2">{today ? "Today's patients" : `Patients · ${fmtDate(day)}`}
            {filter && <Badge tone="blue">{filter === 'waiting' ? 'Waiting' : filter} · <button type="button" className="underline" onClick={() => setFilter('')}>clear</button></Badge>}</span>}
            icon="Users" actions={
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" aria-hidden />
                <Input ref={searchRef} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Patient / UHID / token" className="h-8 w-52 pl-8" aria-label="Search patients" />
              </div>
            }>
            <p className="border-b border-line px-4 py-1.5 text-xs text-ink-3">
              {acc.emrOpen ? 'Open any row to consult.' : 'View only — open the EMR of patients who have checked in.'} {shown.length} of {rows.length} patient{rows.length === 1 ? '' : 's'}.
            </p>
            {!shown.length ? (
              <Empty icon="CalendarX2" title={rows.length ? 'No patients match this filter' : 'No patients booked for this day'} />
            ) : (
              <ul className="divide-y divide-line">
                {pageRows.map((r) => <PatientRow key={r.id} r={r} acc={acc} onOpen={() => open.mutate(r.id)} opening={open.isPending && open.variables === r.id} />)}
              </ul>
            )}
            {shown.length > PAGE && <Pager page={page} limit={PAGE} total={shown.length} onPage={setPage} fetching={q.isFetching} />}
          </Card>
        </>
      )}
    </div>
  )
}

function Tile({ label, value, icon, hint, active, onClick }: {
  label: string; value: number; icon: ReactNode; hint?: ReactNode; active: boolean; onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('flex min-w-0 flex-col rounded-xl border bg-surface px-4 py-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:bg-surface-2',
        active ? 'border-brand-600 ring-1 ring-brand-600/30' : 'border-line hover:border-brand-600/40')}>
      <span className="flex items-center justify-between gap-2 text-xs font-medium text-ink-2">
        <span className="truncate">{label}</span><span className="text-ink-3">{icon}</span>
      </span>
      <span className="mt-1 text-2xl font-semibold tracking-tight text-ink tabular">{value}</span>
      {hint && <span className="mt-0.5 text-xs text-ink-3">{hint}</span>}
    </button>
  )
}

function PatientRow({ r, acc, onOpen, opening }: { r: Visit; acc: Access; onOpen: () => void; opening: boolean }) {
  const arrived = r.stage !== 'Not arrived'
  // doctors (and admin) open the EMR — the consulting doctor starts the consultation; others only view an existing encounter
  const action: 'open' | 'view' | null = !arrived ? null : acc.emrOpen ? 'open' : r.encounter_id ? 'view' : null
  const slot = [r.token_no ? `Token ${r.token_no}` : null, r.slot].filter(Boolean).join(' / ')
  const wait = r.stage === 'Awaiting vitals' || r.stage === 'Waiting'
    ? (r.wait_min !== null && r.wait_min !== undefined ? `waiting ${r.wait_min} min` : null)
    : r.stage === 'Seen' && r.duration_min !== null && r.duration_min !== undefined ? `visit ${r.duration_min} min` : null
  const line = [`UHID ${r.uhid}`, r.department, r.doctor, slot || null, ageSex(r.age, r.gender), wait].filter(Boolean).join(' · ')
  return (
    <li onClick={action === 'open' ? onOpen : undefined}
      className={cn('flex items-center gap-3 px-4 py-2.5', action === 'open' && 'cursor-pointer hover:bg-surface-2')}>
      <GenderAvatar gender={r.gender} name={r.patient} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink">{r.patient}</span>
          <StagePill stage={r.stage} />
          <AllergyChip allergies={r.allergies} />
          {r.priority && r.priority !== 'Normal' && <Badge tone="red">{r.priority}</Badge>}
        </div>
        <div className={cn('mt-0.5 truncate text-xs', wait && (r.wait_min ?? 0) > 30 ? 'text-red-700 dark:text-red-300' : 'text-ink-3')} title={line}>{line}</div>
        {r.reason && <div className="truncate text-xs text-ink-2">{r.reason}</div>}
      </div>
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        {action === 'open' && <Button size="sm" variant="primary" loading={opening} onClick={onOpen}>Open EMR</Button>}
        {action === 'view' && (
          <Link to={`/op/emr/${r.encounter_id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">
            <Eye className="size-4" /> View EMR
          </Link>
        )}
      </div>
    </li>
  )
}
