import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Pager } from '@/components/list'
import {
  Badge, Button, cn, Drawer, Empty, ErrorBox, FieldWrap, Input, Modal, Segmented, Select, Spinner, type BadgeTone,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { date, dateTime, money, todayISO } from '@/lib/format'
import { REF_MODES, type Bill, type CounterContext, type Line } from './api'

export interface BillRow {
  sno: number; id: string; bill_no: string; patient_id: string; patient: string; uhid: string; mobile?: string; net: number; due?: number | null
  discount?: number; paid?: number; sponsor_due?: number | null; status: string; sub_status?: string | null; camp?: string | null; consultant?: string | null
  client_type?: string; sponsor?: string | null; lead_source?: string | null; remarks?: string | null; created_by?: string | null
  created_by_code?: string | null; date?: string; counter?: string; source?: string
}

export const STATUS_TONE: Record<string, BadgeTone> = { CONFIRMED: 'green', DRAFT: 'amber', 'PENDING APPROVAL': 'amber', CANCELLED: 'red', DISCARDED: 'gray' }

export function BillStatus({ status, sub }: { status: string; sub?: string | null }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge tone={STATUS_TONE[status] ?? 'gray'}>{status}</Badge>
      {sub && <span className={cn('text-[10px] font-semibold uppercase tracking-wide', sub === 'DUE' ? 'text-red-600' : 'text-ink-3')}>{sub}</span>}
    </span>
  )
}

/** Confirmed bills (from the counter): my bills / all users, today or a range, balance, print. */
export function BillsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [sel, setSel] = useState<string | null>(null)
  const dq = useDebounced(q, 300)
  const list = useQuery({
    queryKey: ['x', 'billing', 'op-bills', 'confirmed', scope, from, to, dq, page],
    queryFn: () => api<{ rows: BillRow[]; total: number }>('/opbilling/bills', { query: { scope, date_from: from, date_to: to, q: dq || undefined, status: 'CONFIRMED', page, limit: 25 } }),
    enabled: open,
  })
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Confirmed bills">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 w-64" placeholder="Search bill no, UHID or patient…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} />
          <Input type="date" className="h-8 w-36" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-ink-3">–</span>
          <Input type="date" className="h-8 w-36" value={to} onChange={(e) => setTo(e.target.value)} />
          <Segmented value={scope} onChange={(v) => { setScope(v); setPage(1) }} options={[{ key: 'mine', label: 'My bills' }, { key: 'all', label: 'All users' }]} />
          <Button size="sm" onClick={() => { setFrom(todayISO()); setTo(todayISO()) }}>Today</Button>
        </div>
        {list.isLoading && <Spinner />}
        {list.error && <ErrorBox error={list.error} />}
        {list.data && !list.data.rows.length && <Empty icon="FileText" title={scope === 'mine' ? 'You have not billed anything in this range.' : 'No bills in this range.'} />}
        {!!list.data?.rows.length && (
          <BillTable rows={list.data.rows} onOpen={setSel} compact />
        )}
        {list.data && <Pager page={page} limit={25} total={list.data.total} onPage={setPage} />}
        <p className="text-xs text-ink-3">Picking a bill opens it here — the counter stays where it is.</p>
      </div>
      <BillDrawer id={sel} onClose={() => setSel(null)} />
    </Modal>
  )
}

