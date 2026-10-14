import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EntityView, NewButton, useEntity } from '@/components/records'
import { Badge, Button, Empty, ErrorBox, FieldWrap, Select, Spinner, Textarea } from '@/components/ui'
import { FormHistory, FormLibrary, FormRunner, IoFlowsheet, OtBooklet } from '@/features/forms'
import { api, errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { K, type ChartHeader } from '../api'
import { Section } from '../ui'
import { ReactiveModal } from './Banner'
import { ProgressNotes } from './Notes'
import { ChartIt, VitalsPanel, type ChartItHandle } from './Overview'

type Props = { h: ChartHeader; sub?: string | null; go: (tab: string, sub?: string) => void }
const ctxOf = (h: ChartHeader) => ({ patientId: h.patient.id, encounterId: h.admission.id })
const isOpen = (h: ChartHeader) => h.admission.status === 'Admitted' || h.admission.status === 'Discharge Initiated'

/** A clinical form (forms engine) for this admission, with its recent entries. */
export function FormPage({ h, formKey }: { h: ChartHeader; formKey: string }) {
  return (
    <div className="space-y-4">
      <FormRunner key={formKey} {...ctxOf(h)} formKey={formKey} readOnly={!isOpen(h)} />
    </div>
  )
}

export function FormsTab({ h }: { h: ChartHeader }) {
  return <FormLibrary {...ctxOf(h)} />
}

/** Tabs that are a suite of forms (Cath, Dietary): the chosen sub-page, else the suite's library. */
export function SuiteTab({ h, sub, suites }: Props & { suites: string[] }) {
  if (sub && sub.includes('.')) return <FormPage h={h} formKey={sub} />
  return <FormLibrary {...ctxOf(h)} suites={suites} />
}

interface Instr { id: string; code: string; message: string; priority: string; for_role: string; given_by?: string; given_at: string; status: string; acknowledged_at?: string; acknowledged_by?: string; action_taken?: string; can_ack: boolean }

export function Instructions({ h }: { h: ChartHeader }) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const q = useQuery({ queryKey: K.instructions(aid), queryFn: () => api<{ rows: Instr[]; open: number }>(`/ipchart/admissions/${aid}/instructions`) })
  const [msg, setMsg] = useState('')
  const [priority, setPriority] = useState('Routine')
  const [forRole, setForRole] = useState('Nursing')
  const refresh = () => { qc.invalidateQueries({ queryKey: K.instructions(aid) }); qc.invalidateQueries({ queryKey: K.chart(aid) }) }
  const add = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${aid}/instructions`, { method: 'POST', body: { message: msg, priority, for_role: forRole } }),
    onSuccess: () => { toast.success('Instruction sent to the ward'); setMsg(''); refresh() }, onError: (e) => toast.error(errorMessage(e)),
  })
  const ack = useMutation({
    mutationFn: (id: string) => api(`/ipchart/instructions/${id}/acknowledge`, { method: 'POST', body: { action_taken: window.prompt('Action taken (optional)') ?? undefined } }),
    onSuccess: () => { toast.success('Acknowledged'); refresh() }, onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Section title="Doctor's instructions" icon="MessageSquareText" tone="violet" subtitle="Everything the doctor has left for this patient — acknowledged instructions stay here with who actioned them and when.">
      {h.permissions.instruct && isOpen(h) && (
        <div className="mb-4 grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_9rem_11rem_auto] sm:items-end">
          <FieldWrap label="Instruction"><Textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="e.g. Repeat CBC at 6 am; inform if SBP < 90" /></FieldWrap>
          <FieldWrap label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}>{['Routine', 'Urgent', 'STAT'].map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap>
          <FieldWrap label="For"><Select value={forRole} onChange={(e) => setForRole(e.target.value)}>{['Nursing', 'Dietitian', 'Physiotherapy', 'Pharmacy', 'Billing / front office', 'Resident doctor'].map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap>
          <Button variant="primary" disabled={msg.trim().length < 3} loading={add.isPending} onClick={() => add.mutate()}>Send</Button>
        </div>
      )}
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.rows.length ? <Empty icon="MessageSquare" title="No instructions for this patient" /> : (
        <ul className="space-y-2">
          {q.data.rows.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-line p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                  {i.priority !== 'Routine' && <Badge tone="red">{i.priority}</Badge>}<Badge tone="gray">{i.for_role}</Badge>
                  <span>{i.given_by} · {dateTime(i.given_at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{i.message}</p>
                {i.acknowledged_at && <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">✓ Acknowledged by {i.acknowledged_by} · {dateTime(i.acknowledged_at)}{i.action_taken ? ` — ${i.action_taken}` : ''}</p>}
              </div>
              {i.status === 'Open' ? (i.can_ack ? <Button size="sm" variant="success" loading={ack.isPending && ack.variables === i.id} onClick={() => ack.mutate(i.id)}>Acknowledge</Button> : <Badge tone="amber">Open</Badge>)
                : <Badge tone={i.status === 'Acknowledged' ? 'green' : 'gray'}>{i.status}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function DoctorTab({ h, sub }: Props) {
  const s = sub ?? 'progress-notes'
  if (s.includes('.')) return <FormPage h={h} formKey={s} />
  if (s === 'instructions') return <Instructions h={h} />
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Section title="Progress notes" icon="NotebookPen" tone="blue" subtitle="By shift and speciality — signed under the author's name.">
        <ProgressNotes aid={h.admission.id} kind="clinical" canWrite={h.permissions.doctor_note && isOpen(h)} defaultSpecialty={h.department?.name} />
      </Section>
      <div className="space-y-4">
        <Instructions h={h} />
        <FormHistory {...ctxOf(h)} suite="doctor" title="Doctor forms on this stay" />
      </div>
    </div>
  )
}

export function NursingTab({ h, sub }: Props) {
  const s = sub ?? 'mar'
  const mar = useEntity('nursing.mar')
  const tasks = useEntity('nursing.tasks')
  const handovers = useEntity('nursing.handovers')
  if (s.includes('.')) return <FormPage h={h} formKey={s} />
  if (s === 'nursing-notes') return <Section title="Nursing notes" icon="NotebookPen" tone="pink"><ProgressNotes aid={h.admission.id} kind="nursing" canWrite={h.permissions.nursing_note && isOpen(h)} /></Section>
  if (s === 'tasks') return tasks ? <EntityView entity={tasks} fixed={{ patient_id: h.patient.id }} compact title="Nursing tasks" /> : null
  if (s === 'handover') {
    return (
      <div className="space-y-4">
        <FormPage h={h} formKey="nursing.sbar" />
        {handovers && h.bed?.ward_id && <EntityView entity={handovers} fixed={{ ward: h.bed.ward_id }} compact title="Ward handovers" />}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-2">Barcode-verified administration (wristband + medicine scan) is done from the <Link className="text-brand-700 underline dark:text-brand-300" to="/m/nursing/nursing-station">nursing station</Link>.</p>
      {mar && <EntityView entity={mar} fixed={{ patient_id: h.patient.id }} compact title="Medication administration record" />}
    </div>
  )
}

export function MonitoringTab({ h, sub }: Props) {
  const s = sub ?? 'vitals'
  const [ref] = useState<{ current: ChartItHandle | null }>({ current: null })
  if (s.includes('.')) return <FormPage h={h} formKey={s} />
  if (s === 'intake-output') return <IoFlowsheet {...ctxOf(h)} readOnly={!isOpen(h) || !h.permissions.observe} />
  return (
    <div className="space-y-4">
      <VitalsPanel aid={h.admission.id} canRecord={h.permissions.observe && isOpen(h)} onRecord={() => ref.current?.open()} />
      {h.permissions.observe && isOpen(h) && <ChartIt ref={(x) => { ref.current = x }} aid={h.admission.id} />}
      <FormHistory {...ctxOf(h)} suite="monitoring" title="Monitoring charts" />
    </div>
  )
}

export function HicTab({ h, sub }: Props) {
  const [edit, setEdit] = useState(false)
  if (sub && sub.includes('.')) return <FormPage h={h} formKey={sub} />
  const r = h.reactive
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title="Reactive status & isolation" icon="ShieldAlert" tone="teal" actions={h.permissions.clinical && isOpen(h) ? <Button size="sm" onClick={() => setEdit(true)}>Edit</Button> : undefined}>
        <div className="space-y-2 text-sm">
          <div><Badge tone={r.status === 'reactive' ? 'red' : r.status === 'non_reactive' ? 'green' : 'amber'}>{r.status === 'reactive' ? 'Reactive' : r.status === 'non_reactive' ? 'Non reactive' : 'Not recorded'}</Badge></div>
          {r.conditions.length > 0 && <div className="flex flex-wrap gap-1">{r.conditions.map((c) => <Badge key={c} tone="red">{c}</Badge>)}{r.other && <Badge tone="red">{r.other}</Badge>}</div>}
          <div className="text-ink-2">Precautions: <b className="text-ink">{r.isolation}</b></div>
          {r.by && <div className="text-xs text-ink-3">Recorded by {r.by} · {dateTime(r.at)}</div>}
        </div>
      </Section>
      <FormHistory {...ctxOf(h)} suite="infection" title="Care-bundle audits" />
      {edit && <ReactiveModal h={h} onClose={() => setEdit(false)} />}
    </div>
  )
}

export function OtTab({ h, sub }: Props) {
  const bookings = useEntity('ot.bookings')
  const [booking, setBooking] = useState<string | undefined>()
  if (sub === 'booklet') return <OtBooklet {...ctxOf(h)} bookingId={booking} />
  return (
    <Section title="OT scheduled list" icon="Scissors" tone="pink" actions={bookings && isOpen(h) ? <NewButton entity={bookings} label="Book theatre" fixed={{ patient_id: h.patient.id, encounter_id: h.admission.id }} /> : undefined} pad={false}>
      {bookings ? <div className="p-3"><EntityView entity={bookings} fixed={{ patient_id: h.patient.id }} compact hideCreate /></div> : <Empty icon="Scissors" title="No OT bookings for this admission yet" />}
      <div className="border-t border-line px-4 py-2 text-xs text-ink-2">Open the <button type="button" className="text-brand-700 underline dark:text-brand-300" onClick={() => setBooking(undefined)}>OT booklet</button> from the OT ▾ menu to fill the 21 sheets.</div>
    </Section>
  )
}
