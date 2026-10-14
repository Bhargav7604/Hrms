import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, FieldWrap, Input, Select, Spinner, StatusBadge } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import type { Rec } from '@/lib/types'
import { erKey, useErRefresh, useErSettings, type VisitDetail, type VitalPoint } from '../api'
import { VitalsEntry } from '../dialogs'
import { ClockBadge, Lbl, NarrativeField, SectionHead, Seg, targetText, TRIAGE_DOT, TriagePill } from '../ui'

const RED_FLAGS = ['Airway compromise', 'Respiratory distress', 'Shock', 'Chest pain (suspected ACS)', 'Stroke signs (BE-FAST)', 'Active seizure',
  'Altered sensorium', 'Major trauma', 'Poisoning / envenomation', 'Pregnancy with bleeding / pain', 'Severe pain (≥7)', 'No signs of life']

// ------------------------------------------------------------------ triage

export function TriagePanel({ d }: { d: VisitDetail }) {
  const settings = useErSettings()
  const refresh = useErRefresh()
  const p = d.permissions
  const s = d.summary
  const retriage = !!s.triaged_at
  const [level, setLevel] = useState('')
  const [flags, setFlags] = useState<string[]>([])
  const [vit, setVit] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [reason, setReason] = useState('')
  const levels = (settings.data?.triage.levels ?? []).filter((l) => l.enabled !== false)
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { level, red_flags: flags, notes: notes || null, retriage_reason: reason || null }
      for (const [k, v] of Object.entries(vit)) if (v !== '') body[k] = Number(v)
      return api(`/er/visits/${s.id}/triage`, { method: 'POST', body })
    },
    onSuccess: () => { toast.success(retriage ? 'Re-triage recorded' : 'Triage recorded'); setLevel(''); setFlags([]); setVit({}); setNotes(''); setReason(''); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Card icon="Siren" title={retriage ? 'Re-triage' : 'Triage'} actions={s.triage && <span className="flex items-center gap-2"><TriagePill triage={s.triage} /><ClockBadge state={s.triage_clock.state} /></span>}>
        {!p.triage ? (
          s.triage ? <p className="text-sm text-ink-2">Current level <TriagePill triage={s.triage} /> · target {targetText(s.triage.target_minutes)}</p>
            : <Empty icon="Siren" title="Not triaged yet" />
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); m.mutate() }} className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {levels.map((l) => {
                const on = level === l.key
                return (
                  <button key={l.key} type="button" aria-pressed={on} onClick={() => setLevel(on ? '' : l.key)}
                    className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm', on ? 'border-brand-700 bg-brand-50 ring-2 ring-brand-700/20 dark:bg-brand-500/15' : 'border-line-2 hover:bg-surface-2')}>
                    <span className={cn('size-3.5 shrink-0 rounded-full', TRIAGE_DOT[l.color ?? l.key])} />
                    <span className="flex-1">
                      <span className="block font-medium text-ink">{l.label}{l.priority && ` (${l.priority})`}</span>
                      <span className="text-xs text-ink-3">Doctor within {targetText(l.target_minutes)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <div>
              <Lbl>Red flags</Lbl>
              <div className="flex flex-wrap gap-1.5">
                {RED_FLAGS.map((f) => {
                  const on = flags.includes(f)
                  return (
                    <button key={f} type="button" aria-pressed={on} onClick={() => setFlags(on ? flags.filter((x) => x !== f) : [...flags, f])}
                      className={cn('rounded-full px-2.5 py-1 text-xs ring-1', on ? 'bg-red-600 text-white ring-red-700' : 'bg-surface-2 text-ink-2 ring-line hover:text-ink')}>
                      {f}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
              {[['pulse', 'Pulse'], ['bp_systolic', 'BP sys'], ['spo2', 'SpO₂ %'], ['resp_rate', 'RR'], ['gcs', 'GCS'], ['pain_score', 'Pain'], ['rbs', 'RBS']].map(([k, label]) => (
                <FieldWrap key={k} label={label}><Input type="number" inputMode="decimal" value={vit[k] ?? ''} onChange={(e) => setVit({ ...vit, [k]: e.target.value })} /></FieldWrap>
              ))}
            </div>
            <FieldWrap label="Triage notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></FieldWrap>
            {retriage && <FieldWrap label="Reason for re-triage" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. deteriorated — SpO₂ falling" /></FieldWrap>}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={!level || (retriage && !reason.trim())} loading={m.isPending}>{retriage ? 'Save re-triage' : 'Save triage'}</Button>
            </div>
          </form>
        )}
      </Card>
      <Card icon="History" title="Triage history" pad={false}>
        {!d.triage_history.length ? <Empty icon="History" title="No triage recorded yet" /> : (
          <ul className="divide-y divide-line">
            {d.triage_history.map((t) => {
              const lv = (settings.data?.triage.levels ?? []).find((l) => l.value === t.triage_level)
              return (
                <li key={t.id} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <TriagePill triage={lv ?? { key: 'none', value: t.triage_level, label: t.triage_level }} />
                    {t.retriage && <Badge tone="blue">Re-triage</Badge>}
                    <span className="ml-auto text-xs text-ink-3">{dateTime(t.triaged_at)} · {d.refs[t.triage_nurse] ?? '—'}</span>
                  </div>
                  {t.retriage_reason && <p className="mt-1 text-xs text-ink-2">Reason: {t.retriage_reason}</p>}
                  {!!t.red_flags?.length && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{t.red_flags.join(' · ')}</p>}
                  {t.notes && <p className="mt-1 text-xs text-ink-2">{t.notes}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ nursing assessment

const AIRWAY = ['Patent', 'Partially obstructed', 'Obstructed', 'Maintained with adjunct', 'Secured (ETT / SGA)']
const CIRCULATION = ['Normal', 'Pale / cold peripheries', 'Delayed capillary refill (> 2 s)', 'Active bleeding', 'Shock']
const SPO2_ON = ['Room air', 'Nasal prongs', 'Face mask', 'Venturi mask', 'NRBM', 'HFNC', 'NIV (BiPAP/CPAP)', 'Ventilator / BVM']
const VITALS: [string, string, number, number][] = [
  ['bp_systolic', 'BP systolic (mmHg)', 0, 300], ['bp_diastolic', 'BP diastolic (mmHg)', 0, 200], ['pulse', 'Pulse (/min)', 0, 300],
  ['resp_rate', 'Respiratory rate (/min)', 0, 80], ['temperature', 'Temperature (°F)', 90, 110], ['spo2', 'SpO₂ (%)', 0, 100], ['grbs', 'GRBS (mg/dL)', 0, 1500],
]
const NUM_KEYS = ['bp_systolic', 'bp_diastolic', 'pulse', 'resp_rate', 'temperature', 'spo2', 'grbs', 'gcs_e', 'gcs_v', 'gcs_m', 'pain_score']
const TEXT_KEYS = ['avpu', 'airway', 'breathing', 'circulation', 'fall_risk', 'skin', 'spo2_on', 'medication_allergy', 'food_allergy', 'other_allergies',
  'pain_location', 'pain_character', 'pain_type', 'pain_duration', 'notes']

type Form = Record<string, string | number | null>

function fromRecord(r: Rec | null): Form {
  const f: Form = {}
  for (const k of [...NUM_KEYS, ...TEXT_KEYS]) f[k] = r?.[k] ?? null
  return f
}

export function NursingAssessment({ d }: { d: VisitDetail }) {
  const refresh = useErRefresh()
  const edit = d.permissions.nursing
  const [f, setF] = useState<Form>(() => fromRecord(d.nursing))
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setF(fromRecord(d.nursing)) }, [d.nursing, dirty])
  const set = (k: string, v: string | number | null) => { setF((x) => ({ ...x, [k]: v })); setDirty(true) }
  const num = (k: string) => (f[k] === null || f[k] === undefined ? '' : String(f[k]))
  const gcs = ['gcs_e', 'gcs_v', 'gcs_m'].every((k) => f[k] !== null && f[k] !== undefined && f[k] !== '') ? Number(f.gcs_e) + Number(f.gcs_v) + Number(f.gcs_m) : null
  const invalid = VITALS.some(([k, , lo, hi]) => num(k) !== '' && (Number(num(k)) < lo || Number(num(k)) > hi))
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {}
      for (const k of NUM_KEYS) body[k] = f[k] === null || f[k] === '' ? null : Number(f[k])
      for (const k of TEXT_KEYS) body[k] = f[k] === '' ? null : f[k]
      return api<Rec>(`/er/visits/${d.summary.id}/nursing-assessment`, { method: 'POST', body })
    },
    onSuccess: () => { toast.success('Nursing assessment saved — vitals added to the chart'); setDirty(false); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  useShortcuts('Nursing assessment', edit ? [{ keys: 'mod+s', label: 'Save nursing assessment', allowInInput: true, run: () => !invalid && save.mutate() }] : [])
  const seg = (k: string, label: string, opts: readonly string[]) => (
    <div><Lbl>{label}</Lbl><Seg options={opts} value={(f[k] as string) ?? null} onChange={(v) => set(k, v)} disabled={!edit} /></div>
  )
  return (
    <Card icon="ClipboardHeart" title={<>Nursing assessment <span className="font-normal text-ink-3">· {d.nursing ? `recorded ${dateTime(d.nursing.assessed_at)} by ${d.refs[d.nursing.assessed_by] ?? '—'}` : 'not recorded yet'}</span></>}
      actions={<>
        {d.nursing && <a href={`/er/visits/${d.summary.id}/print?doc=nursing`} target="_blank" rel="noreferrer"><Button size="sm" icon="Printer">Print</Button></a>}
        {edit && <Button size="sm" variant="primary" icon="Save" loading={save.isPending} disabled={invalid} onClick={() => save.mutate()}>Save nursing assessment</Button>}
      </>}>
      <SectionHead no={1} title="Status" tone="blue" icon="Activity" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {seg('avpu', 'Level of consciousness (AVPU)', ['Alert', 'Voice', 'Pain', 'Unresponsive'])}
        <div><Lbl>Airway</Lbl>
          <Select value={(f.airway as string) ?? ''} disabled={!edit} onChange={(e) => set('airway', e.target.value || null)}>
            <option value="">Select…</option>{AIRWAY.map((a) => <option key={a}>{a}</option>)}
          </Select>
        </div>
        {seg('breathing', 'Breathing', ['Normal', 'Laboured', 'Assisted'])}
        <div><Lbl>Circulation</Lbl>
          <Select value={(f.circulation as string) ?? ''} disabled={!edit} onChange={(e) => set('circulation', e.target.value || null)}>
            <option value="">Select…</option>{CIRCULATION.map((a) => <option key={a}>{a}</option>)}
          </Select>
        </div>
        {seg('fall_risk', 'Fall risk', ['Low', 'Moderate', 'High'])}
        <div className="xl:col-span-3"><Lbl>Skin / pressure areas</Lbl><Input value={(f.skin as string) ?? ''} disabled={!edit} onChange={(e) => set('skin', e.target.value)} /></div>
      </div>

      <SectionHead no={2} title="Vitals" tone="pink" icon="HeartPulse" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {VITALS.map(([k, label, lo, hi]) => {
          const bad = num(k) !== '' && (Number(num(k)) < lo || Number(num(k)) > hi)
          return (
            <FieldWrap key={k} label={label} error={bad ? `${lo}–${hi}` : undefined}>
              <Input type="number" inputMode="decimal" step={k === 'temperature' ? 0.1 : 1} value={num(k)} invalid={bad} disabled={!edit} onChange={(e) => set(k, e.target.value === '' ? null : e.target.value)} />
            </FieldWrap>
          )
        })}
        <FieldWrap label="SpO₂ on">
          <Select value={(f.spo2_on as string) ?? ''} disabled={!edit} onChange={(e) => set('spo2_on', e.target.value || null)}>
            <option value="">Select…</option>{SPO2_ON.map((a) => <option key={a}>{a}</option>)}
          </Select>
        </FieldWrap>
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        <div><Lbl>GCS — Eye (1–4)</Lbl><Seg options={[1, 2, 3, 4]} value={f.gcs_e === null ? null : Number(f.gcs_e)} onChange={(v) => set('gcs_e', v)} disabled={!edit} /></div>
        <div><Lbl>GCS — Verbal (1–5)</Lbl><Seg options={[1, 2, 3, 4, 5]} value={f.gcs_v === null ? null : Number(f.gcs_v)} onChange={(v) => set('gcs_v', v)} disabled={!edit} /></div>
        <div><Lbl>GCS — Motor (1–6)</Lbl><Seg options={[1, 2, 3, 4, 5, 6]} value={f.gcs_m === null ? null : Number(f.gcs_m)} onChange={(v) => set('gcs_m', v)} disabled={!edit} /></div>
      </div>
      <p className="mt-1 text-xs text-ink-2">GCS total: <b className={cn('text-ink', gcs !== null && gcs <= 8 && 'text-red-600')}>{gcs ?? '—'}</b>{gcs !== null && gcs <= 8 && ' · airway at risk (≤ 8)'}</p>
      <div className="mt-3"><Lbl>Pain score (0–10)</Lbl>
        <Seg options={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} value={f.pain_score === null ? null : Number(f.pain_score)} onChange={(v) => set('pain_score', v)} disabled={!edit} />
      </div>

      <SectionHead no={3} title="Allergies" tone="green" icon="TriangleAlert" />
      <div className="grid gap-4 md:grid-cols-3">
        {seg('medication_allergy', 'Medication allergy', ['Yes', 'No'])}
        {seg('food_allergy', 'Food allergy', ['Yes', 'No'])}
        <div><Lbl>Other allergies / details</Lbl><Input value={(f.other_allergies as string) ?? ''} disabled={!edit} onChange={(e) => set('other_allergies', e.target.value)} /></div>
      </div>

      <SectionHead no={4} title="Pain" tone="violet" icon="Zap" />
      <div className="grid gap-4 md:grid-cols-4">
        <div><Lbl>Pain location</Lbl><Input value={(f.pain_location as string) ?? ''} disabled={!edit} onChange={(e) => set('pain_location', e.target.value)} /></div>
        <div><Lbl>Pain character</Lbl><Input value={(f.pain_character as string) ?? ''} disabled={!edit} onChange={(e) => set('pain_character', e.target.value)} placeholder="Dull, sharp, burning…" /></div>
        {seg('pain_type', 'Acute / chronic', ['Acute', 'Chronic'])}
        <div><Lbl>Duration</Lbl><Input value={(f.pain_duration as string) ?? ''} disabled={!edit} onChange={(e) => set('pain_duration', e.target.value)} placeholder="e.g. 2 hours" /></div>
      </div>
      <div className="mt-4">
        <NarrativeField label="Nursing notes" value={(f.notes as string) ?? ''} onChange={(v) => set('notes', v)} disabled={!edit} context="er.nursing" />
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ vitals list

export function VitalsPanel({ d }: { d: VisitDetail }) {
  const q = useQuery({
    queryKey: erKey('vitals', d.summary.id, '720'),
    queryFn: () => api<{ series: VitalPoint[] }>(`/er/visits/${d.summary.id}/vitals`, { query: { hours: 720 } }),
  })
  const rows = [...(q.data?.series ?? [])].reverse()
  return (
    <div className="space-y-4">
      {d.permissions.vitals && <Card icon="HeartPulse" title="Record observations"><VitalsEntry visitId={d.summary.id} compact /></Card>}
      <Card icon="Table" title="Observations" pad={false}>
        {q.isLoading ? <Spinner /> : !rows.length ? <Empty icon="HeartPulse" title="No observations recorded" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-surface-2 text-left text-[11px] uppercase text-ink-3">
                <tr>{['Time', 'BP', 'Pulse', 'RR', 'SpO₂', 'O₂', 'Temp °F', 'GCS', 'Pain', 'GRBS', 'NEWS2'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line tabular-nums">
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td className="px-3 py-1.5 text-ink-2">{dateTime(v.recorded_at)}</td>
                    <td className="px-3 py-1.5">{v.bp_systolic ? `${v.bp_systolic}/${v.bp_diastolic ?? '—'}` : '—'}</td>
                    <td className="px-3 py-1.5">{v.pulse ?? '—'}</td>
                    <td className="px-3 py-1.5">{v.resp_rate ?? '—'}</td>
                    <td className="px-3 py-1.5">{v.spo2 ?? '—'}</td>
                    <td className="px-3 py-1.5 text-xs">{v.o2_support ?? '—'}</td>
                    <td className="px-3 py-1.5">{v.temperature ?? '—'}</td>
                    <td className="px-3 py-1.5">{v.gcs ?? '—'}</td>
                    <td className="px-3 py-1.5">{v.pain_score ?? '—'}</td>
                    <td className="px-3 py-1.5">{v.blood_sugar ?? '—'}</td>
                    <td className="px-3 py-1.5">{v.news2 !== undefined && v.news2 !== null ? <Badge tone={v.news2 >= 7 ? 'red' : v.news2 >= 5 ? 'amber' : 'green'}>{v.news2} · {v.news2_risk}</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ S-BAR handover

function currentShift(shifts: { key: string; start: string }[]) {
  const now = new Date()
  const mins = now.getHours() * 60 + now.getMinutes()
  const starts = shifts.map((s) => ({ ...s, m: Number(s.start.slice(0, 2)) * 60 + Number(s.start.slice(3, 5)) })).sort((a, b) => a.m - b.m)
  return (starts.filter((s) => s.m <= mins).pop() ?? starts[starts.length - 1])?.key ?? 'Morning'
}

export function HandoverPanel({ d }: { d: VisitDetail }) {
  const settings = useErSettings()
  const refresh = useErRefresh()
  const shifts = settings.data?.handover.shifts ?? [{ key: 'Morning', start: '08:00' }, { key: 'Evening', start: '14:00' }, { key: 'Night', start: '20:00' }]
  const [f, setF] = useState({ shift: '', situation: '', background: '', assessment: '', recommendation: '' })
  const [to, setTo] = useState<string | null>(null)
  const s = d.summary
  const prefill = () => setF({
    shift: f.shift, situation: `${s.patient.name}, ${s.patient.age ?? '?'}y ${s.patient.gender ?? ''} on ${s.bed?.bed_no ?? 'no bed'} — ${s.chief_complaint ?? ''}`.trim(),
    background: [d.doctor_assessment?.past_history, s.mlc ? 'Medico-legal case' : null, d.allergies.length ? `Allergies: ${d.allergies.map((a) => a.allergen).join(', ')}` : null].filter(Boolean).join('. '),
    assessment: [s.triage?.label, d.latest_vitals ? `Last obs BP ${d.latest_vitals.bp_systolic ?? '—'}/${d.latest_vitals.bp_diastolic ?? '—'}, HR ${d.latest_vitals.pulse ?? '—'}, SpO₂ ${d.latest_vitals.spo2 ?? '—'}%` : null, s.provisional_diagnosis].filter(Boolean).join('. '),
    recommendation: `Pending: ${s.current_step.label}`,
  })
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${s.id}/handover`, { method: 'POST', body: { ...f, shift: f.shift || currentShift(shifts), handed_over_to: to } }),
    onSuccess: () => { toast.success('Handover recorded'); setF({ shift: '', situation: '', background: '', assessment: '', recommendation: '' }); setTo(null); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const ack = useMutation({
    mutationFn: (id: string) => api(`/m/er/handovers/${id}/transition`, { method: 'POST', body: { to: 'Acknowledged' } }),
    onSuccess: () => { toast.success('Handover acknowledged'); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {d.permissions.handover && (
        <Card icon="ArrowLeftRight" title="S-BAR shift handover" actions={<Button size="xs" variant="ghost" icon="Wand2" onClick={prefill}>Prefill from chart</Button>}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate() }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldWrap label="Shift">
                <Select value={f.shift || currentShift(shifts)} onChange={(e) => setF({ ...f, shift: e.target.value })}>{shifts.map((x) => <option key={x.key}>{x.key}</option>)}</Select>
              </FieldWrap>
              <FieldWrap label="Handed over to"><RefPicker refName="employees.employees" value={to} onChange={(id) => setTo(id)} placeholder="Receiving nurse / doctor" /></FieldWrap>
            </div>
            <NarrativeField label="S — Situation" required value={f.situation} onChange={(v) => setF({ ...f, situation: v })} rows={2} context="er.sbar.situation" />
            <NarrativeField label="B — Background" value={f.background} onChange={(v) => setF({ ...f, background: v })} rows={2} context="er.sbar.background" />
            <NarrativeField label="A — Assessment" value={f.assessment} onChange={(v) => setF({ ...f, assessment: v })} rows={2} context="er.sbar.assessment" />
            <NarrativeField label="R — Recommendation" value={f.recommendation} onChange={(v) => setF({ ...f, recommendation: v })} rows={2} context="er.sbar.recommendation" />
            <div className="flex justify-end"><Button type="submit" variant="primary" disabled={f.situation.trim().length < 2} loading={m.isPending}>Record handover</Button></div>
          </form>
        </Card>
      )}
      <Card icon="History" title="Handovers" pad={false} className={cn(!d.permissions.handover && 'xl:col-span-2')}>
        {!d.handovers.length ? <Empty icon="ArrowLeftRight" title="No handover recorded" /> : (
          <ul className="divide-y divide-line">
            {d.handovers.map((h) => (
              <li key={h.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-ink">{h.shift} shift</b>
                  <span className="text-xs text-ink-3">{dateTime(h.handover_at)} · {d.refs[h.handed_over_by] ?? '—'} → {d.refs[h.handed_over_to] ?? 'anyone'}</span>
                  <span className="ml-auto"><StatusBadge status={h.status} /></span>
                  {h.status === 'Handed Over' && d.permissions.handover && <Button size="xs" loading={ack.isPending} onClick={() => ack.mutate(h.id)}>Acknowledge</Button>}
                </div>
                <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {(['situation', 'background', 'assessment', 'recommendation'] as const).map((k) => (
                    <div key={k}><dt className="text-[11px] font-semibold uppercase text-ink-3">{k}</dt><dd className="whitespace-pre-wrap text-ink">{h[k] || '—'}</dd></div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
