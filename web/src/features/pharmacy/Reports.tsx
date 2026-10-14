import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Badge, Card, Empty, ErrorBox, FieldWrap, Input, Segmented, Spinner } from '@/components/ui'
import { useDebounced } from '@/components/fields'
import { api } from '@/lib/api'
import { dateTime, money, todayISO } from '@/lib/format'
import { BillDrawer } from './Bills'
import { MODE_LABEL, PharmShell } from './shell'

interface Dues {
  rows: { id: string; code: string; customer_name?: string | null; customer_phone?: string | null; patient?: string | null; net: number; paid: number; due: number
    billed_at: string; billed_by?: string | null; credit_org?: string | null; age_days: number; bucket: string; overdue: boolean }[]
  total: number; count: number; buckets: { bucket: string; due: number }[]; by_payer: { payer: string; bills: number; due: number }[]
}

export function DueBills() {
  const [payer, setPayer] = useState<'all' | 'self' | 'credit'>('all')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [openId, setOpenId] = useState<string | null>(null)
  const list = useQuery({ queryKey: ['x', 'pharmacy', 'dues', payer, dq], queryFn: () => api<Dues>('/op-pharmacy/reports/dues', { query: { payer, q: dq || undefined } }), placeholderData: (p) => p })
  const d = list.data
  return (
    <PharmShell screen="dues" icon="HandCoins" title="Due bills" subtitle="Pharmacy bills with a balance — patients' dues and credit organisations' receivables — with ageing. Open a bill to collect.">
      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-2.5">
        <FieldWrap label="Payer"><Segmented value={payer} onChange={setPayer} options={[{ key: 'all', label: 'All' }, { key: 'self', label: 'Patients' }, { key: 'credit', label: 'Credit organisations' }]} /></FieldWrap>
        <FieldWrap label="Search" className="min-w-56 flex-1"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" /><Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" placeholder="Bill no / customer / mobile" /></div></FieldWrap>
      </div>
      {list.isLoading && <Spinner />}
      {list.error && <ErrorBox error={list.error} />}
      {d && (
        <>
          <div className="mb-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card title={`Ageing · ${money(d.total)} on ${d.count} bills`}>
              <div className="grid grid-cols-4 gap-2">{d.buckets.map((b) => (
                <div key={b.bucket} className="rounded-lg bg-surface-2 px-3 py-2"><div className="text-[11px] text-ink-3">{b.bucket} days</div><div className="font-semibold tabular text-ink">{money(b.due, true)}</div></div>
              ))}</div>
            </Card>
            <Card title="By payer" pad={false}>
              <ul className="divide-y divide-line">{d.by_payer.map((p) => <li key={p.payer} className="flex justify-between px-3 py-1.5 text-sm"><span className="text-ink">{p.payer} <span className="text-xs text-ink-3">· {p.bills} bills</span></span><span className="tabular font-medium">{money(p.due)}</span></li>)}</ul>
            </Card>
          </div>
          <Card pad={false}>
            {d.rows.length === 0 ? <Empty icon="CircleCheck" title="No dues" /> : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-xs text-ink-2"><tr>{['Bill', 'Date', 'Customer', 'Payer', 'Net', 'Paid', 'Due', 'Age'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
                  <tbody>{d.rows.map((r) => (
                    <tr key={r.id} onClick={() => setOpenId(r.id)} className="cursor-pointer border-t border-line hover:bg-surface-2">
                      <td className="px-3 py-2 font-mono text-xs">{r.code}</td><td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{dateTime(r.billed_at)}</td>
                      <td className="px-3 py-2 text-ink">{r.patient ?? r.customer_name}<div className="text-xs text-ink-3">{r.customer_phone}</div></td>
                      <td className="px-3 py-2 text-xs text-ink-2">{r.credit_org ?? 'Self'}</td>
                      <td className="px-3 py-2 tabular">{money(r.net)}</td><td className="px-3 py-2 tabular text-ink-2">{money(r.paid)}</td>
                      <td className="px-3 py-2 tabular font-semibold text-amber-700 dark:text-amber-300">{money(r.due)}</td>
                      <td className="px-3 py-2">{r.overdue ? <Badge tone="red">{r.age_days} d · past terms</Badge> : <span className="text-xs text-ink-2">{r.age_days} d</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      {openId && <BillDrawer id={openId} onClose={() => setOpenId(null)} />}
    </PharmShell>
  )
}

interface Coll { rows: { user: string; by_mode: Record<string, number>; sales: number; due_collections: number; refunds: number; net: number; receipts: number; bills: number }[]
  modes: string[]; totals: { sales: number; due_collections: number; refunds: number; net: number }; by_mode: Record<string, number> }

export function UserCollections() {
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const q = useQuery({ queryKey: ['x', 'pharmacy', 'collections', from, to], queryFn: () => api<Coll>('/op-pharmacy/reports/collections', { query: { date_from: from, date_to: to } }), placeholderData: (p) => p })
  const d = q.data
  return (
    <PharmShell screen="collections" icon="Wallet" title="User collection report" subtitle="What each user collected at the pharmacy counter, by payment mode: sales, due collections and refunds.">
      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-2.5">
        <FieldWrap label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" /></FieldWrap>
        <FieldWrap label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" /></FieldWrap>
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {d && (
        <Card pad={false}>
          {d.rows.length === 0 ? <Empty icon="Wallet" title="No collections in this period" /> : (
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-ink-2"><tr>
                  <th className="px-3 py-2 text-left font-medium">User</th><th className="px-3 py-2 text-right font-medium">Bills</th>
                  {d.modes.map((m) => <th key={m} className="px-3 py-2 text-right font-medium">{MODE_LABEL[m] ?? m}</th>)}
                  <th className="px-3 py-2 text-right font-medium">Sales</th><th className="px-3 py-2 text-right font-medium">Due collected</th><th className="px-3 py-2 text-right font-medium">Refunds</th><th className="px-3 py-2 text-right font-medium">Net</th>
                </tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.user} className="border-t border-line">
                      <td className="px-3 py-2 text-ink">{r.user}</td><td className="px-3 py-2 text-right tabular">{r.bills}</td>
                      {d.modes.map((m) => <td key={m} className="px-3 py-2 text-right tabular">{money(r.by_mode[m] ?? 0)}</td>)}
                      <td className="px-3 py-2 text-right tabular">{money(r.sales)}</td><td className="px-3 py-2 text-right tabular">{money(r.due_collections)}</td>
                      <td className="px-3 py-2 text-right tabular text-red-700 dark:text-red-300">{money(r.refunds)}</td><td className="px-3 py-2 text-right tabular font-semibold">{money(r.net)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-line-2 font-semibold">
                    <td className="px-3 py-2">Total</td><td />
                    {d.modes.map((m) => <td key={m} className="px-3 py-2 text-right tabular">{money(d.by_mode[m] ?? 0)}</td>)}
                    <td className="px-3 py-2 text-right tabular">{money(d.totals.sales)}</td><td className="px-3 py-2 text-right tabular">{money(d.totals.due_collections)}</td>
                    <td className="px-3 py-2 text-right tabular">{money(d.totals.refunds)}</td><td className="px-3 py-2 text-right tabular">{money(d.totals.net)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </PharmShell>
  )
}
