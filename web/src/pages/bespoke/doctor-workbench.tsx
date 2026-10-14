import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { RefPicker, useDebounced } from '@/components/fields'
import {
  Avatar, Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Kbd, Modal, Select, Spinner, StatTile, StatusBadge, Tabs, Textarea,
  type BadgeTone,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, minutes, time } from '@/lib/format'
import type { Rec } from '@/lib/types'
import type { BespokeProps } from './index'

interface QueueRow {
  id: string; code: string; token_no?: number; slot?: string; type?: string; status: string; patient_id: string; patient: string; uhid: string
  age?: number | null; gender?: string | null; phone?: string | null; allergies: string[]; reason?: string | null; encounter_id?: string | null
  checked_in_at?: string | null; consult_started_at?: string | null; completed_at?: string | null; wait_minutes?: number | null
  in_consult_minutes?: number | null; consultation: { id: string; code: string; status: string; diagnosis?: string | null } | null
}
interface Inpatient {
  encounter_id: string; admission_code: string; patient_id: string; patient: string; uhid: string; age?: number | null; gender?: string | null
  allergies: string[]; bed_no?: string; ward?: string; diagnosis?: string; status: string; los_days?: number | null; news2?: number | null
  risk?: string | null; new_results: number; critical_unack: number
}
interface Workbench {
  doctor: { id: string; name?: string }
  date: string
  queue: QueueRow[]
  by_status: Record<string, number>
  kpis: Record<string, number | null>
  inpatients: Inpatient[]
  consults: Rec[]
  unsigned_notes: Rec[]
  refs: Record<string, string>
}
interface Alert { type: string; label: string; severity: 'Contraindicated' | 'Major' | 'Moderate' | 'Minor'; item: string; with?: string | null; message: string; blocking: boolean }
interface Line { drug: string | null; dose: string; route: string; frequency: string; duration_days: string; qty: string; instructions: string; autoQty: boolean }

const ROUTES = ['Oral', 'IV', 'IM', 'SC', 'Topical', 'Inhalation', 'Sublingual', 'PR', 'Ophthalmic', 'Other']
const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT', 'Q4H', 'Q6H', 'Q8H', 'Weekly']
const PER_DAY: Record<string, number> = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1, STAT: 1, Q4H: 6, Q6H: 4, Q8H: 3, Weekly: 1 / 7 }
const QUEUE_ORDER: Record<string, number> = { 'In Consultation': 0, 'Checked-in': 1, Booked: 2, Completed: 3, 'No-show': 4, Cancelled: 5 }
const emptyLine = (): Line => ({ drug: null, dose: '', route: 'Oral', frequency: 'BD', duration_days: '5', qty: '', instructions: '', autoQty: true })

const SEVERITY_TONE: Record<string, BadgeTone> = { Contraindicated: 'red', Major: 'red', Moderate: 'amber', Minor: 'gray' }

function autoQty(l: Line): string {
  const per = PER_DAY[l.frequency]
  const days = Number(l.duration_days)
  if (!per || !days) return l.frequency === 'STAT' ? '1' : l.qty
  return String(Math.max(1, Math.ceil(per * days)))
}

