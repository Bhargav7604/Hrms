import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { dateTime, money } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { Rec } from '@/lib/types'
import { erKey, type VisitSummary } from '../api'
import { StateBadge } from '../ui'

interface Line {
  id: string; code: string; status: string; description?: string; qty?: number; rate?: number; amount?: number; charged_at?: string
  invoice_id?: string | null; source?: string; service: { code?: string; name?: string; category?: string }; attached: boolean
}
export interface ErBilling {
  state: 'Active' | 'Awaiting billing' | 'Closed'; status: string; payer: string
  lines: Line[]; invoices: Rec[]; payments: Rec[]
  clearance: { cleared: boolean; unbilled_count: number; unbilled_amount: number; balance_due: number }
  totals: { unbilled: number; billed: number; paid: number; balance: number; deposit: number }
  closable: boolean; blockers: string[]; closed_at?: string; closed_by?: string; closure_note?: string; closure_override?: string
  visit: VisitSummary | null
  permissions: { bill: boolean; close: boolean; override_close: boolean }
}

const MODES = ['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'INSURANCE'] as const

export function useErBilling(id: string) {
  return useQuery({ queryKey: erKey('billing', id), queryFn: () => api<ErBilling>(`/er/visits/${id}/billing`) })
}

export function BillingPanel({ visitId }: { visitId: string }) {
  const qc = useQueryClient()
  const q = useErBilling(visitId)
  const [bill, setBill] = useState(false)
  const [pay, setPay] = useState<Rec | null>(null)
  const [close, setClose] = useState(false)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['x', 'er'] }); qc.invalidateQueries({ queryKey: ['x', 'billing'] }) }
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  const b = q.data!
  const p = b.permissions
  const unbilled = b.lines.filter((l) => l.status === 'Unbilled')
  return (
    <div className="space-y-4">
      <div className={cn('flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3',
        b.state === 'Closed' ? 'border-line bg-surface-2' : b.state === 'Awaiting billing' ? 'border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10' : 'border-line bg-surface')}>
        <StateBadge state={b.state} />
        <span className="text-sm text-ink-2">
          {b.state === 'Active' && 'The patient is still in the ER — charges accrue to this visit until the disposition.'}
          {b.state === 'Awaiting billing' && (b.closable ? 'Billing is cleared — the visit can be closed.' : b.blockers.join(' · '))}
          {b.state === 'Closed' && `Closed ${dateTime(b.closed_at)} by ${b.closed_by ?? '—'}${b.closure_override ? ` · override: ${b.closure_override}` : b.closure_note ? ` · ${b.closure_note}` : ''}`}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          {p.bill && unbilled.length > 0 && b.state !== 'Closed' && <Button size="sm" variant="primary" icon="ReceiptText" onClick={() => setBill(true)}>Generate ER bill</Button>}
          {p.close && b.state === 'Awaiting billing' && (b.closable || p.override_close) && (
            <Button size="sm" variant={b.closable ? 'success' : 'warning'} icon="CircleCheck" onClick={() => setClose(true)}>{b.closable ? 'Close visit' : 'Close with override'}</Button>
          )}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {([['Unbilled', b.totals.unbilled], ['Billed', b.totals.billed], ['Paid', b.totals.paid], ['Balance due', b.totals.balance], ['Deposit available', b.totals.deposit]] as const).map(([k, v]) => (
          <div key={k} className={cn('rounded-xl border bg-surface px-4 py-3', k === 'Balance due' && v > 0 ? 'border-red-300 dark:border-red-500/40' : 'border-line')}>
            <div className="text-xs text-ink-2">{k}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{money(v)}</div>
          </div>
        ))}
      </div>

      <Card icon="List" title={`Charges on this ER visit (${b.lines.length})`} pad={false}>
        {!b.lines.length ? <Empty icon="ReceiptText" title="No charges yet">The ER consultation is charged when the doctor first assesses the patient; orders, medicines and procedures add theirs.</Empty> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-surface-2 text-left text-[11px] uppercase text-ink-3">
                <tr>{['Charged', 'Service', 'Description', 'Qty', 'Rate', 'Amount', 'Status'].map((h) => <th key={h} className={cn('px-3 py-2 font-semibold', ['Qty', 'Rate', 'Amount'].includes(h) && 'text-right')}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {b.lines.map((l) => (
                  <tr key={l.id} className={cn(l.status === 'Cancelled' && 'text-ink-3 line-through')}>
                    <td className="px-3 py-1.5 text-xs text-ink-2">{dateTime(l.charged_at)}</td>
                    <td className="px-3 py-1.5 text-xs">{l.service.code ?? '—'}</td>
                    <td className="px-3 py-1.5 text-ink">{l.description ?? l.service.name}{!l.attached && <Badge tone="amber" className="ml-1">Not yet on the visit</Badge>}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.qty}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(l.rate)}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums">{money(l.amount)}</td>
                    <td className="px-3 py-1.5"><StatusBadge status={l.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card icon="ReceiptText" title="ER bills & payments" pad={false}>
        {!b.invoices.length ? <Empty icon="ReceiptText" title="No ER bill yet" /> : (
          <ul className="divide-y divide-line">
            {b.invoices.map((i) => {
              const pays = b.payments.filter((x) => x.invoice_id === i.id)
              return (
                <li key={i.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <b className="text-ink">{i.code}</b>
                    <span className="text-xs text-ink-3">{dateTime(i.billed_at)} · {i.payer}</span>
                    <StatusBadge status={i.status} />
                    <span className="ml-auto tabular-nums text-ink-2">Net <b className="text-ink">{money(i.net)}</b> · paid {money(i.paid)} · balance <b className={cn(Number(i.balance) > 0 ? 'text-red-600' : 'text-ink')}>{money(i.balance)}</b></span>
                    <a href={`/print/billing/invoices/${i.id}`} target="_blank" rel="noreferrer"><Button size="xs" icon="Printer">Print</Button></a>
                    {p.bill && Number(i.balance) > 0 && ['Final', 'Partially Paid'].includes(i.status ?? '') && <Button size="xs" variant="primary" icon="IndianRupee" onClick={() => setPay(i)}>Collect</Button>}
                  </div>
                  {pays.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-ink-2">
                      {pays.map((x) => <li key={x.id}>{x.code} · {x.kind} · {x.mode} {x.reference ? `(${x.reference})` : ''} · {money(x.amount)} · {dateTime(x.paid_at)} · {x.received_by} · {x.status}</li>)}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
      {bill && <BillDialog visitId={visitId} amount={b.totals.unbilled} payer={b.payer} onClose={() => setBill(false)} onDone={refresh} />}
      {pay && <PayDialog invoice={pay} onClose={() => setPay(null)} onDone={refresh} />}
      {close && <CloseDialog visitId={visitId} b={b} onClose={() => setClose(false)} onDone={refresh} />}
    </div>
  )
}

function BillDialog({ visitId, amount, payer, onClose, onDone }: { visitId: string; amount: number; payer: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ payer, discount_percent: '', discount_amount: '', discount_reason: '' })
  const discount = Number(f.discount_amount || 0) + (amount * Number(f.discount_percent || 0)) / 100
  const m = useMutation({
    mutationFn: () => api<Rec>(`/er/visits/${visitId}/bill`, { method: 'POST', body: {
      payer: f.payer, discount_percent: Number(f.discount_percent || 0), discount_amount: Number(f.discount_amount || 0), discount_reason: f.discount_reason || null } }),
    onSuccess: (r) => { toast.success(r.status === 'Draft' ? `Bill ${r.code} created — discount sent for approval` : `Bill ${r.code} generated · ${money(r.net)}`); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Generate ER bill" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={discount > 0 && !f.discount_reason.trim()} onClick={() => m.mutate()}>Generate bill</Button></>}>
      <p className="text-sm text-ink-2">All unbilled charges of this ER visit ({money(amount)}) go on one bill; any unused deposit is adjusted.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FieldWrap label="Payer" className="sm:col-span-2">
          <Select value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })}>{['Self-pay', 'Insurance', 'Corporate', 'Government scheme'].map((x) => <option key={x}>{x}</option>)}</Select>
        </FieldWrap>
        <FieldWrap label="Discount %"><Input type="number" min={0} max={100} value={f.discount_percent} onChange={(e) => setF({ ...f, discount_percent: e.target.value })} /></FieldWrap>
        <FieldWrap label="Discount ₹"><Input type="number" min={0} value={f.discount_amount} onChange={(e) => setF({ ...f, discount_amount: e.target.value })} /></FieldWrap>
        {discount > 0 && <FieldWrap label="Discount reason" required className="sm:col-span-2" help="Discounts above the approval limit go to the approvals inbox"><Input value={f.discount_reason} onChange={(e) => setF({ ...f, discount_reason: e.target.value })} /></FieldWrap>}
      </div>
      <p className="mt-3 text-right text-sm text-ink-2">Net before tax <b className="text-ink">{money(Math.max(0, amount - discount))}</b></p>
    </Modal>
  )
}

function PayDialog({ invoice, onClose, onDone }: { invoice: Rec; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<(typeof MODES)[number]>('CASH')
  const [amount, setAmount] = useState(String(invoice.balance ?? ''))
  const [ref, setRef] = useState('')
  const needsRef = mode !== 'CASH' && mode !== 'INSURANCE'
  const m = useMutation({
    mutationFn: () => api<Rec>('/billing/payments', { method: 'POST', body: { patient_id: invoice.patient_id, invoice_id: invoice.id, mode, amount: Number(amount), reference: ref || null } }),
    onSuccess: (r) => { toast.success(`Receipt ${r.code} · ${money(r.amount)}`); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const over = Number(amount) > Number(invoice.balance) + 0.01
  return (
    <Modal open onClose={onClose} title={`Collect payment · ${invoice.code}`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!(Number(amount) > 0) || over || (needsRef && !ref.trim())} onClick={() => m.mutate()}>Collect {money(Number(amount) || 0)}</Button></>}>
      <p className="text-sm text-ink-2">Balance due <b className="text-ink">{money(invoice.balance)}</b></p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {MODES.map((x) => (
          <button key={x} type="button" aria-pressed={mode === x} onClick={() => setMode(x)}
            className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold ring-1', mode === x ? 'bg-brand-700 text-white ring-brand-800' : 'bg-surface-2 text-ink-2 ring-line')}>{x}</button>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FieldWrap label="Amount (₹)" error={over ? 'More than the balance' : undefined}><Input type="number" min={0} value={amount} invalid={over} onChange={(e) => setAmount(e.target.value)} autoFocus /></FieldWrap>
        <FieldWrap label={needsRef ? 'Transaction reference' : 'Reference'} required={needsRef}><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={mode === 'UPI' ? 'UPI ref no.' : ''} /></FieldWrap>
      </div>
    </Modal>
  )
}

function CloseDialog({ visitId, b, onClose, onDone }: { visitId: string; b: ErBilling; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [override, setOverride] = useState('')
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${visitId}/close`, { method: 'POST', body: { note: note || null, override_reason: b.closable ? null : override } }),
    onSuccess: () => { toast.success('ER visit closed'); onDone(); onClose() },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Close ER visit" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={b.closable ? 'success' : 'warning'} loading={m.isPending} disabled={!b.closable && override.trim().length < 5} onClick={() => m.mutate()}>Close visit</Button></>}>
      {b.closable ? <p className="text-sm text-ink-2">Billing is cleared. Closing completes the ER workflow.</p> : (
        <>
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <Icon name="TriangleAlert" className="mt-0.5 size-4 shrink-0" />{b.blockers.join(' · ')}
          </p>
          <FieldWrap label="Override reason (audited)" required className="mt-3" help="e.g. insurance pre-auth pending, MLC — free treatment under scheme">
            <Textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} />
          </FieldWrap>
        </>
      )}
      <FieldWrap label="Closure note" className="mt-3"><Input value={note} onChange={(e) => setNote(e.target.value)} /></FieldWrap>
    </Modal>
  )
}
