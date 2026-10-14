import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, Printer, ReceiptIndianRupee } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { Badge, Button, cn, Empty, ErrorBox, Segmented, Spinner, StatusBadge } from '@/components/ui'
import { date, dateTime, money, number } from '@/lib/format'
import { Section } from './Home'
import { papi, usePortal, type ReportRow } from './lib'

interface ResultValue { parameter: string; value?: string | null; unit?: string | null; ref_range?: string | null; flag?: string | null }
interface ReportDetailData {
  hospital: string; test: string; category: string; doctor?: string | null
  order: { code: string; ordered_at?: string; collected_at?: string; resulted_at?: string; verified_at?: string; critical?: boolean; result?: string | null; result_values?: ResultValue[] | null; impression?: string | null; sample_barcode?: string | null }
  patient: { name: string; uhid: string; age?: number | null; gender?: string | null }
}
interface Invoice { id: string; code: string; type?: string; billed_at?: string; gross?: number; discount?: number; tax?: number; net?: number; paid?: number; balance?: number; payer?: string; status: string }
interface Receipt { id: string; code: string; kind: string; mode?: string; amount: number; paid_at?: string; reference?: string | null; invoice?: string | null }
interface BillsData { invoices: Invoice[]; receipts: Receipt[]; outstanding: number }
interface BillDetailData {
  hospital: string; patient: { name: string; uhid: string }; invoice: Invoice
  lines: { description: string; qty?: number; rate?: number; amount?: number; charged_at?: string; tax_percent?: number }[]
  payments: { code: string; kind: string; mode?: string; amount: number; paid_at?: string; reference?: string | null }[]
}
interface Rx {
  id: string; code: string; source: string; date?: string; doctor?: string | null; diagnosis?: string | null; status?: string; notes?: string | null; valid_till?: string | null
  items: { drug: string; dose?: string | null; frequency?: string | null; route?: string | null; duration_days?: number | null; qty?: number | null; instructions?: string | null }[]
}

const FLAG_CLASS: Record<string, string> = {
  High: 'text-amber-700 dark:text-amber-300', Low: 'text-amber-700 dark:text-amber-300', Abnormal: 'text-amber-700 dark:text-amber-300',
  'Critical High': 'font-semibold text-red-700 dark:text-red-300', 'Critical Low': 'font-semibold text-red-700 dark:text-red-300',
}

function BackTitle({ to, title, children }: { to: string; title: string; children?: ReactNode }) {
  return (
    <div className="no-print flex items-center gap-2">
      <Link to={to} className="rounded-full p-1.5 text-ink-2 hover:bg-surface-2" aria-label="Back"><ChevronLeft className="size-5" /></Link>
      <h1 className="flex-1 text-xl font-semibold text-ink">{title}</h1>
      {children}
    </div>
  )
}