export default function DoctorWorkbench(_: BespokeProps) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'inpatients' | 'consults' | 'notes'>('inpatients')
  const [ipRx, setIpRx] = useState<Inpatient | null>(null)
  const wb = useQuery({ queryKey: ['x', 'opd', 'workbench'], queryFn: () => api<Workbench>('/clinical/workbench'), refetchInterval: 30_000 })
  const queue = useMemo(() => [...(wb.data?.queue ?? [])].sort((a, b) =>
    (QUEUE_ORDER[a.status] ?? 9) - (QUEUE_ORDER[b.status] ?? 9) || (a.token_no ?? 999) - (b.token_no ?? 999)), [wb.data])
  const current = queue.find((q) => q.id === sel) ?? null
  const start = useMutation({
    mutationFn: (id: string) => api<{ appointment: Rec; consultation: Rec }>('/clinical/workbench/start', { method: 'POST', body: { appointment_id: id } }),
    onSuccess: (r) => { setSel(r.appointment.id); qc.invalidateQueries({ queryKey: ['x', 'opd'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const next = queue.find((q) => q.status === 'Checked-in')
  if (wb.isLoading) return <Spinner label="Loading your worklist…" />
  if (wb.error) return <ErrorBox error={wb.error} />
  const d = wb.data!
  const k = d.kpis
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile icon="CalendarDays" label="Appointments today" value={k.appointments ?? 0} hint={`${k.booked ?? 0} yet to arrive`} />
        <StatTile icon="Hourglass" label="Waiting" value={k.waiting ?? 0} hint={k.avg_wait_minutes !== null ? `avg wait ${minutes(k.avg_wait_minutes)}` : 'no one waiting'}
          tone={(k.avg_wait_minutes ?? 0) > 30 ? 'alert' : 'default'} />
        <StatTile icon="Stethoscope" label="In consultation" value={k.in_consultation ?? 0} />
        <StatTile icon="CheckCircle2" label="Seen today" value={k.seen ?? 0} />
        <StatTile icon="BedDouble" label="My inpatients" value={k.inpatients ?? 0} onClick={() => setTab('inpatients')} />
        <StatTile icon="FileSignature" label="Unsigned notes · consults" value={`${k.unsigned_notes ?? 0} · ${k.consults_pending ?? 0}`}
          tone={(k.unsigned_notes ?? 0) > 0 ? 'alert' : 'default'} onClick={() => setTab('notes')} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Card pad={false} title={`Today's queue · ${d.doctor.name ?? ''}`} icon="ListOrdered"
          actions={<>
            {current && current.status !== 'Booked' && <Button size="xs" icon="NotebookPen" onClick={async () => {
              try {
                const r = await api<{ encounter_id: string }>(`/opd/visits/${current.id}/open`, { method: 'POST' })
                navigate(`/op/emr/${r.encounter_id}`)
              } catch (e) { toast.error(errorMessage(e)) }
            }}>Full OP EMR</Button>}
            <Link to="/op/my-clinic" className="text-xs text-brand-700 hover:underline dark:text-brand-300">My Clinic</Link>
            <Button size="xs" variant="primary" disabled={!next} loading={start.isPending} onClick={() => next && start.mutate(next.id)}>Call next</Button>
          </>}>
          {queue.length === 0 ? <Empty icon="CalendarX2" title="No appointments today" /> : (
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto scroll-thin">
              {queue.map((q) => (
                <li key={q.id}>
                  <button onClick={() => setSel(q.id)}
                    className={cn('flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-2', sel === q.id && 'bg-brand-50 dark:bg-brand-500/10')}>
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-sm font-semibold tabular text-ink ring-1 ring-line">{q.token_no ?? '—'}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{q.patient}</span>
                      <span className="block truncate text-xs text-ink-3">{q.uhid} · {[q.age !== null && q.age !== undefined ? `${q.age}y` : null, q.gender?.[0]].filter(Boolean).join('/')} · {q.slot} · {q.type}</span>
                      {q.allergies.length > 0 && <span className="block truncate text-xs text-red-600 dark:text-red-300">Allergy: {q.allergies.join(', ')}</span>}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={q.status} />
                      {q.status === 'Checked-in' && q.wait_minutes !== null && q.wait_minutes !== undefined && (
                        <span className={cn('text-xs tabular', q.wait_minutes > 30 ? 'text-red-600 dark:text-red-300' : 'text-ink-3')}>waiting {minutes(q.wait_minutes)}</span>
                      )}
                      {q.status === 'In Consultation' && q.in_consult_minutes !== null && <span className="text-xs text-ink-3">{minutes(q.in_consult_minutes)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="min-w-0">
          {current ? (
            <ConsultPanel key={current.id} appt={current} onStart={() => start.mutate(current.id)} starting={start.isPending}
              onDone={() => { const n = queue.find((q) => q.status === 'Checked-in' && q.id !== current.id); setSel(n?.id ?? null) }} />
          ) : (
            <Card><Empty icon="Stethoscope" title="Select a patient from the queue">
              <span>Press <b>Call next</b> to start the next checked-in patient. In the consult panel, <Kbd>Ctrl</Kbd> + <Kbd>S</Kbd> saves and <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> completes.</span>
            </Empty></Card>
          )}
        </div>
      </div>

      <Card pad={false}>
        <Tabs className="px-3" value={tab} onChange={setTab} tabs={[
          { key: 'inpatients', label: 'My inpatients', icon: 'BedDouble', count: d.inpatients.length },
          { key: 'consults', label: 'Consult requests', icon: 'MessagesSquare', count: d.consults.length },
          { key: 'notes', label: 'Unsigned notes', icon: 'FileSignature', count: d.unsigned_notes.length },
        ]} />
        {tab === 'inpatients' && <Inpatients rows={d.inpatients} onPrescribe={setIpRx} />}
        {tab === 'consults' && <SimpleList rows={d.consults} refs={d.refs} empty="No pending consult requests" link={(r) => `/m/caremgmt/consults?r=${r.id}`}
          render={(r) => <><span className="font-medium text-ink">{r.title}</span><span className="text-xs text-ink-3"> · {(r.patient_id && d.refs[r.patient_id]) || ''} · requested {dateTime(r.requested_at ?? r.created_at)}</span></>} />}
        {tab === 'notes' && <SimpleList rows={d.unsigned_notes} refs={d.refs} empty="All your notes are signed" link={(r) => `/m/emr/patient-chart?patient=${r.patient_id}`}
          render={(r) => <><span className="font-medium text-ink">{r.note_type}</span><span className="text-xs text-ink-3"> · {(r.patient_id && d.refs[r.patient_id]) || ''} · {dateTime(r.noted_at ?? r.created_at)}</span></>} />}
      </Card>
      {ipRx && <InpatientRxModal ip={ipRx} onClose={() => setIpRx(null)} />}
    </div>
  )
}

function Inpatients({ rows, onPrescribe }: { rows: Inpatient[]; onPrescribe: (r: Inpatient) => void }) {
  if (!rows.length) return <Empty icon="BedDouble" title="No admitted patients under your care" />
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
          <tr>{['Bed', 'Patient', 'Diagnosis', 'LOS', 'NEWS2', 'Results', ''].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.encounter_id} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-3 py-2"><div className="font-medium text-ink">{r.bed_no ?? '—'}</div><div className="text-xs text-ink-3">{r.ward}</div></td>
              <td className="px-3 py-2">
                <Link to={`/m/emr/patient-chart?patient=${r.patient_id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{r.patient}</Link>
                <div className="text-xs text-ink-3">{r.uhid} · {r.admission_code} {r.status !== 'Admitted' && <StatusBadge status={r.status} />}</div>
                {r.allergies.length > 0 && <div className="text-xs text-red-600 dark:text-red-300">Allergy: {r.allergies.join(', ')}</div>}
              </td>
              <td className="max-w-xs truncate px-3 py-2 text-ink-2">{r.diagnosis ?? '—'}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular text-ink-2">{r.los_days ?? 0} d</td>
              <td className="px-3 py-2">{r.news2 !== null && r.news2 !== undefined
                ? <Badge tone={r.news2 >= 7 ? 'red' : r.news2 >= 5 || r.risk === 'Low-medium' ? 'amber' : 'green'}>{r.news2} · {r.risk}</Badge>
                : <span className="text-xs text-ink-3">no vitals</span>}</td>
              <td className="whitespace-nowrap px-3 py-2">
                {r.critical_unack > 0 && <Badge tone="red">{r.critical_unack} critical</Badge>}{' '}
                {r.new_results > 0 ? <Badge tone="blue">{r.new_results} new (24 h)</Badge> : r.critical_unack === 0 && <span className="text-xs text-ink-3">—</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                <Button size="xs" variant="ghost" icon="Pill" onClick={() => onPrescribe(r)}>Prescribe</Button>
                <Link to={`/m/orders/cpoe?patient=${r.patient_id}`} className="ml-1 text-xs text-brand-700 hover:underline dark:text-brand-300">Orders</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SimpleList({ rows, render, link, empty }: { rows: Rec[]; refs: Record<string, string>; render: (r: Rec) => ReactNode; link: (r: Rec) => string; empty: string }) {
  if (!rows.length) return <Empty icon="CheckCircle2" title={empty} />
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id}><Link to={link(r)} className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-surface-2">
          <span className="min-w-0 truncate text-sm">{render(r)}</span><StatusBadge status={r.status} />
        </Link></li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------ consultation panel

interface ChartCtx { allergies: { allergen: string; severity?: string | null }[]; vitals: { latest: Rec | null }; medications: { name: string; dose?: string; frequency?: string }[] }
type ConsultFields = Record<'chief_complaint' | 'hpi' | 'examination' | 'diagnosis' | 'icd_code' | 'plan' | 'advice' | 'follow_up_date', string> & { review_with_reports: boolean }
const BLANK: ConsultFields = { chief_complaint: '', hpi: '', examination: '', diagnosis: '', icd_code: '', plan: '', advice: '', follow_up_date: '', review_with_reports: false }

function ConsultPanel({ appt, onStart, starting, onDone }: { appt: QueueRow; onStart: () => void; starting: boolean; onDone: () => void }) {
  const qc = useQueryClient()
  const cid = appt.consultation?.id
  const cons = useQuery({ queryKey: ['x', 'opd', 'consultation', cid], queryFn: () => api<Rec>(`/m/opd/consultations/${cid}`), enabled: !!cid })
  const rxq = useQuery({
    queryKey: ['x', 'opd', 'rx-of', cid],
    queryFn: () => api<{ rows: Rec[]; refs: Record<string, string> }>('/m/opd/prescriptions', { query: { f_consultation: cid!, limit: 5 } }),
    enabled: !!cid,
  })
  const ctx = useQuery({ queryKey: ['x', 'emr', 'chart', appt.patient_id, '24'], queryFn: () => api<ChartCtx>(`/clinical/patients/${appt.patient_id}/chart`, { query: { hours: 24 } }) })
  const [f, setF] = useState<ConsultFields>(BLANK)
  const [rx, setRx] = useState<{ id: string | null; status?: string; lines: Line[]; names: Record<string, string> }>({ id: null, lines: [], names: {} })
  const loaded = useRef<string | null>(null)
  useEffect(() => {
    if (!cid || !cons.data || !rxq.data || loaded.current === cid) return
    loaded.current = cid
    const c = cons.data
    setF({ ...BLANK, ...Object.fromEntries(Object.keys(BLANK).map((k) => [k, c[k] ?? (k === 'review_with_reports' ? false : '')])) } as ConsultFields)
    const r = rxq.data.rows.find((x) => x.status !== 'Cancelled')
    if (r) {
      setRx({
        id: r.id, status: r.status, names: rxq.data.refs,
        lines: (r.items ?? []).map((l: Rec) => ({ drug: l.drug, dose: l.dose ?? '', route: l.route ?? 'Oral', frequency: l.frequency ?? '', duration_days: l.duration_days ? String(l.duration_days) : '',
          qty: l.qty ? String(l.qty) : '', instructions: l.instructions ?? '', autoQty: false })),
      })
    }
  }, [cid, cons.data, rxq.data])
  const set = (k: keyof ConsultFields, v: string | boolean) => setF((s) => ({ ...s, [k]: v }))
  const open = appt.status === 'In Consultation' && (!appt.consultation || appt.consultation.status === 'Open')
  const editable = open && (!cid || (!!cons.data && !!rxq.data))
  const rxLocked = !!rx.status && rx.status !== 'Active'

  const body = () => ({
    patient_id: appt.patient_id, consultation_id: cid, appointment_id: appt.id, consultation: f,
    prescription: rxLocked ? undefined : { id: rx.id, diagnosis: f.diagnosis || undefined, items: rx.lines.filter((l) => l.drug).map((l) => ({
      drug: l.drug, dose: l.dose || null, route: l.route || null, frequency: l.frequency || null, duration_days: l.duration_days ? Number(l.duration_days) : null,
      qty: l.qty ? Number(l.qty) : null, instructions: l.instructions || null,
    })) },
  })
  const save = useMutation({
    mutationFn: () => api<{ consultation: Rec | null; prescription: Rec | null; alerts: Alert[] }>('/clinical/workbench/save', { method: 'POST', body: body() }),
    onSuccess: (r) => {
      if (r.prescription) setRx((s) => ({ ...s, id: r.prescription!.status === 'Cancelled' ? null : r.prescription!.id, status: r.prescription!.status }))
      qc.invalidateQueries({ queryKey: ['x', 'opd'] })
      return r
    },
  })
  const complete = useMutation({
    mutationFn: async () => {
      const r = await save.mutateAsync()
      const id = r.consultation?.id ?? cid
      if (!id) throw new Error('Save the consultation first')
      return api<{ follow_up: Rec | null }>('/clinical/workbench/complete', { method: 'POST', body: { consultation_id: id } })
    },
    onSuccess: (r) => {
      toast.success(`Consultation completed${r.follow_up ? ` · follow-up ${r.follow_up.due_date}` : ''}`)
      qc.invalidateQueries({ queryKey: ['x', 'opd'] })
      onDone()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const onKey = (e: KeyboardEvent) => {
    if (!editable || !(e.ctrlKey || e.metaKey)) return
    if (e.key === 's') {
      e.preventDefault()
      save.mutate(undefined, { onSuccess: () => toast.success('Saved'), onError: (x) => toast.error(errorMessage(x)) })
    } else if (e.key === 'Enter') { e.preventDefault(); complete.mutate() }
  }
  const latest = ctx.data?.vitals.latest
  return (
    <div className="space-y-3" onKeyDown={onKey}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <Avatar name={appt.patient} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/m/emr/patient-chart?patient=${appt.patient_id}`} className="font-semibold text-ink hover:underline">{appt.patient}</Link>
            <span className="font-mono text-xs text-ink-2">{appt.uhid}</span>
            <span className="text-sm text-ink-2">{[appt.age !== null && appt.age !== undefined ? `${appt.age}y` : null, appt.gender].filter(Boolean).join(' · ')}</span>
            <StatusBadge status={appt.status} />
            <Badge tone="gray">Token {appt.token_no ?? '—'} · {appt.type}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(ctx.data?.allergies ?? []).map((a) => <Badge key={a.allergen} tone="red">Allergy: {a.allergen}{a.severity ? ` (${a.severity})` : ''}</Badge>)}
            {ctx.data && !ctx.data.allergies.length && <Badge tone="gray">No known allergies recorded</Badge>}
            {latest && <span className="text-xs text-ink-2">Vitals {time(latest.recorded_at)}: BP {latest.bp_systolic ?? '—'}/{latest.bp_diastolic ?? '—'} · HR {latest.pulse ?? '—'} · SpO2 {latest.spo2 ?? '—'}% · T {latest.temperature ?? '—'}°F{latest.news2 !== null && latest.news2 !== undefined ? ` · NEWS2 ${latest.news2}` : ''}</span>}
          </div>
          {ctx.data && ctx.data.medications.length > 0 && <div className="mt-1 truncate text-xs text-ink-3">On: {ctx.data.medications.map((m) => `${m.name} ${m.frequency ?? ''}`).join(', ')}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/m/orders/cpoe?patient=${appt.patient_id}`} className="inline-flex h-8 items-center rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">Order tests</Link>
          {appt.status === 'Checked-in' && <Button size="sm" variant="primary" icon="Play" loading={starting} onClick={onStart}>Start consultation</Button>}
        </div>
      </div>
      {appt.reason && <p className="px-1 text-sm text-ink-2">Reason for visit: <span className="text-ink">{appt.reason}</span></p>}
      {appt.status === 'Booked' && <Card><Empty icon="Clock" title="Patient has not checked in yet">The front desk checks the patient in and collects the consultation fee.</Empty></Card>}
      {(appt.status === 'Checked-in' || appt.status === 'In Consultation' || appt.status === 'Completed') && (cid && (cons.isLoading || rxq.isLoading) ? <Spinner /> : (
        <>
          <Card title="Consultation" icon="ClipboardPen" actions={cid && <span className="text-xs text-ink-3">{appt.consultation?.code}</span>}>
            <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-6">
              <FieldWrap label="Chief complaint" className="sm:col-span-6"><Input value={f.chief_complaint} onChange={(e) => set('chief_complaint', e.target.value)} placeholder="e.g. Fever with chills × 3 days" /></FieldWrap>
              <FieldWrap label="History of present illness" className="sm:col-span-3"><Textarea rows={3} value={f.hpi} onChange={(e) => set('hpi', e.target.value)} /></FieldWrap>
              <FieldWrap label="Examination" className="sm:col-span-3"><Textarea rows={3} value={f.examination} onChange={(e) => set('examination', e.target.value)} placeholder="General & systemic examination" /></FieldWrap>
              <FieldWrap label="Diagnosis" required className="sm:col-span-4"><Input value={f.diagnosis} onChange={(e) => set('diagnosis', e.target.value)} /></FieldWrap>
              <FieldWrap label="ICD-10" className="sm:col-span-2"><Input value={f.icd_code} onChange={(e) => set('icd_code', e.target.value.toUpperCase())} placeholder="J18.9" /></FieldWrap>
              <FieldWrap label="Plan" className="sm:col-span-3"><Textarea rows={2} value={f.plan} onChange={(e) => set('plan', e.target.value)} /></FieldWrap>
              <FieldWrap label="Advice (printed on the prescription)" className="sm:col-span-3"><Textarea rows={2} value={f.advice} onChange={(e) => set('advice', e.target.value)} /></FieldWrap>
              <FieldWrap label="Follow-up date" className="sm:col-span-2"><Input type="date" value={f.follow_up_date} onChange={(e) => set('follow_up_date', e.target.value)} /></FieldWrap>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink sm:col-span-4">
                <input type="checkbox" className="size-4 accent-brand-700" checked={f.review_with_reports} onChange={(e) => set('review_with_reports', e.target.checked)} />
                Review with reports
              </label>
            </fieldset>
          </Card>
          <Card title="E-prescription" icon="Pill" actions={rx.status && <StatusBadge status={rx.status} />}>
            {rxLocked && <p className="mb-2 text-sm text-amber-700 dark:text-amber-300">Pharmacy has started dispensing this prescription — it can no longer be edited.</p>}
            <RxBuilder patientId={appt.patient_id} lines={rx.lines} names={rx.names} disabled={!editable || rxLocked}
              onChange={(lines, names) => setRx((s) => ({ ...s, lines, names: { ...s.names, ...names } }))} />
          </Card>
          {open && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-xs text-ink-3"><Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> save · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> complete</span>
              <Button icon="Save" loading={save.isPending && !complete.isPending} disabled={!editable}
                onClick={() => save.mutate(undefined, { onSuccess: () => toast.success('Consultation saved'), onError: (e) => toast.error(errorMessage(e)) })}>Save draft</Button>
              <Button variant="success" icon="CheckCircle2" loading={complete.isPending} disabled={!editable || !f.diagnosis.trim()} onClick={() => complete.mutate()}>
                Complete consultation
              </Button>
            </div>
          )}
        </>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ e-prescription builder with live safety checks

function RxBuilder({ patientId, lines, names, onChange, disabled }: {
  patientId: string; lines: Line[]; names: Record<string, string>; onChange: (l: Line[], names: Record<string, string>) => void; disabled?: boolean
}) {
  const items = lines.filter((l) => l.drug).map((l) => ({ item_id: l.drug!, qty: Number(l.qty) || 0 }))
  const key = useDebounced(JSON.stringify(items), 400)
  const check = useQuery({
    queryKey: ['x', 'pharmacy', 'check', patientId, key],
    queryFn: () => api<{ alerts: Alert[] }>('/pharmacy/check', { method: 'POST', body: { patient_id: patientId, items: JSON.parse(key), purpose: 'prescribe' } }),
    enabled: key !== '[]',
    placeholderData: (p) => p,
  })
  const upd = (i: number, patch: Partial<Line>, newNames: Record<string, string> = {}) => {
    const out = lines.map((l, j) => {
      if (j !== i) return l
      const n = { ...l, ...patch }
      if ('qty' in patch) n.autoQty = false
      else if (n.autoQty && ('frequency' in patch || 'duration_days' in patch || 'drug' in patch)) n.qty = autoQty(n)
      return n
    })
    onChange(out, newNames)
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-line scroll-thin">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-surface-2 text-xs text-ink-2">
            <tr>{['Medicine', 'Dose', 'Route', 'Frequency', 'Days', 'Qty', 'Instructions', ''].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="w-64 px-1 py-1">
                  <RefPicker refName="mdm.items" filter={{ type: 'Drug', status: 'Active' }} value={l.drug} disabled={disabled}
                    label={l.drug ? names[l.drug] : undefined} placeholder="Search drug / generic"
                    onChange={(id, row) => upd(i, { drug: id, dose: l.dose || row?.strength || '' }, id && row ? { [id]: row.title || row.label } : {})} />
                </td>
                <td className="w-24 px-1 py-1"><Input value={l.dose} disabled={disabled} onChange={(e) => upd(i, { dose: e.target.value })} placeholder="500 mg" /></td>
                <td className="w-28 px-1 py-1"><Select value={l.route} disabled={disabled} onChange={(e) => upd(i, { route: e.target.value })}>{ROUTES.map((r) => <option key={r}>{r}</option>)}</Select></td>
                <td className="w-24 px-1 py-1"><Select value={l.frequency} disabled={disabled} onChange={(e) => upd(i, { frequency: e.target.value })}>{FREQUENCIES.map((r) => <option key={r}>{r}</option>)}</Select></td>
                <td className="w-16 px-1 py-1"><Input type="number" min={0} value={l.duration_days} disabled={disabled} onChange={(e) => upd(i, { duration_days: e.target.value })} className="tabular" /></td>
                <td className="w-20 px-1 py-1"><Input type="number" min={0} value={l.qty} disabled={disabled} invalid={!!l.drug && !Number(l.qty)} onChange={(e) => upd(i, { qty: e.target.value })} className="tabular" /></td>
                <td className="px-1 py-1"><Input value={l.instructions} disabled={disabled} onChange={(e) => upd(i, { instructions: e.target.value })} placeholder="After food" /></td>
                <td className="px-1 py-1.5">
                  {!disabled && <button className="rounded p-1 text-ink-3 hover:bg-red-50 hover:text-red-600" aria-label="Remove medicine" onClick={() => onChange(lines.filter((_, j) => j !== i), {})}><Trash2 className="size-4" /></button>}
                </td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={8} className="px-3 py-3 text-center text-xs text-ink-3">No medicines prescribed</td></tr>}
          </tbody>
        </table>
        {!disabled && (
          <button className="flex w-full items-center justify-center gap-1 border-t border-line py-1.5 text-xs font-medium text-brand-700 hover:bg-surface-2 dark:text-brand-300"
            onClick={() => onChange([...lines, emptyLine()], {})}>+ Add medicine</button>
        )}
      </div>
      <AlertList alerts={check.data?.alerts ?? []} loading={check.isFetching} />
    </div>
  )
}

function AlertList({ alerts, loading }: { alerts: Alert[]; loading?: boolean }) {
  if (!alerts.length) return loading ? <p className="text-xs text-ink-3">Checking drug safety…</p> : null
  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-surface-2 p-3">
      <div className="text-xs font-semibold text-ink-2">Drug-safety alerts {loading && <span className="font-normal text-ink-3">· updating…</span>}</div>
      {alerts.map((a, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
          <span className="text-xs text-ink-3">{a.label}</span>
          <span className="min-w-0 flex-1 text-ink">{a.message}</span>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ inpatient medication orders

function InpatientRxModal({ ip, onClose }: { ip: Inpatient; onClose: () => void }) {
  const qc = useQueryClient()
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const [names, setNames] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const save = useMutation({
    mutationFn: () => api<{ prescription: Rec | null; alerts: Alert[] }>('/clinical/workbench/save', {
      method: 'POST', body: {
        patient_id: ip.patient_id, encounter_id: ip.encounter_id,
        prescription: { diagnosis: ip.diagnosis, notes: notes || undefined, items: lines.filter((l) => l.drug).map((l) => ({
          drug: l.drug, dose: l.dose || null, route: l.route, frequency: l.frequency, duration_days: l.duration_days ? Number(l.duration_days) : null,
          qty: l.qty ? Number(l.qty) : null, instructions: l.instructions || null,
        })) },
      },
    }),
    onSuccess: (r) => {
      toast.success(`Medication order ${r.prescription?.code ?? ''} sent to IP pharmacy — nursing can generate the MAR`)
      qc.invalidateQueries({ queryKey: ['x', 'opd'] })
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} size="xl" title={`Medication order · ${ip.patient} · ${ip.bed_no ?? ip.admission_code}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="Send" loading={save.isPending} disabled={!lines.some((l) => l.drug)} onClick={() => save.mutate()}>Sign & send to pharmacy</Button></>}>
      <div className="space-y-3">
        {ip.allergies.length > 0 && <div className="flex flex-wrap gap-1.5">{ip.allergies.map((a) => <Badge key={a} tone="red">Allergy: {a}</Badge>)}</div>}
        <RxBuilder patientId={ip.patient_id} lines={lines} names={names} onChange={(l, n) => { setLines(l); setNames((s) => ({ ...s, ...n })) }} />
        <FieldWrap label="Notes to pharmacy / nursing"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></FieldWrap>
      </div>
    </Modal>
  )
}
