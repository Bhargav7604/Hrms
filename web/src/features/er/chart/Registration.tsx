import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, Empty, FieldWrap, Input, Modal, Select, Spinner } from '@/components/ui'
import { api, apiUrl, errorMessage, uploadFile } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useErRefresh, useErSettings, type VisitDetail, type VisitDoc } from '../api'
import { LinkUhidDialog, PatientDetailsDialog } from '../dialogs'
import { Kv, UnmappedBadge } from '../ui'

export function RegistrationPanel({ d, editDetails, onEditDone }: { d: VisitDetail; editDetails?: boolean; onEditDone?: () => void }) {
  const p = d.permissions
  const v = d.visit
  const pt = d.patient
  const [details, setDetails] = useState(!!editDetails && p.details)
  const [link, setLink] = useState(false)
  const close = () => { setDetails(false); onEditDone?.() }
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card icon="IdCard" title="ER registration"
        actions={p.details && <Button size="sm" icon="UserPen" onClick={() => setDetails(true)}>{d.temporary ? 'Add patient details' : 'Attendant details'}</Button>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Kv label="ER number">{d.summary.code}</Kv>
          <Kv label="Arrived">{dateTime(d.summary.arrived_at)}</Kv>
          <Kv label="Arrival mode">{v.arrival_mode}</Kv>
          <Kv label="Registered by">{v.registered_by}</Kv>
          <Kv label="Brought by">{[v.brought_by_type, v.brought_by].filter(Boolean).join(' — ') || '—'}</Kv>
          <Kv label="Attendant mobile">{v.attendant_phone}</Kv>
          {(v.police_station || v.police_officer) && <Kv label="Police">{[v.police_station, v.police_officer].filter(Boolean).join(' · ')}</Kv>}
          <Kv label="Payer">{v.payer ?? 'Self-pay'}</Kv>
          <Kv label="Presenting complaint">{v.chief_complaint}</Kv>
          <Kv label="Medico-legal">{d.summary.mlc ? <>Yes{d.summary.mlc_no ? ` · ${d.summary.mlc_no}` : ' · number not issued'}{d.mlc_case && <Badge tone="violet" className="ml-1">{d.mlc_case.code} · {d.mlc_case.status}</Badge>}</> : 'No'}</Kv>
        </div>
        {!!v.bed_moves?.length && (
          <>
            <h4 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Bed movements</h4>
            <ul className="space-y-0.5 text-sm text-ink-2">
              {v.bed_moves.map((m: { at: string; to_bed_no?: string; by?: string; reason?: string }, i: number) => (
                <li key={i}>→ {m.to_bed_no} · {dateTime(m.at)} · {m.by}{m.reason && ` · ${m.reason}`}</li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card icon="UserRound" title="Patient identity" actions={p.link && <Button size="sm" variant="primary" icon="Link" onClick={() => setLink(true)}>Link UHID</Button>}>
        {d.temporary ? (
          <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <Icon name="TriangleAlert" className="mt-0.5 size-4 shrink-0" />
            <span>The visit runs on a temporary record (<b>{pt.code}</b>). Register it as a UHID through <i>Add patient details</i>, or link it to the patient's existing UHID — all visit data moves with it.</span>
          </div>
        ) : v.linked_from && (
          <p className="mb-3 text-sm text-ink-2">Identified {dateTime(v.uhid_linked_at)} by {v.uhid_linked_by}: temporary record {v.linked_from.code} ({v.linked_from.name}) merged into this UHID.</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Kv label="Name">{pt.title} {d.temporary && <UnmappedBadge />}</Kv>
          <Kv label="UHID">{d.temporary ? 'Not mapped' : pt.code}</Kv>
          <Kv label="Gender / age">{[pt.gender, pt.age !== null && pt.age !== undefined ? `${pt.age} y${pt.dob_estimated ? ' (approx.)' : ''}` : null].filter(Boolean).join(' · ') || '—'}</Kv>
          <Kv label="Mobile">{pt.phone}</Kv>
          <Kv label="Address">{[pt.address, pt.city].filter(Boolean).join(', ') || '—'}</Kv>
          <Kv label="Emergency contact">{[pt.emergency_contact_name, pt.emergency_contact_phone].filter(Boolean).join(' · ') || '—'}</Kv>
          {d.permissions.view_clinical && (v.identification_marks || pt.identification_marks) && <Kv label="Identification marks">{v.identification_marks ?? pt.identification_marks}</Kv>}
        </div>
      </Card>
      {details && <PatientDetailsDialog visitId={d.summary.id} open onClose={close} temporary={d.temporary} visit={v} patient={pt} canLink={p.link} />}
      {link && <LinkUhidDialog visitId={d.summary.id} code={d.summary.code} current={`${pt.title} (${pt.code})`} open onClose={() => setLink(false)} />}
    </div>
  )
}

// ------------------------------------------------------------------ documents

export function DocumentsPanel({ d }: { d: VisitDetail }) {
  const settings = useErSettings()
  const refresh = useErRefresh()
  const cats = settings.data?.documents.categories ?? ['Uncategorised']
  const [cat, setCat] = useState(cats[0] ?? 'Uncategorised')
  const [filter, setFilter] = useState('')
  const [remove, setRemove] = useState<VisitDoc | null>(null)
  const [reason, setReason] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const can = d.permissions.documents
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const f = await uploadFile(file, d.patient.id)
      return api(`/er/visits/${d.summary.id}/documents`, { method: 'POST', body: { file_id: f.id, category: cat } })
    },
    onSuccess: () => { toast.success('Document attached'); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({
    mutationFn: () => api(`/er/visits/${d.summary.id}/documents/${remove!.file_id}`, { method: 'DELETE', query: { reason } }),
    onSuccess: () => { toast.success('Document removed from the visit'); setRemove(null); setReason(''); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const docs = d.documents.filter((x) => !filter || x.category === filter)
  return (
    <Card icon="FileText" title={<>Documents <span className="font-normal text-ink-3">· uploaded documents of this visit</span></>}>
      <div className="flex flex-wrap items-end gap-2">
        {can && (
          <>
            <FieldWrap label="Category"><Select className="w-56" value={cat} onChange={(e) => setCat(e.target.value)}>{cats.map((c) => <option key={c}>{c}</option>)}</Select></FieldWrap>
            <input ref={input} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = '' }} />
            <Button icon="Upload" loading={upload.isPending} onClick={() => input.current?.click()}>Attach file</Button>
          </>
        )}
        {d.documents.length > 0 && (
          <FieldWrap label="Show" className="ml-auto">
            <Select className="w-48" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All categories</option>{Array.from(new Set(d.documents.map((x) => x.category))).map((c) => <option key={c}>{c}</option>)}
            </Select>
          </FieldWrap>
        )}
      </div>
      {upload.isPending && <Spinner label="Uploading…" />}
      {!docs.length ? <Empty icon="FileText" title="No documents attached">{can ? 'Choose a category and attach referral letters, police memos, old records or consent forms.' : undefined}</Empty> : (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {docs.map((x) => (
            <li key={x.file_id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <Icon name={x.mime?.startsWith('image/') ? 'Image' : 'FileText'} className="size-5 text-ink-3" />
              <a href={apiUrl(`/files/${x.file_id}`, undefined, true)} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline dark:text-brand-300">{x.name}</a>
              <Badge>{x.category}</Badge>
              <span className="text-xs text-ink-3">{dateTime(x.uploaded_at)} · {x.uploaded_by}{x.size ? ` · ${Math.max(1, Math.round(x.size / 1024))} KB` : ''}</span>
              {can && <Button size="xs" variant="ghost" icon="Trash2" className="ml-auto" onClick={() => setRemove(x)}>Remove</Button>}
            </li>
          ))}
        </ul>
      )}
      {remove && (
        <Modal open onClose={() => setRemove(null)} title={`Remove ${remove.name}?`} size="sm"
          footer={<><Button variant="ghost" onClick={() => setRemove(null)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={del.isPending} onClick={() => del.mutate()}>Remove</Button></>}>
          <p className="text-sm text-ink-2">The file is detached from this visit (it stays in the patient's records). The removal is audited.</p>
          <FieldWrap label="Reason" className="mt-3"><Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></FieldWrap>
        </Modal>
      )}
    </Card>
  )
}
