import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import {
  Avatar, Badge, Button, Card, Empty, FieldWrap, Input, Modal, Select, Spinner, StatTile, StatusBadge, Tabs, Textarea,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Icon } from '@/lib/icons'
import { age, dateTime, money } from '@/lib/format'
import type { Rec } from '@/lib/types'
import type { BespokeProps } from './index'

interface Account {
  patient: Rec
  unbilled: Rec[]
  invoices: Rec[]
  payments: Rec[]
  encounters: Rec[]
  refs: Record<string, string>
  totals: { unbilled: number; outstanding: number; deposit_balance: number }
}

const MODES = ['CASH', 'UPI', 'CARD', 'WALLET', 'BANK', 'CHEQUE', 'INSURANCE'] as const

export default function BillingDesk(_: BespokeProps) {
  const [params, setParams] = useSearchParams()
  const pid = params.get('patient')
  const [enc, setEnc] = useState('')
  const [tab, setTab] = useState<'running' | 'bills' | 'receipts'>('running')
  const setPatient = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('patient', id); else p.delete('patient')
    setParams(p)
    setEnc('')
  }
  const acct = useQuery({
    queryKey: ['x', 'billing', 'account', pid, enc],
    queryFn: () => api<Account>(`/billing/patients/${pid}/account`, { query: { encounter_id: enc || undefined } }),
    enabled: !!pid,
  })
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <FieldWrap label="Patient" className="w-full max-w-md">
            <RefPicker refName="registration.patients" kind="patient" value={pid} onChange={(id) => setPatient(id)} placeholder="Search UHID, name or mobile" />
          </FieldWrap>
          {acct.data && (
            <FieldWrap label="Visit / admission" className="w-72">
              <Select value={enc} onChange={(e) => setEnc(e.target.value)}>
                <option value="">All charges</option>
                {acct.data.encounters.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.type} · {e.status}</option>)}
              </Select>
            </FieldWrap>
          )}
        </div>
      </Card>
      {!pid && <Empty icon="Receipt" title="Choose a patient to open their account">Unbilled charges are captured automatically at the point of service — consultations, orders, pharmacy, room rent and procedures.</Empty>}
      {acct.isLoading && <Spinner />}
      {acct.data && (
        <>
          <PatientStrip a={acct.data} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile icon="FileClock" label="Unbilled charges" value={money(acct.data.totals.unbilled)} hint={`${acct.data.unbilled.length} lines`} />
            <StatTile icon="Hourglass" label="Outstanding on bills" value={money(acct.data.totals.outstanding)} tone={acct.data.totals.outstanding > 0 ? 'alert' : 'default'} />
            <StatTile icon="PiggyBank" label="Deposit available" value={money(acct.data.totals.deposit_balance)} />
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[
            { key: 'running', label: 'Running bill', count: acct.data.unbilled.length },
            { key: 'bills', label: 'Bills', count: acct.data.invoices.length },
            { key: 'receipts', label: 'Receipts & refunds', count: acct.data.payments.length },
          ]} />
          {tab === 'running' && <RunningBill a={acct.data} encounterId={enc} onBilled={() => setTab('bills')} />}
          {tab === 'bills' && <Bills a={acct.data} />}
          {tab === 'receipts' && <Receipts a={acct.data} />}
        </>
      )}
    </div>
  )
}

