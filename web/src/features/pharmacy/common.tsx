import { Plus, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input, Select } from '@/components/ui'
import { dateTime, money } from '@/lib/format'
import { MODE_LABEL, MODES, NEEDS_REF, type PayMode } from './shell'

export interface BillLine {
  item: string; name: string; generic?: string | null; schedule?: string | null; uom?: string | null; batch?: string | null; expiry?: string | null
  unit?: string | null; pack_size?: number | null; qty: number; mrp?: number | null; discount_percent?: number | null; discount?: number | null
  gst_percent?: number | null; hsn?: string | null; taxable?: number | null; gst?: number | null; amount?: number | null; returned: number; returnable: number
}
export interface Bill {
  id: string; code: string; status: string; patient_id?: string | null; patient?: string | null; customer_name?: string | null; customer_phone?: string | null
  doctor_name?: string | null; prescription?: string | null; prescription_code?: string | null; sale_type: string; payer: string; credit_org?: string | null
  credit_org_name?: string | null; lines: BillLine[]; gross: number; discount: number; taxable: number; cgst: number; sgst: number; round_off: number
  net: number; paid: number; due: number; returned_amount?: number | null; refunded_amount?: number | null; return_status?: string | null
  payments?: { mode: string; amount: number; reference?: string | null }[]; gst_slabs?: { gst_percent: number; taxable: number; cgst: number; sgst: number }[]
  counter?: string | null; billed_at: string; billed_by?: string | null; cancel_reason?: string | null; age_days?: number | null; notes?: string | null
  receipts?: { id: string; code: string; kind: string; mode: string; amount: number; reference?: string | null; received_by?: string | null; received_at?: string | null }[]
  returns?: { id: string; code: string; status: string; reason: string; refund_amount?: number | null; adjusted_to_due?: number | null; requested_at?: string | null; requested_by?: string | null; approved_by?: string | null }[]
}

export interface PayLine { mode: PayMode; amount: string; reference: string }

