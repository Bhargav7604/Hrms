import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, FieldWrap, Input, Modal, Select, Switch } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, nowLocal } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { Rec } from '@/lib/types'
import { OUTCOME_LABEL, useErRefresh, useErSettings, type VisitDetail } from '../api'
import { Kv, NarrativeField } from '../ui'

const TYPES: { key: string; icon: string; hint: string }[] = [
  { key: 'Discharged', icon: 'House', hint: 'Treated and sent home with advice' },
  { key: 'Admitted', icon: 'BedDouble', hint: 'Admit to a ward / ICU — frees the ER bed' },
  { key: 'Transferred', icon: 'Ambulance', hint: 'Transfer to another hospital' },
  { key: 'Referred', icon: 'Forward', hint: 'Refer to another facility / specialty' },
  { key: 'LAMA', icon: 'DoorOpen', hint: 'Left against medical advice' },
  { key: 'DAMA', icon: 'FileWarning', hint: 'Discharged against medical advice' },
  { key: 'Shifted to OT', icon: 'Scissors', hint: 'Shifted directly to theatre' },
  { key: 'Expired', icon: 'HeartCrack', hint: 'Death in the ER' },
  { key: 'Brought dead', icon: 'HeartOff', hint: 'No signs of life on arrival' },
  { key: 'Absconded', icon: 'UserX', hint: 'Left without informing staff' },
]
const SHOWN: Record<string, string[]> = {
  Discharged: ['condition_at_disposition', 'followup_advice', 'disposition_notes'],
  Admitted: ['disposition_notes'],
  Transferred: ['referred_to', 'transfer_reason', 'transport_mode', 'condition_at_disposition', 'disposition_notes'],
  Referred: ['referred_to', 'transfer_reason', 'condition_at_disposition', 'disposition_notes'],
  LAMA: ['lama_reason', 'consent_by', 'risks_explained', 'condition_at_disposition', 'disposition_notes'],
  DAMA: ['lama_reason', 'consent_by', 'risks_explained', 'condition_at_disposition', 'disposition_notes'],
  'Shifted to OT': ['disposition_notes'],
  Expired: ['time_of_death', 'cause_of_death', 'disposition_notes'],
  'Brought dead': ['time_of_death', 'cause_of_death', 'disposition_notes'],
  Absconded: ['absconded_noticed_at', 'security_informed', 'disposition_notes'],
}
const LABEL: Record<string, string> = {
  condition_at_disposition: 'Condition at disposition', followup_advice: 'Follow-up advice', disposition_notes: 'Notes / advice given',
  referred_to: 'Referred / transferred to', transfer_reason: 'Reason', transport_mode: 'Mode of transport', lama_reason: 'Reason for leaving',
  consent_by: 'Consent signed by (name / relation)', risks_explained: 'Risks explained to patient / attendant', time_of_death: 'Time of death',
  cause_of_death: 'Cause of death (provisional)', absconded_noticed_at: 'Absconding noticed at', security_informed: 'Security / police informed',
}
const CONDITION = ['Stable', 'Improved', 'Unchanged', 'Critical', 'Deteriorated']
const TRANSPORT = ['Own transport', '108 ambulance', 'Hospital ambulance (BLS)', 'Hospital ambulance (ALS)', 'Private ambulance']
const PAYERS = ['Self-pay', 'Insurance', 'Corporate', 'Government scheme']
const ISOLATION = ['None', 'Contact', 'Droplet', 'Airborne', 'C. difficile (spore)']

export function DispositionPanel({ d }: { d: VisitDetail }) {
  const s = d.summary
  if (s.state !== 'Active') return <DispositionSummary d={d} />
  return <DispositionForm d={d} />
}

