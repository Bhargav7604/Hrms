import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Bars, ChartFrame } from '@/components/charts'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Segmented, Spinner, StatTile, StatusBadge } from '@/components/ui'
import { api, apiUrl, getToken } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { money, moneyShort, number, todayISO } from '@/lib/format'
import type { BespokeProps } from './index'

type ModeRow = { mode: string; amount: number }
type DailyRow = { date: string } & Record<string, number | string>
interface Finance {
  range: { from: string; to: string }
  collections: { total: number; refunds: number; net: number; by_mode: Record<string, number>; daily: DailyRow[]
    by_branch: { branch: string; collected: number; refunds: number; receipts: number; by_mode: Record<string, number> }[] }
  ip: { billed: number; accrued: number; expenses: number; cost_centres: { department: string; ip_revenue: number; expenses: number; margin: number }[] }
  receivables: { unbilled: number; outstanding: number; pending_refunds: number; refund_requests: number; expenses_awaiting_approval: number }
  pnl: { revenue: { stream: string; gross: number; discount: number; net: number; bills: number }[]; revenue_total: number
    expenses: { head: string; amount: number }[]; expenses_total: number; surplus: number; margin_pct: number | null }
  targets: { month: string; rows: { id: string; code: string; period: string; revenue_stream: string; department_name?: string | null
    target_amount: number; achieved_amount: number | null; achievement_percent: number | null; status: string }[] }
}
type Preset = 'mtd' | 'last' | '7' | 'custom'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function presetRange(p: Preset) {
  const now = new Date()
  if (p === 'last') return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) }
  if (p === '7') { const f = new Date(); f.setDate(now.getDate() - 6); return { from: iso(f), to: iso(now) } }
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) }
}
const MODE_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK: 'NEFT / RTGS', CHEQUE: 'Cheque', WALLET: 'Wallet', INSURANCE: 'Insurance / TPA' }
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return iso(d) }

function TallyExport() {
  const { user } = useAuth()
  const [from, setFrom] = useState(yesterday)
  const [to, setTo] = useState(yesterday)
  const [busy, setBusy] = useState(false)
  const allowed = ['billing', 'management', 'admin'].includes(user?.role ?? '')
  const run = async () => {
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/tally/export', { from, to }), { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(body.message ?? res.statusText)
      }
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `tally-vouchers_${from}_${to}.xml`
      a.click()
      URL.revokeObjectURL(a.href)
      const skipped = Number(res.headers.get('X-Skipped') ?? 0)
      toast.success(`${res.headers.get('X-Vouchers')} vouchers exported (${res.headers.get('X-New-Postings')} new GL postings) · ${res.headers.get('X-Export-Batch')}`)
      if (skipped) toast.warning(`${skipped} unbalanced document(s) skipped — see the connector message log`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Tally / ERP export" icon="FileCode2">
      <p className="mb-3 text-xs text-ink-2">Sales vouchers for bills and Receipt / Payment / Journal vouchers for collections, refunds and deposit
        adjustments as Tally XML (Gateway → Import Data). Each voucher is recorded once in GL postings; re-exports never duplicate postings.</p>
      <div className="flex flex-wrap items-end gap-2">
        <FieldWrap label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" /></FieldWrap>
        <FieldWrap label="To"><Input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} className="w-40" /></FieldWrap>
        <Button variant="primary" loading={busy} disabled={!allowed} onClick={run}><Download className="size-4" /> Export XML</Button>
        <Link to="/m/finance/gl_postings" className="text-sm text-brand-700 hover:underline dark:text-brand-300">GL postings →</Link>
      </div>
      {!allowed && <p className="mt-2 text-xs text-ink-3">Only billing and management can export to Tally.</p>}
    </Card>
  )
}

