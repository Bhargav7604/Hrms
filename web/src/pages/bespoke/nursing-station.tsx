import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Circle, ScanBarcode } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { NewButton, TransitionDialog, useEntity, useMyEmployeeId } from '@/components/records'
import {
  Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Segmented, Select, Spinner, StatTile, StatusBadge, Tabs, Textarea,
  type BadgeTone,
} from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { ago, dateTime, minutes, time } from '@/lib/format'
import type { Rec, TransitionDef } from '@/lib/types'
import type { BespokeProps } from './index'

interface Ward { id: string; code: string; name: string; ward_type?: string; beds: number; occupied: number }
interface Pt {
  encounter_id: string; admission_code: string; patient_id: string; patient: string; uhid: string; age?: number | null; gender?: string | null
  allergies: string[]; bed_id?: string | null; bed_no?: string | null; diagnosis?: string | null; status: string; los_days?: number | null
  doctor?: string | null; news2?: number | null; news2_risk?: string | null; last_vitals_at?: string | null; vitals_due: boolean
  meds_due: number; meds_overdue: number; tasks: number
}
interface MarRow {
  id: string; code: string; patient_id: string; patient?: string; uhid?: string; bed_no?: string; drug_id: string; drug: string; generic?: string
  drug_code?: string; drug_barcode?: string | null; dose?: string; route?: string; scheduled_at: string; high_alert: boolean; overdue: boolean
  due_in_minutes?: number | null; status: string; encounter_id?: string
}
interface Station {
  wards: Ward[]
  ward: Ward | null
  as_of?: string
  beds?: { id: string; bed_no: string; status: string; category?: string; patient_id?: string | null }[]
  patients?: Pt[]
  mar?: MarRow[]
  tasks?: Rec[]
  handovers?: Rec[]
  refs?: Record<string, string>
  census?: { beds: number; by_status: Record<string, number>; patients: number; high_news2: number; vitals_due: number; meds_due: number; meds_overdue: number; tasks: number; stat_tasks: number; discharges_pending: number }
}

const WARD_KEY = 'vlack.nursing.ward'
const readWard = () => { try { return localStorage.getItem(WARD_KEY) } catch { return null } }
const saveWard = (w: string) => { try { localStorage.setItem(WARD_KEY, w) } catch { /* storage unavailable */ } }
type Filter = 'all' | 'news2' | 'vitals' | 'meds'

function news2Tone(score?: number | null, risk?: string | null): BadgeTone {
  if (score === null || score === undefined) return 'gray'
  if (score >= 7) return 'red'
  if (score >= 5 || risk === 'Low-medium') return 'amber'
  return 'green'
}

export default function NursingStation(_: BespokeProps) {
  const [params, setParams] = useSearchParams()
  const ward = params.get('ward') ?? readWard() ?? ''
  const qc = useQueryClient()
  const setWard = (id: string) => {
    saveWard(id)
    const p = new URLSearchParams(params)
    p.set('ward', id)
    setParams(p, { replace: true })
  }
  const q = useQuery({
    queryKey: ['x', 'nursing', 'station', ward],
    queryFn: () => api<Station>('/clinical/nursing', { query: { ward: ward || undefined } }),
    refetchInterval: 60_000,
  })
  const gen = useMutation({
    mutationFn: () => api<{ created: number; skipped: number; admissions: number }>('/clinical/mar/generate', { method: 'POST', body: { ward_id: ward } }),
    onSuccess: (r) => {
      toast.success(`MAR generated: ${r.created} new doses for ${r.admissions} patients${r.skipped ? ` (${r.skipped} already scheduled)` : ''}`)
      qc.invalidateQueries({ queryKey: ['x', 'nursing'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const handover = useEntity('nursing.handovers')
  const task = useEntity('nursing.tasks')
  if (q.isLoading) return <Spinner label="Loading ward…" />
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404 && ward) {
      return <Empty icon="Hospital" title="That ward is no longer available" action={<Button onClick={() => setWard('')}>Choose another ward</Button>} />
    }
    return <ErrorBox error={q.error} />
  }
  const d = q.data!
  return (
    <div className="space-y-4">
      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <FieldWrap label="Ward" className="w-72">
            <Select value={d.ward?.id ?? ''} onChange={(e) => e.target.value && setWard(e.target.value)}>
              <option value="">Choose a ward…</option>
              {d.wards.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.occupied}/{w.beds}</option>)}
            </Select>
          </FieldWrap>
          {d.ward && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-3">Updated {time(d.as_of)}</span>
              <Button size="sm" icon="CalendarClock" loading={gen.isPending} onClick={() => gen.mutate()}>Generate today's MAR</Button>
              <NewButton entity={task} label="Task" variant="secondary" fixed={{ ward: d.ward.id }} onSaved={() => qc.invalidateQueries({ queryKey: ['x', 'nursing'] })} />
              <NewButton entity={handover} label="Handover" fixed={{ ward: d.ward.id }} onSaved={() => qc.invalidateQueries({ queryKey: ['x', 'nursing'] })} />
            </div>
          )}
        </div>
      </Card>
      {!d.ward ? <WardPicker wards={d.wards} onPick={setWard} /> : <WardView d={d} />}
    </div>
  )
}

function WardPicker({ wards, onPick }: { wards: Ward[]; onPick: (id: string) => void }) {
  if (!wards.length) return <Empty icon="Hospital" title="No wards configured" />
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
      {wards.map((w) => (
        <button key={w.id} onClick={() => onPick(w.id)} className="rounded-xl border border-line bg-surface px-3 py-2.5 text-left hover:border-brand-600/40 hover:bg-surface-2">
          <div className="truncate text-sm font-medium text-ink">{w.name}</div>
          <div className="text-xs text-ink-3">{w.ward_type} · {w.occupied}/{w.beds} occupied</div>
        </button>
      ))}
    </div>
  )
}

