import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, Card, Drawer, Empty, ErrorBox, FieldWrap, Input, Modal, Select, Spinner, StatusBadge, Tabs, Textarea } from '@/components/ui'
import { useDebounced } from '@/components/fields'
import { api, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { dateTime, money, todayISO } from '@/lib/format'
import { BillPrint, PaymentLines, toPayments, type Bill, type PayLine } from './common'
import { MODE_LABEL, PharmShell, usePharmAccess } from './shell'

interface Row { id: string; code: string; status: string; customer_name?: string | null; customer_phone?: string | null; patient?: string | null; sale_type: string
  payer: string; credit_org?: string | null; gross: number; discount: number; taxable: number; cgst: number; sgst: number; net: number; paid: number; due: number
  returned_amount?: number | null; billed_at: string; billed_by?: string | null; items: number; doctor_name?: string | null }
interface Res { rows: Row[]; totals: Record<string, number>; by_day: { date: string; bills: number; net: number; paid: number; due: number }[]; users: string[] }
type Tab = 'Paid,Due' | 'Due' | 'Draft' | 'Cancelled'

export default function BillsReport() {
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>((params.get('status') as Tab) || 'Paid,Due')
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [saleType, setSaleType] = useState('')
  const [user, setUser] = useState('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [openId, setOpenId] = useState<string | null>(params.get('bill'))
  const list = useQuery({
    queryKey: ['x', 'pharmacy', 'bills', tab, from, to, saleType, user, dq],
    queryFn: () => api<Res>('/op-pharmacy/bills', { query: { status: tab, date_from: from, date_to: to, sale_type: saleType || undefined, user: user || undefined, q: dq || undefined } }),
    placeholderData: (p) => p,
  })
  const t = list.data?.totals
  return (
    <PharmShell screen="bills" icon="ReceiptText" title="Bills report" subtitle="Counter bills with GST, discounts, payments, dues and returns; parked drafts and cancelled bills.">
      <Tabs className="mb-3" value={tab} onChange={(k) => { setTab(k); setParams({ status: k }, { replace: true }) }} tabs={[
        { key: 'Paid,Due', label: 'Bills' }, { key: 'Due', label: 'With balance due' }, { key: 'Draft', label: 'Draft bills' }, { key: 'Cancelled', label: 'Cancelled' },
      ]} />
      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-2.5">
        {tab !== 'Draft' && <>
          <FieldWrap label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" /></FieldWrap>
          <FieldWrap label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" /></FieldWrap>
        </>}
        <FieldWrap label="Sale type"><Select value={saleType} onChange={(e) => setSaleType(e.target.value)} className="w-40"><option value="">All</option><option>Walk-in (OTC)</option><option>Prescription</option><option>Credit</option></Select></FieldWrap>
        <FieldWrap label="Billed by"><Select value={user} onChange={(e) => setUser(e.target.value)} className="w-44"><option value="">Everyone</option>{list.data?.users.map((u) => <option key={u}>{u}</option>)}</Select></FieldWrap>
        <FieldWrap label="Search" className="min-w-52 flex-1"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" /><Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" placeholder="Bill no / customer / mobile" /></div></FieldWrap>
      </div>
      {t && tab !== 'Draft' && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          {([['Bills', t.bills, false], ['Gross', t.gross, true], ['Discount', t.discount, true], ['Taxable', t.taxable, true], ['CGST + SGST', (t.cgst ?? 0) + (t.sgst ?? 0), true], ['Net', t.net, true], ['Due', t.due, true], ['Returned', t.returned_amount, true]] as const).map(([k, v, m]) => (
            <div key={k} className="rounded-xl border border-line bg-surface px-3 py-2"><div className="text-[11px] text-ink-3">{k}</div><div className="font-semibold tabular text-ink">{m ? money(v) : v}</div></div>
          ))}
        </div>
      )}
      <Card pad={false}>
        {list.isLoading && <Spinner />}
        {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
        {list.data && list.data.rows.length === 0 && <Empty icon="ReceiptText" title="No bills" />}
        {list.data && list.data.rows.length > 0 && (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['Bill', 'Date', 'Customer', 'Type', 'Items', 'Net', 'Paid', 'Due', 'By', 'Status'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
              <tbody>{list.data.rows.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className="cursor-pointer border-t border-line hover:bg-surface-2">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.code}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{dateTime(r.billed_at)}</td>
                  <td className="max-w-52 px-3 py-2"><div className="truncate text-ink">{r.patient ?? r.customer_name}</div><div className="text-xs text-ink-3">{r.customer_phone}</div></td>
                  <td className="px-3 py-2 text-xs text-ink-2">{r.sale_type}{r.credit_org && <div>{r.credit_org}</div>}</td>
                  <td className="px-3 py-2 tabular text-ink-2">{r.items}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular font-medium text-ink">{money(r.net)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular text-ink-2">{money(r.paid)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular">{r.due > 0 ? <span className="font-medium text-amber-700 dark:text-amber-300">{money(r.due)}</span> : '—'}</td>
                  <td className="px-3 py-2 text-xs text-ink-2">{r.billed_by}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status} />{r.returned_amount ? <div className="text-[11px] text-ink-3">returned {money(r.returned_amount)}</div> : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {openId && <BillDrawer id={openId} onClose={() => setOpenId(null)} />}
    </PharmShell>
  )
}

export function BillDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const acc = usePharmAccess()
  const meta = useMeta()
  const nav = useNavigate()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['x', 'pharmacy', 'bill', id], queryFn: () => api<Bill>(`/op-pharmacy/bills/${id}`) })
  const [mode, setMode] = useState<'collect' | 'cancel' | 'return' | null>(null)
  const [printing, setPrinting] = useState(false)
  const b = q.data
  const refresh = () => { qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] }) }
  const discard = useMutation({
    mutationFn: () => api(`/op-pharmacy/bills/${id}/discard`, { method: 'POST' }),
    onSuccess: () => { toast.success('Draft discarded'); refresh(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const today = b && b.billed_at.slice(0, 10) === todayISO()
  return (
    <Drawer open onClose={onClose} width="max-w-3xl" title={b ? <span className="flex items-center gap-2">Bill {b.code} <StatusBadge status={b.status} />{b.return_status && <Badge tone="violet">{b.return_status}</Badge>}</span> : 'Bill'}
      subtitle={b && `${b.patient ?? b.customer_name} · ${b.sale_type} · ${dateTime(b.billed_at)} · ${b.billed_by ?? ''}`}
      footer={b && (
        <>
          {b.status !== 'Draft' && b.status !== 'Cancelled' && <Button size="sm" icon="Printer" onClick={() => setPrinting(true)}>Print</Button>}
          {acc.sell && b.status === 'Draft' && <>
            <Button size="sm" variant="ghost" className="text-red-700" loading={discard.isPending} onClick={() => discard.mutate()}>Discard draft</Button>
            <Button size="sm" variant="primary" onClick={() => nav(`/pharmacy/counter?draft=${b.id}`)}>Resume at counter</Button>
          </>}
          {acc.sell && b.status === 'Due' && <Button size="sm" variant="primary" onClick={() => setMode('collect')}>Collect due</Button>}
          {acc.sell && ['Paid', 'Due'].includes(b.status) && b.lines.some((l) => l.returnable > 0) && <Button size="sm" onClick={() => setMode('return')}>Return items</Button>}
          {acc.sell && today && ['Paid', 'Due'].includes(b.status) && !b.returns?.length && <Button size="sm" variant="danger" onClick={() => setMode('cancel')}>Cancel bill</Button>}
        </>
      )}>
      {q.isLoading && <Spinner />}
      {q.error && <div className="p-5"><ErrorBox error={q.error} /></div>}
      {b && (
        <div className="space-y-4 p-5">
          <div className="grid gap-2 text-sm sm:grid-cols-4">
            {([['Net', b.net], ['Paid', b.paid], ['Due', b.due], ['Returned', b.returned_amount ?? 0]] as const).map(([k, v]) => (
              <div key={k} className="rounded-lg bg-surface-2 px-3 py-2"><div className="text-[11px] text-ink-3">{k}</div><div className="font-semibold tabular text-ink">{money(v)}</div></div>
            ))}
          </div>
          {b.credit_org_name && <p className="text-sm text-ink-2">Credit organisation: <b>{b.credit_org_name}</b></p>}
          {b.doctor_name && <p className="text-sm text-ink-2">Prescriber: {b.doctor_name}{b.prescription_code && ` · ${b.prescription_code}`}</p>}
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-3"><tr>{['Item', 'Batch / exp', 'Qty', 'MRP', 'Disc', 'GST', 'Amount', 'Returned'].map((h) => <th key={h} className="py-1 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody>{b.lines.map((l, i) => (
              <tr key={i} className="border-t border-line">
                <td className="py-1.5 text-ink">{l.name}<div className="text-[11px] text-ink-3">{l.generic}</div></td>
                <td className="py-1.5 text-xs text-ink-2">{l.batch}<div>{l.expiry}</div></td>
                <td className="py-1.5 tabular">{l.qty}</td><td className="py-1.5 tabular">{money(l.mrp)}</td>
                <td className="py-1.5 tabular text-ink-2">{l.discount_percent ? `${l.discount_percent}%` : '—'}</td><td className="py-1.5 text-xs text-ink-2">{l.gst_percent}%</td>
                <td className="py-1.5 tabular font-medium">{money(l.amount)}</td><td className="py-1.5 tabular text-ink-2">{l.returned || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          {!!b.receipts?.length && (
            <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Receipts & refunds</h4>
              <ul className="space-y-0.5 text-sm">{b.receipts.map((r) => <li key={r.id} className="flex justify-between gap-2"><span className="text-ink-2">{dateTime(r.received_at)} · {r.kind} · {MODE_LABEL[r.mode] ?? r.mode}{r.reference ? ` · ${r.reference}` : ''} · {r.received_by}</span><span className={r.amount < 0 ? 'tabular text-red-700 dark:text-red-300' : 'tabular text-ink'}>{money(r.amount)}</span></li>)}</ul>
            </div>
          )}
          {!!b.returns?.length && (
            <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Returns</h4>
              <ul className="space-y-0.5 text-sm">{b.returns.map((r) => <li key={r.id} className="flex justify-between gap-2"><span className="text-ink-2">{r.code} · {r.reason} · {r.requested_by}</span><span><StatusBadge status={r.status} /> <span className="tabular">{money(r.refund_amount)}</span></span></li>)}</ul>
            </div>
          )}
          {b.cancel_reason && <p className="text-sm text-red-700 dark:text-red-300">Cancelled: {b.cancel_reason}</p>}
        </div>
      )}
      {b && mode === 'collect' && <CollectDialog b={b} onClose={() => setMode(null)} onDone={refresh} />}
      {b && mode === 'cancel' && <CancelDialog b={b} onClose={() => setMode(null)} onDone={() => { refresh(); onClose() }} />}
      {b && mode === 'return' && <ReturnDialog b={b} onClose={() => setMode(null)} onDone={refresh} />}
      {b && printing && <BillPrint bill={b} hospital={meta.data?.hospital.name ?? ''} onDone={() => setPrinting(false)} />}
    </Drawer>
  )
}

function CollectDialog({ b, onClose, onDone }: { b: Bill; onClose: () => void; onDone: () => void }) {
  const [pays, setPays] = useState<PayLine[]>([{ mode: 'CASH', amount: b.due.toFixed(2), reference: '' }])
  const m = useMutation({
    mutationFn: () => api(`/op-pharmacy/bills/${b.id}/collect`, { method: 'POST', body: { payments: toPayments(pays) } }),
    onSuccess: () => { toast.success('Due collected'); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} size="sm" title={`Collect due · ${b.code}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Collect</Button></>}>
      <p className="mb-3 text-sm text-ink-2">Balance due {money(b.due)}{b.credit_org_name ? ` from ${b.credit_org_name}` : ''}.</p>
      <PaymentLines lines={pays} onChange={setPays} due={b.due} autoFocus />
    </Modal>
  )
}

function CancelDialog({ b, onClose, onDone }: { b: Bill; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: () => api<{ refunded: number }>(`/op-pharmacy/bills/${b.id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: (r) => { toast.success(`Bill cancelled — stock restored, refund ${money(r.refunded)}`); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} size="sm" title={`Cancel bill ${b.code}`} footer={<><Button variant="ghost" onClick={onClose}>Keep</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={m.isPending} onClick={() => m.mutate()}>Cancel bill & refund</Button></>}>
      <p className="mb-3 text-sm text-ink-2">Every batch goes back to stock and {money(b.paid)} is refunded in the modes it was paid. Audited.</p>
      <FieldWrap label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></FieldWrap>
    </Modal>
  )
}

const REASONS = ['Doctor changed the prescription', 'Excess purchased', 'Adverse drug reaction', 'Wrong item billed', 'Patient expired', 'Other']

export function ReturnDialog({ b, onClose, onDone }: { b: Bill; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<number, string>>({})
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState('CASH')
  const items = b.lines.map((l, i) => ({ l, i, q: Number(qty[i] || 0) })).filter((x) => x.q > 0)
  const value = items.reduce((s, x) => s + (Number(x.l.amount) / x.l.qty) * x.q, 0)
  const m = useMutation({
    mutationFn: () => api('/op-pharmacy/returns', { method: 'POST', body: { bill_id: b.id, reason, refund_mode: mode, items: items.map((x) => ({ item_id: x.l.item, batch: x.l.batch, qty: x.q })) } }),
    onSuccess: () => { toast.success('Return requested — approve it in Returns to restock and refund'); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const bad = items.some((x) => x.q > x.l.returnable)
  return (
    <Modal open onClose={onClose} size="lg" title={`Return against ${b.code}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!items.length || !reason || bad} loading={m.isPending} onClick={() => m.mutate()}>Request return · {money(value)}</Button></>}>
      <table className="mb-3 w-full text-sm">
        <thead className="text-xs text-ink-3"><tr><th className="text-left">Item</th><th className="text-left">Batch</th><th className="text-right">Sold</th><th className="text-right">Returnable</th><th className="text-right">Return qty</th></tr></thead>
        <tbody>{b.lines.map((l, i) => (
          <tr key={i} className="border-t border-line">
            <td className="py-1 text-ink">{l.name}</td><td className="text-xs text-ink-2">{l.batch}</td><td className="text-right tabular">{l.qty}</td><td className="text-right tabular">{l.returnable}</td>
            <td className="py-1 text-right"><Input type="number" min={0} max={l.returnable} disabled={l.returnable <= 0} className="ml-auto h-8 w-20 tabular" value={qty[i] ?? ''} onChange={(e) => setQty({ ...qty, [i]: e.target.value })} aria-label={`Return ${l.name}`} invalid={Number(qty[i] || 0) > l.returnable} /></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldWrap label="Reason" required><Select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose…</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</Select></FieldWrap>
        <FieldWrap label="Refund mode" help={b.due > 0 ? `The ${money(b.due)} due is adjusted first` : undefined}><Select value={mode} onChange={(e) => setMode(e.target.value)}>{Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></FieldWrap>
      </div>
      <p className="mt-2 text-xs text-ink-3">Refund at the price charged (after discount). Expired batches cannot be taken back into stock. <Link to="/pharmacy/returns" className="text-brand-700 hover:underline dark:text-brand-300">Return approvals →</Link></p>
    </Modal>
  )
}