export default function FinanceConsole(_: BespokeProps) {
  const [preset, setPreset] = useState<Preset>('mtd')
  const [range, setRange] = useState(() => presetRange('mtd'))
  const q = useQuery({
    queryKey: ['x', 'finance', 'console', range.from, range.to],
    queryFn: () => api<Finance>('/insights/finance', { query: { from: range.from, to: range.to } }),
    placeholderData: (p) => p,
  })
  const d = q.data
  const modes: ModeRow[] = useMemo(() => Object.entries(d?.collections.by_mode ?? {}).map(([mode, amount]) => ({ mode: MODE_LABEL[mode] ?? mode, amount }))
    .sort((a, b) => b.amount - a.amount), [d])
  const modeKeys = useMemo(() => {
    const keys = new Set<string>()
    d?.collections.daily.forEach((r) => Object.keys(r).forEach((k) => k !== 'date' && keys.add(k)))
    return Array.from(keys).sort((a, b) => (d!.collections.by_mode[b] ?? 0) - (d!.collections.by_mode[a] ?? 0)).slice(0, 6)
  }, [d])
  const daily = useMemo(() => (d?.collections.daily ?? []).map((r): DailyRow => ({ ...r, label: r.date.slice(5).split('-').reverse().join('/') })), [d])

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <Segmented value={preset} onChange={(p) => { setPreset(p); if (p !== 'custom') setRange(presetRange(p)) }} options={[
          { key: 'mtd', label: 'Month to date' }, { key: 'last', label: 'Last month' }, { key: '7', label: 'Last 7 days' }, { key: 'custom', label: 'Custom' },
        ]} />
        <div className="flex items-center gap-1 text-xs text-ink-2">
          <Input type="date" className="h-8 w-36" value={range.from} max={range.to} aria-label="From" onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })) }} />
          <span>to</span>
          <Input type="date" className="h-8 w-36" value={range.to} min={range.from} max={todayISO()} aria-label="To" onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })) }} />
        </div>
      </div>
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <Spinner label="Loading finance…" />}
      {d && (
        <div className={cn('space-y-4', q.isFetching && 'opacity-80')}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile icon="Wallet" label="Net collections" value={moneyShort(d.collections.net)} hint={`${moneyShort(d.collections.total)} received − ${moneyShort(d.collections.refunds)} refunded`} />
            <StatTile icon="FileText" label="Revenue (net billed)" value={moneyShort(d.pnl.revenue_total)} hint={`${number(d.pnl.revenue.reduce((a, r) => a + r.bills, 0))} bills`} />
            <StatTile icon="ReceiptText" label="Unbilled charges" value={moneyShort(d.receivables.unbilled)} hint="Running IP accounts and open OP charges" />
            <StatTile icon="Hourglass" label="Outstanding on bills" value={moneyShort(d.receivables.outstanding)} hint="Final / partially paid bills" />
            <StatTile icon="Undo2" label="Pending refunds" value={moneyShort(d.receivables.pending_refunds)} hint={`${d.receivables.refund_requests} refund request(s) open`} />
            <StatTile icon="ClipboardCheck" label="Expenses awaiting approval" value={moneyShort(d.receivables.expenses_awaiting_approval)} hint="Recorded, not yet approved" />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartFrame title="Collections by mode" subtitle={`${range.from} to ${range.to} · payments and deposits`}
              table={{ columns: ['Mode', 'Amount', 'Share'], rows: modes.map((m) => [m.mode, money(m.amount, true), d.collections.total ? `${((m.amount / d.collections.total) * 100).toFixed(1)}%` : '—']) }}>
              {modes.length ? <Bars data={modes} x="mode" horizontal series={[{ key: 'amount', label: 'Collected' }]} fmt={moneyShort} /> : <Empty icon="Wallet" title="No collections in this range" />}
            </ChartFrame>
            <ChartFrame title="Daily collections" subtitle="Stacked by payment mode"
              table={{ columns: ['Date', ...modeKeys.map((k) => MODE_LABEL[k] ?? k)], rows: daily.map((r) => [r.date, ...modeKeys.map((k) => money(Number(r[k] ?? 0), true))]) }}>
              {daily.length ? <Bars data={daily} x="label" stacked series={modeKeys.map((k) => ({ key: k, label: MODE_LABEL[k] ?? k }))} fmt={moneyShort} />
                : <Empty icon="CalendarDays" title="No collections in this range" />}
            </ChartFrame>
          </div>

          <Card pad={false} title="Collections by branch" icon="Building2">
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                  <tr><th className="px-3 py-2 text-left font-medium">Branch</th><th className="px-3 py-2 text-right font-medium">Receipts</th>
                    {Object.keys(MODE_LABEL).map((m) => <th key={m} className="px-3 py-2 text-right font-medium">{MODE_LABEL[m]}</th>)}
                    <th className="px-3 py-2 text-right font-medium">Collected</th><th className="px-3 py-2 text-right font-medium">Refunds</th></tr>
                </thead>
                <tbody>
                  {d.collections.by_branch.map((b) => (
                    <tr key={b.branch} className="border-b border-line last:border-0">
                      <td className="px-3 py-2 font-medium text-ink">{b.branch}</td>
                      <td className="px-3 py-2 text-right tabular">{number(b.receipts)}</td>
                      {Object.keys(MODE_LABEL).map((m) => <td key={m} className="px-3 py-2 text-right tabular text-ink-2">{b.by_mode[m] ? money(b.by_mode[m], true) : '—'}</td>)}
                      <td className="px-3 py-2 text-right font-medium tabular">{money(b.collected, true)}</td>
                      <td className="px-3 py-2 text-right tabular">{money(b.refunds, true)}</td>
                    </tr>
                  ))}
                  {!d.collections.by_branch.length && <tr><td colSpan={11}><Empty icon="Building2" title="No collections in this range" /></td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card pad={false} title="IP revenue vs expenditure" icon="Scale">
              <div className="grid grid-cols-3 gap-3 border-b border-line p-3 text-sm">
                <div><div className="text-xs text-ink-3">IP billed</div><div className="text-lg font-semibold tabular">{moneyShort(d.ip.billed)}</div></div>
                <div><div className="text-xs text-ink-3">IP accrued (charges)</div><div className="text-lg font-semibold tabular">{moneyShort(d.ip.accrued)}</div></div>
                <div><div className="text-xs text-ink-3">Expenses booked</div><div className="text-lg font-semibold tabular">{moneyShort(d.ip.expenses)}</div></div>
              </div>
              <div className="max-h-80 overflow-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
                    <tr><th className="px-3 py-2 text-left font-medium">Cost centre</th><th className="px-3 py-2 text-right font-medium">IP revenue</th>
                      <th className="px-3 py-2 text-right font-medium">Expenses</th><th className="px-3 py-2 text-right font-medium">Contribution</th></tr>
                  </thead>
                  <tbody>
                    {d.ip.cost_centres.map((c) => (
                      <tr key={c.department} className="border-b border-line last:border-0">
                        <td className="px-3 py-1.5 text-ink">{c.department}</td>
                        <td className="px-3 py-1.5 text-right tabular">{money(c.ip_revenue, true)}</td>
                        <td className="px-3 py-1.5 text-right tabular">{money(c.expenses, true)}</td>
                        <td className={cn('px-3 py-1.5 text-right font-medium tabular', c.margin < 0 && 'text-red-700 dark:text-red-300')}>{c.margin < 0 ? '−' : ''}{money(Math.abs(c.margin), true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!d.ip.cost_centres.length && <Empty icon="Scale" title="No IP revenue or expenses in this range" />}
              </div>
            </Card>

            <Card pad={false} title="Profit & loss (management view)" icon="Landmark">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="bg-surface-2 text-xs font-semibold uppercase tracking-wide text-ink-3"><td className="px-3 py-1.5" colSpan={2}>Revenue (net of discounts)</td></tr>
                  {d.pnl.revenue.map((r) => (
                    <tr key={r.stream} className="border-b border-line">
                      <td className="px-3 py-1.5 text-ink">{r.stream} <span className="text-xs text-ink-3">· {number(r.bills)} bills · discount {money(r.discount, true)}</span></td>
                      <td className="px-3 py-1.5 text-right tabular">{money(r.net, true)}</td>
                    </tr>
                  ))}
                  <tr className="border-b border-line font-medium"><td className="px-3 py-1.5">Total revenue</td><td className="px-3 py-1.5 text-right tabular">{money(d.pnl.revenue_total, true)}</td></tr>
                  <tr className="bg-surface-2 text-xs font-semibold uppercase tracking-wide text-ink-3"><td className="px-3 py-1.5" colSpan={2}>Expenses (approved / paid)</td></tr>
                  {d.pnl.expenses.map((x) => (
                    <tr key={x.head} className="border-b border-line"><td className="px-3 py-1.5 text-ink">{x.head}</td><td className="px-3 py-1.5 text-right tabular">{money(x.amount, true)}</td></tr>
                  ))}
                  {!d.pnl.expenses.length && <tr className="border-b border-line"><td className="px-3 py-1.5 text-ink-3" colSpan={2}>No approved expenses in this range</td></tr>}
                  <tr className="border-b border-line font-medium"><td className="px-3 py-1.5">Total expenses</td><td className="px-3 py-1.5 text-right tabular">{money(d.pnl.expenses_total, true)}</td></tr>
                  <tr className="font-semibold">
                    <td className="px-3 py-2">{d.pnl.surplus >= 0 ? 'Surplus' : 'Deficit'} {d.pnl.margin_pct != null && <span className="text-xs font-normal text-ink-2">({d.pnl.margin_pct}% margin)</span>}</td>
                    <td className={cn('px-3 py-2 text-right tabular', d.pnl.surplus < 0 && 'text-red-700 dark:text-red-300')}>{d.pnl.surplus < 0 ? '−' : ''}{money(Math.abs(d.pnl.surplus), true)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="border-t border-line px-3 py-2 text-xs text-ink-3">Cash-basis revenue from bills; expenses by booking date. Statutory accounts are maintained in Tally.</p>
            </Card>
          </div>

          <Card pad={false} title={`Revenue targets vs achievement · ${d.targets.month}`} icon="Target"
            actions={<Link to="/m/finance/revenue_targets" className="text-xs text-brand-700 hover:underline dark:text-brand-300">Manage targets →</Link>}>
            {!d.targets.rows.length ? <Empty icon="Target" title={`No targets set for ${d.targets.month}`}>Add revenue targets per stream or department to track achievement here.</Empty> : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                    <tr>{['Stream', 'Department', 'Target', 'Achieved', 'Achievement', 'Status'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {d.targets.rows.map((t) => {
                      const pct = t.achievement_percent ?? 0
                      return (
                        <tr key={t.id} className="border-b border-line last:border-0">
                          <td className="px-3 py-2 text-ink">{t.revenue_stream}</td>
                          <td className="px-3 py-2 text-ink-2">{t.department_name ?? 'Hospital-wide'}</td>
                          <td className="px-3 py-2 tabular">{money(t.target_amount, true)}</td>
                          <td className="px-3 py-2 tabular">{money(t.achieved_amount ?? 0, true)}</td>
                          <td className="min-w-48 px-3 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-2 flex-1 rounded-full bg-surface-2"><div className="h-2 rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: 'var(--s1)' }} /></div>
                              <span className="w-14 text-right text-xs font-medium tabular">{t.achievement_percent != null ? `${pct.toFixed(0)}%` : '—'}</span>
                              {pct >= 100 && <Badge tone="green">Met</Badge>}
                            </div>
                          </td>
                          <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <TallyExport />
        </div>
      )}
    </div>
  )
}
