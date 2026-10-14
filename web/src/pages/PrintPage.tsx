import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useParams } from 'react-router'
import { FieldValue } from '@/components/fields'
import { Button, ErrorBox, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useMeta, useRegistry } from '@/lib/auth'
import { age, date, dateTime, money } from '@/lib/format'
import type { Rec } from '@/lib/types'

/** Printable A4 / card layouts. Opened in a new tab; prints automatically once data is loaded. */
export default function PrintPage() {
  const { module = '', entity = '', id = '' } = useParams()
  const meta = useMeta()
  const ready = !!meta.data
  if (!ready) return <Spinner />
  if (module === 'billing' && entity === 'invoices') return <BillPrint id={id} />
  if (module === 'registration' && entity === 'patients') return <UhidCard id={id} />
  return <GenericPrint module={module} entity={entity} id={id} />
}

function useAutoPrint(ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => window.print(), 400)
    return () => clearTimeout(t)
  }, [ready])
}

function Sheet({ children }: { children: React.ReactNode }) {
  const meta = useMeta()
  return (
    <div className="min-h-full bg-slate-100 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] justify-end gap-2">
        <Button size="sm" icon="Printer" onClick={() => window.print()}>Print</Button>
        <Button size="sm" variant="ghost" onClick={() => window.close()}>Close</Button>
      </div>
      <article className="print-area mx-auto max-w-[210mm] bg-white p-10 text-[13px] text-slate-900 shadow-lg">
        <header className="mb-6 flex items-center justify-between border-b-2 border-slate-800 pb-3">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" className="size-10" alt="" />
            <div>
              <div className="text-lg font-bold">{meta.data?.hospital.name}</div>
              <div className="text-xs text-slate-600">Guntur, Andhra Pradesh · NABH accredited · 24×7 Emergency</div>
            </div>
          </div>
          <div className="text-right text-xs text-slate-600">Printed {dateTime(new Date().toISOString())}<br />by {meta.data?.user.name}</div>
        </header>
        {children}
        <footer className="mt-10 border-t border-slate-300 pt-2 text-[10px] text-slate-500">Computer-generated document from Vlack HRMS. Every print is recorded in the audit trail.</footer>
      </article>
    </div>
  )
}