function WardView({ d }: { d: Station }) {
  const qc = useQueryClient()
  const c = d.census!
  const pts = d.patients ?? []
  const [filter, setFilter] = useState<Filter>('all')
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'mar' | 'tasks' | 'handover'>('mar')
  const [vitalsFor, setVitalsFor] = useState<Pt | null>(null)
  const shown = pts.filter((p) => filter === 'all' || (filter === 'news2' && ((p.news2 ?? 0) >= 5 || p.news2_risk === 'Low-medium'))
    || (filter === 'vitals' && p.vitals_due) || (filter === 'meds' && p.meds_due + p.meds_overdue > 0))
  const selected = pts.find((p) => p.patient_id === sel) ?? null
  const refresh = () => qc.invalidateQueries({ queryKey: ['x', 'nursing'] })
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile icon="BedDouble" label="Patients / beds" value={`${c.patients} / ${c.beds}`} hint={`${c.by_status.Vacant ?? 0} vacant · ${c.discharges_pending} discharges pending`} />
        <StatTile icon="Siren" label="NEWS2 ≥ 5 or single 3" value={c.high_news2} tone={c.high_news2 ? 'alert' : 'default'} onClick={() => setFilter('news2')} />
        <StatTile icon="Activity" label={`Vitals due (> ${6} h)`} value={c.vitals_due} onClick={() => setFilter('vitals')} />
        <StatTile icon="Pill" label="Doses due (4 h)" value={c.meds_due} onClick={() => { setFilter('meds'); setTab('mar') }} />
        <StatTile icon="AlarmClock" label="Overdue doses" value={c.meds_overdue} tone={c.meds_overdue ? 'alert' : 'default'} onClick={() => { setFilter('meds'); setTab('mar') }} />
        <StatTile icon="ListTodo" label="Pending tasks" value={c.tasks} hint={c.stat_tasks ? `${c.stat_tasks} STAT` : undefined} tone={c.stat_tasks ? 'alert' : 'default'} onClick={() => setTab('tasks')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_27rem]">
        <Card pad={false} title={`Patients · ${d.ward!.name}`} icon="Users" actions={
          <Segmented value={filter} onChange={setFilter} options={[{ key: 'all', label: 'All' }, { key: 'news2', label: 'NEWS2' }, { key: 'vitals', label: 'Vitals due' }, { key: 'meds', label: 'Meds due' }]} />
        }>
          {shown.length === 0 ? <Empty icon="Users" title={pts.length ? 'No patients match this filter' : 'No patients admitted on this ward'} /> : (
            <div className="grid gap-2 p-3 sm:grid-cols-2 2xl:grid-cols-3">
              {shown.map((p) => (
                <div key={p.patient_id} role="button" tabIndex={0} onClick={() => setSel(sel === p.patient_id ? null : p.patient_id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setSel(sel === p.patient_id ? null : p.patient_id) }}
                  className={cn('cursor-pointer rounded-lg border bg-surface p-2.5 text-left transition-colors hover:bg-surface-2',
                    sel === p.patient_id ? 'border-brand-600 ring-1 ring-brand-600/30' : 'border-line', (p.news2 ?? 0) >= 7 && 'border-red-400 dark:border-red-500/60')}>
                  <div className="flex items-start gap-2">
                    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-semibold text-ink ring-1 ring-line">{p.bed_no ?? '—'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{p.patient}</div>
                      <div className="truncate text-xs text-ink-3">{p.uhid} · {[p.age !== null && p.age !== undefined ? `${p.age}y` : null, p.gender?.[0]].filter(Boolean).join('/')} · day {(p.los_days ?? 0) + 1}</div>
                    </div>
                    <Badge tone={news2Tone(p.news2, p.news2_risk)}>{p.news2 !== null && p.news2 !== undefined ? `NEWS2 ${p.news2}` : 'No obs'}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-ink-2">{p.diagnosis ?? '—'}{p.doctor ? ` · ${p.doctor}` : ''}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {p.allergies.length > 0 && <Badge tone="red">Allergy: {p.allergies.join(', ')}</Badge>}
                    {p.status === 'Discharge Initiated' && <StatusBadge status={p.status} />}
                    {p.vitals_due && <Badge tone="amber">Vitals due{p.last_vitals_at ? ` · ${ago(p.last_vitals_at)}` : ''}</Badge>}
                    {p.meds_overdue > 0 && <Badge tone="red">{p.meds_overdue} overdue</Badge>}
                    {p.meds_due > 0 && <Badge tone="blue">{p.meds_due} due</Badge>}
                    {p.tasks > 0 && <Badge tone="violet">{p.tasks} task{p.tasks > 1 ? 's' : ''}</Badge>}
                  </div>
                  <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <Button size="xs" icon="Activity" onClick={() => setVitalsFor(p)}>Vitals</Button>
                    <Link to={`/m/emr/patient-chart?patient=${p.patient_id}`} className="inline-flex h-7 items-center rounded-lg px-2 text-xs text-brand-700 hover:bg-surface-2 dark:text-brand-300">Chart</Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card pad={false}>
          <Tabs className="px-3" value={tab} onChange={setTab} tabs={[
            { key: 'mar', label: 'MAR', icon: 'Pill', count: (d.mar ?? []).filter((m) => !sel || m.patient_id === sel).length },
            { key: 'tasks', label: 'Tasks', icon: 'ListTodo', count: (d.tasks ?? []).filter((t) => !sel || t.patient_id === sel).length },
            { key: 'handover', label: 'Handover', icon: 'ArrowRightLeft' },
          ]} />
          {selected && (
            <div className="flex items-center justify-between gap-2 border-b border-line bg-brand-50 px-3 py-1.5 text-xs dark:bg-brand-500/10">
              <span className="truncate text-ink">Showing {selected.bed_no} · {selected.patient}</span>
              <button className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => setSel(null)}>Show whole ward</button>
            </div>
          )}
          {tab === 'mar' && <MarPanel rows={(d.mar ?? []).filter((m) => !sel || m.patient_id === sel)} onChanged={refresh} />}
          {tab === 'tasks' && <TasksPanel rows={(d.tasks ?? []).filter((t) => !sel || t.patient_id === sel)} refs={d.refs ?? {}} onChanged={refresh} />}
          {tab === 'handover' && <HandoverPanel rows={d.handovers ?? []} refs={d.refs ?? {}} onChanged={refresh} />}
        </Card>
      </div>
      {vitalsFor && <QuickVitals pt={vitalsFor} onClose={() => setVitalsFor(null)} onSaved={refresh} />}
    </>
  )
}

// ------------------------------------------------------------------ MAR with BCMA

function MarPanel({ rows, onChanged }: { rows: MarRow[]; onChanged: () => void }) {
  const mar = useEntity('nursing.mar')
  const [give, setGive] = useState<MarRow | null>(null)
  const [tr, setTr] = useState<{ rec: Rec; t: TransitionDef } | null>(null)
  const startTransition = (m: MarRow, to: string) => {
    const t = mar?.transitions.find((x) => x.to === to)
    if (t) setTr({ rec: { id: m.id, code: m.code, status: m.status, patient_id: m.patient_id }, t })
  }
  if (!rows.length) return <Empty icon="Pill" title="No doses due in the next 4 hours">Generate today's MAR after new medication orders.</Empty>
  return (
    <>
      <ul className="max-h-[65vh] divide-y divide-line overflow-y-auto scroll-thin">
        {rows.map((m) => (
          <li key={m.id} className={cn('px-3 py-2', m.overdue && 'bg-red-50/60 dark:bg-red-500/5')}>
            <div className="flex items-start gap-2">
              <div className="w-12 shrink-0 text-center">
                <div className={cn('text-sm font-semibold tabular', m.overdue ? 'text-red-700 dark:text-red-300' : 'text-ink')}>{time(m.scheduled_at)}</div>
                <div className="text-[11px] text-ink-3">{m.overdue ? 'overdue' : m.due_in_minutes !== null && m.due_in_minutes !== undefined && m.due_in_minutes > 0 ? `in ${minutes(m.due_in_minutes)}` : 'due'}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-ink">{m.drug}</span>
                  {m.high_alert && <Badge tone="red">High-alert</Badge>}
                </div>
                <div className="text-xs text-ink-2">{[m.dose, m.route].filter(Boolean).join(' · ')}</div>
                <div className="truncate text-xs text-ink-3">{m.bed_no} · {m.patient} · {m.uhid}</div>
              </div>
            </div>
            <div className="mt-1.5 flex justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => startTransition(m, 'Held')}>Hold</Button>
              <Button size="xs" variant="ghost" onClick={() => startTransition(m, 'Refused')}>Refused</Button>
              <Button size="xs" variant="success" icon="ScanBarcode" onClick={() => setGive(m)}>Give</Button>
            </div>
          </li>
        ))}
      </ul>
      {give && <BcmaModal m={give} onClose={() => setGive(null)} onDone={() => { setGive(null); onChanged() }} />}
      {tr && mar && <TransitionDialog entity={mar} rec={tr.rec} t={tr.t} onClose={() => setTr(null)} onDone={() => { setTr(null); onChanged() }} />}
    </>
  )
}

const norm = (s?: string | null) => (s ?? '').replace(/\s+/g, '').toUpperCase()

function BcmaModal({ m, onClose, onDone }: { m: MarRow; onClose: () => void; onDone: () => void }) {
  const me = useMyEmployeeId()
  const [scan, setScan] = useState('')
  const [scans, setScans] = useState<string[]>([])
  const [site, setSite] = useState('')
  const [witness, setWitness] = useState<string | null>(null)
  const [remarks, setRemarks] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const uhid = norm(m.uhid)
  const drugCodes = [norm(m.drug_barcode), norm(m.drug_code)].filter(Boolean)
  const patientOk = scans.includes(uhid)
  const drugOk = scans.some((s) => drugCodes.includes(s))
  const strangers = scans.filter((s) => s !== uhid && !drugCodes.includes(s))
  const early = (m.due_in_minutes ?? 0) > 60
  const give = useMutation({
    mutationFn: () => api<Rec>(`/clinical/mar/${m.id}/administer`, {
      method: 'POST', body: { barcode: scans.join(' '), witness: witness || undefined, site: site || undefined, remarks: remarks || undefined },
    }),
    onSuccess: () => { toast.success(`${m.drug} given to ${m.patient} — barcode verified`); onDone() },
    onError: (e) => setErr(errorMessage(e)),
  })
  const addScan = () => {
    const v = norm(scan)
    if (v) setScans((s) => (s.includes(v) ? s : [...s, v]))
    setScan('')
    setErr(null)
  }
  const ready = patientOk && drugOk && (!m.high_alert || (!!witness && witness !== me)) && (!early || !!remarks.trim())
  return (
    <Modal open onClose={onClose} title="Barcode medication administration"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="success" icon="CheckCircle2" disabled={!ready} loading={give.isPending} onClick={() => give.mutate()}>Confirm administration</Button></>}>
      <div className="space-y-3">
        <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
          <div className="font-medium text-ink">{m.drug} <span className="text-ink-2">{[m.dose, m.route].filter(Boolean).join(' · ')}</span></div>
          <div className="text-xs text-ink-2">{m.bed_no} · {m.patient} · {m.uhid} · scheduled {dateTime(m.scheduled_at)}</div>
          {m.high_alert && <div className="mt-1"><Badge tone="red">High-alert — independent double-check by a second nurse</Badge></div>}
        </div>
        <FieldWrap label="Scan the patient's wristband, then the medicine" help="Scanner input ends with Enter. Item code works when the pack has no barcode.">
          <div className="relative">
            <ScanBarcode className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input ref={input} value={scan} className="pl-8 font-mono" placeholder="Scan…" onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addScan() } }} />
          </div>
        </FieldWrap>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Check ok={patientOk} label={`Patient wristband ${m.uhid}`} />
          <Check ok={drugOk} label={`Medicine ${m.drug_code ?? ''}`} />
        </div>
        {strangers.length > 0 && <p className="text-sm font-medium text-red-700 dark:text-red-300">Mismatch: {strangers.join(', ')} does not belong to this dose — stop and re-check.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldWrap label="Site / line"><Input value={site} onChange={(e) => setSite(e.target.value)} placeholder="e.g. Left forearm cannula" /></FieldWrap>
          {m.high_alert && (
            <FieldWrap label="Second nurse (double-check)" required error={witness && witness === me ? 'Choose another nurse' : undefined}>
              <RefPicker refName="employees.employees" filter={{ category: 'Nurse' }} value={witness} onChange={(id) => setWitness(id)} />
            </FieldWrap>
          )}
          <FieldWrap label={early ? 'Reason for giving early' : 'Remarks'} required={early} className="sm:col-span-2">
            <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </FieldWrap>
        </div>
        {err && <ErrorBox error={err} />}
      </div>
    </Modal>
  )
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-1.5', ok ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-line text-ink-2')}>
      {ok ? <CheckCircle2 className="size-4" /> : <Circle className="size-4" />}
      <span className="truncate">{label}</span>
      <span className="ml-auto text-xs">{ok ? 'Verified' : 'Not scanned'}</span>
    </div>
  )
}

