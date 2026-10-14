import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useParams } from 'react-router'
import { ErrorBox, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, money } from '@/lib/format'
import type { Bill } from './api'

/** Printable OP bill / receipt (A5-friendly). */
export default function BillPrint() {
  const { id } = useParams()
  const q = useQuery({ queryKey: ['x', 'billing', 'op-bill-print', id], queryFn: () => api<Bill & { hospital: { name: string } }>(`/opbilling/bills/${id}/print`) })
  useEffect(() => { if (q.data) window.setTimeout(() => window.print(), 300) }, [q.data])
  if (q.isLoading) return <Spinner />
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} /></div>
  const b = q.data!
  const p = b.patient
  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-[13px] text-black">
      <div className="flex items-start justify-between border-b-2 border-black pb-2">
        <div><div className="text-lg font-bold">{b.hospital.name}</div><div>OP Bill / Receipt</div></div>
        <div className="text-right"><div className="font-mono font-bold">{b.code}</div><div>{dateTime(b.billed_at ?? b.created_at)}</div><div className="font-semibold">{b.label.status}{b.label.sub ? ` · ${b.label.sub}` : ''}</div></div>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 py-3">
        <div><b>Patient:</b> {p.name}</div><div><b>UHID:</b> {p.uhid}</div>
        <div><b>Age / sex:</b> {[p.age != null ? `${p.age}y` : null, p.gender].filter(Boolean).join(' / ')}</div><div><b>Mobile:</b> {p.phone}</div>
        <div><b>Payer:</b> {b.payer ?? 'Self'}{b.state.sponsor_name ? ` — ${b.state.sponsor_name}` : ''}</div><div><b>Doctor:</b> {b.visit?.doctor ?? '—'}</div>
      </div>
      <table className="w-full border-collapse">
        <thead><tr className="border-y border-black">{['#', 'Service', 'Qty', 'Rate', 'Discount', 'Amount'].map((h) => <th key={h} className="px-1 py-1 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {(b.charges ?? []).map((c, i) => (
            <tr key={c.id} className="border-b border-gray-300"><td className="px-1 py-1">{i + 1}</td><td className="px-1 py-1">{c.description}{c.consultant_name ? ` (${c.consultant_name})` : ''}</td>
              <td className="px-1 py-1">{c.qty}</td><td className="px-1 py-1">{money(c.rate)}</td><td className="px-1 py-1">{c.discount ? money(c.discount) : '—'}</td><td className="px-1 py-1 text-right">{money(c.line_net ?? c.amount - (c.discount || 0))}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="ml-auto mt-3 w-72 space-y-0.5">
        {[['Gross', b.gross], ['Discount', b.discount], ['Tax', b.tax], ['Net', b.net], ['Sponsor share', b.totals.sponsor_amount], ['Patient share', b.totals.patient_payable], ['Paid', b.paid], ['Patient due', b.patient_due ?? 0]].map(([l, v]) => (
          <div key={String(l)} className="flex justify-between"><span>{l}</span><span className="tabular">{money(v)}</span></div>
        ))}
      </div>
      {!!b.payments?.length && <div className="mt-3"><b>Receipts:</b> {b.payments.map((x) => `${x.code} ${x.kind === 'REFUND' ? 'refund ' : ''}${x.mode} ${money(x.amount)}${x.reference ? ` (${x.reference})` : ''}`).join(' · ')}</div>}
      {b.state.discount_remarks && <div className="mt-1"><b>Discount reason:</b> {b.state.discount_remarks}</div>}
      <div className="mt-10 flex justify-between text-xs"><span>Healthcare services are exempt from GST unless stated.</span><span>Authorised signatory</span></div>
    </div>
  )
}
