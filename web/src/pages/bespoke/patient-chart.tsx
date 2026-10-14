import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChartFrame, Lines } from '@/components/charts'
import { RefPicker } from '@/components/fields'
import { NewButton, RecordFormModal, TransitionDialog, useEntity, useMyEmployeeId } from '@/components/records'
import {
  Avatar, Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, KeyValue, Segmented, Spinner, StatusBadge, type BadgeTone,
} from '@/components/ui'
import { api } from '@/lib/api'
import { date, dateTime, number, time } from '@/lib/format'
import type { Rec, TransitionDef } from '@/lib/types'
import type { BespokeProps } from './index'

interface Allergy { allergen: string; severity?: string | null; reaction?: string | null; source: string; verification?: string | null }
interface Vital {
  id: string; code?: string; recorded_at: string; temperature?: number; temperature_c?: number; pulse?: number; resp_rate?: number
  bp_systolic?: number; bp_diastolic?: number; spo2?: number; o2_support?: string; pain_score?: number; gcs?: number
  blood_sugar?: number; weight?: number; height?: number; bmi?: number; news2?: number | null; news2_risk?: string | null
  news2_missing?: string[] | null; recorded_by?: string
}
interface Med {
  item_id: string; name: string; generic?: string; dose?: string; route?: string; frequency?: string; duration_days?: number
  instructions?: string; prescription_code?: string; prescribed_at?: string; until?: string; doctor?: string; high_alert?: boolean; schedule?: string
}
interface Encounter {
  encounter_id: string; encounter_code: string; type: string; status: string; doctor_id?: string; started_at?: string
  bed_no?: string; ward?: string; diagnosis?: string
}
interface Chart {
  patient: Rec
  encounter: Encounter | null
  allergies: Allergy[]
  vitals: { hours: number; series: Vital[]; latest: Vital | null }
  notes: Rec[]
  problems: Rec[]
  resolved_problems: Rec[]
  medications: Med[]
  mar_today: Rec[]
  io_today: { intake: number; output: number; balance: number; entries: number }
  history: Rec | null
  refs: Record<string, string>
}

const RANGES = [{ key: '24', label: '24 h' }, { key: '72', label: '72 h' }, { key: '168', label: '7 days' }] as const

function news2Tone(score?: number | null, risk?: string | null): BadgeTone {
  if (score === null || score === undefined) return 'gray'
  if (score >= 7) return 'red'
  if (score >= 5 || risk === 'Low-medium') return 'amber'
  return 'green'
}

function News2Badge({ score, risk }: { score?: number | null; risk?: string | null }) {
  if (score === null || score === undefined) return <Badge tone="gray">NEWS2 —</Badge>
  return <Badge tone={news2Tone(score, risk)} dot>NEWS2 {score} · {risk ?? ''}</Badge>
}

export default function PatientChart(_: BespokeProps) {
  const [params, setParams] = useSearchParams()
  const pid = params.get('patient')
  const [hours, setHours] = useState<'24' | '72' | '168'>('72')
  const setPatient = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('patient', id); else p.delete('patient')
    setParams(p)
  }
  const q = useQuery({
    queryKey: ['x', 'emr', 'chart', pid, hours],
    queryFn: () => api<Chart>(`/clinical/patients/${pid}/chart`, { query: { hours } }),
    enabled: !!pid,
    refetchInterval: 60_000,
  })
  return (
    <div className="space-y-4">
      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <FieldWrap label="Patient" className="w-full max-w-md">
            <RefPicker refName="registration.patients" kind="patient" value={pid} onChange={(id) => setPatient(id)}
              placeholder="Search UHID, name or mobile" label={q.data?.patient.id === pid ? `${q.data.patient.title} · ${q.data.patient.code}` : undefined} />
          </FieldWrap>
          {pid && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Segmented value={hours} onChange={setHours} options={RANGES.map((r) => ({ key: r.key, label: r.label }))} />
              <Link to={`/patients/${pid}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">
                360° view
              </Link>
              <Link to={`/m/orders/cpoe?patient=${pid}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">
                Orders
              </Link>
            </div>
          )}
        </div>
      </Card>
      {!pid && (
        <Empty icon="FileHeart" title="Open a patient's chart">
          Search by UHID, name or mobile number. The chart shows vitals trends with NEWS2, the problem list, allergies, current medicines,
          clinical notes and today's intake / output.
        </Empty>
      )}
      {q.isLoading && <Spinner label="Opening chart…" />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && <ChartBody c={q.data} pid={pid!} />}
    </div>
  )
}