function DispositionForm({ d }: { d: VisitDetail }) {
  const settings = useErSettings()
  const refresh = useErRefresh()
  const p = d.permissions
  const s = d.summary
  const types = TYPES.filter((t) => (settings.data?.disposition.types[t.key]?.enabled ?? true) && (p.dispose || (p.abscond && t.key === 'Absconded')))
  const [type, setType] = useState<string>('')
  const [f, setF] = useState<Record<string, string | boolean>>({ provisional_diagnosis: s.provisional_diagnosis ?? '' })
  const [admit, setAdmit] = useState<Record<string, string | null>>({ ward: null, bed_id: null, doctor_id: null, department_id: null, payer: s.payer ?? 'Self-pay', expected_los: '', isolation: 'None' })
  const [confirm, setConfirm] = useState(false)
  const required = new Set(type ? settings.data?.disposition.types[type]?.required ?? [] : [])
  const set = (k: string, v: string | boolean) => setF((x) => ({ ...x, [k]: v }))
  const missing = [...required].filter((k) => f[k] === undefined || f[k] === '' || f[k] === false)
  const admitMissing = type === 'Admitted' && !(admit.bed_id && admit.doctor_id && admit.department_id)
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { disposition: type }
      for (const [k, v] of Object.entries(f)) if (v !== '' && v !== undefined) body[k] = k === 'time_of_death' || k === 'absconded_noticed_at' ? new Date(String(v)).toISOString() : v
      if (type === 'Admitted') body.admit = { bed_id: admit.bed_id, doctor_id: admit.doctor_id, department_id: admit.department_id, diagnosis: f.provisional_diagnosis || null,
        payer: admit.payer, expected_los: admit.expected_los ? Number(admit.expected_los) : null, isolation: admit.isolation }
      return api<{ visit: Rec; admission: Rec | null; charges_carried: number }>(`/er/visits/${s.id}/disposition`, { method: 'POST', body })
    },
    onSuccess: (r) => {
      toast.success(r.admission ? `Admitted — ${r.admission.code}${r.charges_carried ? ` · ${r.charges_carried} ER charge(s) moved to the IP bill` : ''}` : `Disposition recorded: ${OUTCOME_LABEL[type] ?? type}`)
      setConfirm(false); refresh()
    },
    onError: (e) => { setConfirm(false); toast.error(errorMessage(e)) },
  })
  if (!types.length) return <Card icon="LogOut" title="Disposition"><p className="text-sm text-ink-2">The patient is still in the ER. The disposition is recorded by the treating doctor.</p></Card>
  const field = (k: string) => {
    const req = required.has(k)
    const lbl = LABEL[k]
    switch (k) {
      case 'condition_at_disposition':
        return <FieldWrap key={k} label={lbl} required={req}><Select value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)}><option value="">Select…</option>{CONDITION.map((c) => <option key={c}>{c}</option>)}</Select></FieldWrap>
      case 'transport_mode':
        return <FieldWrap key={k} label={lbl} required={req}><Select value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)}><option value="">Select…</option>{TRANSPORT.map((c) => <option key={c}>{c}</option>)}</Select></FieldWrap>
      case 'risks_explained': case 'security_informed':
        return <label key={k} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink ring-1 ring-line">{lbl}{req && <span className="text-red-600">*</span>}<Switch checked={!!f[k]} onChange={(c) => set(k, c)} label={lbl} /></label>
      case 'time_of_death': case 'absconded_noticed_at':
        return <FieldWrap key={k} label={lbl} required={req}><Input type="datetime-local" max={nowLocal()} value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)} /></FieldWrap>
      case 'disposition_notes':
        return <div key={k} className="sm:col-span-2"><NarrativeField label={lbl} required={req} value={String(f[k] ?? '')} onChange={(v) => set(k, v)} rows={3} context={`er.disposition.${type}`} /></div>
      default:
        return <FieldWrap key={k} label={lbl} required={req}><Input value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)} /></FieldWrap>
    }
  }
  return (
    <Card icon="LogOut" title="Disposition">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {types.map((t) => (
          <button key={t.key} type="button" aria-pressed={type === t.key} onClick={() => setType(t.key)}
            className={cn('flex flex-col items-start gap-1 rounded-xl border p-3 text-left', type === t.key ? 'border-brand-700 bg-brand-50 ring-2 ring-brand-700/20 dark:bg-brand-500/15' : 'border-line hover:bg-surface-2')}>
            <Icon name={t.icon} className="size-5 text-brand-700 dark:text-brand-300" />
            <span className="text-sm font-semibold text-ink">{OUTCOME_LABEL[t.key] ?? t.key}</span>
            <span className="text-xs text-ink-3">{t.hint}</span>
          </button>
        ))}
      </div>
      {type && (
        <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); setConfirm(true) }}>
          {(type === 'Expired' || type === 'Brought dead') && !s.mlc && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              <Icon name="ShieldAlert" className="mt-0.5 size-4 shrink-0" /> Deaths in the ER and brought-dead cases are usually medico-legal — mark MLC from the action bar if police intimation is needed. The patient record is marked deceased.
            </p>
          )}
          {type === 'Admitted' && (
            <div className="rounded-xl border border-line p-3">
              <h4 className="mb-3 text-sm font-semibold text-ink">Admission</h4>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <FieldWrap label="Ward"><RefPicker refName="mdm.wards" value={admit.ward} onChange={(id) => setAdmit({ ...admit, ward: id, bed_id: null })} /></FieldWrap>
                <FieldWrap label="Bed" required help={admit.ward ? 'Vacant beds of the ward' : 'Choose the ward first'}>
                  <RefPicker refName="ipd.beds" disabled={!admit.ward} extraFilter={{ ward_id: admit.ward, status: 'Vacant' }} value={admit.bed_id} onChange={(id) => setAdmit({ ...admit, bed_id: id })} />
                </FieldWrap>
                <FieldWrap label="Admitting consultant" required>
                  <RefPicker refName="employees.employees" extraFilter={{ category: 'Doctor' }} value={admit.doctor_id} onChange={(id) => setAdmit({ ...admit, doctor_id: id })} />
                </FieldWrap>
                <FieldWrap label="Department" required><RefPicker refName="mdm.departments" value={admit.department_id} onChange={(id) => setAdmit({ ...admit, department_id: id })} /></FieldWrap>
                <FieldWrap label="Payer"><Select value={admit.payer ?? ''} onChange={(e) => setAdmit({ ...admit, payer: e.target.value })}>{PAYERS.map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap>
                <FieldWrap label="Expected stay (days)"><Input type="number" min={0} value={admit.expected_los ?? ''} onChange={(e) => setAdmit({ ...admit, expected_los: e.target.value })} /></FieldWrap>
                <FieldWrap label="Isolation"><Select value={admit.isolation ?? 'None'} onChange={(e) => setAdmit({ ...admit, isolation: e.target.value })}>{ISOLATION.map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap>
              </div>
              <p className="mt-2 text-xs text-ink-3">The admission follows the IPD rules (bed availability, one open admission per patient). The ER bed goes for cleaning and unbilled ER charges move to the IP bill.</p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldWrap label="Diagnosis" required={type === 'Admitted'}><Input value={String(f.provisional_diagnosis ?? '')} onChange={(e) => set('provisional_diagnosis', e.target.value)} /></FieldWrap>
            {(SHOWN[type] ?? []).map(field)}
          </div>
          <div className="flex items-center justify-end gap-3">
            {(missing.length > 0 || admitMissing) && <span className="text-xs text-ink-3">Fill the required fields marked *</span>}
            <Button type="submit" variant="primary" icon="Check" disabled={missing.length > 0 || admitMissing || (type === 'Admitted' && !String(f.provisional_diagnosis ?? '').trim())}>
              Record disposition
            </Button>
          </div>
        </form>
      )}
      {confirm && (
        <Modal open onClose={() => setConfirm(false)} title={`Confirm: ${OUTCOME_LABEL[type] ?? type}`} size="sm"
          footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Back</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Confirm</Button></>}>
          <p className="text-sm text-ink-2">The patient leaves the ER{s.bed ? ` and bed ${s.bed.bed_no} is sent for cleaning` : ''}. The visit moves to <b>Billing & Closure</b>{type === 'Admitted' ? ' (closed automatically when nothing is left to bill)' : ''}. This cannot be undone from the chart.</p>
        </Modal>
      )}
    </Card>
  )
}

