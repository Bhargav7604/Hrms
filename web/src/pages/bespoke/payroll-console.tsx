import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { Download, Play, Printer, RotateCw, Search, Send, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { NewButton, TransitionDialog, useEntity } from '@/components/records'
import { Badge, Button, Card, cn, Empty, ErrorBox, Input, KeyValue, Modal, Spinner, StatTile, StatusBadge, Tabs, toneVariant } from '@/components/ui'
import { api, apiUrl, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { date, dateTime, money, moneyShort, number } from '@/lib/format'
import type { ListResult, Rec, TransitionDef } from '@/lib/types'
import type { BespokeProps } from './index'

// ------------------------------------------------------------------ shared payslip document (also used by self-service)

interface Line { component: string; amount: number }
export interface PayslipPrint {
  payslip: Rec & {
    period: string; days_in_month: number; paid_days: number; lop_days: number; earnings: Line[]; deductions: Line[]
    gross: number; total_deductions: number; net_pay: number; employer_pf?: number; employer_esi?: number
    fee_share?: { basis: string } | null; lop_detail?: Record<string, number>
  }
  employee: { code?: string; name?: string; designation?: string; category?: string; department?: string; doj?: string; pan?: string; uan?: string; esi_no?: string; bank_account?: string; ifsc?: string }
  hospital: { name: string; branch?: string; address?: string; city?: string; state?: string; phone?: string; gstin?: string }
  period_label: string; pay_date?: string; run_code?: string; net_in_words: string; generated_at: string
}

const inr = (v: unknown) => money(v).replace('₹', '₹ ')

export function PayslipDocument({ data }: { data: PayslipPrint }) {
  const { payslip: p, employee: e, hospital: h } = data
  const rows = Math.max(p.earnings.length, p.deductions.length)
  const lop = p.lop_detail ?? {}
  const lopParts = [lop.absent && `${lop.absent} absent`, lop.half_day && `${lop.half_day} half-day`, lop.lop_leave && `${lop.lop_leave} LOP leave`].filter(Boolean)
  return (
    <article className="payslip-doc mx-auto max-w-3xl text-sm text-ink">
      <header className="flex items-start justify-between gap-4 border-b-2 border-ink pb-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight">{h.name}</h2>
          <p className="text-xs text-ink-2">{[h.branch, h.address, h.city, h.state].filter(Boolean).join(', ')}</p>
          {h.gstin && <p className="text-xs text-ink-2">GSTIN {h.gstin}</p>}
        </div>
        <div className="text-right">
          <div className="text-base font-semibold">Payslip · {data.period_label}</div>
          <div className="font-mono text-xs text-ink-2">{p.code}{data.run_code ? ` · ${data.run_code}` : ''}</div>
          {data.pay_date && <div className="text-xs text-ink-2">Pay date {date(data.pay_date)}</div>}
        </div>
      </header>
      <section className="grid grid-cols-2 gap-x-8 gap-y-1 border-b border-line py-3 text-xs sm:grid-cols-3">
        {([
          ['Employee', e.name], ['Employee code', e.code], ['Designation', e.designation], ['Department', e.department],
          ['Date of joining', e.doj ? date(e.doj) : null], ['PAN', e.pan], ['PF UAN', e.uan], ['ESI number', e.esi_no],
          ['Bank account', e.bank_account ? `${e.bank_account}${e.ifsc ? ` · ${e.ifsc}` : ''}` : null],
          ['Days in month', p.days_in_month], ['Paid days', p.paid_days], ['LOP days', `${p.lop_days}${lopParts.length ? ` (${lopParts.join(', ')})` : ''}`],
        ] as [string, ReactNode][]).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 sm:block">
            <span className="text-ink-3">{k}</span>
            <span className="font-medium sm:ml-0 sm:block">{v === null || v === undefined || v === '' ? '—' : v}</span>
          </div>
        ))}
      </section>
      <table className="mt-3 w-full border border-line text-xs">
        <thead className="bg-surface-2">
          <tr>
            <th className="border-b border-r border-line px-2 py-1.5 text-left">Earnings</th>
            <th className="border-b border-r border-line px-2 py-1.5 text-right">Amount</th>
            <th className="border-b border-r border-line px-2 py-1.5 text-left">Deductions</th>
            <th className="border-b border-line px-2 py-1.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td className="border-r border-line px-2 py-1">{p.earnings[i]?.component ?? ''}</td>
              <td className="tabular border-r border-line px-2 py-1 text-right">{p.earnings[i] ? inr(p.earnings[i].amount) : ''}</td>
              <td className="border-r border-line px-2 py-1">{p.deductions[i]?.component ?? ''}</td>
              <td className="tabular px-2 py-1 text-right">{p.deductions[i] ? inr(p.deductions[i].amount) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-surface-2 font-semibold">
          <tr>
            <td className="border-r border-t border-line px-2 py-1.5">Gross earnings</td>
            <td className="tabular border-r border-t border-line px-2 py-1.5 text-right">{inr(p.gross)}</td>
            <td className="border-r border-t border-line px-2 py-1.5">Total deductions</td>
            <td className="tabular border-t border-line px-2 py-1.5 text-right">{inr(p.total_deductions)}</td>
          </tr>
        </tfoot>
      </table>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border-2 border-ink px-3 py-2">
        <div>
          <div className="text-xs text-ink-2">Net pay</div>
          <div className="text-xs italic">{data.net_in_words}</div>
        </div>
        <div className="tabular text-xl font-bold">{inr(p.net_pay)}</div>
      </div>
      <div className="mt-3 space-y-0.5 text-[11px] text-ink-2">
        {(p.employer_pf || p.employer_esi) ? <p>Employer contributions (not deducted): PF {inr(p.employer_pf ?? 0)}{p.employer_esi ? ` · ESI ${inr(p.employer_esi)}` : ''}.</p> : null}
        {p.fee_share?.basis && <p>Professional fee share: {p.fee_share.basis}.</p>}
        <p>This is a computer-generated payslip and does not require a signature. Generated {dateTime(data.generated_at)}.</p>
      </div>
    </article>
  )
}

/** Renders `children` as the only printed content while mounted (the app behind is hidden on paper). */
export function PrintOnly({ children }: { children: ReactNode }) {
  return createPortal(
    <>
      <style>{`
        .print-only-root { display: none; }
        @media print {
          body > *:not(.print-only-root) { display: none !important; }
          .print-only-root { display: block !important; padding: 12mm; }
          .print-only-root, .print-only-root * { color: #000 !important; background: transparent !important; border-color: #888 !important; }
          @page { size: A4; margin: 8mm; }
        }
      `}</style>
      <div className="print-only-root">{children}</div>
    </>,
    document.body,
  )
}

export function PayslipModal({ slipId, source, onClose }: { slipId: string; source: 'hr' | 'ess'; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['x', 'payroll', 'payslip-print', source, slipId],
    queryFn: () => api<PayslipPrint>(source === 'ess' ? `/ess/payslips/${slipId}` : `/payroll/payslips/${slipId}/print`),
  })
  return (
    <Modal open onClose={onClose} size="xl" title={q.data ? `Payslip · ${q.data.period_label} · ${q.data.employee.name ?? ''}` : 'Payslip'}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={!q.data} onClick={() => window.print()}><Printer className="size-4" />Print / save PDF</Button>
      </>}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <>
          <PayslipDocument data={q.data} />
          <PrintOnly><PayslipDocument data={q.data} /></PrintOnly>
        </>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ console

interface SlipRow {
  id: string; code: string; employee_id: string; employee_code?: string; employee_name?: string; designation?: string; category?: string
  department?: string | null; days_in_month: number; paid_days: number; lop_days: number; gross: number; total_deductions: number
  net_pay: number; employer_pf?: number; employer_esi?: number; status: string; bank_ok: boolean; fee_share?: { basis: string } | null
}
interface Summary {
  period_label: string
  totals: { employees: number; gross: number; deductions: number; net: number; employer_pf: number; employer_esi: number; employer_cost: number }
  departments: { department: string; employees: number; gross: number; deductions: number; net: number; employer_pf: number; employer_esi: number; employer_cost: number }[]
  statutory: {
    pf: { members?: number; pf_wages?: number; pf?: number; vpf?: number; employer_pf?: number; employer_eps?: number; employer_epf?: number; total_remittance: number; due_date: string }
    esi: { members?: number; esi_wages?: number; esi?: number; employer_esi?: number; total_remittance: number; due_date: string }
    pt: { total: number; by_state: { state: string; employees: number; amount: number }[]; due_date: string }
    tds: { employees?: number; amount?: number; due_date: string }
  }
  missing_bank: { employee_id: string; code: string; name: string }[]
  warnings: string[]
}
type Tab = 'payslips' | 'statutory' | 'warnings'

const RUN_STEPS = ['Draft', 'Processed', 'Approved', 'Paid']

export default function PayrollConsole(_: BespokeProps) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const runEntity = useEntity('payroll.payroll_runs')
  const canWrite = reg.canEntity('payroll.payroll_runs', 'write')
  const [selected, setSelected] = useState<string | null>(null)
  const runs = useQuery({
    queryKey: ['m', 'payroll', 'payroll_runs', 'console'],
    queryFn: () => api<ListResult>('/m/payroll/payroll_runs', { query: { sort: '-period', limit: 24 } }),
  })
  useEffect(() => {
    if (!selected && runs.data?.rows.length) setSelected(runs.data.rows[0].id)
  }, [runs.data, selected])

  return (
    <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card title="Payroll runs" icon="CalendarRange" pad={false}
        actions={<NewButton entity={runEntity} label="New run" onSaved={(r) => { setSelected(r.id); qc.invalidateQueries({ queryKey: ['m', 'payroll'] }) }} />}>
        {runs.isLoading && <Spinner />}
        {runs.error && <div className="p-3"><ErrorBox error={runs.error} /></div>}
        {runs.data?.rows.length === 0 && (
          <Empty icon="Calculator" title="No payroll runs yet">{canWrite ? 'Create a run for the month (YYYY-MM), then process it.' : undefined}</Empty>
        )}
        <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto scroll-thin">
          {runs.data?.rows.map((r) => (
            <li key={r.id}>
              <button onClick={() => setSelected(r.id)}
                className={cn('flex w-full items-start justify-between gap-2 px-4 py-2.5 text-left hover:bg-surface-2', selected === r.id && 'bg-brand-50 dark:bg-brand-500/10')}>
                <span className="min-w-0">
                  <span className="block font-medium text-ink">{periodName(r.period)}</span>
                  <span className="block font-mono text-xs text-ink-3">{r.code}{r.employee_count ? ` · ${r.employee_count} staff` : ''}</span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <StatusBadge status={r.status} />
                  {r.net_total ? <span className="tabular text-xs text-ink-2">{moneyShort(r.net_total)}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {selected ? <RunPanel runId={selected} /> : !runs.isLoading && <Card><Empty icon="Calculator" title="Select or create a payroll run" /></Card>}
    </div>
  )
}

function periodName(p?: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(p ?? '')
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }) : p ?? '—'
}

function RunPanel({ runId }: { runId: string }) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const entity = useEntity('payroll.payroll_runs')
  const canWrite = reg.canEntity('payroll.payroll_runs', 'write')
  const isHr = reg.meta?.user.role === 'hr' || reg.meta?.user.role === 'admin'
  const [tab, setTab] = useState<Tab>('payslips')
  const [tr, setTr] = useState<TransitionDef | null>(null)
  const run = useQuery({ queryKey: ['m', 'payroll', 'payroll_runs', 'one', runId], queryFn: () => api<Rec>(`/m/payroll/payroll_runs/${runId}`) })
  const slips = useQuery({ queryKey: ['x', 'payroll', 'payslips', runId], queryFn: () => api<{ rows: SlipRow[] }>(`/payroll/runs/${runId}/payslips`) })
  const summary = useQuery({
    queryKey: ['x', 'payroll', 'summary', runId], queryFn: () => api<Summary>(`/payroll/runs/${runId}/summary`),
    enabled: tab !== 'payslips' || !!run.data?.employee_count,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['x', 'payroll'] })
    qc.invalidateQueries({ queryKey: ['m', 'payroll'] })
    qc.invalidateQueries({ queryKey: ['stats', 'payroll'] })
  }
  const process = useMutation({
    mutationFn: () => api<{ payslips: number; warnings: string[] }>(`/payroll/runs/${runId}/process`, { method: 'POST' }),
    onSuccess: (r) => { toast.success(`Processed ${r.payslips} payslips${r.warnings.length ? ` · ${r.warnings.length} warnings to review` : ''}`); invalidate() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const publish = useMutation({
    mutationFn: () => api<{ published: number }>(`/payroll/runs/${runId}/publish`, { method: 'POST' }),
    onSuccess: (r) => { toast.success(r.published ? `${r.published} payslips published to staff self-service` : 'Payslips were already published'); invalidate() },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const r = run.data
  if (run.isLoading) return <Spinner />
  if (run.error || !r) return <ErrorBox error={run.error ?? 'Run not found'} />
  const step = RUN_STEPS.indexOf(r.status ?? 'Draft')
  const locked = r.status === 'Approved' || r.status === 'Paid'
  const unpublished = (slips.data?.rows ?? []).filter((s) => s.status === 'Generated').length

  return (
    <div className="min-w-0 space-y-3">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-ink">{periodName(r.period)}</h2>
              <StatusBadge status={r.status} />
              <span className="font-mono text-xs text-ink-3">{r.code}</span>
            </div>
            <p className="mt-0.5 text-xs text-ink-2">
              Pay date {date(r.pay_date)} · attendance up to {date(r.attendance_cutoff)}
              {r.processed_at && <> · processed {dateTime(r.processed_at)} by {r.processed_by}</>}
              {r.approved_by && <> · approved by {r.approved_by}</>}
              {r.bank_reference && <> · bank ref {r.bank_reference}</>}
            </p>
            <ol className="mt-2 flex items-center gap-1 text-[11px]" aria-label="Run progress">
              {RUN_STEPS.map((s, i) => (
                <li key={s} className="flex items-center gap-1">
                  <span className={cn('rounded-full px-2 py-0.5 font-medium', i <= step ? 'bg-brand-700 text-white' : 'bg-surface-2 text-ink-3 ring-1 ring-line')}>{s}</span>
                  {i < RUN_STEPS.length - 1 && <span className="text-ink-3">›</span>}
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isHr && !locked && (
              <Button size="sm" variant={r.status === 'Draft' ? 'primary' : 'secondary'} loading={process.isPending}
                onClick={() => { if (r.status === 'Draft' || confirm('Re-process this run? Payslips are recalculated from current attendance, leave and salary data.')) process.mutate() }}>
                {r.status === 'Draft' ? <Play className="size-4" /> : <RotateCw className="size-4" />}{r.status === 'Draft' ? 'Process payroll' : 'Re-process'}
              </Button>
            )}
            {canWrite && r._transitions?.map((t) => (
              <Button key={t.to + t.label} size="sm" variant={toneVariant(t.tone)} onClick={() => setTr(t)}>{t.label}</Button>
            ))}
            {isHr && locked && unpublished > 0 && (
              <Button size="sm" loading={publish.isPending} onClick={() => publish.mutate()}><Send className="size-4" />Publish {unpublished} payslips</Button>
            )}
            {isHr && locked && (
              <a href={apiUrl(`/payroll/runs/${runId}/bank-file`, undefined, true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink shadow-sm hover:bg-surface-2">
                <Download className="size-4" />Bank file
              </a>
            )}
          </div>
        </div>
        {process.isPending && <p className="mt-2 text-xs text-ink-2">Calculating attendance, LOP, statutory deductions and fee shares for every employee…</p>}
      </Card>

      {r.employee_count ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <StatTile label="Employees paid" value={number(r.employee_count)} icon="Users" />
          <StatTile label="Gross" value={moneyShort(r.gross_total)} icon="Wallet" />
          <StatTile label="Deductions" value={moneyShort(r.deduction_total)} icon="Minus" />
          <StatTile label="Net pay" value={moneyShort(r.net_total)} icon="BadgeIndianRupee" />
          <StatTile label="Employer PF + ESI" value={moneyShort(Number(r.employer_pf_total ?? 0) + Number(r.employer_esi_total ?? 0))} icon="Landmark"
            hint={r.warning_count ? `${r.warning_count} warnings` : undefined} tone={r.warning_count ? 'alert' : 'default'} onClick={r.warning_count ? () => setTab('warnings') : undefined} />
        </div>
      ) : (
        <Card>
          <Empty icon="Calculator" title="Not processed yet">
            Processing computes paid days (attendance and loss-of-pay leave), pro-rated earnings, approved overtime and incentives,
            doctors' fee share, PF, ESI, professional tax and TDS for every active employee with a salary structure.
          </Empty>
        </Card>
      )}

      {!!r.employee_count && (
        <>
          <Tabs value={tab} onChange={setTab} tabs={[
            { key: 'payslips', label: 'Payslips', icon: 'FileText', count: slips.data?.rows.length },
            { key: 'statutory', label: 'Statutory & departments', icon: 'Landmark' },
            { key: 'warnings', label: 'Warnings', icon: 'TriangleAlert', count: r.warning_count ?? 0 },
          ]} />
          {tab === 'payslips' && <PayslipTable q={slips} />}
          {tab === 'statutory' && (summary.isLoading ? <Spinner /> : summary.error ? <ErrorBox error={summary.error} /> : summary.data && <StatutoryView s={summary.data} />)}
          {tab === 'warnings' && <Warnings run={r} summary={summary.data} />}
        </>
      )}

      {tr && entity && <TransitionDialog entity={entity} rec={r} t={tr} onClose={() => setTr(null)} onDone={() => { setTr(null); invalidate() }} />}
    </div>
  )
}

function PayslipTable({ q }: { q: UseQueryResult<{ rows: SlipRow[] }> }) {
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase()
    return (q.data?.rows ?? []).filter((r) => !t || `${r.employee_name} ${r.employee_code} ${r.department ?? ''} ${r.designation ?? ''}`.toLowerCase().includes(t))
  }, [q.data, term])
  const total = (k: 'gross' | 'total_deductions' | 'net_pay') => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)
  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorBox error={q.error} />
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search name, code, department…" className="h-8 pl-8" />
        </div>
        <span className="text-xs text-ink-3">{rows.length} payslips · click a row to view and print</span>
      </div>
      <div className="max-h-[60vh] overflow-auto scroll-thin">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-ink-2">
            <tr>
              {['Employee', 'Department', 'Paid / days', 'LOP', 'Gross', 'Deductions', 'Net pay', 'Status'].map((h, i) => (
                <th key={h} className={cn('whitespace-nowrap border-b border-line px-3 py-2 font-medium', i >= 4 && i <= 6 ? 'text-right' : 'text-left')}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setOpen(r.id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
                <td className="px-3 py-1.5">
                  <div className="font-medium text-ink">{r.employee_name}</div>
                  <div className="text-xs text-ink-3">{r.employee_code} · {r.designation}{r.fee_share ? ' · fee share' : ''}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-ink-2">{r.department ?? '—'}</td>
                <td className="tabular px-3 py-1.5">{number(r.paid_days)} / {r.days_in_month}</td>
                <td className={cn('tabular px-3 py-1.5', r.lop_days > 0 && 'font-medium text-red-700 dark:text-red-300')}>{r.lop_days > 0 ? number(r.lop_days) : '—'}</td>
                <td className="tabular px-3 py-1.5 text-right">{money(r.gross, true)}</td>
                <td className="tabular px-3 py-1.5 text-right">{money(r.total_deductions, true)}</td>
                <td className="tabular px-3 py-1.5 text-right font-medium text-ink">{money(r.net_pay, true)}</td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  <StatusBadge status={r.status} />
                  {!r.bank_ok && r.net_pay > 0 && <Badge tone="red" className="ml-1">No bank details</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 bg-surface-2 text-sm font-semibold text-ink">
            <tr>
              <td className="border-t border-line px-3 py-2" colSpan={4}>Total ({rows.length})</td>
              <td className="tabular border-t border-line px-3 py-2 text-right">{money(total('gross'), true)}</td>
              <td className="tabular border-t border-line px-3 py-2 text-right">{money(total('total_deductions'), true)}</td>
              <td className="tabular border-t border-line px-3 py-2 text-right">{money(total('net_pay'), true)}</td>
              <td className="border-t border-line" />
            </tr>
          </tfoot>
        </table>
        {rows.length === 0 && <Empty icon="Search" title="No payslips match" />}
      </div>
      {open && <PayslipModal slipId={open} source="hr" onClose={() => setOpen(null)} />}
    </div>
  )
}

function StatutoryView({ s }: { s: Summary }) {
  const { pf, esi, pt, tds } = s.statutory
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Provident Fund (EPF)" icon="Landmark" actions={<Badge tone="amber">Due {date(pf.due_date)}</Badge>}>
          <KeyValue cols={1} items={[
            { label: 'Members · PF wages', value: `${number(pf.members ?? 0)} · ${money(pf.pf_wages ?? 0, true)}` },
            { label: 'Employee 12%', value: money(pf.pf ?? 0, true) },
            { label: 'Voluntary PF', value: money(pf.vpf ?? 0, true) },
            { label: 'Employer EPF 3.67% · EPS 8.33%', value: `${money(pf.employer_epf ?? 0, true)} · ${money(pf.employer_eps ?? 0, true)}` },
            { label: 'Total ECR remittance', value: <b>{money(pf.total_remittance, true)}</b> },
          ]} />
        </Card>
        <Card title="ESI" icon="HeartPulse" actions={<Badge tone="amber">Due {date(esi.due_date)}</Badge>}>
          <KeyValue cols={1} items={[
            { label: 'Members · ESI wages', value: `${number(esi.members ?? 0)} · ${money(esi.esi_wages ?? 0, true)}` },
            { label: 'Employee 0.75%', value: money(esi.esi ?? 0, true) },
            { label: 'Employer 3.25%', value: money(esi.employer_esi ?? 0, true) },
            { label: 'Total challan', value: <b>{money(esi.total_remittance, true)}</b> },
          ]} />
        </Card>
        <Card title="Professional Tax" icon="Receipt" actions={<Badge tone="amber">Due {date(pt.due_date)}</Badge>}>
          <KeyValue cols={1} items={[
            ...pt.by_state.map((x) => ({ label: `${x.state} · ${x.employees} staff`, value: money(x.amount, true) })),
            { label: 'Total', value: <b>{money(pt.total, true)}</b> },
          ]} />
        </Card>
        <Card title="Income tax (TDS s.192)" icon="FileText" actions={<Badge tone="amber">Due {date(tds.due_date)}</Badge>}>
          <KeyValue cols={1} items={[
            { label: 'Employees with TDS', value: number(tds.employees ?? 0) },
            { label: 'TDS to deposit', value: <b>{money(tds.amount ?? 0, true)}</b> },
          ]} />
        </Card>
      </div>
      <Card title={`Department totals · ${s.period_label}`} icon="Building2" pad={false}>
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-2">
              <tr>
                {['Department', 'Staff', 'Gross', 'Deductions', 'Net pay', 'Employer PF', 'Employer ESI', 'Cost to hospital'].map((h, i) => (
                  <th key={h} className={cn('whitespace-nowrap border-b border-line px-3 py-2 font-medium', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.departments.map((d) => (
                <tr key={d.department} className="border-b border-line last:border-0">
                  <td className="px-3 py-1.5 text-ink">{d.department}</td>
                  <td className="tabular px-3 py-1.5 text-right">{d.employees}</td>
                  {(['gross', 'deductions', 'net', 'employer_pf', 'employer_esi', 'employer_cost'] as const).map((k) => (
                    <td key={k} className="tabular px-3 py-1.5 text-right">{money(d[k], true)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-surface-2 font-semibold">
              <tr>
                <td className="border-t border-line px-3 py-2">Total</td>
                <td className="tabular border-t border-line px-3 py-2 text-right">{s.totals.employees}</td>
                {(['gross', 'deductions', 'net', 'employer_pf', 'employer_esi', 'employer_cost'] as const).map((k) => (
                  <td key={k} className="tabular border-t border-line px-3 py-2 text-right">{money(s.totals[k], true)}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  )
}

function Warnings({ run, summary }: { run: Rec; summary?: Summary }) {
  const warnings: string[] = run.warnings ?? []
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title="Processing warnings" icon="TriangleAlert">
        {warnings.length === 0 ? <Empty icon="BadgeCheck" title="No warnings" /> : (
          <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto text-sm scroll-thin">
            {warnings.map((w, i) => <li key={i} className="flex gap-2 text-ink-2"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />{w}</li>)}
          </ul>
        )}
        {(run.warning_count ?? 0) > warnings.length && <p className="mt-2 text-xs text-ink-3">Showing the first {warnings.length} of {run.warning_count}.</p>}
      </Card>
      <Card title="Excluded from the bank file" icon="Landmark">
        {!summary ? <Spinner /> : summary.missing_bank.length === 0 ? <Empty icon="BadgeCheck" title="Every payee has bank details" /> : (
          <>
            <p className="mb-2 text-xs text-ink-2">These staff have no account number / IFSC on their profile and must be paid separately or updated before the transfer.</p>
            <ul className="divide-y divide-line text-sm">
              {summary.missing_bank.map((m) => <li key={m.employee_id} className="flex justify-between py-1.5"><span className="text-ink">{m.name}</span><span className="font-mono text-xs text-ink-3">{m.code}</span></li>)}
            </ul>
          </>
        )}
      </Card>
    </div>
  )
}
