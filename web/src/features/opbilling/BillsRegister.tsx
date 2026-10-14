import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useDebounced } from '@/components/fields'
import { Pager } from '@/components/list'
import { Badge, Button, Card, Empty, ErrorBox, Input, Kbd, PageHeader, Select, Spinner, StatTile, Tabs } from '@/components/ui'
import { api, apiUrl } from '@/lib/api'
import { dateTime, money, todayISO } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import { useCounterAccess } from './BillingCounter'
import { BillDrawer, BillTable, type BillRow } from './modals'

type Tab = 'bills' | 'refunds' | 'receipts'

/** OP bills register: every outpatient bill (draft → confirmed / paid / due), refunds and receipts (payment-mode correction). */
export default function BillsRegister({ embedded = false }: { embedded?: boolean }) {
  const nav = useNavigate()
  const counter = useCounterAccess()
  const [tab, setTab] = useState<Tab>('bills')
  const [f, setF] = useState({ q: '', status: '', search_by: 'all', from: todayISO(), to: todayISO() })
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [sel, setSel] = useState<string | null>(null)
  const dq = useDebounced(f.q, 300)
  const query = { scope: 'all', date_from: f.from, date_to: f.to, status: f.status || undefined, q: dq || undefined, search_by: f.search_by }
  const bills = useQuery({
    queryKey: ['x', 'billing', 'op-bills', query, page, limit],
    queryFn: () => api<{ rows: BillRow[]; total: number; summary: { net: number; discount: number; paid: number; balance: number } }>('/opbilling/bills', { query: { ...query, page, limit } }),
    enabled: tab === 'bills',
  })
  const refunds = useQuery({
    queryKey: ['x', 'billing', 'op-refunds', f.from, f.to],
    queryFn: () => api<{ id: string; code: string; amount: number; mode: string; status: string; paid_at: string; reason?: string; bill_id: string; bill: string; patient: string; uhid: string; received_by?: string }[]>('/opbilling/refunds', { query: { date_from: f.from, date_to: f.to } }),
    enabled: tab === 'refunds',
  })
  const receipts = useQuery({
    queryKey: ['x', 'billing', 'op-receipts', f.from, f.to, dq],
    queryFn: () => api<{ id: string; code: string; amount: number; mode: string; status: string; paid_at: string; reference?: string; corrected_from?: string; pending_correction?: unknown; bill_id: string; bill: string; patient: string; uhid: string; received_by?: string }[]>('/opbilling/payments', { query: { date_from: f.from, date_to: f.to, q: dq || undefined } }),
    enabled: tab === 'receipts',
  })
  useShortcuts('OP bills', [{ keys: '/', label: 'Search bills', run: () => document.getElementById('opb-search')?.focus() }])
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setPage(1) }
  return (
    <div className="space-y-3">
      {!embedded && <PageHeader icon="FileText" title="OP Bills" subtitle="All outpatient bills — search, review and open"
        actions={counter ? <Button variant="primary" icon="Plus" onClick={() => nav('/op/billing')}>New bill</Button> : undefined} />}
      {embedded && counter && <div className="flex justify-end"><Button variant="primary" icon="Plus" onClick={() => nav('/op/billing')}>New bill</Button></div>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ key: 'bills', label: 'Bills', icon: 'FileText' }, { key: 'refunds', label: 'Refunds', icon: 'Undo2' }, { key: 'receipts', label: 'Receipts & mode correction', icon: 'Wallet' }]} />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative">
            <Input id="opb-search" className="h-8 w-72 pr-8" placeholder="Search bills — bill no, UHID, mobile, patient" value={f.q} onChange={(e) => set('q', e.target.value)} />
            <span className="absolute right-2 top-1.5"><Kbd>/</Kbd></span>
          </div>
          {tab === 'bills' && <>
            <Select className="h-8 w-40" value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
              <option value="">All statuses</option><option value="DRAFT">Draft</option><option value="PENDING_APPROVAL">Pending approval</option>
              <option value="CONFIRMED">Confirmed</option><option value="PAID">Paid</option><option value="DUE">Due</option><option value="CANCELLED">Cancelled / discarded</option>
            </Select>
            <Select className="h-8 w-36" value={f.search_by} onChange={(e) => set('search_by', e.target.value)} aria-label="Search by">
              <option value="all">All fields</option><option value="bill">Bill no</option><option value="uhid">UHID</option><option value="mobile">Mobile</option><option value="patient">Patient</option>
            </Select>
          </>}
          <Input type="date" className="h-8 w-36" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="From" />
          <span className="text-ink-3">–</span>
          <Input type="date" className="h-8 w-36" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="To" />
          {tab === 'bills' && <a href={apiUrl('/opbilling/bills', { ...query, format: 'csv' }, true)} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">Export CSV</a>}
        </div>
        {tab === 'bills' && (
          <>
            {bills.data && (
              <div className="grid grid-cols-2 gap-2 border-t border-line p-3 md:grid-cols-5">
                <StatTile label="Bills" value={bills.data.total} />
                <StatTile label="Net billed" value={money(bills.data.summary.net, true)} />
                <StatTile label="Discount" value={money(bills.data.summary.discount, true)} />
                <StatTile label="Collected" value={money(bills.data.summary.paid, true)} />
                <StatTile label="Outstanding" value={money(bills.data.summary.balance, true)} />
              </div>
            )}
            {bills.isLoading && <Spinner />}
            {bills.error && <div className="p-3"><ErrorBox error={bills.error} /></div>}
            {bills.data && !bills.data.rows.length && <Empty icon="FileText" title="No bills match" />}
            {!!bills.data?.rows.length && <BillTable rows={bills.data.rows} onOpen={setSel} />}
            {bills.data && <Pager page={page} limit={limit} total={bills.data.total} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1) }} fetching={bills.isFetching} />}
          </>
        )}
        {tab === 'refunds' && (
          <Rows loading={refunds.isLoading} error={refunds.error} empty={!refunds.data?.length} cols={['Refund', 'Bill', 'Patient', 'Mode', 'Amount', 'Reason', 'By', 'When', 'Status']}>
            {refunds.data?.map((r) => (
              <tr key={r.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => setSel(r.bill_id)}>
                <td className="px-2.5 py-1.5 font-mono text-xs">{r.code}</td><td className="px-2.5 py-1.5 font-mono text-xs">{r.bill}</td><td className="px-2.5 py-1.5">{r.patient} <span className="text-xs text-ink-3">{r.uhid}</span></td>
                <td className="px-2.5 py-1.5">{r.mode}</td><td className="tabular px-2.5 py-1.5">{money(r.amount)}</td><td className="px-2.5 py-1.5 text-ink-2">{r.reason}</td>
                <td className="px-2.5 py-1.5 text-ink-2">{r.received_by}</td><td className="px-2.5 py-1.5 text-ink-2">{dateTime(r.paid_at)}</td>
                <td className="px-2.5 py-1.5"><Badge tone={r.status === 'Success' ? 'green' : r.status === 'Pending' ? 'amber' : 'red'}>{r.status === 'Pending' ? 'Awaiting approval' : r.status}</Badge></td>
              </tr>
            ))}
          </Rows>
        )}
        {tab === 'receipts' && (
          <Rows loading={receipts.isLoading} error={receipts.error} empty={!receipts.data?.length} cols={['Receipt', 'Bill', 'Patient', 'Mode', 'Reference', 'Amount', 'By', 'When', '']}>
            {receipts.data?.map((r) => (
              <tr key={r.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => setSel(r.bill_id)}>
                <td className="px-2.5 py-1.5 font-mono text-xs">{r.code}</td><td className="px-2.5 py-1.5 font-mono text-xs">{r.bill}</td><td className="px-2.5 py-1.5">{r.patient} <span className="text-xs text-ink-3">{r.uhid}</span></td>
                <td className="px-2.5 py-1.5">{r.mode}{r.corrected_from && <span className="ml-1 text-xs text-ink-3">(was {r.corrected_from})</span>}</td><td className="px-2.5 py-1.5 text-xs text-ink-2">{r.reference}</td>
                <td className="tabular px-2.5 py-1.5">{money(r.amount)}</td><td className="px-2.5 py-1.5 text-ink-2">{r.received_by}</td><td className="px-2.5 py-1.5 text-ink-2">{dateTime(r.paid_at)}</td>
                <td className="px-2.5 py-1.5">{r.pending_correction ? <Badge tone="amber">Correction pending</Badge> : null}</td>
              </tr>
            ))}
          </Rows>
        )}
      </Card>
      <BillDrawer id={sel} onClose={() => setSel(null)} />
    </div>
  )
}

function Rows({ loading, error, empty, cols, children }: { loading: boolean; error: unknown; empty: boolean; cols: string[]; children: React.ReactNode }) {
  if (loading) return <Spinner />
  if (error) return <div className="p-3"><ErrorBox error={error} /></div>
  if (empty) return <Empty icon="Inbox" title="Nothing in this range" />
  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full text-sm"><thead className="border-b border-line bg-surface-2 text-xs text-ink-2"><tr>{cols.map((h) => <th key={h} className="px-2.5 py-2 text-left font-medium">{h}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </div>
  )
}