function DispositionSummary({ d }: { d: VisitDetail }) {
  const v = d.visit
  const s = d.summary
  const keys = SHOWN[v.disposition as string] ?? []
  return (
    <Card icon="LogOut" title={<>Disposition · {s.outcome ?? v.disposition}</>}
      actions={d.permissions.view_clinical && <a href={`/er/visits/${s.id}/print?doc=discharge-summary`} target="_blank" rel="noreferrer"><Button size="sm" icon="Printer">ER discharge summary</Button></a>}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kv label="Outcome"><Badge tone={['Expired', 'Brought dead', 'Absconded', 'LAMA', 'DAMA'].includes(v.disposition) ? 'red' : 'green'}>{s.outcome ?? v.disposition}</Badge></Kv>
        <Kv label="Recorded">{dateTime(v.disposed_at ?? v.ended_at)}{v.disposition_by && ` · ${v.disposition_by}`}</Kv>
        <Kv label="Time in ER">{v.er_los_minutes !== undefined && v.er_los_minutes !== null ? `${Math.floor(v.er_los_minutes / 60)}h ${v.er_los_minutes % 60}m` : '—'}</Kv>
        <Kv label="Door-to-doctor">{v.door_to_doctor_minutes !== undefined && v.door_to_doctor_minutes !== null ? `${v.door_to_doctor_minutes} min` : '—'}</Kv>
        {d.permissions.view_clinical && <Kv label="Diagnosis">{v.provisional_diagnosis}</Kv>}
        {d.admission && (
          <Kv label="IP admission">
            <Link to={`/m/ipd/admissions?r=${d.admission.id}`} className="text-brand-700 hover:underline dark:text-brand-300">{d.admission.code}</Link> · {d.refs[d.admission.bed_id] ?? ''} · {d.admission.status}
          </Kv>
        )}
        {d.permissions.view_clinical && keys.map((k) => (
          <Kv key={k} label={LABEL[k]}>
            {typeof v[k] === 'boolean' ? (v[k] ? 'Yes' : 'No') : k === 'time_of_death' || k === 'absconded_noticed_at' ? dateTime(v[k]) : <span className="whitespace-pre-wrap">{v[k] ?? '—'}</span>}
          </Kv>
        ))}
      </div>
    </Card>
  )
}
