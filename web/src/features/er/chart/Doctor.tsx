import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, FieldWrap, Input, Modal, Select, Spinner, Switch } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, nowLocal } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import { erKey, useErRefresh, type VisitDetail } from '../api'
import { Lbl, NarrativeField } from '../ui'

interface Doctor { id: string; name: string; designation?: string | null; department?: string | null; active: number; on_duty: boolean | null; primary: boolean }

// ------------------------------------------------------------------ assignment

export function DoctorAssignment({ d }: { d: VisitDetail }) {
  const refresh = useErRefresh()
  const s = d.summary
  const q = useQuery({ queryKey: erKey('visit-doctors', s.id), queryFn: () => api<{ current: string | null; doctors: Doctor[]; roster_based: boolean }>(`/er/visits/${s.id}/doctors`) })
  const [pick, setPick] = useState<Doctor | null>(null)
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${s.id}/assign-doctor`, { method: 'POST', body: { doctor_id: pick!.id, reason: reason || null } }),
    onSuccess: () => { toast.success(`${pick!.name} assigned`); setPick(null); setReason(''); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const current = q.data?.doctors.find((x) => x.id === q.data?.current)
  return (
    <Card icon="UserRoundCheck" title={<>Doctor assignment <span className="font-normal text-ink-3">· {current ? `assigned to ${current.name}` : 'not assigned'}</span></>}
      actions={current && <Badge tone="green" className="gap-1"><Icon name="UserRoundCheck" className="size-3" />{current.name}</Badge>}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        ER doctors · least loaded first{q.data?.roster_based ? ' · from today\'s duty roster' : ' · ER and medicine consultants'}
      </p>
      {q.isLoading ? <Spinner /> : !q.data?.doctors.length ? <Empty icon="Stethoscope" title="No ER doctors found">Add doctors to the Emergency Medicine department or the ER duty roster.</Empty> : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {q.data.doctors.map((doc) => {
            const cur = doc.id === q.data?.current
            return (
              <div key={doc.id} className={cn('flex items-center gap-2 rounded-lg border px-3 py-2', cur ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10' : 'border-line')}>
                <Icon name="Stethoscope" className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{doc.name}</div>
                  <div className="truncate text-xs text-ink-3">
                    {doc.department ?? '—'} · <b className={cn(doc.active >= 4 && 'text-amber-700 dark:text-amber-300')}>{doc.active} active</b>
                    {doc.on_duty && <span className="text-emerald-700 dark:text-emerald-300"> · on duty</span>}
                  </div>
                </div>
                {cur ? <Icon name="CircleCheck" className="size-5 text-emerald-600" aria-label="Currently assigned" />
                  : d.permissions.assign && <Button size="xs" onClick={() => setPick(doc)}>{q.data?.current ? 'Re-assign' : 'Assign'}</Button>}
              </div>
            )
          })}
        </div>
      )}
      <h4 className="mb-2 mt-5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3"><Icon name="History" className="size-3.5" />Assignment history</h4>
      {!d.assignments.length ? <p className="text-sm text-ink-3">No doctor assigned yet.</p> : (
        <ol className="space-y-1.5">
          {[...d.assignments].reverse().map((a, i) => (
            <li key={i} className="text-sm">
              <b className="text-ink">{a.doctor ?? '—'}</b> <span className="text-xs text-ink-3">· by {a.by ?? 'system'} · {a.reason ?? ''} · {dateTime(a.at)}</span>
            </li>
          ))}
        </ol>
      )}
      {pick && (
        <Modal open onClose={() => setPick(null)} title={`Assign ${pick.name}`} size="sm"
          footer={<><Button variant="ghost" onClick={() => setPick(null)}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Assign</Button></>}>
          <p className="text-sm text-ink-2">{pick.name} has {pick.active} active ER patient{pick.active === 1 ? '' : 's'}.</p>
          <FieldWrap label="Reason (kept in the assignment history)" className="mt-3">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. shift change, specialty need" autoFocus />
          </FieldWrap>
        </Modal>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ doctor assessment

const FIELDS = ['presenting_complaints', 'history', 'past_history', 'general_examination', 'cvs', 'rs', 'cns', 'abdomen', 'local_examination',
  'provisional_diagnosis', 'differential_diagnosis', 'plan'] as const
type DA = Record<(typeof FIELDS)[number], string>

export function DoctorAssessment({ d }: { d: VisitDetail }) {
  const refresh = useErRefresh()
  const edit = d.permissions.doctor
  const init = (): DA => Object.fromEntries(FIELDS.map((k) => [k, (d.doctor_assessment?.[k] as string) ?? (k === 'presenting_complaints' ? d.summary.chief_complaint ?? '' : '')])) as DA
  const [f, setF] = useState<DA>(init)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setF(init()) }, [d.doctor_assessment]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof DA) => (v: string) => { setF((x) => ({ ...x, [k]: v })); setDirty(true) }
  const save = useMutation({
    mutationFn: () => api(`/er/visits/${d.summary.id}/doctor-assessment`, { method: 'POST', body: Object.fromEntries(FIELDS.map((k) => [k, f[k] || null])) }),
    onSuccess: () => { toast.success(d.summary.status === 'Waiting' ? 'Assessment saved — patient marked seen by doctor' : 'Assessment saved'); setDirty(false); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const ok = f.provisional_diagnosis.trim().length >= 2
  useShortcuts('Doctor assessment', edit ? [{ keys: 'mod+s', label: 'Save assessment', allowInInput: true, run: () => ok && save.mutate() }] : [])
  if (!edit && !d.doctor_assessment) return <Card icon="Stethoscope" title="Doctor assessment"><Empty icon="Stethoscope" title="No doctor assessment yet" /></Card>
  return (
    <Card icon="Stethoscope" title={<>Doctor assessment <span className="font-normal text-ink-3">· {d.doctor_assessment ? `${dateTime(d.doctor_assessment.assessed_at)} · ${d.refs[d.doctor_assessment.doctor] ?? ''}` : 'not recorded yet'}</span></>}
      actions={edit && <Button size="sm" variant="primary" icon="Save" loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>Save assessment</Button>}>
      {edit && d.summary.status === 'Waiting' && (
        <p className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">Saving the first assessment marks the patient as seen (door-to-doctor time) and posts the ER consultation charge.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <NarrativeField label="Presenting complaints" value={f.presenting_complaints} onChange={set('presenting_complaints')} disabled={!edit} rows={3} context="er.doctor.complaints" />
        <NarrativeField label="History of present illness" value={f.history} onChange={set('history')} disabled={!edit} rows={3} context="er.doctor.hpi" />
        <NarrativeField label="Past / medication history" value={f.past_history} onChange={set('past_history')} disabled={!edit} rows={2} context="er.doctor.past" />
        <NarrativeField label="General examination" value={f.general_examination} onChange={set('general_examination')} disabled={!edit} rows={2} context="er.doctor.general" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([['cvs', 'CVS'], ['rs', 'Respiratory'], ['cns', 'CNS'], ['abdomen', 'Per abdomen']] as const).map(([k, label]) => (
          <div key={k}><Lbl>{label}</Lbl><Input value={f[k]} disabled={!edit} onChange={(e) => set(k)(e.target.value)} /></div>
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <NarrativeField label="Local examination" value={f.local_examination} onChange={set('local_examination')} disabled={!edit} rows={2} context="er.doctor.local" />
        <div className="space-y-3">
          <div><Lbl required>Provisional diagnosis</Lbl><Input value={f.provisional_diagnosis} disabled={!edit} onChange={(e) => set('provisional_diagnosis')(e.target.value)} invalid={edit && dirty && !ok} /></div>
          <div><Lbl>Differential diagnosis</Lbl><Input value={f.differential_diagnosis} disabled={!edit} onChange={(e) => set('differential_diagnosis')(e.target.value)} /></div>
        </div>
      </div>
      <div className="mt-4">
        <NarrativeField label="Plan / orders" value={f.plan} onChange={set('plan')} disabled={!edit} rows={3} context="er.doctor.plan" />
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ treatment & reassessment

const TYPES = ['Treatment given', 'Reassessment', 'Procedure', 'Doctor visit', 'Specialist consult', 'Nursing note']
const RESPONSE = ['Improved', 'No change', 'Deteriorated', 'Not applicable']

export function TreatmentPanel({ d }: { d: VisitDetail }) {
  const [params] = useSearchParams()
  const refresh = useErRefresh()
  const p = d.permissions
  const [f, setF] = useState({ entry_type: params.get('type') && TYPES.includes(params.get('type')!) ? params.get('type')! : 'Treatment given', details: '', response: '', vitals_summary: '', next_review_at: '', chargeable: false })
  const [consultant, setConsultant] = useState<string | null>(null)
  const visit = f.entry_type === 'Doctor visit' || f.entry_type === 'Specialist consult'
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${d.summary.id}/treatments`, {
      method: 'POST', body: { ...f, response: f.response || null, vitals_summary: f.vitals_summary || null, consultant: visit ? consultant : null,
        chargeable: visit && f.chargeable, next_review_at: f.next_review_at ? new Date(f.next_review_at).toISOString() : null },
    }),
    onSuccess: () => { toast.success('Entry recorded'); setF({ ...f, details: '', response: '', vitals_summary: '', next_review_at: '', chargeable: false }); setConsultant(null); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {p.treatment && (
        <Card icon="Syringe" title="Treatment & reassessment entry">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate() }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldWrap label="Entry type">
                <Select value={f.entry_type} onChange={(e) => setF({ ...f, entry_type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
              </FieldWrap>
              <FieldWrap label="Response">
                <Select value={f.response} onChange={(e) => setF({ ...f, response: e.target.value })}><option value="">—</option>{RESPONSE.map((t) => <option key={t}>{t}</option>)}</Select>
              </FieldWrap>
            </div>
            <NarrativeField label="Details" required value={f.details} onChange={(v) => setF({ ...f, details: v })} rows={3} context={`er.treatment.${f.entry_type}`} />
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldWrap label="Vitals on reassessment"><Input value={f.vitals_summary} onChange={(e) => setF({ ...f, vitals_summary: e.target.value })} placeholder="BP 110/70, HR 96, SpO₂ 97% RA" /></FieldWrap>
              <FieldWrap label="Next review at"><Input type="datetime-local" min={nowLocal()} value={f.next_review_at} onChange={(e) => setF({ ...f, next_review_at: e.target.value })} /></FieldWrap>
            </div>
            {visit && (
              <div className="grid items-end gap-3 rounded-lg bg-surface-2 p-3 ring-1 ring-line sm:grid-cols-2">
                <FieldWrap label="Visiting doctor / specialist" required={f.chargeable}>
                  <RefPicker refName="employees.employees" extraFilter={{ category: 'Doctor' }} value={consultant} onChange={(id) => setConsultant(id)} />
                </FieldWrap>
                <label className="flex items-center justify-between gap-2 text-sm text-ink">Bill the visit <Switch checked={f.chargeable} onChange={(c) => setF({ ...f, chargeable: c })} label="Bill the visit" /></label>
              </div>
            )}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={m.isPending} disabled={f.details.trim().length < 2 || (visit && f.chargeable && !consultant)}>Record entry</Button>
            </div>
          </form>
        </Card>
      )}
      <Card icon="ListOrdered" title="Treatment timeline" pad={false} className={cn(!p.treatment && 'xl:col-span-2')}>
        {!d.treatments.length ? <Empty icon="Syringe" title="No treatment or reassessment recorded" /> : (
          <ol className="divide-y divide-line">
            {d.treatments.map((t) => (
              <li key={t.id} className="px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={t.entry_type === 'Reassessment' ? 'blue' : t.entry_type?.includes('visit') || t.entry_type?.includes('consult') ? 'violet' : 'gray'}>{t.entry_type}</Badge>
                  {t.response && <Badge tone={t.response === 'Improved' ? 'green' : t.response === 'Deteriorated' ? 'red' : 'gray'}>{t.response}</Badge>}
                  {t.chargeable && <Badge tone="amber">Billed</Badge>}
                  <span className="ml-auto text-xs text-ink-3">{dateTime(t.recorded_at)} · {d.refs[t.recorded_by] ?? '—'}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-ink">{t.details}</p>
                {(t.vitals_summary || t.consultant || t.next_review_at) && (
                  <p className="mt-0.5 text-xs text-ink-2">{[t.vitals_summary, t.consultant && `By ${d.refs[t.consultant] ?? 'consultant'}`, t.next_review_at && `Review ${dateTime(t.next_review_at)}`].filter(Boolean).join(' · ')}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}
