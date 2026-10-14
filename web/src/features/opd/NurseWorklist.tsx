import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Download, ExternalLink, HeartPulse, LogIn, Printer, RefreshCw, Search, Stethoscope, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Pager } from '@/components/list'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Kbd, Select, Spinner, Textarea, type BadgeTone } from '@/components/ui'
import { ApiError, errorMessage, get, post } from '@/lib/api'
import { date as fmtDate, dateTime, time, todayISO } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import {
  AgeSexChip, AllergyFlag, downloadCsv, GenderAvatar, OPK, printVisitSlip, ScreenHeader, STAGES, StagePill, useClinicAccess, useClinicDoctors,
  useOpenEmr, type Stage, type Visit, type VisitVitals, type VitalsView,
} from './clinic-shared'

interface WorklistData {
  rows: Visit[]
  kpis: { consultations: number; patients: number; vitals_done: number; awaiting_vitals: number; not_arrived: number }
  doctors: { id: string; name: string; department?: string | null }[]
}

type Access = ReturnType<typeof useClinicAccess>
const PAGE = 25

/** Nurse Worklist: pick a visit on the left, capture OP vitals and the nursing assessment on the right. */
export default function NurseWorklist({ embedded = false }: { embedded?: boolean }) {
  const acc = useClinicAccess('nurse-worklist')
  if (!acc.ready) return <Spinner />
  if (!acc.page || !acc.view) {
    return <Empty icon="Lock" title="Nurse Worklist is not available for your role">Ask an administrator if you need access to the OP nursing station.</Empty>
  }
  return <Worklist embedded={embedded} acc={acc} />
}