export function PaymentLines({ lines, onChange, due, autoFocus }: { lines: PayLine[]; onChange: (l: PayLine[]) => void; due: number; autoFocus?: boolean }) {
  const paid = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const set = (i: number, patch: Partial<PayLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  return (
    <div className="space-y-1.5">
      {lines.map((l, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select value={l.mode} onChange={(e) => set(i, { mode: e.target.value as PayMode })} className="h-8 w-28" aria-label="Payment mode">
            {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </Select>
          <Input type="number" min={0} step="0.01" className="h-8 w-28 tabular" value={l.amount} autoFocus={autoFocus && i === 0} aria-label="Amount"
            onChange={(e) => set(i, { amount: e.target.value })} />
          {NEEDS_REF.has(l.mode) && <Input className="h-8 min-w-0 flex-1" value={l.reference} placeholder={l.mode === 'CARD' ? 'Last 4 / approval' : l.mode === 'UPI' ? 'UTR' : 'Reference'} aria-label="Reference" onChange={(e) => set(i, { reference: e.target.value })} />}
          {lines.length > 1 && <button type="button" aria-label="Remove payment" className="text-ink-3 hover:text-red-600" onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <Button size="xs" variant="ghost" onClick={() => onChange([...lines, { mode: 'UPI', amount: due - paid > 0 ? (due - paid).toFixed(2) : '', reference: '' }])}><Plus className="size-3.5" />Split payment</Button>
        <span className="text-xs text-ink-2">Paying {money(paid)}{due - paid > 0.009 ? ` · balance ${money(due - paid)}` : ''}</span>
      </div>
    </div>
  )
}

export const toPayments = (lines: PayLine[]) => lines.filter((l) => Number(l.amount) > 0).map((l) => ({ mode: l.mode, amount: Number(l.amount), reference: l.reference.trim() || undefined }))

// ================================================================== bill print (A5, GST invoice)

const CSS = `
.w7-bill { display: none; }
@media print {
  @page { size: A5; margin: 7mm; }
  body > *:not(.w7-bill) { display: none !important; }
  .w7-bill { display: block !important; color: #111; font: 8.5pt/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .w7-bill table { border-collapse: collapse; width: 100%; }
  .w7-bill th, .w7-bill td { text-align: left; padding: 1.5px 3px; vertical-align: top; }
  .w7-bill .r { text-align: right; }
}`

export function BillPrint({ bill, hospital, onDone }: { bill: Bill; hospital: string; onDone: () => void }) {
  useEffect(() => {
    const after = () => onDone()
    window.addEventListener('afterprint', after)
    const t = setTimeout(() => window.print(), 200)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after) }
  }, [onDone])
  const slabs = bill.gst_slabs ?? []
  return (
    <>
      <style>{CSS}</style>
      {createPortal(
        <div className="w7-bill">
          <div style={{ textAlign: 'center', borderBottom: '1px solid #333', paddingBottom: 4, marginBottom: 4 }}>
            <div style={{ fontSize: '12pt', fontWeight: 700 }}>{hospital}</div>
            <div>OP Pharmacy · Tax invoice{bill.counter ? ` · ${bill.counter}` : ''}</div>
          </div>
          <table style={{ marginBottom: 4 }}>
            <tbody>
              <tr><td>Bill no: <b>{bill.code}</b></td><td className="r">{dateTime(bill.billed_at)}</td></tr>
              <tr><td>Name: <b>{bill.patient ?? bill.customer_name}</b>{bill.customer_phone ? ` · ${bill.customer_phone}` : ''}</td><td className="r">{bill.sale_type}</td></tr>
              {(bill.doctor_name || bill.prescription_code) && <tr><td colSpan={2}>Prescriber: {bill.doctor_name ?? '—'}{bill.prescription_code ? ` · Rx ${bill.prescription_code}` : ''}</td></tr>}
              {bill.credit_org_name && <tr><td colSpan={2}>Credit: {bill.credit_org_name}</td></tr>}
            </tbody>
          </table>
          <table>
            <thead style={{ borderTop: '1px solid #333', borderBottom: '1px solid #333' }}>
              <tr><th>#</th><th>Item</th><th>HSN</th><th>Batch</th><th>Exp</th><th className="r">Qty</th><th className="r">MRP</th><th className="r">Disc</th><th className="r">GST%</th><th className="r">Amount</th></tr>
            </thead>
            <tbody>
              {bill.lines.map((l, i) => (
                <tr key={i} style={{ borderBottom: '1px dotted #bbb' }}>
                  <td>{i + 1}</td><td>{l.name}{l.schedule && l.schedule !== 'None' ? ` [${l.schedule}]` : ''}</td><td>{l.hsn ?? ''}</td><td>{l.batch ?? ''}</td>
                  <td>{l.expiry ? l.expiry.slice(5, 7) + '/' + l.expiry.slice(2, 4) : ''}</td><td className="r">{l.qty}</td><td className="r">{Number(l.mrp ?? 0).toFixed(2)}</td>
                  <td className="r">{Number(l.discount ?? 0).toFixed(2)}</td><td className="r">{l.gst_percent ?? ''}</td><td className="r">{Number(l.amount ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table style={{ marginTop: 4 }}>
            <tbody>
              <tr>
                <td style={{ width: '55%' }}>
                  <table><thead><tr><th>GST%</th><th className="r">Taxable</th><th className="r">CGST</th><th className="r">SGST</th></tr></thead>
                    <tbody>{slabs.map((s) => <tr key={s.gst_percent}><td>{s.gst_percent}%</td><td className="r">{s.taxable.toFixed(2)}</td><td className="r">{s.cgst.toFixed(2)}</td><td className="r">{s.sgst.toFixed(2)}</td></tr>)}</tbody>
                  </table>
                </td>
                <td>
                  <table><tbody>
                    <tr><td>Gross (MRP)</td><td className="r">{bill.gross.toFixed(2)}</td></tr>
                    <tr><td>Discount</td><td className="r">-{bill.discount.toFixed(2)}</td></tr>
                    <tr><td>Round off</td><td className="r">{bill.round_off.toFixed(2)}</td></tr>
                    <tr style={{ fontWeight: 700, fontSize: '10pt' }}><td>Net payable</td><td className="r">₹{bill.net.toFixed(2)}</td></tr>
                    <tr><td>Paid</td><td className="r">{bill.paid.toFixed(2)}</td></tr>
                    {bill.due > 0 && <tr style={{ fontWeight: 700 }}><td>{bill.credit_org_name ? `Due from ${bill.credit_org_name}` : 'Balance due'}</td><td className="r">{bill.due.toFixed(2)}</td></tr>}
                  </tbody></table>
                </td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 4 }}>{(bill.payments ?? []).map((p) => `${MODE_LABEL[p.mode] ?? p.mode} ₹${p.amount.toFixed(2)}${p.reference ? ` (${p.reference})` : ''}`).join(' · ')}</div>
          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between' }}><span>Billed by {bill.billed_by}</span><span>Pharmacist</span></div>
          <div style={{ marginTop: 6, borderTop: '1px solid #ccc', paddingTop: 3, fontSize: '7pt', color: '#555' }}>
            Prices include GST. Medicines are taken back within 30 days with this bill, sealed strips only; cold-chain items are not returnable. Get well soon.
          </div>
        </div>, document.body)}
    </>
  )
}