function PatientStrip({ a }: { a: Account }) {
  const p = a.patient
  const qc = useQueryClient()
  const [dep, setDep] = useState(false)
  // In-patients are billed on the IP working bill (packages, sponsor tariff, discharge settlement).
  const ipStay = a.encounters.find((e) => e.type === 'IPD' && ['Admitted', 'Discharge Initiated'].includes(e.status ?? '')) ?? a.encounters.find((e) => e.type === 'IPD')
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <Avatar name={p.title} />
      <div className="min-w-0 flex-1">
        <Link to={`/patients/${p.id}`} className="font-medium text-ink hover:underline">{p.title}</Link>
        <div className="text-xs text-ink-2"><span className="font-mono">{p.code}</span> · {[age(p.dob), p.gender].filter(Boolean).join(' ')} · {p.phone} · Payer: {p.payer_type ?? 'Cash'}</div>
      </div>
      {ipStay && (
        <Link to={`/ip/billing/${ipStay.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm font-medium text-ink shadow-sm hover:bg-surface-2">
          <Icon name="FileSpreadsheet" className="size-4" />IP working bill · {ipStay.code}
        </Link>
      )}
      <Button size="sm" icon="PiggyBank" onClick={() => setDep(true)}>Collect deposit</Button>
      <PaymentModal open={dep} onClose={() => setDep(false)} patientId={p.id} kind="DEPOSIT" onDone={() => qc.invalidateQueries({ queryKey: ['x', 'billing'] })} />
    </div>
  )
}

function RunningBill({ a, encounterId, onBilled }: { a: Account; encounterId: string; onBilled: () => void }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [disc, setDisc] = useState({ percent: '', amount: '', reason: '' })
  const [payer, setPayer] = useState('Self')
  const [applyDeposit, setApplyDeposit] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  useEffect(() => { setSel(new Set(a.unbilled.map((c) => c.id))) }, [a.unbilled])
  const chosen = a.unbilled.filter((c) => sel.has(c.id))
  const gross = chosen.reduce((s, c) => s + Number(c.amount || 0), 0)
  const discount = (Number(disc.percent || 0) / 100) * gross + Number(disc.amount || 0)
  const encType = a.encounters.find((e) => e.id === (encounterId || chosen[0]?.encounter_id))?.type
  const invType = encType === 'IPD' ? 'IP' : 'OP'
  const bill = useMutation({
    mutationFn: () => api<Rec>('/billing/invoices', {
      method: 'POST', body: {
        patient_id: a.patient.id, encounter_id: encounterId || undefined, charge_ids: [...sel], type: invType, payer,
        discount_percent: Number(disc.percent || 0), discount_amount: Number(disc.amount || 0), discount_reason: disc.reason || undefined, apply_deposit: applyDeposit,
      },
    }),
    onSuccess: (inv) => {
      toast.success(inv.status === 'Draft' ? `Bill ${inv.code} created — discount sent for approval` : `Bill ${inv.code} created · balance ${money(inv.balance)}`)
      qc.invalidateQueries({ queryKey: ['x', 'billing'] })
      setDisc({ percent: '', amount: '', reason: '' })
      onBilled()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/billing/charges/${id}/cancel`, { method: 'POST', body: { reason: prompt('Reason for cancelling this charge?') || '' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['x', 'billing'] }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const groups = useMemo(() => {
    const m = new Map<string, Rec[]>()
    for (const c of a.unbilled) {
      const k = String(c.source ?? 'manual').startsWith('ipd.daily') ? 'Room & nursing' : String(c.source ?? 'manual').split('.')[0]
      m.set(k, [...(m.get(k) ?? []), c])
    }
    return [...m.entries()]
  }, [a.unbilled])
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card title="Unbilled charges" icon="ListChecks" pad={false}
        actions={<Button size="sm" icon="Plus" onClick={() => setAddOpen(true)}>Add charge</Button>}>
        {a.unbilled.length === 0 ? <Empty icon="CheckCircle2" title="Nothing to bill" /> : (
          <div className="max-h-[560px] overflow-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>
                  <th className="w-8 px-3 py-2"><input type="checkbox" className="accent-brand-700" checked={sel.size === a.unbilled.length}
                    onChange={(e) => setSel(e.target.checked ? new Set(a.unbilled.map((c) => c.id)) : new Set())} aria-label="Select all" /></th>
                  <th className="px-2 py-2 text-left font-medium">Date</th>
                  <th className="px-2 py-2 text-left font-medium">Description</th>
                  <th className="px-2 py-2 text-right font-medium">Qty</th>
                  <th className="px-2 py-2 text-right font-medium">Rate</th>
                  <th className="px-2 py-2 text-right font-medium">Amount</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {groups.map(([g, rows]) => (
                  <Fragment key={g}>
                    <tr className="bg-surface-2/60"><td colSpan={7} className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-ink-3">{g} · {money(rows.reduce((s, c) => s + Number(c.amount || 0), 0))}</td></tr>
                    {rows.map((c) => (
                      <tr key={c.id} className="border-t border-line">
                        <td className="px-3 py-1.5"><input type="checkbox" className="accent-brand-700" checked={sel.has(c.id)}
                          onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(c.id); else n.delete(c.id); setSel(n) }} aria-label="Select charge" /></td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-2">{dateTime(c.charged_at)}</td>
                        <td className="px-2 py-1.5">{c.description}{String(c.description).includes('unpriced') && <Badge tone="amber" className="ml-2">Review price</Badge>}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.qty}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{money(c.rate)}</td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">{money(c.amount)}</td>
                        <td className="px-2">{(user?.role === 'billing' || user?.role === 'admin') && (
                          <button className="text-xs text-ink-3 hover:text-red-600" onClick={() => cancel.mutate(c.id)}>Void</button>
                        )}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Create bill" icon="Receipt">
        <div className="space-y-3 text-sm">
          <div className="flex justify-between"><span className="text-ink-2">Selected lines</span><span>{chosen.length}</span></div>
          <div className="flex justify-between"><span className="text-ink-2">Gross</span><span className="tabular-nums">{money(gross)}</span></div>
          <div className="grid grid-cols-2 gap-2">
            <FieldWrap label="Discount %"><Input type="number" min={0} max={100} value={disc.percent} onChange={(e) => setDisc({ ...disc, percent: e.target.value })} /></FieldWrap>
            <FieldWrap label="Discount ₹"><Input type="number" min={0} value={disc.amount} onChange={(e) => setDisc({ ...disc, amount: e.target.value })} /></FieldWrap>
          </div>
          {discount > 0 && (
            <FieldWrap label="Discount reason" required>
              <Input value={disc.reason} onChange={(e) => setDisc({ ...disc, reason: e.target.value })} placeholder="e.g. Senior citizen, staff, goodwill" />
            </FieldWrap>
          )}
          {gross > 0 && discount / gross > 0.1 && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">Discounts above the policy limit go to management for approval; the bill stays in Draft until approved.</p>}
          <FieldWrap label="Payer">
            <Select value={payer} onChange={(e) => setPayer(e.target.value)}>{['Self', 'Insurance', 'Corporate', 'Government Scheme'].map((x) => <option key={x}>{x}</option>)}</Select>
          </FieldWrap>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-brand-700" checked={applyDeposit} onChange={(e) => setApplyDeposit(e.target.checked)} /> Adjust available deposit ({money(a.totals.deposit_balance)})</label>
          <div className="flex justify-between border-t border-line pt-3 text-base font-semibold"><span>Net payable</span><span className="tabular-nums">{money(Math.max(0, gross - discount))}</span></div>
          <Button variant="primary" className="w-full" icon="FileCheck" disabled={!chosen.length} loading={bill.isPending} onClick={() => bill.mutate()}>Generate {invType} bill</Button>
        </div>
      </Card>
      <AddChargeModal open={addOpen} onClose={() => setAddOpen(false)} patientId={a.patient.id} encounterId={encounterId} />
    </div>
  )
}

function Bills({ a }: { a: Account }) {
  const qc = useQueryClient()
  const [pay, setPay] = useState<Rec | null>(null)
  const [refund, setRefund] = useState<Rec | null>(null)
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/billing/invoices/${id}/cancel`, { method: 'POST', body: { reason: prompt('Reason for cancelling this bill?') || '' } }),
    onSuccess: () => { toast.success('Bill cancelled; charges returned to the running bill'); qc.invalidateQueries({ queryKey: ['x', 'billing'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (!a.invoices.length) return <Empty icon="Receipt" title="No bills yet" />
  return (
    <Card pad={false}>
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
          <tr>{['Bill', 'Date', 'Type', 'Net', 'Paid', 'Balance', 'Status', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {a.invoices.map((i) => (
            <tr key={i.id} className="border-b border-line last:border-0">
              <td className="px-3 py-2 font-mono text-xs">{i.code}</td>
              <td className="px-3 py-2 text-xs text-ink-2">{dateTime(i.billed_at)}</td>
              <td className="px-3 py-2"><Badge tone="cyan">{i.type}</Badge></td>
              <td className="px-3 py-2 tabular-nums">{money(i.net)}{Number(i.discount) > 0 && <span className="ml-1 text-xs text-ink-3">(−{money(i.discount)})</span>}</td>
              <td className="px-3 py-2 tabular-nums">{money(i.paid)}</td>
              <td className="px-3 py-2 font-medium tabular-nums">{money(i.balance)}</td>
              <td className="px-3 py-2"><StatusBadge status={i.status} /></td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  {Number(i.balance) > 0 && ['Final', 'Partially Paid'].includes(i.status ?? '') && <Button size="xs" variant="primary" onClick={() => setPay(i)}>Collect</Button>}
                  {Number(i.paid) > 0 && <Button size="xs" onClick={() => setRefund(i)}>Refund</Button>}
                  <Button size="xs" icon="Printer" onClick={() => window.open(`/print/billing/invoices/${i.id}`, '_blank')} aria-label="Print bill" />
                  {Number(i.paid) === 0 && i.status !== 'Cancelled' && <Button size="xs" variant="ghost" className="text-red-600" onClick={() => cancel.mutate(i.id)}>Cancel</Button>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PaymentModal open={!!pay} onClose={() => setPay(null)} patientId={a.patient.id} invoice={pay} kind="PAYMENT" onDone={() => qc.invalidateQueries({ queryKey: ['x', 'billing'] })} />
      <RefundModal open={!!refund} onClose={() => setRefund(null)} patientId={a.patient.id} invoice={refund} />
    </Card>
  )
}

function Receipts({ a }: { a: Account }) {
  const [refund, setRefund] = useState(false)
  return (
    <Card pad={false} title="Receipts, deposits & refunds" actions={a.totals.deposit_balance > 0 && <Button size="sm" onClick={() => setRefund(true)}>Refund deposit</Button>}>
      {!a.payments.length ? <Empty icon="Wallet" title="No receipts yet" /> : (
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
            <tr>{['Receipt', 'Date', 'Kind', 'Mode', 'Amount', 'Bill', 'Reference', 'Status'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {a.payments.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2 font-mono text-xs">{p.code}</td>
                <td className="px-3 py-2 text-xs text-ink-2">{dateTime(p.paid_at)}</td>
                <td className="px-3 py-2"><Badge tone={p.kind === 'REFUND' ? 'red' : p.kind === 'DEPOSIT' ? 'violet' : 'green'}>{p.kind}</Badge></td>
                <td className="px-3 py-2">{p.mode}</td>
                <td className="px-3 py-2 tabular-nums">{p.kind === 'REFUND' ? '−' : ''}{money(p.amount)}</td>
                <td className="px-3 py-2 font-mono text-xs">{a.invoices.find((i) => i.id === p.invoice_id)?.code ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-ink-2">{p.reference}</td>
                <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RefundModal open={refund} onClose={() => setRefund(false)} patientId={a.patient.id} invoice={null} />
    </Card>
  )
}

function PaymentModal({ open, onClose, patientId, invoice, kind, onDone }: { open: boolean; onClose: () => void; patientId: string; invoice?: Rec | null; kind: 'PAYMENT' | 'DEPOSIT'; onDone: () => void }) {
  const [mode, setMode] = useState<string>('UPI')
  const [amount, setAmount] = useState('')
  const [ref, setRef] = useState('')
  useEffect(() => { if (open) { setAmount(invoice ? String(invoice.balance) : ''); setRef('') } }, [open, invoice])
  const m = useMutation({
    mutationFn: () => api<Rec>('/billing/payments', { method: 'POST', body: { patient_id: patientId, invoice_id: invoice?.id, kind, mode, amount: Number(amount), reference: ref || undefined } }),
    onSuccess: (r) => { toast.success(`Receipt ${r.code} · ${money(r.amount)}`); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} size="sm" title={kind === 'DEPOSIT' ? 'Collect deposit' : `Collect payment · ${invoice?.code ?? ''}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!Number(amount)} onClick={() => m.mutate()}>Collect {money(Number(amount || 0))}</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {MODES.filter((x) => kind === 'PAYMENT' || x !== 'INSURANCE').map((x) => (
            <button key={x} onClick={() => setMode(x)} className={`rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${mode === x ? 'bg-brand-700 text-white ring-brand-700' : 'ring-line-2 hover:bg-surface-2'}`}>{x}</button>
          ))}
        </div>
        <FieldWrap label="Amount (₹)"><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></FieldWrap>
        {mode !== 'CASH' && <FieldWrap label="Transaction / UTR / cheque reference" required><Input value={ref} onChange={(e) => setRef(e.target.value)} /></FieldWrap>}
      </div>
    </Modal>
  )
}

function RefundModal({ open, onClose, patientId, invoice }: { open: boolean; onClose: () => void; patientId: string; invoice: Rec | null }) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('CASH')
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: () => api<Rec & { approval?: Rec }>('/billing/refunds', { method: 'POST', body: { patient_id: patientId, invoice_id: invoice?.id, amount: Number(amount), mode, reason } }),
    onSuccess: (r) => {
      toast.success(r.approval ? `Refund ${r.code} sent for approval` : `Refund ${r.code} completed`)
      qc.invalidateQueries({ queryKey: ['x', 'billing'] }); onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} size="sm" title={invoice ? `Refund on ${invoice.code}` : 'Refund unused deposit'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={m.isPending} disabled={!Number(amount) || reason.length < 3} onClick={() => m.mutate()}>Refund</Button></>}>
      <div className="space-y-3">
        <FieldWrap label="Amount (₹)"><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></FieldWrap>
        <FieldWrap label="Mode"><Select value={mode} onChange={(e) => setMode(e.target.value)}>{['CASH', 'CARD', 'UPI', 'BANK', 'CHEQUE'].map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap>
        <FieldWrap label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></FieldWrap>
        <p className="text-xs text-ink-3">Refunds above the configured limit need management approval (Workflow Builder).</p>
      </div>
    </Modal>
  )
}

function AddChargeModal({ open, onClose, patientId, encounterId }: { open: boolean; onClose: () => void; patientId: string; encounterId: string }) {
  const qc = useQueryClient()
  const [svc, setSvc] = useState<Rec | null>(null)
  const [qty, setQty] = useState('1')
  const [rate, setRate] = useState('')
  const m = useMutation({
    mutationFn: () => api('/billing/charges', { method: 'POST', body: { patient_id: patientId, encounter_id: encounterId || undefined, service_id: svc?.id, qty: Number(qty), rate: rate ? Number(rate) : undefined } }),
    onSuccess: () => { toast.success('Charge added'); qc.invalidateQueries({ queryKey: ['x', 'billing'] }); onClose(); setSvc(null); setRate('') },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open={open} onClose={onClose} title="Add charge" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!svc} loading={m.isPending} onClick={() => m.mutate()}>Add</Button></>}>
      <div className="space-y-3">
        <FieldWrap label="Service (tariff)"><RefPicker refName="billing.services" value={svc?.id} filter={{ status: 'Active' }} onChange={(_, row) => { setSvc(row ?? null); setRate('') }} /></FieldWrap>
        <div className="grid grid-cols-2 gap-2">
          <FieldWrap label="Quantity"><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></FieldWrap>
          <FieldWrap label="Rate (₹)" help={svc ? `Tariff ${money(svc.rate)}` : undefined}><Input type="number" value={rate} placeholder={svc ? String(svc.rate) : ''} onChange={(e) => setRate(e.target.value)} /></FieldWrap>
        </div>
      </div>
    </Modal>
  )
}