function Worklist({ embedded, acc }: { embedded: boolean; acc: Access }) {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [doctor, setDoctor] = useState('')
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 200)
  const [stage, setStage] = useState<Stage | ''>('')
  const [page, setPage] = useState(1)
  const [cursor, setCursor] = useState(0)
  const selId = params.get('visit')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  const rangeError = to < from ? 'The To date is before the From date' : null
  const query = { date_from: from, date_to: to, doctor_id: doctor || undefined }
  const list = useQuery({
    queryKey: OPK.worklist(query),
    queryFn: () => get<WorklistData>('/opd/worklist', query),
    enabled: !rangeError && !!from && !!to,
    refetchInterval: 30_000,
    placeholderData: (p) => p,
  })
  const doctors = useClinicDoctors(from)
  const doctorOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string; department?: string | null }>()
    for (const d of doctors.data ?? []) m.set(d.id, d)
    for (const d of list.data?.doctors ?? []) if (!m.has(d.id)) m.set(d.id, d)
    return [...m.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }, [doctors.data, list.data])

  const rows = useMemo(() => list.data?.rows ?? [], [list.data])
  const searched = useMemo(() => {
    const t = dq.trim().toLowerCase()
    if (!t) return rows
    return rows.filter((r) => [r.patient, r.uhid, r.bill, r.code, r.phone, r.token_no].some((x) => String(x ?? '').toLowerCase().includes(t)))
  }, [rows, dq])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of searched) c[r.stage] = (c[r.stage] ?? 0) + 1
    return c
  }, [searched])
  const shown = useMemo(() => (stage ? searched.filter((r) => r.stage === stage) : searched), [searched, stage])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE)
  useEffect(() => { setPage(1); setCursor(0) }, [dq, stage, doctor, from, to])
  useEffect(() => { if (page > pages) setPage(pages) }, [page, pages])

  // keep the selected visit even when the date / doctor filters no longer return it
  const [snap, setSnap] = useState<Visit | null>(null)
  const selected = rows.find((r) => r.id === selId) ?? (snap?.id === selId ? snap : null)

  const select = (v: Visit | null) => {
    setSnap(v)
    const p = new URLSearchParams(params)
    if (v) p.set('visit', v.id)
    else p.delete('visit')
    setParams(p, { replace: true })
    if (v) {
      const i = shown.findIndex((r) => r.id === v.id)
      if (i >= 0) { setCursor(i); setPage(Math.floor(i / PAGE) + 1) }
    }
  }
  const move = (d: number) => {
    if (!shown.length) return
    const i = Math.min(shown.length - 1, Math.max(0, cursor + d))
    setCursor(i)
    setPage(Math.floor(i / PAGE) + 1)
    listRef.current?.focus({ preventScroll: true })
    requestAnimationFrame(() => rowRefs.current.get(shown[i].id)?.scrollIntoView({ block: 'nearest' }))
  }
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && e.target === e.currentTarget && shown[cursor]) {
      e.preventDefault()
      select(shown[cursor])
    }
  }
  const nextAwaiting = (afterId: string) => {
    const i = shown.findIndex((r) => r.id === afterId)
    return shown.slice(i + 1).find((r) => r.stage === 'Awaiting vitals' && r.id !== afterId)
      ?? shown.find((r) => r.stage === 'Awaiting vitals' && r.id !== afterId) ?? null
  }

  const checkIn = useMutation({
    mutationFn: (v: Visit) => post<{ id: string; status: string; encounter_id?: string }>(`/opd/visits/${v.id}/check-in`),
    onSuccess: (_, v) => {
      toast.success(`${v.patient} checked in — awaiting vitals`)
      qc.invalidateQueries({ queryKey: OPK.all })
      select(v)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const open = useOpenEmr()

  useShortcuts('Nurse worklist', [
    { keys: '/', label: 'Search consultations', run: () => searchRef.current?.focus() },
    { keys: 'arrowdown', label: 'Next consultation', run: () => move(1) },
    { keys: 'arrowup', label: 'Previous consultation', run: () => move(-1) },
    { keys: 'enter', label: 'Open the highlighted consultation (list focused)' },
    { keys: 'r', label: 'Refresh', run: () => list.refetch() },
  ])

  const exportCsv = () => {
    downloadCsv(`nurse-worklist-${from}${to !== from ? `_${to}` : ''}.csv`,
      ['Date', 'Token', 'Visit', 'UHID', 'Patient', 'Age', 'Sex', 'Doctor', 'Department', 'Visit type', 'Stage', 'Bill', 'In', 'Out', 'Minutes', 'Vitals done', 'Allergies'],
      shown.map((r) => [r.date, r.token_no, r.code, r.uhid, r.patient, r.age, r.gender, r.doctor, r.department, r.type, r.stage, r.bill,
        r.in_at ? time(r.in_at) : '', r.out_at ? time(r.out_at) : '', r.duration_min, r.vitals_done ? 'Yes' : 'No', r.allergies.join('; ')]))
  }

  const k = list.data?.kpis
  return (
    <div className="space-y-4">
      <ScreenHeader embedded={embedded} icon="ClipboardList" title="Nurse Worklist"
        subtitle="Pick a patient on the left, then capture vitals & assessment on the right"
        actions={<>
          <label className="flex items-center gap-2 text-xs font-medium text-ink-2">
            Doctor
            <Select className="h-8 w-56 text-sm" value={doctor} onChange={(e) => setDoctor(e.target.value)} aria-label="Filter by doctor">
              <option value="">All doctors</option>
              {doctorOptions.map((d) => <option key={d.id} value={d.id}>{d.name}{d.department ? ` · ${d.department}` : ''}</option>)}
            </Select>
          </label>
          <KpiChip icon={<Stethoscope className="size-4" />} value={k?.consultations} label="Consultations" />
          <KpiChip icon={<Users className="size-4" />} value={k?.patients} label="Patients" />
          <KpiChip icon={<ClipboardCheck className="size-4" />} value={k?.vitals_done} label="Vitals done" />
          <KpiChip icon={<HeartPulse className="size-4" />} value={k?.awaiting_vitals} label="Awaiting vitals" alert={!!k?.awaiting_vitals}
            active={stage === 'Awaiting vitals'} onClick={() => setStage(stage === 'Awaiting vitals' ? '' : 'Awaiting vitals')} />
        </>} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:items-start xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        <Card pad={false} title="Consultations" icon="ListChecks">
          <div className="space-y-2 border-b border-line px-3 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" aria-hidden />
              <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by bill / UHID / patient…" className="pl-8" aria-label="Search consultations" />
            </div>
            <div className="flex items-end gap-2">
              <FieldWrap label="From" className="flex-1"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></FieldWrap>
              <FieldWrap label="To" className="flex-1"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></FieldWrap>
              <Button variant="ghost" className="px-2.5" onClick={() => list.refetch()} title="Refresh (R)" aria-label="Refresh">
                <RefreshCw className={cn('size-4', list.isFetching && 'animate-spin')} />
              </Button>
              <Button variant="ghost" className="px-2.5" onClick={exportCsv} disabled={!shown.length} title="Download CSV of these consultations" aria-label="Download CSV">
                <Download className="size-4" />
              </Button>
            </div>
            {rangeError && <p className="text-xs text-red-600">{rangeError}</p>}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="mr-1 text-xs text-ink-2 tabular">{shown.length} consultation{shown.length === 1 ? '' : 's'} found</span>
              <StageChip label="All" count={searched.length} active={!stage} onClick={() => setStage('')} />
              {STAGES.map((s) => <StageChip key={s} label={s} count={counts[s] ?? 0} active={stage === s} onClick={() => setStage(stage === s ? '' : s)} />)}
            </div>
          </div>
          {list.isLoading ? <Spinner label="Loading consultations…" /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : !shown.length ? (
            <Empty icon="ClipboardList" title={rows.length ? 'No consultations match these filters' : 'No consultations in this period'}>
              {rows.length ? 'Clear the search or the stage filter.' : 'Visits booked for the selected dates appear here.'}
            </Empty>
          ) : (
            <div ref={listRef} role="listbox" tabIndex={0} aria-label="Consultations" aria-activedescendant={shown[cursor] ? `nw-${shown[cursor].id}` : undefined}
              onKeyDown={onListKey}
              className="divide-y divide-line overflow-y-auto outline-none scroll-thin focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600/30 lg:max-h-[calc(100vh-21rem)]">
              {pageRows.map((r, i) => {
                const idx = (page - 1) * PAGE + i
                return (
                  <VisitRow key={r.id} r={r} ref={(el) => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id) }}
                    selected={r.id === selId} highlighted={idx === cursor} showDate={from !== to} acc={acc}
                    onSelect={() => { setCursor(idx); select(r) }}
                    onCheckIn={() => checkIn.mutate(r)} checkingIn={checkIn.isPending && checkIn.variables?.id === r.id}
                    onOpen={() => open.mutate(r.id)} opening={open.isPending && open.variables === r.id} />
                )
              })}
            </div>
          )}
          {shown.length > PAGE && <Pager page={page} limit={PAGE} total={shown.length} onPage={setPage} fetching={list.isFetching} />}
        </Card>

        <div className="min-w-0">
          {selected ? (
            <VitalsPanel key={selected.id} visit={selected} acc={acc}
              onCheckIn={() => checkIn.mutate(selected)} checkingIn={checkIn.isPending}
              onOpen={() => open.mutate(selected.id)} opening={open.isPending}
              onNext={() => {
                const n = nextAwaiting(selected.id)
                if (n) select(n)
                else toast.info('No more patients awaiting vitals')
              }} />
          ) : (
            <Card>
              <Empty icon="Activity" title="Select a consultation to capture vitals & assessment">
                <span>Use <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move through the list and <Kbd>Enter</Kbd> to open. <Kbd>/</Kbd> searches.</span>
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function KpiChip({ icon, value, label, alert, active, onClick }: {
  icon: ReactNode; value?: number; label: string; alert?: boolean; active?: boolean; onClick?: () => void
}) {
  const body = (
    <>
      <span className={cn('grid size-7 place-items-center rounded-lg', alert ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300')}>{icon}</span>
      <span className="text-left leading-tight">
        <span className="block text-base font-semibold text-ink tabular">{value ?? '—'}</span>
        <span className="block text-[11px] text-ink-2">{label}</span>
      </span>
    </>
  )
  const cls = cn('flex items-center gap-2 rounded-xl border bg-surface px-2.5 py-1.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
    active ? 'border-brand-600 ring-1 ring-brand-600/30' : 'border-line')
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active} title={`Show only “${label}”`} className={cn(cls, 'hover:bg-surface-2')}>{body}</button>
    : <div className={cls}>{body}</div>
}

function StageChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        active ? 'border-brand-700 bg-brand-700 text-white dark:border-brand-500 dark:bg-brand-600' : 'border-line-2 bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink')}>
      {label}<span className={cn('tabular', active ? 'text-white/80' : 'text-ink-3')}>{count}</span>
    </button>
  )
}

function VisitRow({ r, ref, selected, highlighted, showDate, acc, onSelect, onCheckIn, checkingIn, onOpen, opening }: {
  r: Visit; ref: (el: HTMLDivElement | null) => void; selected: boolean; highlighted: boolean; showDate: boolean; acc: Access
  onSelect: () => void; onCheckIn: () => void; checkingIn: boolean; onOpen: () => void; opening: boolean
}) {
  const notArrived = r.stage === 'Not arrived'
  const detail = [`UHID ${r.uhid}`, r.bill ? `Bill ${r.bill}` : r.charge_status === 'Unbilled' ? 'Not billed' : null,
    [r.department, r.doctor].filter(Boolean).join(' / ') || null, r.type, r.token_no ? `Token ${r.token_no}` : null, showDate ? fmtDate(r.date) : null]
  return (
    <div ref={ref} id={`nw-${r.id}`} role="option" aria-selected={selected} onClick={onSelect}
      className={cn('flex cursor-pointer items-start gap-2.5 px-3 py-2.5 hover:bg-surface-2',
        selected ? 'bg-brand-50 dark:bg-brand-500/10' : highlighted && 'bg-surface-2', highlighted && 'shadow-[inset_3px_0_0_var(--color-brand-600)]')}>
      <GenderAvatar gender={r.gender} name={r.patient} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="truncate text-sm font-medium text-ink">{r.patient}</span>
          <AllergyFlag allergies={r.allergies} compact />
          <AgeSexChip age={r.age} gender={r.gender} />
          {r.priority && r.priority !== 'Normal' && <Badge tone="red">{r.priority}</Badge>}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-3" title={detail.filter(Boolean).join(' · ')}>{detail.filter(Boolean).join(' · ')}</div>
        {(r.in_at || r.out_at) && (
          <div className="mt-0.5 text-xs tabular">
            {r.in_at && <span className="text-emerald-700 dark:text-emerald-300">In {time(r.in_at)}</span>}
            {r.out_at && <span className="text-amber-700 dark:text-amber-300"> · Out {time(r.out_at)}</span>}
            {r.duration_min !== null && r.duration_min !== undefined
              ? <span className="text-ink-3"> · {r.duration_min}m</span>
              : r.wait_min !== null && r.wait_min !== undefined && <span className={cn(r.wait_min > 30 ? 'text-red-600 dark:text-red-300' : 'text-ink-3')}> · waiting {r.wait_min}m</span>}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <StagePill stage={r.stage} />
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {notArrived && acc.checkIn && (
            <Button size="xs" variant="ghost" onClick={onCheckIn} loading={checkingIn} title="Check in (mark arrived)" aria-label={`Check in ${r.patient}`}>
              {!checkingIn && <LogIn className="size-4" />}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => printVisitSlip(r, acc.hospital)} title="Print visit slip" aria-label={`Print visit slip for ${r.patient}`}>
            <Printer className="size-4" />
          </Button>
          {acc.emrOpen && !notArrived && (
            <Button size="xs" variant="ghost" onClick={onOpen} loading={opening} title="Open EMR" aria-label={`Open EMR for ${r.patient}`}
              className="text-brand-700 dark:text-brand-300">
              {!opening && <ExternalLink className="size-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ vitals & assessment

interface VitalDef {
  label: string; unit?: string; int?: boolean; min?: number; max?: number; kind?: 'number' | 'select' | 'date' | 'text'
  options?: string[]; conv?: 'height' | 'weight' | 'temperature'; computed?: boolean
}
const O2 = ['Room air', 'Nasal prongs', 'Face mask', 'Venturi mask', 'NRBM', 'HFNC', 'NIV (BiPAP/CPAP)', 'Ventilator']
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
const VITALS: Record<string, VitalDef> = {
  temperature: { label: 'Temperature', conv: 'temperature', min: 90, max: 110, unit: '°F' },
  pulse: { label: 'Pulse', unit: '/min', int: true, min: 20, max: 250 },
  resp_rate: { label: 'Respiratory rate', unit: '/min', int: true, min: 4, max: 80 },
  bp_systolic: { label: 'BP systolic (sitting)', unit: 'mmHg', int: true, min: 40, max: 300 },
  bp_diastolic: { label: 'BP diastolic (sitting)', unit: 'mmHg', int: true, min: 20, max: 200 },
  standing_bp_systolic: { label: 'Standing BP systolic', unit: 'mmHg', int: true, min: 40, max: 300 },
  standing_bp_diastolic: { label: 'Standing BP diastolic', unit: 'mmHg', int: true, min: 20, max: 200 },
  spo2: { label: 'SpO₂', unit: '%', int: true, min: 40, max: 100 },
  o2_support: { label: 'Oxygen support', kind: 'select', options: O2 },
  pain_score: { label: 'Pain score (0–10)', int: true, min: 0, max: 10 },
  weight: { label: 'Weight', conv: 'weight', min: 0.3, max: 400, unit: 'kg' },
  height: { label: 'Height', conv: 'height', min: 20, max: 250, unit: 'cm' },
  bmi: { label: 'BMI', unit: 'kg/m²', computed: true },
  blood_sugar: { label: 'RBS', unit: 'mg/dL', min: 10, max: 900 },
  gcs: { label: 'GCS', int: true, min: 3, max: 15 },
  head_circumference: { label: 'Head circumference', unit: 'cm', min: 20, max: 70 },
  muac: { label: 'MUAC', unit: 'cm', min: 5, max: 60 },
  waist: { label: 'Waist circumference', unit: 'cm', min: 30, max: 250 },
  lmp: { label: 'LMP', kind: 'date' },
}
/** Defaults when the field configuration cannot be loaded (same as the platform defaults). */
const DEFAULT_LAYOUT = ['temperature', 'pulse', 'resp_rate', 'bp_systolic', 'bp_diastolic', 'spo2', 'pain_score', 'weight', 'height', 'bmi']
/** Accepted by the server but not part of the "OP Vitals" field configuration: always offered. */
const EXTRA_FIELDS = ['standing_bp_systolic', 'standing_bp_diastolic']

interface VField { key: string; label: string; required: boolean; readonly: boolean }
interface ScreenCfg {
  fields: Record<string, { visible?: boolean; hidden?: boolean; required?: boolean; readonly?: boolean; label?: string }>
  sections: { key: string; label: string; fields: string[] }[]
}

/** "Temperature (°F)" → "Temperature" for fields that carry their own unit selector. */
const cleanLabel = (label: string, def: VitalDef) => (def.conv ? label.replace(/\s*\((cm|kg|°F|°C|lb)\)\s*$/i, '') : label)

function useVitalsLayout() {
  const q = useQuery({
    queryKey: ['x', 'settings', 'screen', 'op.vitals'],
    queryFn: () => get<ScreenCfg>('/fieldconfig/screens/op.vitals'),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const layout = useMemo<VField[]>(() => {
    const cfg = q.data
    if (!cfg?.sections?.length) return DEFAULT_LAYOUT.map((k) => ({ key: k, label: VITALS[k].label, required: false, readonly: !!VITALS[k].computed }))
    const out: VField[] = []
    for (const s of cfg.sections) {
      for (const key of s.fields) {
        const f = cfg.fields[key]
        const def = VITALS[key]
        if (!def || !f || f.hidden || f.visible === false) continue
        out.push({ key, label: cleanLabel(f.label || def.label, def), required: !!f.required && !def.computed, readonly: !!f.readonly || !!def.computed })
      }
    }
    return out
  }, [q.data])
  return { layout, loading: q.isLoading, fallback: !!q.error }
}

type Units = { height: 'cm' | 'ftin'; weight: 'kg' | 'lb'; temperature: 'F' | 'C' }
const UNITS_KEY = 'vlack.opd.vitalUnits'
const DEFAULT_UNITS: Units = { height: 'cm', weight: 'kg', temperature: 'F' }
function readUnits(): Units {
  try { return { ...DEFAULT_UNITS, ...JSON.parse(localStorage.getItem(UNITS_KEY) ?? '{}') } } catch { return DEFAULT_UNITS }
}
function saveUnits(u: Units) {
  try { localStorage.setItem(UNITS_KEY, JSON.stringify(u)) } catch { /* storage unavailable */ }
}

const LB = 0.45359237
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d
/** '' → null, not a number → NaN */
const parse = (s: string | undefined): number | null => {
  const t = (s ?? '').trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}
const show = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? '' : String(round(n, d)))

type Vals = Record<string, string>

function toDisplay(v: VitalsView | null, u: Units): Vals {
  const out: Vals = {}
  if (!v) return out
  for (const key of Object.keys(VITALS)) {
    const x = v[key as keyof VitalsView]
    if (x !== null && x !== undefined && x !== '') out[key] = String(x)
  }
  if (v.height) {
    if (u.height === 'ftin') {
      const inches = v.height / 2.54
      out.height_ft = String(Math.floor(inches / 12))
      out.height_in = show(inches % 12)
    }
  }
  if (v.weight && u.weight === 'lb') out.weight = show(v.weight / LB)
  if (v.temperature && u.temperature === 'C') out.temperature = show(((v.temperature - 32) * 5) / 9)
  return out
}

function heightCm(vals: Vals, u: Units): number | null {
  if (u.height === 'cm') return parse(vals.height)
  const ft = parse(vals.height_ft)
  const inch = parse(vals.height_in)
  if (ft === null && inch === null) return null
  if (Number.isNaN(ft) || Number.isNaN(inch)) return NaN
  return ((ft ?? 0) * 12 + (inch ?? 0)) * 2.54
}
function weightKg(vals: Vals, u: Units): number | null {
  const w = parse(vals.weight)
  return w === null || Number.isNaN(w) || u.weight === 'kg' ? w : w * LB
}
function tempF(vals: Vals, u: Units): number | null {
  const t = parse(vals.temperature)
  return t === null || Number.isNaN(t) || u.temperature === 'F' ? t : (t * 9) / 5 + 32
}

/** BMI with the Asia-Pacific (WHO 2004) categories used for Indian adults. */
function bmiOf(h: number | null, w: number | null): { value: number; label: string; tone: BadgeTone } | null {
  if (!h || !w || Number.isNaN(h) || Number.isNaN(w) || h < 20) return null
  const value = round(w / (h / 100) ** 2)
  const [label, tone]: [string, BadgeTone] = value < 18.5 ? ['Underweight', 'amber'] : value < 23 ? ['Normal', 'green'] : value < 25 ? ['Overweight', 'amber'] : ['Obese', 'red']
  return { value, label, tone }
}

function news2Tone(score?: number | null, risk?: string | null): BadgeTone {
  if (score === null || score === undefined) return 'gray'
  if (score >= 7 || /high/i.test(risk ?? '')) return 'red'
  if (score >= 5 || /medium/i.test(risk ?? '')) return 'amber'
  return 'green'
}

interface Assess {
  chief_complaint: string; pain_location: string; allergies_reviewed: boolean | null; fall_risk: string; nutrition_risk: string; mobility: string
  lmp: string; pregnancy_status: string; smoking: string; current_medications: string; observations: string
}
const str = (x: unknown) => (x === null || x === undefined ? '' : String(x))
function initAssess(d: VisitVitals): Assess {
  const a = d.assessment ?? {}
  return {
    chief_complaint: str(a.chief_complaint) || str(d.appointment.reason), pain_location: str(a.pain_location),
    allergies_reviewed: typeof a.allergies_reviewed === 'boolean' ? a.allergies_reviewed : null, fall_risk: str(a.fall_risk),
    nutrition_risk: str(a.nutrition_risk), mobility: str(a.mobility), lmp: str(a.lmp).slice(0, 10), pregnancy_status: str(a.pregnancy_status),
    smoking: str(a.smoking), current_medications: str(a.current_medications), observations: str(a.observations),
  }
}

interface SaveResult { vitals: VitalsView; assessment_id?: string | null; encounter_id: string }

function VitalsPanel({ visit, acc, onCheckIn, checkingIn, onOpen, opening, onNext }: {
  visit: Visit; acc: Access; onCheckIn: () => void; checkingIn: boolean; onOpen: () => void; opening: boolean; onNext: () => void
}) {
  const q = useQuery({ queryKey: OPK.visit(visit.id), queryFn: () => get<VisitVitals>(`/opd/visits/${visit.id}/vitals`) })
  const cfg = useVitalsLayout()
  if (q.isLoading || cfg.loading) return <Card><Spinner label="Loading the visit…" /></Card>
  if (q.error) return <Card><ErrorBox error={q.error} /></Card>
  return <VitalsForm visit={visit} d={q.data!} layout={cfg.layout} cfgFallback={cfg.fallback} acc={acc}
    onCheckIn={onCheckIn} checkingIn={checkingIn} onOpen={onOpen} opening={opening} onNext={onNext} />
}

function VitalsForm({ visit, d, layout, cfgFallback, acc, onCheckIn, checkingIn, onOpen, opening, onNext }: {
  visit: Visit; d: VisitVitals; layout: VField[]; cfgFallback: boolean; acc: Access
  onCheckIn: () => void; checkingIn: boolean; onOpen: () => void; opening: boolean; onNext: () => void
}) {
  const qc = useQueryClient()
  const [units, setUnitsState] = useState<Units>(readUnits)
  const [vals, setVals] = useState<Vals>(() => ({ ...toDisplay(d.vitals, readUnits()), o2_support: d.vitals?.o2_support ?? 'Room air' }))
  const [bloodGroup, setBloodGroup] = useState('')
  const [a, setA] = useState<Assess>(() => initAssess(d))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState<VitalsView | null>(d.vitals)
  const [showPrev, setShowPrev] = useState(false)
  const [advancing, setAdvancing] = useState(false)

  const age = d.patient.age ?? visit.age
  // LMP / pregnancy only where it applies: women of reproductive age (or age not recorded)
  const reproductive = /^f/i.test(d.patient.gender ?? visit.gender ?? '') && (age === null || age === undefined || (age >= 10 && age <= 55))
  const status = d.appointment.status
  const closed = status === 'Completed' && visit.date !== todayISO()
  const notArrived = status === 'Booked'
  const readOnly = !acc.vitals || notArrived || closed
  const fields = useMemo(() => [...layout.filter((f) => f.key !== 'lmp' || reproductive),
    ...EXTRA_FIELDS.filter((k) => !layout.some((f) => f.key === k)).map((k) => ({ key: k, label: VITALS[k].label, required: false, readonly: false }))],
  [layout, reproductive])
  const vitalsHasLmp = fields.some((f) => f.key === 'lmp')
  const knownBloodGroup = d.patient.blood_group && d.patient.blood_group !== 'Unknown' ? d.patient.blood_group : null

  const h = heightCm(vals, units)
  const w = weightKg(vals, units)
  const bmi = bmiOf(h, w)
  const clearError = (...keys: string[]) => {
    if (keys.some((k) => errors[k])) setErrors((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k))))
  }
  const set = (k: string, v: string) => {
    setVals((x) => ({ ...x, [k]: v }))
    clearError(k.startsWith('height') ? 'height' : k)
  }
  const setAs = <K extends keyof Assess>(k: K, v: Assess[K]) => {
    setA((x) => ({ ...x, [k]: v }))
    clearError(`a.${k}`)
  }
  const setUnit = <K extends keyof Units>(k: K, v: Units[K]) => {
    // convert what is already typed into the new unit
    setVals((x) => {
      const next = { ...x }
      if (k === 'height') {
        const cm = heightCm(x, units)
        if (cm && !Number.isNaN(cm)) {
          if (v === 'ftin') { const inches = cm / 2.54; next.height_ft = String(Math.floor(inches / 12)); next.height_in = show(inches % 12) }
          else next.height = show(cm)
        }
      } else if (k === 'weight') {
        const kg = weightKg(x, units)
        if (kg && !Number.isNaN(kg)) next.weight = v === 'lb' ? show(kg / LB) : show(kg, 2)
      } else {
        const f = tempF(x, units)
        if (f && !Number.isNaN(f)) next.temperature = v === 'C' ? show(((f - 32) * 5) / 9) : show(f)
      }
      return next
    })
    const u = { ...units, [k]: v }
    setUnitsState(u)
    saveUnits(u)
  }

  const build = (): { body: { vitals: Record<string, unknown>; assessment?: Record<string, unknown> } | null; errs: Record<string, string> } => {
    const errs: Record<string, string> = {}
    const out: Record<string, unknown> = {}
    for (const f of fields) {
      const def = VITALS[f.key]
      if (def.computed || f.readonly) continue
      let v: number | string | null
      if (def.kind === 'select' || def.kind === 'date' || def.kind === 'text') v = (vals[f.key] ?? '').trim() || null
      else if (def.conv === 'height') v = heightCm(vals, units)
      else if (def.conv === 'weight') v = weightKg(vals, units)
      else if (def.conv === 'temperature') v = tempF(vals, units)
      else v = parse(vals[f.key])
      if (v === null) {
        if (f.required) errs[f.key] = 'Required'
        continue
      }
      if (typeof v === 'number') {
        if (Number.isNaN(v)) { errs[f.key] = 'Enter a number'; continue }
        if (def.int && !Number.isInteger(v)) { errs[f.key] = 'Whole number'; continue }
        if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) {
          errs[f.key] = `Between ${def.min} and ${def.max}${def.unit ? ` ${def.unit}` : ''}`
          continue
        }
        v = def.conv === 'weight' ? round(v, 2) : def.conv ? round(v) : v
      }
      out[f.key] = v
    }
    for (const [s1, d1] of [['bp_systolic', 'bp_diastolic'], ['standing_bp_systolic', 'standing_bp_diastolic']]) {
      if (errs[s1] || errs[d1]) continue
      if ((out[s1] === undefined) !== (out[d1] === undefined)) errs[out[s1] === undefined ? s1 : d1] = 'Enter both systolic and diastolic'
      else if (out[s1] !== undefined && Number(out[d1]) >= Number(out[s1])) errs[d1] = 'Must be lower than systolic'
    }
    if (!knownBloodGroup && bloodGroup) out.blood_group = bloodGroup
    if ((vals.remarks ?? '').trim()) out.remarks = vals.remarks.trim()
    if (!Object.keys(out).some((k) => !['o2_support', 'remarks', 'blood_group'].includes(k)) && !Object.keys(errs).length) {
      return { body: null, errs: { _form: 'Enter at least one vital sign' } }
    }
    const assessment: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a)) {
      if (k === 'allergies_reviewed') { if (v !== null) assessment[k] = v; continue }
      if (!reproductive && (k === 'lmp' || k === 'pregnancy_status')) continue
      if (typeof v === 'string' && v.trim()) assessment[k] = v.trim()
    }
    if (reproductive && vitalsHasLmp && out.lmp && !assessment.lmp) assessment.lmp = out.lmp
    return { body: { vitals: out, assessment: Object.keys(assessment).length ? assessment : undefined }, errs }
  }

  const save = useMutation({
    mutationFn: (body: object) => post<SaveResult>(`/opd/visits/${visit.id}/vitals`, body),
    onError: (e) => {
      const fe = e instanceof ApiError ? e.fieldErrors : {}
      const mapped: Record<string, string> = {}
      for (const [k, v] of Object.entries(fe)) {
        if (k.startsWith('vitals.')) mapped[k.slice(7)] = v
        else if (k.startsWith('assessment.')) mapped[`a.${k.slice(11)}`] = v
        else mapped[k] = v
      }
      setErrors(mapped)
      setFormError(e instanceof ApiError ? e.message : errorMessage(e))
      toast.error(errorMessage(e))
    },
  })
  const submit = (advance: boolean) => {
    if (readOnly || save.isPending) return
    const { body, errs } = build()
    setFormError(errs._form ?? null)
    const { _form, ...fieldErrs } = errs
    setErrors(fieldErrs)
    if (!body || Object.keys(fieldErrs).length) {
      if (Object.keys(fieldErrs).length) setFormError('Please fix the highlighted fields')
      return
    }
    setAdvancing(advance)
    save.mutate(body, {
      onSuccess: (r) => {
        setSaved(r.vitals)
        setFormError(null)
        qc.invalidateQueries({ queryKey: OPK.all })
        const n = r.vitals.news2
        const msg = `Vitals saved for ${d.patient.title}${n !== null && n !== undefined ? ` · NEWS2 ${n}${r.vitals.news2_risk ? ` (${r.vitals.news2_risk})` : ''}` : ''}`
        const tone = news2Tone(n, r.vitals.news2_risk)
        if (tone === 'red') toast.error(msg, { description: 'High clinical risk — inform the doctor now', duration: 15000 })
        else if (tone === 'amber') toast.warning(msg, { description: 'Inform the doctor', duration: 10000 })
        else toast.success(msg)
        if (advance) onNext()
      },
    })
  }
  useShortcuts('Vitals & assessment', readOnly ? [] : [
    { keys: 'mod+s', label: 'Save vitals', run: () => submit(false), allowInInput: true },
    { keys: 'mod+enter', label: 'Save and go to the next awaiting patient', run: () => submit(true), allowInInput: true },
  ])

  const prev = d.previous
  const last = prev[0]
  return (
    <Card pad={false} title="Vitals & Assessment" icon="Activity" actions={<>
      <Button size="xs" variant="ghost" onClick={() => printVisitSlip(visit, acc.hospital)} title="Print visit slip"><Printer className="size-4" /> Print</Button>
      {acc.emrOpen && !notArrived && <Button size="xs" variant="ghost" icon="ExternalLink" loading={opening} onClick={onOpen}>Open EMR</Button>}
    </>}>
      {/* patient header */}
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <GenderAvatar gender={d.patient.gender} name={d.patient.title} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link to={`/patients/${d.patient.id}`} className="truncate text-sm font-semibold text-ink hover:underline">{d.patient.title}</Link>
            <AgeSexChip age={d.patient.age} gender={d.patient.gender} />
            <StagePill stage={visit.stage} />
            {d.appointment.token_no && <Badge tone="gray">Token {d.appointment.token_no}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-ink-2">
            UHID {d.patient.code} · {[visit.doctor, visit.department, d.appointment.type, d.appointment.code].filter(Boolean).join(' · ')}
            {knownBloodGroup && <> · Blood group {knownBloodGroup}</>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {d.allergies.length ? d.allergies.map((al) => (
              <Badge key={al.allergen} tone="red">⚠ {al.allergen}{al.severity ? ` · ${al.severity}` : ''}{al.reaction ? ` (${al.reaction})` : ''}</Badge>
            )) : <span className="text-xs text-ink-3">No allergies recorded</span>}
          </div>
        </div>
      </div>

      {notArrived && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-2 text-sm text-ink-2">
          <span>The patient has not arrived. Check them in before recording vitals.</span>
          {acc.checkIn && <Button size="sm" variant="primary" icon="LogIn" loading={checkingIn} onClick={onCheckIn}>Check in</Button>}
        </div>
      )}
      {!notArrived && readOnly && (
        <div className="border-b border-line bg-surface-2 px-4 py-2 text-sm text-ink-2">
          {closed ? 'This visit is closed — vitals can no longer be changed.' : 'View only — your role cannot record vitals.'}
        </div>
      )}

      {/* previous vitals */}
      {last && (
        <div className="border-b border-line px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
            <span className="font-medium text-ink">Previous</span>
            <span>{dateTime(last.recorded_at)}</span>
            <span className="tabular">{vitalsSummary(last)}</span>
            {last.news2 !== null && last.news2 !== undefined && <Badge tone={news2Tone(last.news2, last.news2_risk)}>NEWS2 {last.news2}</Badge>}
            {prev.length > 1 && (
              <button type="button" className="ml-auto text-brand-700 hover:underline dark:text-brand-300" onClick={() => setShowPrev(!showPrev)} aria-expanded={showPrev}>
                {showPrev ? 'Hide' : `Show all ${prev.length}`}
              </button>
            )}
          </div>
          {showPrev && <PreviousTable rows={prev} />}
        </div>
      )}

      <fieldset disabled={readOnly} className="space-y-5 px-4 py-4">
        <section>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">Vitals</h4>
            {saved?.news2 !== null && saved?.news2 !== undefined && (
              <Badge tone={news2Tone(saved.news2, saved.news2_risk)}>NEWS2 {saved.news2}{saved.news2_risk ? ` · ${saved.news2_risk}` : ''}</Badge>
            )}
            {saved?.recorded_at && <span className="text-xs text-ink-3">recorded {time(saved.recorded_at)}</span>}
            {cfgFallback && <span className="text-xs text-ink-3">Default layout (field configuration unavailable)</span>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {fields.map((f) => (
              <VitalInput key={f.key} f={f} vals={vals} units={units} error={errors[f.key]} set={set} setUnit={setUnit} bmi={bmi} />
            ))}
            {!knownBloodGroup ? (
              <FieldWrap label="Blood group" error={errors.blood_group} htmlFor="v-blood_group">
                <Select id="v-blood_group" value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)}>
                  <option value="">Not known</option>
                  {BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}
                </Select>
              </FieldWrap>
            ) : null}
          </div>
          <FieldWrap label="Remarks" className="mt-3" error={errors.remarks} htmlFor="v-remarks">
            <Textarea id="v-remarks" rows={2} maxLength={500} value={vals.remarks ?? ''} onChange={(e) => set('remarks', e.target.value)} placeholder="Anything unusual while taking the vitals" />
          </FieldWrap>
        </section>

        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">Nursing assessment</h4>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <FieldWrap label="Chief complaint" className="sm:col-span-2 xl:col-span-4" error={errors['a.chief_complaint']} htmlFor="a-cc">
              <Textarea id="a-cc" rows={2} maxLength={1000} value={a.chief_complaint} onChange={(e) => setAs('chief_complaint', e.target.value)} placeholder="In the patient's words, with duration" />
            </FieldWrap>
            <FieldWrap label="Pain location" error={errors['a.pain_location']} htmlFor="a-pain">
              <Input id="a-pain" maxLength={200} value={a.pain_location} onChange={(e) => setAs('pain_location', e.target.value)} placeholder={Number(vals.pain_score) > 0 ? 'Where is the pain?' : ''} />
            </FieldWrap>
            <AssessSelect id="a-fall" label="Fall risk" value={a.fall_risk} options={['Low', 'Moderate', 'High']} error={errors['a.fall_risk']} onChange={(v) => setAs('fall_risk', v)} />
            <AssessSelect id="a-nut" label="Nutrition screen" value={a.nutrition_risk} options={['Not at risk', 'At risk', 'Malnourished']} error={errors['a.nutrition_risk']} onChange={(v) => setAs('nutrition_risk', v)} />
            <AssessSelect id="a-mob" label="Mobility" value={a.mobility} options={['Independent', 'Assisted', 'Wheelchair', 'Stretcher']} error={errors['a.mobility']} onChange={(v) => setAs('mobility', v)} />
            <AssessSelect id="a-smoke" label="Smoking" value={a.smoking} options={['Never', 'Former', 'Current']} error={errors['a.smoking']} onChange={(v) => setAs('smoking', v)} />
            {reproductive && !vitalsHasLmp && (
              <FieldWrap label="LMP" error={errors['a.lmp']} htmlFor="a-lmp">
                <Input id="a-lmp" type="date" max={todayISO()} value={a.lmp} onChange={(e) => setAs('lmp', e.target.value)} />
              </FieldWrap>
            )}
            {reproductive && (
              <AssessSelect id="a-preg" label="Pregnancy status" value={a.pregnancy_status} options={['Not applicable', 'Not pregnant', 'Pregnant', 'Unknown']}
                error={errors['a.pregnancy_status']} onChange={(v) => setAs('pregnancy_status', v)} />
            )}
            <label className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink sm:col-span-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={a.allergies_reviewed === true}
                onChange={(e) => setAs('allergies_reviewed', e.target.checked)} />
              <span>
                Allergies reviewed with the patient
                <span className="block text-xs text-ink-3">{d.allergies.length ? `On file: ${d.allergies.map((x) => x.allergen).join(', ')}` : 'None on file — confirm and record any new allergy in the EMR'}</span>
              </span>
            </label>
            <FieldWrap label="Current medications" className="sm:col-span-2" error={errors['a.current_medications']} htmlFor="a-meds">
              <Textarea id="a-meds" rows={2} maxLength={2000} value={a.current_medications} onChange={(e) => setAs('current_medications', e.target.value)} placeholder="Drug, dose, frequency" />
            </FieldWrap>
            <FieldWrap label="Other observations" className="sm:col-span-2" error={errors['a.observations']} htmlFor="a-obs">
              <Textarea id="a-obs" rows={2} maxLength={3000} value={a.observations} onChange={(e) => setAs('observations', e.target.value)} />
            </FieldWrap>
          </div>
        </section>
      </fieldset>

      {!readOnly && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-line bg-surface/95 px-4 py-3 backdrop-blur">
          {formError && <span className="mr-auto text-sm text-red-600" role="alert">{formError}</span>}
          {!formError && <span className="mr-auto hidden text-xs text-ink-3 sm:inline"><Kbd>Ctrl</Kbd> + <Kbd>S</Kbd> save · <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> save & next</span>}
          <Button onClick={() => submit(false)} loading={save.isPending && !advancing} disabled={save.isPending}>Save</Button>
          <Button variant="primary" icon="ChevronsRight" onClick={() => submit(true)} loading={save.isPending && advancing} disabled={save.isPending}>Save & next</Button>
        </div>
      )}
    </Card>
  )
}

function vitalsSummary(v: VitalsView): string {
  return [
    v.bp_systolic ? `BP ${v.bp_systolic}/${v.bp_diastolic ?? '—'}` : null, v.pulse ? `P ${v.pulse}` : null, v.resp_rate ? `RR ${v.resp_rate}` : null,
    v.temperature ? `T ${v.temperature}°F` : null, v.spo2 ? `SpO₂ ${v.spo2}%` : null, v.weight ? `Wt ${v.weight} kg` : null, v.height ? `Ht ${v.height} cm` : null,
    v.blood_sugar ? `RBS ${v.blood_sugar}` : null,
  ].filter(Boolean).join(' · ') || 'no values'
}

function PreviousTable({ rows }: { rows: VitalsView[] }) {
  const cols: [string, (v: VitalsView) => unknown][] = [
    ['When', (v) => dateTime(v.recorded_at)], ['BP', (v) => (v.bp_systolic ? `${v.bp_systolic}/${v.bp_diastolic ?? '—'}` : '')],
    ['Pulse', (v) => v.pulse], ['RR', (v) => v.resp_rate], ['Temp °F', (v) => v.temperature], ['SpO₂', (v) => v.spo2],
    ['Wt kg', (v) => v.weight], ['Ht cm', (v) => v.height], ['BMI', (v) => v.bmi], ['NEWS2', (v) => v.news2],
  ]
  return (
    <div className="mt-2 overflow-x-auto scroll-thin">
      <table className="w-full text-xs">
        <thead className="text-ink-3"><tr>{cols.map(([h]) => <th key={h} className="whitespace-nowrap px-2 py-1 text-left font-medium">{h}</th>)}</tr></thead>
        <tbody className="tabular text-ink-2">
          {rows.map((v) => <tr key={v.id} className="border-t border-line">{cols.map(([h, f]) => <td key={h} className="whitespace-nowrap px-2 py-1">{String(f(v) ?? '') || '—'}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  )
}

const unitSelect = 'h-9 shrink-0 rounded-r-lg border border-l-0 border-line-2 bg-surface-2 px-1.5 text-xs text-ink-2 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:opacity-60'

function VitalInput({ f, vals, units, error, set, setUnit, bmi }: {
  f: VField; vals: Vals; units: Units; error?: string; set: (k: string, v: string) => void
  setUnit: <K extends keyof Units>(k: K, v: Units[K]) => void; bmi: ReturnType<typeof bmiOf>
}) {
  const def = VITALS[f.key]
  const id = `v-${f.key}`
  // configured labels may already carry the unit ("Pulse (bpm)")
  const label = <>{f.label}{def.unit && !def.conv && !def.computed && !f.label.includes('(') ? <span className="font-normal text-ink-3"> ({def.unit})</span> : null}</>
  if (def.computed) {
    return (
      <FieldWrap label={label} help={bmi ? undefined : 'From height and weight'}>
        <div className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 text-sm tabular text-ink" aria-live="polite">
          {bmi ? <>{bmi.value}<Badge tone={bmi.tone}>{bmi.label}</Badge></> : <span className="text-ink-3">—</span>}
        </div>
      </FieldWrap>
    )
  }
  if (def.kind === 'select') {
    return (
      <FieldWrap label={label} required={f.required} error={error} htmlFor={id}>
        <Select id={id} value={vals[f.key] ?? ''} invalid={!!error} disabled={f.readonly} onChange={(e) => set(f.key, e.target.value)}>
          {!f.required && <option value="">—</option>}
          {def.options!.map((o) => <option key={o}>{o}</option>)}
        </Select>
      </FieldWrap>
    )
  }
  if (def.kind === 'date') {
    return (
      <FieldWrap label={label} required={f.required} error={error} htmlFor={id}>
        <Input id={id} type="date" max={todayISO()} value={vals[f.key] ?? ''} invalid={!!error} readOnly={f.readonly} onChange={(e) => set(f.key, e.target.value)} />
      </FieldWrap>
    )
  }
  const numProps = { type: 'number', inputMode: def.int ? 'numeric' : 'decimal', step: def.int ? 1 : 'any', readOnly: f.readonly } as const
  if (def.conv === 'height') {
    return (
      <FieldWrap label={label} required={f.required} error={error} htmlFor={id}>
        <div className="flex">
          {units.height === 'cm' ? (
            <Input id={id} {...numProps} className="rounded-r-none" invalid={!!error} value={vals.height ?? ''} onChange={(e) => set('height', e.target.value)} />
          ) : (
            <>
              <Input id={id} {...numProps} className="rounded-r-none px-2" placeholder="ft" aria-label="Height feet" invalid={!!error} value={vals.height_ft ?? ''} onChange={(e) => set('height_ft', e.target.value)} />
              <Input {...numProps} className="rounded-none border-l-0 px-2" placeholder="in" aria-label="Height inches" invalid={!!error} value={vals.height_in ?? ''} onChange={(e) => set('height_in', e.target.value)} />
            </>
          )}
          <select className={unitSelect} value={units.height} aria-label="Height unit" onChange={(e) => setUnit('height', e.target.value as Units['height'])}>
            <option value="cm">cm</option><option value="ftin">ft-in</option>
          </select>
        </div>
      </FieldWrap>
    )
  }
  if (def.conv) {
    const k = def.conv
    const opts = k === 'weight' ? [['kg', 'kg'], ['lb', 'lb']] : [['F', '°F'], ['C', '°C']]
    return (
      <FieldWrap label={label} required={f.required} error={error} htmlFor={id}>
        <div className="flex">
          <Input id={id} {...numProps} className="rounded-r-none" invalid={!!error} value={vals[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
          <select className={unitSelect} value={units[k]} aria-label={`${def.label} unit`} onChange={(e) => setUnit(k, e.target.value as never)}>
            {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </FieldWrap>
    )
  }
  return (
    <FieldWrap label={label} required={f.required} error={error} htmlFor={id}>
      <Input id={id} {...numProps} min={def.min} max={def.max} invalid={!!error} value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
    </FieldWrap>
  )
}

function AssessSelect({ id, label, value, options, error, onChange }: {
  id: string; label: string; value: string; options: string[]; error?: string; onChange: (v: string) => void
}) {
  return (
    <FieldWrap label={label} error={error} htmlFor={id}>
      <Select id={id} value={value} invalid={!!error} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </Select>
    </FieldWrap>
  )
}
