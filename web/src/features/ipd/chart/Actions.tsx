import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Badge, Button, cn, FieldWrap, Input, Modal, Select, Spinner, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, nowLocal } from '@/lib/format'
import { chartScope, type ChartHeader, type PatientBrief } from '../api'
import { SearchSelect } from '../ui'

interface FormCtx { payers: { id: string; name: string; payer_type?: string | null }[]; categories: { key: string; label: string }[]; sponsor_types: Record<string, string[]> }

/** Record a payer / sponsor change for the stay. Re-pricing the bill is done in IP billing. */
export function ChangeSponsorModal({ h, onClose }: { h: ChartHeader; onClose: () => void }) {
  const qc = useQueryClient()
  const a = h.admission
  const ctx = useQuery({ queryKey: ['x', 'ipd', 'admission-form'], queryFn: () => api<FormCtx>('/ipchart/admission-form'), staleTime: 60_000 })
  const [payer, setPayer] = useState(a.payer)
  const [sponsor, setSponsor] = useState<string | null>(a.sponsor?.id ?? null)
  const [auth, setAuth] = useState(a.authorisation_no ?? '')
  const [amount, setAmount] = useState(a.approved_amount != null ? String(a.approved_amount) : '')
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${a.id}/sponsor`, { method: 'POST', body: { payer, sponsor_id: payer === 'Cash' ? null : sponsor, authorisation_no: auth || null, approved_amount: amount ? Number(amount) : null, reason } }),
    onSuccess: () => { toast.success('Sponsor change recorded — IP billing will re-price the bill'); chartScope(qc, a.id); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const types = ctx.data?.sponsor_types[payer] ?? []
  const opts = (ctx.data?.payers ?? []).filter((p) => !p.payer_type || types.includes(p.payer_type)).map((p) => ({ value: p.id, label: p.name, hint: p.payer_type ?? undefined }))
  const ok = reason.trim().length >= 3 && (payer === 'Cash' || !!sponsor)
  return (
    <Modal open onClose={onClose} title="Change sponsor" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} loading={save.isPending} onClick={() => save.mutate()}>Record change</Button></>}>
      <p className="mb-3 text-sm text-ink-2">Admission <b>{a.code}</b> · currently <b>{a.payer_label}{a.sponsor ? ` · ${a.sponsor.name}` : ' · Self-pay'}</b>. The change is audited; IP billing re-prices the stay against the new tariff.</p>
      {ctx.isLoading ? <Spinner /> : (
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldWrap label="Category" required>
            <Select value={payer} onChange={(e) => { setPayer(e.target.value); setSponsor(null) }}>{ctx.data?.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
          </FieldWrap>
          {payer !== 'Cash' && <FieldWrap label="Organisation / sponsor" required><SearchSelect options={opts} value={sponsor} onChange={setSponsor} placeholder="Search sponsor…" /></FieldWrap>}
          {payer !== 'Cash' && <FieldWrap label="Credit / auth letter no"><Input value={auth} onChange={(e) => setAuth(e.target.value)} maxLength={60} /></FieldWrap>}
          {payer !== 'Cash' && h.permissions.money && <FieldWrap label="Approved amount (₹)"><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></FieldWrap>}
          <FieldWrap label="Reason" required className="sm:col-span-2"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Cashless approval received from TPA" /></FieldWrap>
        </div>
      )}
      {a.sponsor_history.length > 0 && (
        <div className="mt-4 border-t border-line pt-3 text-xs text-ink-2">
          <div className="mb-1 font-semibold uppercase tracking-wide text-ink-3">History</div>
          {a.sponsor_history.map((s, i) => <div key={i}>{dateTime(s.at)} · {String((s.from as Record<string, unknown>).sponsor_name ?? 'Self-pay')} → <b>{String((s.to as Record<string, unknown>).sponsor_name ?? 'Self-pay')}</b> · {s.by} — {s.reason}</div>)}
        </div>
      )}
    </Modal>
  )
}

/** Re-link the admission to the correct UHID (front office / admin). Everything recorded under it moves too. */
export function ChangePatientModal({ h, onClose }: { h: ChartHeader; onClose: () => void }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [pick, setPick] = useState<(PatientBrief & { admission?: { code: string } | null }) | null>(null)
  const [reason, setReason] = useState('')
  const term = dq.trim()
  const query = /^[A-Za-z]+\d{2,}/.test(term) ? { uhid: term } : /^\d{5,}$/.test(term) ? { mobile: term } : { name: term }
  const res = useQuery({ queryKey: ['x', 'ipd', 'change-patient-search', query], queryFn: () => api<{ rows: (PatientBrief & { admission?: { code: string } | null })[] }>('/ipchart/patients/search', { query }), enabled: term.length >= 3 })
  const save = useMutation({
    mutationFn: () => api<{ moved: Record<string, number>; note: string }>(`/ipchart/admissions/${h.admission.id}/change-patient`, { method: 'POST', body: { patient_id: pick!.id, reason } }),
    onSuccess: (r) => { toast.success(`Admission re-linked to ${pick!.name} (${pick!.uhid}) · ${Object.values(r.moved).reduce((a, b) => a + b, 0)} records moved`); toast.info(r.note); chartScope(qc, h.admission.id); qc.invalidateQueries({ queryKey: ['x', 'ipd'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Change patient" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!pick || reason.trim().length < 5} loading={save.isPending} onClick={() => save.mutate()}>Re-link admission</Button></>}>
      <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
        Use only when the admission was opened against the wrong UHID. Orders, charges, vitals, notes and indents of <b>{h.admission.code}</b> move from <b>{h.patient.name} ({h.patient.uhid})</b> to the patient you choose. Advance deposits stay with the original UHID. Fully audited.
      </div>
      <FieldWrap label="Find the correct patient" help="UHID, name (3+ letters) or mobile (5+ digits)"><Input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPick(null) }} /></FieldWrap>
      <ul className="mt-2 max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line scroll-thin">
        {res.isLoading && term.length >= 3 && <li className="px-3 py-2 text-sm text-ink-3">Searching…</li>}
        {(res.data?.rows ?? []).filter((r) => r.id !== h.patient.id).map((r) => (
          <li key={r.id}>
            <button type="button" disabled={!!r.admission} onClick={() => setPick(r)} className={cn('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50', pick?.id === r.id && 'bg-brand-50 dark:bg-brand-500/10')}>
              <span><b className="text-ink">{r.name}</b> <span className="text-xs text-ink-3">{[r.uhid, r.age != null ? `${r.age}y` : null, r.gender, r.phone].filter(Boolean).join(' · ')}</span></span>
              {r.admission ? <Badge tone="amber">Admitted {r.admission.code}</Badge> : pick?.id === r.id ? <Badge tone="green">Selected</Badge> : null}
            </button>
          </li>
        ))}
      </ul>
      <FieldWrap label="Reason" required className="mt-3"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Registered under the brother's UHID by mistake" /></FieldWrap>
    </Modal>
  )
}

export function InitiateDischargeModal({ h, onClose, onDone }: { h: ChartHeader; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const [type, setType] = useState('Routine')
  const [expected, setExpected] = useState('')
  const [remarks, setRemarks] = useState('')
  const save = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${h.admission.id}/initiate-discharge`, { method: 'POST', body: { discharge_type: type, expected_at: expected || null, remarks: remarks || null } }),
    onSuccess: () => { toast.success('Discharge initiated — departments notified for clearance'); chartScope(qc, h.admission.id); qc.invalidateQueries({ queryKey: ['x', 'ipd'] }); qc.invalidateQueries({ queryKey: ['x', 'discharge'] }); onDone() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Initiate discharge" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="LogOut" loading={save.isPending} onClick={() => save.mutate()}>Initiate discharge</Button></>}>
      <p className="mb-3 text-sm text-ink-2">Starts the discharge TAT clock, opens the discharge checklist and asks each department for its clearance.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldWrap label="Discharge type" required>
          <Select value={type} onChange={(e) => setType(e.target.value)}>{h.options.discharge_types.map((t) => <option key={t}>{t}</option>)}</Select>
        </FieldWrap>
        <FieldWrap label="Expected discharge" help="Optional"><Input type="datetime-local" min={nowLocal()} value={expected} onChange={(e) => setExpected(e.target.value)} /></FieldWrap>
        <FieldWrap label="Remarks" className="sm:col-span-2"><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Afebrile 48 h, switch to oral antibiotics" /></FieldWrap>
      </div>
      {['DAMA', 'LAMA', 'Absconded', 'Death'].includes(type) && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{type}: complete the relevant consent / documentation in the Doctor tab.</p>}
    </Modal>
  )
}