export function BillTable({ rows, onOpen, compact }: { rows: BillRow[]; onOpen: (id: string) => void; compact?: boolean }) {
  const cols = compact ? ['Bill no', 'Patient', 'UHID', 'Net', 'Balance', 'Status', 'Billed', ''] :
    ['S.No', 'Bill no', 'Patient', 'Mobile', 'Net', 'Due', 'Discount', 'Status', 'Camp', 'Consultant', 'Client type', 'Lead source', 'Remarks', 'Created by', 'Date', '']
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-2 text-xs text-ink-2"><tr>{cols.map((h) => <th key={h} className="whitespace-nowrap px-2.5 py-2 text-left font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => onOpen(r.id)}>
              {!compact && <td className="px-2.5 py-1.5 text-xs text-ink-3">{r.sno}</td>}
              <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-xs text-ink">{r.bill_no}</td>
              <td className="px-2.5 py-1.5"><div className="text-ink">{r.patient}</div>{!compact && <div className="font-mono text-[11px] text-ink-3">{r.uhid}</div>}</td>
              {compact ? <td className="px-2.5 py-1.5 font-mono text-xs text-ink-2">{r.uhid}</td> : <td className="tabular px-2.5 py-1.5 text-ink-2">{r.mobile}</td>}
              <td className="tabular px-2.5 py-1.5 text-right">{money(r.net)}</td>
              <td className={cn('tabular px-2.5 py-1.5 text-right', (r.due ?? 0) > 0 && 'font-medium text-red-600')}>{money(r.due ?? 0)}</td>
              {!compact && <td className="tabular px-2.5 py-1.5 text-right text-ink-2">{r.discount ? money(r.discount) : '—'}</td>}
              <td className="px-2.5 py-1.5"><BillStatus status={r.status} sub={r.sub_status} /></td>
              {!compact && <>
                <td className="px-2.5 py-1.5 text-ink-2">{r.camp ?? '—'}</td>
                <td className="px-2.5 py-1.5 text-ink-2">{r.consultant ?? '—'}</td>
                <td className="px-2.5 py-1.5 text-xs text-ink-2">{r.client_type}{r.sponsor ? <div className="text-ink-3">{r.sponsor}</div> : null}</td>
                <td className="px-2.5 py-1.5 text-xs text-ink-2">{r.lead_source ?? '—'}</td>
                <td className="max-w-48 truncate px-2.5 py-1.5 text-xs text-ink-2" title={r.remarks ?? ''}>{r.remarks ?? '—'}</td>
                <td className="px-2.5 py-1.5 text-xs text-ink-2">{r.created_by ?? '—'}{r.created_by_code && <div className="text-ink-3">{r.created_by_code}</div>}</td>
              </>}
              <td className="whitespace-nowrap px-2.5 py-1.5 text-xs text-ink-2">{dateTime(r.date)}</td>
              <td className="px-2.5 py-1.5 text-right">
                {r.status === 'CONFIRMED' && <Button size="xs" variant="ghost" icon="Printer" aria-label="Print" onClick={(e) => { e.stopPropagation(); window.open(`/op/bills/${r.id}/print`, '_blank') }} />}
                {r.status === 'DRAFT' && <Link to={`/op/billing/${r.id}`} onClick={(e) => e.stopPropagation()} className="text-xs text-brand-700 hover:underline dark:text-brand-300">Open</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One bill: lines, receipts, sponsor split; collect the due, refund, correct a payment mode, print. */
export function BillDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const ctx = useQuery({ queryKey: ['x', 'billing', 'counter-context'], queryFn: () => api<CounterContext>('/opbilling/context'), staleTime: 5 * 60_000, enabled: !!id })
  const b = useQuery({ queryKey: ['x', 'billing', 'op-bill', id], queryFn: () => api<Bill>(`/opbilling/bills/${id}`), enabled: !!id })
  const [panel, setPanel] = useState<null | 'refund' | 'collect' | { fix: string }>(null)
  const [form, setForm] = useState({ amount: 0, mode: 'CASH', reason: '', reference: '' })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['x', 'billing'] }); setPanel(null) }
  const act = useMutation({
    mutationFn: () => {
      if (panel === 'refund') return api(`/opbilling/bills/${id}/refund`, { method: 'POST', body: { amount: form.amount, mode: form.mode, reason: form.reason } })
      if (panel === 'collect') return api(`/opbilling/bills/${id}/collect`, { method: 'POST', body: { pay_lines: [{ mode: form.mode, amount: form.amount, reference: form.reference || null }] } })
      const fix = panel as { fix: string }
      return api(`/opbilling/payments/${fix.fix}/correct-mode`, { method: 'POST', body: { mode: form.mode, reference: form.reference || null, reason: form.reason } })
    },
    onSuccess: (r: unknown) => {
      const appr = (r as { approval?: { code: string } | null })?.approval
      toast.success(appr ? `Sent for approval (${appr.code})` : 'Done')
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const bill = b.data
  const c = ctx.data
  const confirmed = bill?.label.status === 'CONFIRMED'
  return (
    <Drawer open={!!id} onClose={onClose} width="max-w-3xl" title={bill ? `Bill ${bill.code}` : 'Bill'}
      subtitle={bill ? <span className="flex items-center gap-2">{bill.patient.name} · {bill.patient.uhid} <BillStatus status={bill.label.status} sub={bill.label.sub} /></span> : undefined}
      footer={bill && <>
        {bill.label.status === 'DRAFT' && <Link to={`/op/billing/${bill.id}`} className="text-sm text-brand-700 hover:underline dark:text-brand-300">Open at the counter</Link>}
        {confirmed && (bill.patient_due ?? 0) > 0 && c && <Button onClick={() => { setForm({ amount: bill.patient_due ?? 0, mode: c.default_payment_mode, reason: '', reference: '' }); setPanel('collect') }}>Collect due</Button>}
        {confirmed && c?.can_refund && (bill.refundable ?? 0) > 0 && <Button variant="warning" onClick={() => { setForm({ amount: 0, mode: 'CASH', reason: '', reference: '' }); setPanel('refund') }}>Refund</Button>}
        {confirmed && <Button variant="primary" icon="Printer" onClick={() => window.open(`/op/bills/${bill.id}/print`, '_blank')}>Print</Button>}
      </>}>
      {b.isLoading && <Spinner />}
      {b.error && <div className="p-4"><ErrorBox error={b.error} /></div>}
      {bill && (
        <div className="space-y-4 p-5 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['Gross', bill.gross ?? bill.totals.gross], ['Discount', bill.discount ?? bill.totals.discount], ['Net', bill.net ?? bill.totals.net], ['Paid', bill.paid ?? 0],
              ['Patient due', bill.patient_due ?? bill.balance ?? 0], ['Sponsor due', bill.sponsor_due ?? 0], ['Billed', null], ['Payer', null]].map(([l, v]) => (
              <div key={String(l)}><div className="text-xs text-ink-3">{l}</div><div className="tabular font-medium text-ink">
                {l === 'Billed' ? dateTime(bill.billed_at ?? bill.created_at) : l === 'Payer' ? `${bill.payer ?? 'Self'}${bill.state.sponsor_name ? ` · ${bill.state.sponsor_name}` : ''}` : money(v)}</div></div>
            ))}
          </div>
          {bill.approval && <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">Discount approval {bill.approval.code}: {bill.approval.status}{bill.approval.comments ? ` — ${bill.approval.comments}` : ''}</p>}
          <table className="w-full">
            <thead className="border-b border-line text-xs text-ink-2"><tr>{['Item', 'Consultant', 'Qty', 'Rate', 'Disc', 'Net'].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {(bill.charges?.length ? bill.charges.map((ch) => ({ k: ch.id, name: ch.description, cons: ch.consultant_name, qty: ch.qty, rate: ch.rate, disc: ch.discount, net: ch.line_net ?? ch.amount - (ch.discount || 0) }))
                : bill.state.lines.map((l) => { const t = bill.totals.lines.find((x) => x.key === l.key); return { k: l.key, name: l.name, cons: l.consultant_name, qty: l.qty, rate: l.rate, disc: t?.discount ?? 0, net: t?.net ?? 0 } }))
                .map((x) => (
                  <tr key={x.k} className="border-b border-line last:border-0"><td className="px-2 py-1.5 text-ink">{x.name}</td><td className="px-2 py-1.5 text-ink-2">{x.cons ?? '—'}</td>
                    <td className="tabular px-2 py-1.5">{x.qty}</td><td className="tabular px-2 py-1.5">{money(x.rate)}</td><td className="tabular px-2 py-1.5 text-ink-2">{x.disc ? money(x.disc) : '—'}</td>
                    <td className="tabular px-2 py-1.5 font-medium">{money(x.net)}</td></tr>
                ))}
            </tbody>
          </table>
          {!!bill.payments?.length && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Receipts & refunds</h4>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {bill.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                    <span className="font-mono text-xs text-ink-2">{p.code}</span><Badge tone={p.kind === 'REFUND' ? 'red' : 'blue'}>{p.kind} · {p.mode}</Badge>
                    {p.mode_corrected_from && <span className="text-xs text-ink-3">(was {p.mode_corrected_from})</span>}
                    <span className="flex-1 truncate text-xs text-ink-3">{p.reference}</span>
                    <Badge tone={p.status === 'Success' ? 'green' : p.status === 'Pending' ? 'amber' : 'red'}>{p.status}</Badge>
                    <span className="tabular font-medium">{money(p.amount)}</span>
                    {c?.can_correct_mode && p.kind === 'PAYMENT' && p.status === 'Success' && !['INSURANCE', 'DEPOSIT'].includes(p.mode) && (
                      <Button size="xs" variant="ghost" onClick={() => { setForm({ amount: p.amount, mode: p.mode === 'CASH' ? 'UPI' : 'CASH', reason: '', reference: '' }); setPanel({ fix: p.id }) }}>Correct mode</Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {panel && c && (
            <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
              <div className="font-medium text-ink">{panel === 'refund' ? `Refund (up to ${money(bill.refundable)})` : panel === 'collect' ? 'Collect the patient due' : 'Correct the payment mode (audited)'}</div>
              <div className="flex flex-wrap gap-2">
                {(panel === 'refund' || panel === 'collect') && (
                  <FieldWrap label="Amount"><Input type="number" min={0} className="w-28" value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) || 0 })} /></FieldWrap>
                )}
                <FieldWrap label={typeof panel === 'object' ? 'Correct mode' : 'Mode'}>
                  <Select className="w-28" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                    {(panel === 'refund' ? ['CASH', 'CARD', 'UPI', 'BANK', 'CHEQUE'] : ['CASH', 'CARD', 'UPI', 'WALLET', 'BANK', 'CHEQUE']).map((m) => <option key={m}>{m}</option>)}
                  </Select>
                </FieldWrap>
                {panel !== 'refund' && REF_MODES.has(form.mode) && <FieldWrap label="Reference"><Input className="w-40" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></FieldWrap>}
                {panel !== 'collect' && <FieldWrap label="Reason" className="min-w-56 flex-1"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={panel === 'refund' ? 'e.g. Test not done' : 'e.g. Paid by UPI, entered as cash'} /></FieldWrap>}
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
                <Button size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate()}
                  disabled={(panel !== 'collect' && form.reason.trim().length < 3) || ((panel === 'refund' || panel === 'collect') && !(form.amount > 0))}>Submit</Button>
              </div>
              {panel === 'refund' && <p className="text-xs text-ink-3">Refunds above the policy threshold wait for management approval.</p>}
              {typeof panel === 'object' && <p className="text-xs text-ink-3">Same-day corrections apply at once; older receipts go for approval.</p>}
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}

export function DraftsModal({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const list = useQuery({
    queryKey: ['x', 'billing', 'op-drafts', scope],
    queryFn: () => api<{ id: string; code: string; patient: string; uhid: string; items: number; net: number; updated_at?: string; created_by_name?: string }[]>('/opbilling/drafts', { query: { scope } }),
    enabled: open,
  })
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Draft bills">
      <div className="mb-3"><Segmented value={scope} onChange={setScope} options={[{ key: 'mine', label: 'My drafts' }, { key: 'all', label: 'All counters' }]} /></div>
      {list.isLoading && <Spinner />}
      {list.data?.length === 0 && <Empty icon="Files" title="No open draft bills" />}
      <ul className="divide-y divide-line">
        {list.data?.map((d) => (
          <li key={d.id}><button type="button" onClick={() => onOpen(d.id)} className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-surface-2">
            <span className="font-mono text-xs text-ink-2">{d.code}</span><span className="min-w-0 flex-1"><span className="block text-sm text-ink">{d.patient}</span>
              <span className="block text-xs text-ink-3">{d.uhid} · {d.items} items · {d.created_by_name} · {dateTime(d.updated_at)}</span></span>
            <span className="tabular text-sm">{money(d.net)}</span></button></li>
        ))}
      </ul>
    </Modal>
  )
}

export function PriceCheckModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 250)
  const list = useQuery({ queryKey: ['x', 'billing', 'price', dq], queryFn: () => api<Record<string, string | number | null>[]>('/opbilling/price-check', { query: { q: dq } }), enabled: open && dq.length >= 2 })
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Price check">
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Service name or code…" />
      <div className="mt-3 max-h-[55vh] overflow-y-auto scroll-thin">
        {list.data?.length === 0 && <Empty icon="Tag" title="No matching service" />}
        <table className="w-full text-sm">
          {!!list.data?.length && <thead className="border-b border-line text-xs text-ink-2"><tr>{['Code', 'Service', 'Category', 'Rate', 'Private', 'ICU', 'International', 'GST %'].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr></thead>}
          <tbody>
            {list.data?.map((s) => (
              <tr key={String(s.id)} className="border-b border-line last:border-0">
                <td className="px-2 py-1.5 font-mono text-xs">{s.code}</td><td className="px-2 py-1.5">{s.name}</td><td className="px-2 py-1.5 text-ink-2">{s.category}</td>
                <td className="tabular px-2 py-1.5 font-medium">{money(s.rate)}</td><td className="tabular px-2 py-1.5">{s.rate_private ? money(s.rate_private) : '—'}</td>
                <td className="tabular px-2 py-1.5">{s.rate_icu ? money(s.rate_icu) : '—'}</td><td className="tabular px-2 py-1.5">{s.rate_international ? money(s.rate_international) : '—'}</td>
                <td className="tabular px-2 py-1.5">{s.tax_percent ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

export function TemplatesModal({ open, onClose, patientId, lines, onApply }: { open: boolean; onClose: () => void; patientId: string; lines: Line[]; onApply: (l: Line[]) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const list = useQuery({ queryKey: ['x', 'appointments', 'bill-templates'], queryFn: () => api<{ id: string; code: string; name: string; personal: boolean; items: { name: string; qty: number }[] }[]>('/opbilling/templates'), enabled: open })
  const apply = async (id: string) => {
    try { onApply(await api<Line[]>(`/opbilling/templates/${id}/lines`, { query: { patient_id: patientId } })) } catch (e) { toast.error(errorMessage(e)) }
  }
  const save = useMutation({
    mutationFn: () => api('/opbilling/templates', { method: 'POST', body: { name, lines, personal: false } }),
    onSuccess: () => { toast.success('Template saved'); setName(''); qc.invalidateQueries({ queryKey: ['x', 'appointments', 'bill-templates'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const savable = lines.some((l) => l.kind === 'service' || l.kind === 'package')
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Bill templates">
      {list.isLoading && <Spinner />}
      {list.data?.length === 0 && <Empty icon="LayoutTemplate" title="No templates yet">Build a bill and save it as a template below.</Empty>}
      <ul className="divide-y divide-line">
        {list.data?.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1"><div className="text-sm font-medium text-ink">{t.name} {t.personal && <Badge tone="violet">mine</Badge>}</div>
              <div className="truncate text-xs text-ink-3">{t.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(' · ')}</div></div>
            <Button size="sm" variant="primary" onClick={() => apply(t.id)}>Add to bill</Button>
          </li>
        ))}
      </ul>
      {savable && (
        <div className="mt-3 flex gap-2 border-t border-line pt-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Save the current services as a template…" />
          <Button disabled={name.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      )}
    </Modal>
  )
}

export function HistoryModal({ open, onClose, patientId }: { open: boolean; onClose: () => void; patientId: string }) {
  const h = useQuery({
    queryKey: ['x', 'billing', 'history', patientId],
    queryFn: () => api<{ consultations: { id: string; date: string; doctor: string; department?: string; type: string; status: string }[]; bills: { id: string; code: string; net: number; balance: number; billed_at?: string; created_at?: string; label: { status: string; sub: string | null } }[]; deposit_balance: number }>(`/opbilling/patients/${patientId}/history`),
    enabled: open,
  })
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Previous consultations & bills">
      {h.isLoading && <Spinner />}
      {h.data && (
        <div className="space-y-4 text-sm">
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Consultations</h4>
            {!h.data.consultations.length ? <p className="text-ink-3">No earlier visits.</p> : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {h.data.consultations.map((c) => <li key={c.id} className="flex items-center gap-3 px-3 py-1.5"><span className="w-24 text-ink-2">{date(c.date)}</span><span className="flex-1">{c.doctor} <span className="text-ink-3">{c.department}</span></span><span className="text-xs text-ink-3">{c.type}</span><Badge tone="gray">{c.status}</Badge></li>)}
              </ul>
            )}
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Bills · advance available {money(h.data.deposit_balance)}</h4>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {h.data.bills.map((b) => <li key={b.id} className="flex items-center gap-3 px-3 py-1.5"><span className="font-mono text-xs">{b.code}</span><span className="flex-1 text-ink-2">{dateTime(b.billed_at ?? b.created_at)}</span><BillStatus status={b.label.status} sub={b.label.sub} /><span className="tabular">{money(b.net)}</span></li>)}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  )
}