function GenericPrint({ module, entity, id }: { module: string; entity: string; id: string }) {
  const reg = useRegistry()
  const ent = reg.entity(`${module}.${entity}`)
  const q = useQuery({ queryKey: ['m', module, entity, 'one', id], queryFn: () => api<Rec>(`/m/${module}/${entity}/${id}`), enabled: !!ent })
  useAutoPrint(!!q.data)
  if (!ent) return <ErrorBox error="Unknown record type" />
  if (q.error) return <ErrorBox error={q.error} />
  if (!q.data) return <Spinner />
  const r = q.data
  return (
    <Sheet>
      <h1 className="text-xl font-bold">{ent.singular} {r.code}</h1>
      <p className="mb-4 text-sm text-slate-600">{r.title} · Status: {r.status ?? '—'} · {reg.module(module)?.name}</p>
      {r.patient_id && <p className="mb-4 rounded border border-slate-300 px-3 py-2">Patient: <b>{r._refs?.[r.patient_id]}</b></p>}
      <table className="w-full border-collapse">
        <tbody>
          {ent.fields.filter((f) => !f.hidden && f.key !== 'patient_id' && r[f.key] !== null && r[f.key] !== undefined && r[f.key] !== '').map((f) => (
            <tr key={f.key} className="border-b border-slate-200 align-top">
              <th className="w-1/3 py-1.5 pr-4 text-left font-medium text-slate-600">{f.label}</th>
              <td className="py-1.5">{FieldValue({ field: f, value: r[f.key], refs: r._refs })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-16 flex justify-between text-xs text-slate-600"><span>Prepared by</span><span>Authorised signatory</span></div>
    </Sheet>
  )
}

function UhidCard({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['m', 'registration', 'patients', 'one', id], queryFn: () => api<Rec>(`/m/registration/patients/${id}`) })
  const meta = useMeta()
  useAutoPrint(!!q.data)
  if (!q.data) return <Spinner />
  const p = q.data
  return (
    <div className="grid min-h-full place-items-center bg-slate-100 p-6 print:bg-white">
      <div className="w-[86mm] rounded-xl border border-slate-300 bg-white p-4 text-slate-900 shadow print:shadow-none">
        <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
          <img src="/favicon.svg" className="size-7" alt="" />
          <div className="text-xs font-bold leading-tight">{meta.data?.hospital.name}<div className="font-normal text-slate-500">Patient identity card</div></div>
        </div>
        <div className="mt-3 text-base font-semibold">{p.title}</div>
        <div className="text-xs text-slate-600">{[age(p.dob), p.gender, p.blood_group && `Blood ${p.blood_group}`].filter(Boolean).join(' · ')}</div>
        <div className="mt-3 rounded-md bg-slate-900 px-3 py-2 text-center font-mono text-xl font-bold tracking-[0.2em] text-white">{p.code}</div>
        <div className="mt-2 flex justify-between text-[10px] text-slate-500"><span>Mobile {p.phone}</span><span>Since {date(p.created_at)}</span></div>
        {p.abha_id && <div className="text-[10px] text-slate-500">ABHA {p.abha_id}</div>}
        <div className="mt-2 text-[9px] text-slate-400">Carry this card on every visit. Emergency: 108</div>
      </div>
    </div>
  )
}

interface BillData { invoice: Rec; lines: Rec[]; payments: Rec[]; patient: Rec; hospital: string }

function BillPrint({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['x', 'billing', 'print', id], queryFn: () => api<BillData>(`/billing/invoices/${id}/print`) })
  useAutoPrint(!!q.data)
  if (q.error) return <ErrorBox error={q.error} />
  if (!q.data) return <Spinner />
  const { invoice: i, lines, payments, patient: p } = q.data
  return (
    <Sheet>
      <div className="mb-4 flex justify-between">
        <div>
          <h1 className="text-xl font-bold">{i.status === 'Draft' ? 'PROVISIONAL BILL' : `${i.type} BILL / TAX INVOICE`}</h1>
          <div className="text-sm">Bill no. <b className="font-mono">{i.code}</b> · {dateTime(i.billed_at)}</div>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold">{p.title}</div>
          <div>UHID <span className="font-mono">{p.code}</span> · {[age(p.dob), p.gender].filter(Boolean).join(' / ')}</div>
          <div>{p.phone} · Payer: {i.payer}</div>
        </div>
      </div>
      <table className="w-full border-collapse text-[12px]">
        <thead><tr className="border-y border-slate-800 bg-slate-50">{['#', 'Date', 'Particulars', 'Qty', 'Rate', 'Amount'].map((h) => <th key={h} className="px-2 py-1.5 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {lines.map((l, n) => (
            <tr key={l.id} className="border-b border-slate-200">
              <td className="px-2 py-1">{n + 1}</td><td className="px-2 py-1">{date(l.charged_at)}</td><td className="px-2 py-1">{l.description}</td>
              <td className="px-2 py-1 text-right">{l.qty}</td><td className="px-2 py-1 text-right">{money(l.rate)}</td><td className="px-2 py-1 text-right">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ml-auto mt-4 w-72 space-y-1 text-sm">
        {[['Gross', i.gross], ['GST', i.tax], ['Discount', -Number(i.discount || 0)], ['Net payable', i.net], ['Paid', i.paid], ['Balance', i.balance]].map(([l, v]) => (
          <div key={l as string} className={`flex justify-between ${l === 'Net payable' || l === 'Balance' ? 'border-t border-slate-300 pt-1 font-bold' : ''}`}><span>{l}</span><span>{money(v)}</span></div>
        ))}
      </div>
      {payments.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-1 font-semibold">Receipts</h2>
          {payments.map((r) => <div key={r.id} className="text-xs">{r.code} · {dateTime(r.paid_at)} · {r.kind} · {r.mode} · {money(r.amount)} {r.reference ? `· ${r.reference}` : ''}</div>)}
        </div>
      )}
      {i.discount_reason && <p className="mt-4 text-xs text-slate-600">Discount: {i.discount_reason}</p>}
      <div className="mt-16 flex justify-between text-xs text-slate-600"><span>Patient / attendant signature</span><span>Authorised signatory (Billing)</span></div>
    </Sheet>
  )
}
