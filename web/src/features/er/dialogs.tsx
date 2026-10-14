import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, cn, Empty, FieldWrap, Input, Modal, Select, Spinner, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { age } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { Rec } from '@/lib/types'
import { erKey, useErRefresh, useErSettings, type VisitSummary } from './api'

const MLC_TYPES = ['Road traffic accident', 'Assault', 'Burns', 'Poisoning', 'Snake bite', 'Dog bite', 'Fall from height',
  'Hanging / attempted suicide', 'Sexual assault', 'Industrial accident', 'Brought dead', 'Unknown cause', 'Other']
const BROUGHT_BY = ['Self', 'Relatives', 'Police', '108 ambulance', 'Private ambulance', 'Good Samaritan', 'Referred from hospital', 'Other']
const PAYERS = ['Self-pay', 'Insurance', 'Corporate', 'Government scheme']

type Dup = { id: string; code: string; title: string; phone?: string; dob?: string; gender?: string; reasons: string[]; score: number }

// ------------------------------------------------------------------ MLC

export function MlcDialog({ visit, open, onClose, marked, mlcNo }: {
  visit: { id: string; code: string }; open: boolean; onClose: () => void; marked: boolean; mlcNo?: string | null
}) {
  const refresh = useErRefresh()
  const [no, setNo] = useState(mlcNo ?? '')
  const [type, setType] = useState('')
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: (mlc: boolean) => api(`/er/visits/${visit.id}/mlc`, { method: 'POST', body: mlc ? { mlc, mlc_no: no.trim() || null, case_type: type || null } : { mlc, reason } }),
    onSuccess: (_, mlc) => { toast.success(mlc ? 'Marked as medico-legal case' : 'MLC flag removed'); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (marked) {
    return (
      <Modal open={open} onClose={onClose} title="Medico-legal case" size="sm"
        footer={<>
          <Button variant="ghost" onClick={onClose}>Keep MLC</Button>
          <Button variant="primary" loading={m.isPending} disabled={!no.trim() || no.trim() === (mlcNo ?? '')} onClick={() => m.mutate(true)}>Save MLC number</Button>
          <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 5} onClick={() => m.mutate(false)}>Remove flag</Button>
        </>}>
        <FieldWrap label="MLC number"><Input value={no} onChange={(e) => setNo(e.target.value)} placeholder="Issued MLC number" /></FieldWrap>
        <FieldWrap className="mt-3" label="Reason to remove the MLC flag" help="Only while police have not been intimated. Audited.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FieldWrap>
      </Modal>
    )
  }
  return (
    <Modal open={open} onClose={onClose} title="Mark as medico-legal case?" size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Keep as non-MLC</Button>
        <Button variant="primary" loading={m.isPending} onClick={() => m.mutate(true)}>Mark MLC</Button>
      </>}>
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
          <Icon name="ShieldAlert" className="size-5" />
        </div>
        <p className="text-sm text-ink-2">An entry is opened in the MLC register for police intimation and evidence preservation. Enter the MLC number if it is already issued.</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <FieldWrap label="MLC number (optional)"><Input value={no} onChange={(e) => setNo(e.target.value)} autoFocus /></FieldWrap>
        <FieldWrap label="Case type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Unknown cause</option>
            {MLC_TYPES.map((t) => <option key={t}>{t}</option>)}
          </Select>
        </FieldWrap>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ bed move

interface BoardLite { wards: { id: string; name: string }[]; ward_id: string | null; beds: { id: string; bed_no: string; status: string }[] }

export function MoveBedDialog({ visit, open, onClose }: { visit: Pick<VisitSummary, 'id' | 'code' | 'bed'>; open: boolean; onClose: () => void }) {
  const refresh = useErRefresh()
  const [ward, setWard] = useState(visit.bed?.ward_id ?? '')
  const [bed, setBed] = useState('')
  const [reason, setReason] = useState('')
  const board = useQuery({ queryKey: erKey('board', ward || 'default'), queryFn: () => api<BoardLite>('/er/board', { query: { ward: ward || undefined } }), enabled: open })
  const vacant = (board.data?.beds ?? []).filter((b) => b.status === 'Vacant')
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${visit.id}/move-bed`, { method: 'POST', body: { bed_id: bed, reason: reason || null } }),
    onSuccess: () => { toast.success('Bed changed — the previous bed is sent for cleaning'); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title={visit.bed ? `Move ${visit.code} from bed ${visit.bed.bed_no}` : `Assign an ER bed to ${visit.code}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!bed} loading={m.isPending} onClick={() => m.mutate()}>{visit.bed ? 'Move patient' : 'Assign bed'}</Button></>}>
      {(board.data?.wards.length ?? 0) > 1 && (
        <FieldWrap label="Ward" className="mb-3">
          <Select value={ward || board.data?.ward_id || ''} onChange={(e) => { setWard(e.target.value); setBed('') }}>
            {board.data?.wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </FieldWrap>
      )}
      <p className="mb-2 text-xs font-medium text-ink-2">Vacant beds</p>
      {board.isLoading ? <Spinner /> : vacant.length === 0 ? (
        <Empty icon="BedDouble" title="No vacant ER bed">Every bed in this ward is occupied, being cleaned or blocked.</Empty>
      ) : (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {vacant.map((b) => (
            <button key={b.id} type="button" onClick={() => setBed(b.id)} aria-pressed={bed === b.id}
              className={cn('rounded-lg border px-2 py-2 text-sm font-medium', bed === b.id ? 'border-brand-700 bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'border-line-2 hover:bg-surface-2')}>
              {b.bed_no}
            </button>
          ))}
        </div>
      )}
      <FieldWrap label="Reason" className="mt-3"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. shifted to resuscitation bay" /></FieldWrap>
    </Modal>
  )
}

// ------------------------------------------------------------------ patient details & UHID

function Duplicates({ dups, onLink, linking }: { dups: Dup[]; onLink?: (id: string) => void; linking?: boolean }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
      <p className="font-medium text-amber-900 dark:text-amber-200">This patient may already have a UHID</p>
      <ul className="mt-2 space-y-1.5">
        {dups.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-2 py-1.5 ring-1 ring-line">
            <span>
              <span className="font-medium text-ink">{d.title}</span> <span className="text-ink-3">{d.code} · {[age(d.dob), d.gender].filter(Boolean).join(' ')} · {d.phone}</span>
              <span className="block text-xs text-ink-3">{d.reasons.join(', ')} · match {d.score}%</span>
            </span>
            {onLink && <Button size="xs" variant="primary" loading={linking} onClick={() => onLink(d.id)}>Link this UHID</Button>}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PatientDetailsDialog({ visitId, open, onClose, temporary, visit, patient, canLink }: {
  visitId: string; open: boolean; onClose: () => void; temporary: boolean; visit: Rec; patient: Rec; canLink: boolean
}) {
  const refresh = useErRefresh()
  const [f, setF] = useState<Record<string, string>>(() => ({
    first_name: temporary ? '' : patient.first_name ?? '', last_name: temporary ? '' : patient.last_name ?? '', gender: patient.gender ?? '',
    phone: patient.phone ?? '', age_years: '', address: patient.address ?? '', city: patient.city ?? '',
    emergency_contact_name: patient.emergency_contact_name ?? '', emergency_contact_phone: patient.emergency_contact_phone ?? '',
    brought_by_type: visit.brought_by_type ?? '', brought_by: visit.brought_by ?? '', attendant_phone: visit.attendant_phone ?? '',
    police_station: visit.police_station ?? '', police_officer: visit.police_officer ?? '', identification_marks: visit.identification_marks ?? '',
    payer: visit.payer ?? 'Self-pay',
  }))
  const [dups, setDups] = useState<Dup[] | null>(null)
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const body = (register: boolean, force = false) => {
    const out: Record<string, unknown> = {}
    const visitKeys = ['brought_by_type', 'brought_by', 'attendant_phone', 'police_station', 'police_officer', 'identification_marks', 'payer']
    for (const k of visitKeys) out[k] = f[k] || null
    for (const k of ['address', 'city', 'emergency_contact_name', 'emergency_contact_phone']) if (f[k]) out[k] = f[k]
    if (temporary) {
      for (const k of ['first_name', 'last_name', 'gender', 'phone']) if (f[k]) out[k] = f[k]
      if (f.age_years) out.age_years = Number(f.age_years)
    }
    return { ...out, register_uhid: register, force }
  }
  const save = useMutation({
    mutationFn: ({ register, force }: { register: boolean; force?: boolean }) =>
      api<{ patient: Rec }>(`/er/visits/${visitId}/patient-details`, { method: 'POST', body: body(register, force) }),
    onSuccess: (r, v) => { toast.success(v.register ? `UHID ${r.patient.code} registered` : 'Details saved'); refresh(); onClose() },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE') setDups((e.details?.duplicates as Dup[]) ?? [])
      else toast.error(errorMessage(e))
    },
  })
  const link = useMutation({
    mutationFn: (pid: string) => api(`/er/visits/${visitId}/link-uhid`, { method: 'POST', body: { patient_id: pid, note: 'Matched while adding patient details' } }),
    onSuccess: () => { toast.success('Visit linked to the registered UHID'); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const police = f.brought_by_type === 'Police' || !!visit.mlc
  return (
    <Modal open={open} onClose={onClose} size="lg" title={temporary ? 'Add patient details' : 'Attendant & contact details'}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {dups && <Button variant="warning" loading={save.isPending} onClick={() => save.mutate({ register: true, force: true })}>Register new UHID anyway</Button>}
        <Button variant={temporary ? 'secondary' : 'primary'} loading={save.isPending} onClick={() => save.mutate({ register: false })}>Save details</Button>
        {temporary && canLink && <Button variant="primary" loading={save.isPending} disabled={!f.first_name || !f.phone || !f.gender} onClick={() => save.mutate({ register: true })}>Save & register UHID</Button>}
      </>}>
      {temporary && (
        <>
          <p className="mb-3 text-sm text-ink-2">The patient is on a temporary record. Fill what is known; <b>Save & register UHID</b> turns the record into a registered UHID (name, gender and mobile needed), or link the visit to an existing UHID.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FieldWrap label="First name" required><Input value={f.first_name} onChange={set('first_name')} autoFocus /></FieldWrap>
            <FieldWrap label="Last name"><Input value={f.last_name} onChange={set('last_name')} /></FieldWrap>
            <FieldWrap label="Gender" required>
              <Select value={f.gender} onChange={set('gender')}>{['', 'Male', 'Female', 'Transgender', 'Other'].map((g) => <option key={g} value={g}>{g || 'Select…'}</option>)}</Select>
            </FieldWrap>
            <FieldWrap label="Age (years)"><Input type="number" min={0} max={120} value={f.age_years} onChange={set('age_years')} /></FieldWrap>
            <FieldWrap label="Mobile" required><Input inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="10-digit mobile" /></FieldWrap>
            <FieldWrap label="City"><Input value={f.city} onChange={set('city')} /></FieldWrap>
            <FieldWrap label="Address" className="sm:col-span-3"><Input value={f.address} onChange={set('address')} /></FieldWrap>
          </div>
          {dups && <Duplicates dups={dups} onLink={canLink ? (id) => link.mutate(id) : undefined} linking={link.isPending} />}
        </>
      )}
      {!temporary && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldWrap label="Address"><Input value={f.address} onChange={set('address')} /></FieldWrap>
          <FieldWrap label="City"><Input value={f.city} onChange={set('city')} /></FieldWrap>
          <FieldWrap label="Emergency contact"><Input value={f.emergency_contact_name} onChange={set('emergency_contact_name')} /></FieldWrap>
          <FieldWrap label="Emergency contact mobile"><Input value={f.emergency_contact_phone} onChange={set('emergency_contact_phone')} /></FieldWrap>
        </div>
      )}
      <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-ink-3">Brought by & payer</h4>
      <div className="grid gap-3 sm:grid-cols-3">
        <FieldWrap label="Brought by">
          <Select value={f.brought_by_type} onChange={set('brought_by_type')}>{['', ...BROUGHT_BY].map((b) => <option key={b} value={b}>{b || 'Select…'}</option>)}</Select>
        </FieldWrap>
        <FieldWrap label="Name / relation"><Input value={f.brought_by} onChange={set('brought_by')} /></FieldWrap>
        <FieldWrap label="Attendant mobile"><Input inputMode="tel" value={f.attendant_phone} onChange={set('attendant_phone')} /></FieldWrap>
        {police && <FieldWrap label="Police station"><Input value={f.police_station} onChange={set('police_station')} /></FieldWrap>}
        {police && <FieldWrap label="Officer / buckle no."><Input value={f.police_officer} onChange={set('police_officer')} /></FieldWrap>}
        <FieldWrap label="Payer">
          <Select value={f.payer} onChange={set('payer')}>{PAYERS.map((p) => <option key={p}>{p}</option>)}</Select>
        </FieldWrap>
        {temporary && <FieldWrap label="Identification marks" className="sm:col-span-3"><Textarea rows={2} value={f.identification_marks} onChange={set('identification_marks')} /></FieldWrap>}
      </div>
    </Modal>
  )
}

export function LinkUhidDialog({ visitId, code, open, onClose, current }: { visitId: string; code: string; open: boolean; onClose: () => void; current: string }) {
  const refresh = useErRefresh()
  const [pid, setPid] = useState<string | null>(null)
  const [row, setRow] = useState<Rec | null>(null)
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => api<{ patient: Rec; merge_request: Rec }>(`/er/visits/${visitId}/link-uhid`, { method: 'POST', body: { patient_id: pid, note: note || null } }),
    onSuccess: (r) => { toast.success(`${code} linked to ${r.patient.code} (${r.merge_request.code})`); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title="Link to a registered UHID"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!pid} loading={m.isPending} onClick={() => m.mutate()}>Link & merge</Button></>}>
      <p className="text-sm text-ink-2">The temporary record <b>{current}</b> is merged into the chosen UHID: this ER visit, its orders, charges, notes and documents move to it. The merge is recorded in the MPI and the audit trail.</p>
      <FieldWrap label="Registered patient (UHID, mobile or name)" className="mt-3">
        <RefPicker refName="registration.patients" kind="patient" value={pid} onChange={(id, r) => { setPid(id); setRow(r ?? null) }} placeholder="Search UHID, mobile or name…" />
      </FieldWrap>
      {row && (
        <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-sm ring-1 ring-line">
          <span className="font-medium text-ink">{row.title}</span> <span className="text-ink-3">{row.code} · {[age(row.dob), row.gender].filter(Boolean).join(' ')} · {row.phone}</span>
          {row.status !== 'Active' && <Badge tone="red" className="ml-2">{row.status}</Badge>}
        </div>
      )}
      <FieldWrap label="How was the patient identified?" className="mt-3"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. identified by brother with Aadhaar" /></FieldWrap>
    </Modal>
  )
}

// ------------------------------------------------------------------ alerts & vitals

export function AlertsDialog({ visitId, open, onClose, current }: { visitId: string; open: boolean; onClose: () => void; current: string[] }) {
  const refresh = useErRefresh()
  const settings = useErSettings()
  const [sel, setSel] = useState<string[]>(current)
  const [other, setOther] = useState('')
  const options = Array.from(new Set([...(settings.data?.alerts ?? []), ...current]))
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${visitId}/alerts`, { method: 'POST', body: { alerts: [...sel, ...(other.trim() ? [other.trim()] : [])] } }),
    onSuccess: () => { toast.success('Alerts updated'); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title="Clinical alerts" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save alerts</Button></>}>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = sel.includes(o)
          return (
            <button key={o} type="button" aria-pressed={on} onClick={() => setSel(on ? sel.filter((x) => x !== o) : [...sel, o])}
              className={cn('rounded-full px-3 py-1 text-xs font-medium ring-1', on ? 'bg-red-600 text-white ring-red-700' : 'bg-surface-2 text-ink-2 ring-line hover:text-ink')}>
              {on && '✓ '}{o}
            </button>
          )
        })}
      </div>
      <FieldWrap label="Other alert" className="mt-3"><Input value={other} onChange={(e) => setOther(e.target.value)} /></FieldWrap>
    </Modal>
  )
}

const O2 = ['Room air', 'Nasal prongs', 'Face mask', 'Venturi mask', 'NRBM', 'HFNC', 'NIV (BiPAP/CPAP)', 'Ventilator']
export const VITAL_FIELDS: { key: string; label: string; unit?: string; min: number; max: number; step?: number }[] = [
  { key: 'bp_systolic', label: 'BP systolic', unit: 'mmHg', min: 0, max: 300 },
  { key: 'bp_diastolic', label: 'BP diastolic', unit: 'mmHg', min: 0, max: 200 },
  { key: 'pulse', label: 'Pulse', unit: '/min', min: 0, max: 300 },
  { key: 'resp_rate', label: 'Resp. rate', unit: '/min', min: 0, max: 80 },
  { key: 'spo2', label: 'SpO₂', unit: '%', min: 0, max: 100 },
  { key: 'temperature', label: 'Temp', unit: '°F', min: 90, max: 110, step: 0.1 },
  { key: 'gcs', label: 'GCS', min: 3, max: 15 },
  { key: 'pain_score', label: 'Pain', unit: '0–10', min: 0, max: 10 },
  { key: 'blood_sugar', label: 'GRBS', unit: 'mg/dL', min: 0, max: 1500 },
]

/** Inline vitals entry ("Chart it") — also used in the quick-record modal. */
export function VitalsEntry({ visitId, onDone, compact }: { visitId: string; onDone?: () => void; compact?: boolean }) {
  const refresh = useErRefresh()
  const [v, setV] = useState<Record<string, string>>({ o2_support: 'Room air' })
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { o2_support: v.o2_support }
      for (const f of VITAL_FIELDS) if (v[f.key] !== undefined && v[f.key] !== '') body[f.key] = Number(v[f.key])
      return api<Rec>(`/er/visits/${visitId}/vitals`, { method: 'POST', body })
    },
    onSuccess: (r) => {
      toast.success(r.news2 !== null && r.news2 !== undefined ? `Vitals recorded · NEWS2 ${r.news2} (${r.news2_risk})` : 'Vitals recorded')
      setV({ o2_support: v.o2_support }); refresh(); onDone?.()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const bad = VITAL_FIELDS.some((f) => v[f.key] !== undefined && v[f.key] !== '' && (Number(v[f.key]) < f.min || Number(v[f.key]) > f.max))
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate() }}>
      <div className={cn('grid gap-2', compact ? 'grid-cols-3 sm:grid-cols-5 xl:grid-cols-10' : 'grid-cols-2 sm:grid-cols-3')}>
        {VITAL_FIELDS.map((f) => {
          const val = v[f.key] ?? ''
          const out = val !== '' && (Number(val) < f.min || Number(val) > f.max)
          return (
            <FieldWrap key={f.key} label={<>{f.label}{f.unit && <span className="text-ink-3"> {f.unit}</span>}</>} error={out ? `${f.min}–${f.max}` : undefined}>
              <Input type="number" inputMode="decimal" step={f.step ?? 1} value={val} invalid={out} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            </FieldWrap>
          )
        })}
        <FieldWrap label="O₂">
          <Select value={v.o2_support} onChange={(e) => setV({ ...v, o2_support: e.target.value })}>{O2.map((o) => <option key={o}>{o}</option>)}</Select>
        </FieldWrap>
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="submit" variant="primary" size="sm" icon="HeartPulse" loading={m.isPending} disabled={bad}>Record vitals</Button>
      </div>
    </form>
  )
}

export function VitalsDialog({ visitId, open, onClose }: { visitId: string; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Record observations" size="lg">
      <VitalsEntry visitId={visitId} onDone={onClose} />
    </Modal>
  )
}