function ChartBody({ c, pid }: { c: Chart; pid: string }) {
  const latest = c.vitals.latest
  return (
    <>
      <Banner c={c} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <VitalsPanel c={c} pid={pid} />
          <NotesPanel c={c} pid={pid} />
        </div>
        <div className="space-y-4">
          <AllergiesCard c={c} pid={pid} />
          <MedsCard c={c} />
          <ProblemsCard c={c} pid={pid} />
          <IoCard c={c} pid={pid} />
          <HistoryCard c={c} pid={pid} />
        </div>
      </div>
      {latest?.news2_missing?.length ? (
        <p className="text-xs text-ink-3">Latest NEWS2 is partial — not recorded: {latest.news2_missing.join(', ')} (scored as normal).</p>
      ) : null}
    </>
  )
}

function Banner({ c }: { c: Chart }) {
  const p = c.patient
  const e = c.encounter
  const latest = c.vitals.latest
  return (
    <div className="flex flex-wrap items-start gap-4 rounded-xl border border-line bg-surface px-4 py-3">
      <Avatar name={p.title} size="lg" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/patients/${p.id}`} className="text-lg font-semibold text-ink hover:underline">{p.title}</Link>
          <span className="font-mono text-xs text-ink-2">{p.code}</span>
          <span className="text-sm text-ink-2">{[p.age !== null && p.age !== undefined ? `${p.age}y` : null, p.gender, p.blood_group].filter(Boolean).join(' · ')}</span>
          {p.status && p.status !== 'Active' && <StatusBadge status={p.status} />}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {c.allergies.length ? c.allergies.map((a) => (
            <Badge key={a.allergen} tone="red">
              Allergy: {a.allergen}{a.severity ? ` (${a.severity})` : ''}
            </Badge>
          )) : <Badge tone="gray">No known allergies recorded</Badge>}
        </div>
        <div className="text-sm text-ink-2">
          {e ? (
            <>
              <span className="font-medium text-ink">{e.type === 'IPD' ? 'Inpatient' : e.type}</span> · {e.encounter_code} · <StatusBadge status={e.status} />
              {e.ward && <> · {e.ward}{e.bed_no ? ` · bed ${e.bed_no}` : ''}</>}
              {e.doctor_id && <> · {c.refs[e.doctor_id] ?? 'Doctor'}</>}
              {e.started_at && <> · since {dateTime(e.started_at)}</>}
              {e.diagnosis && <> · <span className="text-ink">{e.diagnosis}</span></>}
            </>
          ) : 'No active encounter'}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <News2Badge score={latest?.news2} risk={latest?.news2_risk} />
        {latest && <span className="text-xs text-ink-3">Last vitals {dateTime(latest.recorded_at)}</span>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ vitals

const short = (iso: string) => { try { return format(parseISO(iso), 'dd/MM HH:mm') } catch { return iso } }

function VitalsPanel({ c, pid }: { c: Chart; pid: string }) {
  const vitals = useEntity('emr.vitals')
  const qc = useQueryClient()
  const pts = c.vitals.series.map((v) => ({
    t: short(v.recorded_at), hr: v.pulse ?? null, sys: v.bp_systolic ?? null, dia: v.bp_diastolic ?? null, spo2: v.spo2 ?? null,
    temp: v.temperature ?? null, news2: v.news2 ?? null, rr: v.resp_rate ?? null,
  }))
  const l = c.vitals.latest
  const table = (cols: string[], keys: (keyof (typeof pts)[number])[]) => ({
    columns: ['Time', ...cols], rows: pts.map((p) => [p.t, ...keys.map((k) => (p[k] === null ? '—' : String(p[k])))]),
  })
  return (
    <Card title="Vitals" icon="Activity" actions={
      <NewButton entity={vitals} label="Record vitals" fixed={{ patient_id: pid, ...(c.encounter ? { encounter_id: c.encounter.encounter_id } : {}) }}
        onSaved={() => qc.invalidateQueries({ queryKey: ['x', 'emr', 'chart', pid] })} />
    }>
      {l ? (
        <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Vital label="Pulse" value={l.pulse} unit="bpm" />
          <Vital label="BP" value={l.bp_systolic ? `${l.bp_systolic}/${l.bp_diastolic ?? '—'}` : null} unit="mmHg" />
          <Vital label="SpO2" value={l.spo2} unit={`% ${l.o2_support && l.o2_support !== 'Room air' ? `on ${l.o2_support}` : 'RA'}`} />
          <Vital label="Resp. rate" value={l.resp_rate} unit="/min" />
          <Vital label="Temp" value={l.temperature} unit={l.temperature_c ? `°F (${l.temperature_c} °C)` : '°F'} />
          <Vital label="GCS · pain" value={l.gcs || l.pain_score !== undefined ? `${l.gcs ?? '—'} · ${l.pain_score ?? '—'}` : null} />
          {(l.bmi || l.blood_sugar) ? <Vital label="BMI" value={l.bmi} unit="kg/m²" /> : null}
          {l.blood_sugar ? <Vital label="CBG" value={l.blood_sugar} unit="mg/dL" /> : null}
        </div>
      ) : <Empty icon="Activity" title="No vitals recorded yet" />}
      {pts.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          <ChartFrame title="Heart rate" subtitle="bpm" height={150} table={table(['HR'], ['hr'])}>
            <Lines data={pts} x="t" series={[{ key: 'hr', label: 'Heart rate' }]} />
          </ChartFrame>
          <ChartFrame title="Blood pressure" subtitle="mmHg" height={150} table={table(['Systolic', 'Diastolic'], ['sys', 'dia'])}>
            <Lines data={pts} x="t" series={[{ key: 'sys', label: 'Systolic' }, { key: 'dia', label: 'Diastolic' }]} />
          </ChartFrame>
          <ChartFrame title="SpO2" subtitle="%" height={150} table={table(['SpO2'], ['spo2'])}>
            <Lines data={pts} x="t" series={[{ key: 'spo2', label: 'SpO2' }]} />
          </ChartFrame>
          <ChartFrame title="Temperature" subtitle="°F" height={150} table={table(['Temp °F'], ['temp'])}>
            <Lines data={pts} x="t" series={[{ key: 'temp', label: 'Temperature' }]} fmt={(v) => v.toFixed(1)} />
          </ChartFrame>
        </div>
      ) : l ? <p className="text-sm text-ink-3">No vitals in the selected window — showing the last recorded set.</p> : null}
      {pts.length > 0 && (
        <div className="mt-3 overflow-x-auto scroll-thin">
          <table className="w-full text-xs">
            <thead className="text-ink-3"><tr><th className="py-1 pr-3 text-left font-medium">NEWS2 trend</th>{pts.slice(-12).map((p, i) => <th key={i} className="px-1 py-1 text-center font-normal tabular">{p.t.slice(6)}</th>)}</tr></thead>
            <tbody><tr><td className="py-1 pr-3 text-ink-2">Score</td>{c.vitals.series.slice(-12).map((v) => (
              <td key={v.id} className="px-1 py-1 text-center"><Badge tone={news2Tone(v.news2, v.news2_risk)}>{v.news2 ?? '—'}</Badge></td>
            ))}</tr></tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Vital({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="text-base font-semibold tabular text-ink">{value ?? '—'}</div>
      {unit && <div className="truncate text-[11px] text-ink-3">{unit}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ notes

function NotesPanel({ c, pid }: { c: Chart; pid: string }) {
  const notes = useEntity('emr.notes')
  const qc = useQueryClient()
  const me = useMyEmployeeId()
  const [open, setOpen] = useState(false)
  const [sign, setSign] = useState<{ rec: Rec; t: TransitionDef } | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['x', 'emr', 'chart', pid] })
  const signT = notes?.transitions.find((t) => t.to === 'Signed')
  return (
    <Card title="Clinical notes" icon="NotebookPen" actions={notes && <Button size="sm" variant="primary" icon="Plus" onClick={() => setOpen(true)}>New note</Button>}>
      {c.notes.length === 0 ? <Empty icon="NotebookPen" title="No notes yet">Signed notes and your own drafts appear here.</Empty> : (
        <ol className="relative space-y-4 border-l border-line pl-5">
          {c.notes.map((n) => (
            <li key={n.id} className="relative">
              <span className={cn('absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface', n.status === 'Draft' ? 'bg-amber-500' : 'bg-brand-600')} />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-ink">{n.note_type}</span>
                <StatusBadge status={n.status} />
                <span className="text-xs text-ink-3">{dateTime(n.noted_at ?? n.created_at)} · {c.refs[n.author] ?? 'Author'}</span>
                {n.status === 'Draft' && signT && n.author === me && (
                  <Button size="xs" variant="success" className="ml-auto" onClick={() => setSign({ rec: { ...n, _refs: c.refs }, t: signT })}>Sign</Button>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{n.note}</p>
              {n.amendment_reason && <p className="mt-1 text-xs italic text-ink-3">Amended: {n.amendment_reason}</p>}
            </li>
          ))}
        </ol>
      )}
      {notes && (
        <RecordFormModal entity={notes} open={open} onClose={() => setOpen(false)} onSaved={refresh} title="New clinical note"
          fixed={{ patient_id: pid, ...(c.encounter ? { encounter_id: c.encounter.encounter_id } : {}) }} />
      )}
      {sign && notes && <TransitionDialog entity={notes} rec={sign.rec} t={sign.t} onClose={() => setSign(null)} onDone={() => { setSign(null); refresh() }} />}
    </Card>
  )
}

// ------------------------------------------------------------------ side cards

function AllergiesCard({ c, pid }: { c: Chart; pid: string }) {
  const ent = useEntity('emr.allergies')
  const qc = useQueryClient()
  return (
    <Card title="Allergies" icon="ShieldAlert" actions={<NewButton entity={ent} label="Add" variant="secondary" fixed={{ patient_id: pid }}
      onSaved={() => qc.invalidateQueries({ queryKey: ['x', 'emr', 'chart', pid] })} />}>
      {c.allergies.length === 0 ? <p className="text-sm text-ink-3">No known allergies recorded. Confirm with the patient.</p> : (
        <ul className="space-y-2">
          {c.allergies.map((a) => (
            <li key={a.allergen} className="flex items-start justify-between gap-2 text-sm">
              <div>
                <div className="font-medium text-red-700 dark:text-red-300">{a.allergen}</div>
                <div className="text-xs text-ink-3">{[a.reaction, a.verification, `from ${a.source}`].filter(Boolean).join(' · ')}</div>
              </div>
              {a.severity && <Badge tone={a.severity === 'Severe' || a.severity === 'Life-threatening' ? 'red' : 'amber'}>{a.severity}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function MedsCard({ c }: { c: Chart }) {
  return (
    <Card title="Current medications" icon="Pill">
      {c.medications.length === 0 ? <p className="text-sm text-ink-3">No active prescriptions.</p> : (
        <ul className="divide-y divide-line">
          {c.medications.map((m, i) => (
            <li key={`${m.prescription_code}-${m.item_id}-${i}`} className="py-1.5 text-sm">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-ink">{m.name}</span>
                {m.high_alert && <Badge tone="red">High-alert</Badge>}
                {m.schedule && ['H1', 'X', 'Narcotic'].includes(m.schedule) && <Badge tone="violet">{m.schedule}</Badge>}
              </div>
              <div className="text-xs text-ink-2">{[m.dose, m.route, m.frequency, m.duration_days ? `${m.duration_days} d` : null].filter(Boolean).join(' · ')}</div>
              <div className="text-xs text-ink-3">{m.prescription_code} · until {date(m.until)}{m.instructions ? ` · ${m.instructions}` : ''}</div>
            </li>
          ))}
        </ul>
      )}
      {c.mar_today.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-1.5 text-xs font-semibold text-ink-2">Today's MAR</div>
          <ul className="space-y-1">
            {c.mar_today.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="tabular text-ink-2">{time(m.scheduled_at)}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{m.drug_name} {m.dose ?? ''} {m.route ?? ''}</span>
                <StatusBadge status={m.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

function ProblemsCard({ c, pid }: { c: Chart; pid: string }) {
  const ent = useEntity('emr.problems')
  const qc = useQueryClient()
  return (
    <Card title="Problem list" icon="ListChecks" actions={<NewButton entity={ent} label="Add" variant="secondary" fixed={{ patient_id: pid }}
      onSaved={() => qc.invalidateQueries({ queryKey: ['x', 'emr', 'chart', pid] })} />}>
      {c.problems.length === 0 ? <p className="text-sm text-ink-3">No active problems.</p> : (
        <ul className="space-y-1.5">
          {c.problems.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-2 text-sm">
              <span className="text-ink">{p.problem}{p.icd_code && <span className="ml-1 font-mono text-xs text-ink-3">{p.icd_code}</span>}</span>
              <span className="shrink-0 text-xs text-ink-3">{[p.chronicity, p.onset_date ? date(p.onset_date) : null].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      {c.resolved_problems.length > 0 && (
        <p className="mt-2 text-xs text-ink-3">Resolved: {c.resolved_problems.map((p) => p.problem).join(', ')}</p>
      )}
    </Card>
  )
}

function IoCard({ c, pid }: { c: Chart; pid: string }) {
  const ent = useEntity('nursing.io_charts')
  const qc = useQueryClient()
  const io = c.io_today
  return (
    <Card title="Intake / output today" icon="Droplets" actions={<NewButton entity={ent} label="Add" variant="secondary"
      fixed={{ patient_id: pid, ...(c.encounter ? { encounter_id: c.encounter.encounter_id } : {}) }}
      onSaved={() => qc.invalidateQueries({ queryKey: ['x', 'emr', 'chart', pid] })} />}>
      {io.entries === 0 ? <p className="text-sm text-ink-3">No I/O charted today.</p> : (
        <KeyValue cols={3} items={[
          { label: 'Intake', value: <span className="tabular">{number(io.intake)} ml</span> },
          { label: 'Output', value: <span className="tabular">{number(io.output)} ml</span> },
          { label: 'Balance', value: <span className={cn('tabular font-semibold', io.balance < 0 ? 'text-amber-700 dark:text-amber-300' : 'text-ink')}>{io.balance > 0 ? '+' : ''}{number(io.balance)} ml</span> },
        ]} />
      )}
    </Card>
  )
}

function HistoryCard({ c, pid }: { c: Chart; pid: string }) {
  const ent = useEntity('emr.history')
  const qc = useQueryClient()
  const h = c.history
  return (
    <Card title="History" icon="History" actions={<NewButton entity={ent} label={h ? 'Review' : 'Add'} variant="secondary" fixed={{ patient_id: pid }}
      onSaved={() => qc.invalidateQueries({ queryKey: ['x', 'emr', 'chart', pid] })} />}>
      {!h ? <p className="text-sm text-ink-3">No history recorded.</p> : (
        <div className="space-y-2 text-sm">
          {h.chronic_conditions?.length > 0 && (
            <div className="flex flex-wrap gap-1">{(h.chronic_conditions as string[]).map((x) => <Badge key={x} tone="blue">{x}</Badge>)}</div>
          )}
          <KeyValue cols={2} items={[
            { label: 'Smoking', value: h.smoking ?? '—' }, { label: 'Alcohol', value: h.alcohol ?? '—' },
            { label: 'Past surgical', value: h.past_surgical ?? '—', full: true }, { label: 'Family history', value: h.family_history ?? '—', full: true },
          ]} />
          <p className="text-xs text-ink-3">Reviewed {date(h.reviewed_on)}</p>
        </div>
      )}
    </Card>
  )
}