export function Reports() {
  const { pid } = usePortal()
  const [cat, setCat] = useState<'all' | 'LAB' | 'RAD'>('all')
  const q = useQuery({ queryKey: ['portal', pid, 'reports'], queryFn: () => papi<ReportRow[]>('/reports', { query: { pid } }) })
  const rows = (q.data ?? []).filter((r) => cat === 'all' || r.category === cat)
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">Reports</h1>
      <Segmented value={cat} onChange={setCat} options={[{ key: 'all', label: 'All' }, { key: 'LAB', label: 'Lab' }, { key: 'RAD', label: 'Scans & X-ray' }]} />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <Section title={`${rows.length} verified report${rows.length === 1 ? '' : 's'}`}>
          {rows.length === 0 ? <Empty icon="FileText" title="No reports yet">Reports appear here once the laboratory or radiologist verifies them.</Empty> : (
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link to={`/portal/reports/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                    <FileText className="size-5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{r.test}</span>
                      <span className="block text-xs text-ink-3">{r.category === 'RAD' ? 'Radiology' : 'Laboratory'} · {dateTime(r.verified_at)}</span>
                    </span>
                    {r.critical ? <Badge tone="red"><AlertTriangle className="size-3" /> Critical</Badge> : r.abnormal ? <Badge tone="amber">{r.abnormal} out of range</Badge> : <Badge tone="green">Normal</Badge>}
                    <ChevronRight className="size-4 text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  )
}

export function ReportDetail() {
  const { id = '' } = useParams()
  const { pid } = usePortal()
  const q = useQuery({ queryKey: ['portal', pid, 'report', id], queryFn: () => papi<ReportDetailData>(`/reports/${id}`, { query: { pid } }) })
  if (q.isLoading) return <Spinner />
  if (q.error) return <><BackTitle to="/portal/reports" title="Report" /><ErrorBox error={q.error} /></>
  const r = q.data!
  const o = r.order
  return (
    <div className="space-y-4">
      <BackTitle to="/portal/reports" title="Report"><Button size="sm" onClick={() => window.print()}><Printer className="size-4" /> Print</Button></BackTitle>
      <article className="print-area rounded-2xl border border-line bg-surface p-5 text-ink shadow-sm">
        <header className="border-b border-line pb-3">
          <div className="text-base font-semibold">{r.hospital}</div>
          <div className="text-xs text-ink-3">{r.category === 'RAD' ? 'Department of Radiology' : 'Department of Laboratory Medicine'}</div>
        </header>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-line py-3 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-ink-3">Patient</dt><dd className="font-medium">{r.patient.name}</dd></div>
          <div><dt className="text-xs text-ink-3">UHID</dt><dd className="font-mono">{r.patient.uhid}</dd></div>
          <div><dt className="text-xs text-ink-3">Age / sex</dt><dd>{[r.patient.age != null ? `${r.patient.age} y` : null, r.patient.gender].filter(Boolean).join(' / ') || '—'}</dd></div>
          <div><dt className="text-xs text-ink-3">Order</dt><dd className="font-mono">{o.code}</dd></div>
          <div><dt className="text-xs text-ink-3">Collected</dt><dd>{dateTime(o.collected_at)}</dd></div>
          <div><dt className="text-xs text-ink-3">Verified</dt><dd>{dateTime(o.verified_at)}</dd></div>
          {r.doctor && <div><dt className="text-xs text-ink-3">Referred by</dt><dd>{r.doctor}</dd></div>}
        </dl>
        <h2 className="mt-3 text-lg font-semibold">{r.test}</h2>
        {o.critical && <p className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">This report has a critical value. Your doctor has been informed — please contact the hospital if you have not heard from us.</p>}
        {!!o.result_values?.length && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-ink-3">
                <tr><th className="py-1.5 pr-2 font-medium">Test</th><th className="py-1.5 pr-2 font-medium">Result</th><th className="py-1.5 pr-2 font-medium">Unit</th><th className="py-1.5 pr-2 font-medium">Reference</th><th className="py-1.5 font-medium">Flag</th></tr>
              </thead>
              <tbody>
                {o.result_values.map((v, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="py-1.5 pr-2">{v.parameter}</td>
                    <td className={cn('tabular py-1.5 pr-2', FLAG_CLASS[v.flag ?? ''] ?? 'font-medium')}>{v.value ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-ink-2">{v.unit}</td>
                    <td className="py-1.5 pr-2 text-ink-2">{v.ref_range}</td>
                    <td className={cn('py-1.5 text-xs', FLAG_CLASS[v.flag ?? ''] ?? 'text-ink-3')}>{v.flag && v.flag !== 'Normal' ? v.flag : 'Normal'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {o.result && <pre className="mt-3 whitespace-pre-wrap font-sans text-sm">{o.result}</pre>}
        {o.impression && <p className="mt-3 text-sm"><b>Impression:</b> {o.impression}</p>}
        <footer className="mt-5 border-t border-line pt-2 text-xs text-ink-3">Electronically verified report — no signature required. Interpret results with your doctor; reference ranges vary with age, sex and method.</footer>
      </article>
    </div>
  )
}

export function Bills() {
  const { pid } = usePortal()
  const [tab, setTab] = useState<'bills' | 'receipts'>('bills')
  const q = useQuery({ queryKey: ['portal', pid, 'bills'], queryFn: () => papi<BillsData>('/bills', { query: { pid } }) })
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">Bills & receipts</h1>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <>
          <div className="rounded-2xl border border-line bg-surface p-4">
            <div className="text-xs text-ink-3">Amount due</div>
            <div className={cn('tabular text-3xl font-semibold', q.data.outstanding > 0 ? 'text-red-700 dark:text-red-300' : 'text-ink')}>{money(q.data.outstanding)}</div>
            <p className="mt-1 text-xs text-ink-2">Pay at any billing counter by cash, card or UPI. Keep your UHID handy.</p>
          </div>
          <Segmented value={tab} onChange={setTab} options={[{ key: 'bills', label: `Bills (${q.data.invoices.length})` }, { key: 'receipts', label: `Receipts (${q.data.receipts.length})` }]} />
          {tab === 'bills' ? (
            <Section title="Bills">
              {q.data.invoices.length === 0 ? <Empty icon="Receipt" title="No bills yet" /> : (
                <ul className="divide-y divide-line">
                  {q.data.invoices.map((i) => (
                    <li key={i.id}>
                      <Link to={`/portal/bills/${i.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                        <ReceiptIndianRupee className="size-5 shrink-0 text-ink-3" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-ink">{i.code} · {i.type === 'IP' ? 'Inpatient' : i.type === 'OP' ? 'Outpatient' : i.type}</span>
                          <span className="block text-xs text-ink-3">{date(i.billed_at)}{(i.balance ?? 0) > 0 ? ` · due ${money(i.balance)}` : ''}</span>
                        </span>
                        <span className="text-right">
                          <span className="tabular block text-sm font-semibold text-ink">{money(i.net)}</span>
                          <StatusBadge status={i.status} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : (
            <Section title="Receipts">
              {q.data.receipts.length === 0 ? <Empty icon="Receipt" title="No receipts" /> : (
                <ul className="divide-y divide-line">
                  {q.data.receipts.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-ink">{r.code} · {r.kind === 'DEPOSIT' ? 'Advance deposit' : r.kind === 'REFUND' ? 'Refund' : 'Payment'}</span>
                        <span className="block text-xs text-ink-3">{dateTime(r.paid_at)} · {r.mode}{r.invoice ? ` · bill ${r.invoice}` : ''}</span>
                      </span>
                      <span className={cn('tabular text-sm font-semibold', r.kind === 'REFUND' ? 'text-emerald-700 dark:text-emerald-300' : 'text-ink')}>{r.kind === 'REFUND' ? '−' : ''}{money(r.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  )
}

export function BillDetail() {
  const { id = '' } = useParams()
  const { pid } = usePortal()
  const q = useQuery({ queryKey: ['portal', pid, 'bill', id], queryFn: () => papi<BillDetailData>(`/bills/${id}`, { query: { pid } }) })
  if (q.isLoading) return <Spinner />
  if (q.error) return <><BackTitle to="/portal/bills" title="Bill" /><ErrorBox error={q.error} /></>
  const b = q.data!
  const i = b.invoice
  return (
    <div className="space-y-4">
      <BackTitle to="/portal/bills" title={`Bill ${i.code}`}><Button size="sm" onClick={() => window.print()}><Printer className="size-4" /> Print</Button></BackTitle>
      <article className="print-area rounded-2xl border border-line bg-surface p-5 text-ink shadow-sm">
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line pb-3">
          <div><div className="text-base font-semibold">{b.hospital}</div><div className="text-xs text-ink-3">{i.type === 'IP' ? 'Inpatient' : 'Outpatient'} bill · {i.payer}</div></div>
          <div className="text-right text-sm"><div className="font-mono">{i.code}</div><div className="text-xs text-ink-3">{dateTime(i.billed_at)}</div><StatusBadge status={i.status} /></div>
        </header>
        <div className="py-2 text-sm">{b.patient.name} · <span className="font-mono">{b.patient.uhid}</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-line text-left text-xs text-ink-3"><tr><th className="py-1.5 pr-2 font-medium">Item</th><th className="py-1.5 pr-2 text-right font-medium">Qty</th><th className="py-1.5 pr-2 text-right font-medium">Rate</th><th className="py-1.5 text-right font-medium">Amount</th></tr></thead>
            <tbody>
              {b.lines.map((l, k) => (
                <tr key={k} className="border-b border-line last:border-0">
                  <td className="py-1.5 pr-2">{l.description}</td>
                  <td className="tabular py-1.5 pr-2 text-right">{number(l.qty)}</td>
                  <td className="tabular py-1.5 pr-2 text-right">{money(l.rate)}</td>
                  <td className="tabular py-1.5 text-right">{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto mt-3 w-full max-w-xs space-y-1 text-sm">
          {[['Gross', i.gross], ['Discount', i.discount ? -Number(i.discount) : 0], ['Tax', i.tax], ['Net payable', i.net], ['Paid', i.paid], ['Balance due', i.balance]].map(([k, v]) => (
            <div key={k as string} className={cn('flex justify-between', (k === 'Net payable' || k === 'Balance due') && 'font-semibold')}><dt>{k}</dt><dd className="tabular">{money(v)}</dd></div>
          ))}
        </dl>
        {b.payments.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Payments</h3>
            <ul className="mt-1 text-sm">{b.payments.map((p) => <li key={p.code} className="flex justify-between border-b border-line py-1 last:border-0"><span>{p.code} · {p.mode} · {dateTime(p.paid_at)}</span><span className="tabular">{money(p.amount)}</span></li>)}</ul>
          </div>
        )}
        <footer className="mt-4 border-t border-line pt-2 text-xs text-ink-3">Computer-generated bill. For GST invoice copies or queries contact the billing desk.</footer>
      </article>
    </div>
  )
}

export function Prescriptions() {
  const { pid } = usePortal()
  const q = useQuery({ queryKey: ['portal', pid, 'rx'], queryFn: () => papi<Rx[]>('/prescriptions', { query: { pid } }) })
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">Prescriptions</h1>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data?.length === 0 && <div className="rounded-2xl border border-line bg-surface"><Empty icon="Pill" title="No prescriptions yet">Prescriptions from your OPD and video consultations appear here.</Empty></div>}
      {q.data?.map((r) => (
        <Section key={r.id} title={`${date(r.date)} · ${r.doctor ?? 'Doctor'}`} action={<Badge tone={r.source === 'Teleconsult' ? 'violet' : 'cyan'}>{r.source}</Badge>}>
          <div className="space-y-2 px-4 py-3">
            {r.diagnosis && <div className="text-sm text-ink-2">Diagnosis: <span className="text-ink">{r.diagnosis}</span></div>}
            <ul className="divide-y divide-line rounded-xl border border-line">
              {r.items.map((m, k) => (
                <li key={k} className="px-3 py-2">
                  <div className="text-sm font-medium text-ink">{m.drug}{m.dose ? ` · ${m.dose}` : ''}</div>
                  <div className="text-xs text-ink-2">{[m.frequency, m.route, m.duration_days ? `${m.duration_days} days` : null, m.instructions].filter(Boolean).join(' · ')}</div>
                </li>
              ))}
              {r.items.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No medicines listed</li>}
            </ul>
            {r.notes && <p className="whitespace-pre-wrap text-sm text-ink-2">{r.notes}</p>}
            <div className="text-xs text-ink-3">{r.code}{r.valid_till ? ` · valid till ${date(r.valid_till)}` : ''}</div>
          </div>
        </Section>
      ))}
    </div>
  )
}