// ------------------------------------------------------------------ tasks & handover

const PRIORITY_TONE: Record<string, BadgeTone> = { STAT: 'red', Urgent: 'amber', Routine: 'gray' }

function TasksPanel({ rows, refs, onChanged }: { rows: Rec[]; refs: Record<string, string>; onChanged: () => void }) {
  const done = useMutation({
    mutationFn: (id: string) => api(`/m/nursing/tasks/${id}/transition`, { method: 'POST', body: { to: 'Done' } }),
    onSuccess: () => { toast.success('Task done'); onChanged() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!rows.length) return <Empty icon="ListTodo" title="No pending tasks" />
  return (
    <ul className="max-h-[65vh] divide-y divide-line overflow-y-auto scroll-thin">
      {rows.map((t) => (
        <li key={t.id} className="flex items-start gap-2 px-3 py-2">
          <Badge tone={PRIORITY_TONE[t.priority] ?? 'gray'}>{t.priority ?? 'Routine'}</Badge>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-ink">{t.task}</div>
            <div className="text-xs text-ink-3">{[t.patient_id ? refs[t.patient_id] : null, t.category, t.due_at ? `due ${dateTime(t.due_at)}` : null, t.assigned_to ? refs[t.assigned_to] : null].filter(Boolean).join(' · ')}</div>
          </div>
          <Button size="xs" variant="success" loading={done.isPending && done.variables === t.id} onClick={() => done.mutate(t.id)}>Done</Button>
        </li>
      ))}
    </ul>
  )
}

function HandoverPanel({ rows, refs, onChanged }: { rows: Rec[]; refs: Record<string, string>; onChanged: () => void }) {
  const ent = useEntity('nursing.handovers')
  const [ack, setAck] = useState<{ rec: Rec; t: TransitionDef } | null>(null)
  const ackT = useMemo(() => ent?.transitions.find((t) => t.to === 'Acknowledged'), [ent])
  if (!rows.length) return <Empty icon="ArrowRightLeft" title="No handovers recorded for this ward">Use the Handover button to record an SBAR handover.</Empty>
  return (
    <ul className="max-h-[65vh] divide-y divide-line overflow-y-auto scroll-thin">
      {rows.map((h) => (
        <li key={h.id} className="space-y-1 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{h.shift} shift</span>
            <StatusBadge status={h.status} />
            <span className="text-xs text-ink-3">{dateTime(h.handover_at ?? h.created_at)}</span>
            {h.status === 'Given' && ackT && <Button size="xs" className="ml-auto" onClick={() => setAck({ rec: { ...h, _refs: refs }, t: ackT })}>Acknowledge</Button>}
          </div>
          <div className="text-xs text-ink-2">{refs[h.from_nurse] ?? '—'} → {refs[h.to_nurse] ?? '—'} · census {h.census ?? '—'} · critical {h.critical_patients ?? 0}</div>
          {(['situation', 'background', 'assessment', 'recommendation'] as const).map((k) => h[k] && (
            <p key={k} className="whitespace-pre-wrap text-xs text-ink"><span className="font-semibold text-ink-2">{k[0].toUpperCase()}:</span> {h[k]}</p>
          ))}
          {h.pending_tasks && <p className="text-xs text-amber-700 dark:text-amber-300">Pending: {h.pending_tasks}</p>}
        </li>
      ))}
      {ack && ent && <TransitionDialog entity={ent} rec={ack.rec} t={ack.t} onClose={() => setAck(null)} onDone={() => { setAck(null); onChanged() }} />}
    </ul>
  )
}

// ------------------------------------------------------------------ quick vitals

const O2 = ['Room air', 'Nasal prongs', 'Face mask', 'Venturi mask', 'NRBM', 'HFNC', 'NIV (BiPAP/CPAP)', 'Ventilator']
const VITAL_FIELDS: { key: string; label: string; unit?: string }[] = [
  { key: 'temperature', label: 'Temp', unit: '°F' }, { key: 'pulse', label: 'Pulse', unit: 'bpm' }, { key: 'resp_rate', label: 'Resp. rate', unit: '/min' },
  { key: 'bp_systolic', label: 'BP systolic', unit: 'mmHg' }, { key: 'bp_diastolic', label: 'BP diastolic', unit: 'mmHg' }, { key: 'spo2', label: 'SpO2', unit: '%' },
  { key: 'gcs', label: 'GCS', unit: '3–15' }, { key: 'pain_score', label: 'Pain', unit: '0–10' }, { key: 'blood_sugar', label: 'CBG', unit: 'mg/dL' },
]

function QuickVitals({ pt, onClose, onSaved }: { pt: Pt; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState<Record<string, string>>({ o2_support: 'Room air', gcs: '15' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { patient_id: pt.patient_id, encounter_id: pt.encounter_id, o2_support: v.o2_support, remarks: v.remarks || undefined }
      for (const f of VITAL_FIELDS) if (v[f.key]) body[f.key] = Number(v[f.key])
      return api<Rec>('/m/emr/vitals', { method: 'POST', body })
    },
    onSuccess: (r) => {
      const msg = r.news2 !== null && r.news2 !== undefined ? `NEWS2 ${r.news2} (${r.news2_risk})` : 'NEWS2 needs RR, SpO2, BP and pulse'
      if ((r.news2 ?? 0) >= 7 || r.news2_risk === 'Low-medium') toast.error(`Vitals saved — ${msg}. Escalation task raised.`, { duration: 10000 })
      else if ((r.news2 ?? 0) >= 5) toast.warning(`Vitals saved — ${msg}. Urgent review task raised.`)
      else toast.success(`Vitals saved — ${msg}`)
      qc.invalidateQueries({ queryKey: ['x', 'emr'] })
      onSaved()
      onClose()
    },
    onError: (e) => { if (e instanceof ApiError) setErrors(e.fieldErrors); toast.error(errorMessage(e)) },
  })
  return (
    <Modal open onClose={onClose} title={`Vitals · ${pt.bed_no ?? ''} ${pt.patient}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="Save" loading={save.isPending} onClick={() => save.mutate()}>Save vitals</Button></>}>
      <form className="grid grid-cols-3 gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
        {VITAL_FIELDS.map((f, i) => (
          <FieldWrap key={f.key} label={f.label} error={errors[f.key]} help={f.unit}>
            <Input type="number" inputMode="decimal" step="any" autoFocus={i === 0} className="tabular" value={v[f.key] ?? ''}
              onChange={(e) => setV((s) => ({ ...s, [f.key]: e.target.value }))} />
          </FieldWrap>
        ))}
        <FieldWrap label="Oxygen" className="col-span-3">
          <Select value={v.o2_support} onChange={(e) => setV((s) => ({ ...s, o2_support: e.target.value }))}>{O2.map((o) => <option key={o}>{o}</option>)}</Select>
        </FieldWrap>
        <FieldWrap label="Remarks" className="col-span-3"><Input value={v.remarks ?? ''} onChange={(e) => setV((s) => ({ ...s, remarks: e.target.value }))} /></FieldWrap>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  )
}
