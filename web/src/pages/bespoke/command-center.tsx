import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, BellRing, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, cn, Empty, ErrorBox, Spinner, type BadgeTone } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { ago, minutes, moneyShort, number, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { BespokeProps } from './index'

interface Alert { id: string; code: string; message: string; severity: string; metric: string; observed_value: number; threshold: number; triggered_at: string; status: string; escalated?: boolean }
interface Snapshot {
  as_of: string
  revenue: { today: number; last_week_same_time: number; delta_pct: number | null; collected: number; collected_last_week: number; collected_delta_pct: number | null; bills: number; by_mode: Record<string, number> }
  op: { today: number; seen: number; waiting: number; no_show: number; last_week: number; delta_pct: number | null; wait_min: number | null }
  ip: { census: number; admitted_today: number; discharged_today: number; admitted_last_week: number; delta_pct: number | null; discharge_pending: number; alos_days: number | null; discharge_tat_min: number | null }
  occupancy: { pct: number; occupied: number; vacant: number; total: number; cleaning: number; icu_pct: number | null; by_type: { type: string; total: number; occupied: number; pct: number }[]; bed_turnaround_min: number | null }
  er: { now: number; waiting: number; in_treatment: number; observation: number; visits_today: number; door_to_doctor_min: number | null }
  billing: { unbilled: number; outstanding: number; pending_refunds: number; refunds_today: number }
  pharmacy: { sales_today: number; last_week_same_time: number; delta_pct: number | null; stockouts: number }
  lab: { orders_today: number; pending: number; tat_min: number | null; critical_unack: number }
  radiology: { orders_today: number; pending: number; tat_min: number | null }
  alerts: Alert[]; new_alerts: number
}

const SEV: Record<string, BadgeTone> = { Critical: 'red', Warning: 'amber', Info: 'blue' }

function Delta({ pct, what = 'same time last week' }: { pct: number | null | undefined; what?: string }) {
  if (pct === null || pct === undefined) return <span className="text-ink-3">No comparison for {what}</span>
  const up = pct >= 0
  return (
    <span className="inline-flex items-center gap-0.5 text-ink-2">
      {up ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
      <b className="font-semibold text-ink">{up ? '+' : '−'}{Math.abs(pct).toFixed(1)}%</b>&nbsp;vs {what}
    </span>
  )
}

function Tile({ icon, title, value, sub, children, alert, to }: {
  icon: string; title: string; value: ReactNode; sub?: ReactNode; children?: ReactNode; alert?: boolean; to?: string
}) {
  const body = (
    <section className={cn('h-full rounded-2xl border bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)]', alert ? 'border-red-300 dark:border-red-500/40' : 'border-line', to && 'hover:border-brand-600/40')}>
      <header className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-3">
        <Icon name={icon} className="size-4" /> {title}
        {alert && <Badge tone="red" className="ml-auto normal-case tracking-normal">Needs attention</Badge>}
      </header>
      <div className="mt-1.5 text-3xl font-semibold tracking-tight text-ink tabular">{value}</div>
      {sub && <div className="mt-0.5 text-sm">{sub}</div>}
      {children && <div className="mt-3 border-t border-line pt-2 text-sm text-ink-2">{children}</div>}
    </section>
  )
  return to ? <Link to={to} className="block">{body}</Link> : body
}

function Pair({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span>{label}</span>
      <span className={cn('tabular', strong ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ink')}>{value}</span>
    </div>
  )
}

function Meter({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-ink">{label}</span>
        <span className="tabular text-ink-2">{pct.toFixed(0)}% · {detail}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-surface-2" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} occupancy`}>
        <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: 'var(--s1)' }} />
      </div>
    </div>
  )
}

export default function CommandCenter(_: BespokeProps) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const canAck = reg.canEntity('command.alerts', 'write')
  const q = useQuery({
    queryKey: ['x', 'command', 'snapshot'],
    queryFn: () => api<Snapshot>('/insights/command'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    placeholderData: (p) => p,
  })
  const ack = useMutation({
    mutationFn: (id: string) => api(`/m/command/alerts/${id}/transition`, { method: 'POST', body: { to: 'Acknowledged' } }),
    onSuccess: () => { toast.success('Alert acknowledged'); qc.invalidateQueries({ queryKey: ['x', 'command'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (q.isLoading) return <Spinner label="Loading live numbers…" />
  if (q.error && !q.data) return <ErrorBox error={q.error} />
  const s = q.data!
  const critical = s.alerts.filter((a) => a.severity === 'Critical' && a.status === 'Open')

  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 animate-pulse rounded-full bg-emerald-500" aria-hidden /> Live</span>
        <span>Updated {time(s.as_of)} · refreshes every minute</span>
        <Link to="/" className="ml-auto font-medium text-brand-700 hover:underline dark:text-brand-300">Open the full Command Centre (period comparison, TV mode) →</Link>
        {q.error && <Badge tone="amber">Refresh failed — showing last data</Badge>}
        <Button size="xs" variant="ghost" className="ml-auto" loading={q.isFetching} onClick={() => q.refetch()}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>

      {!!critical.length && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100">
          <div className="flex items-center gap-2 font-semibold"><BellRing className="size-4" /> {critical.length} critical alert{critical.length > 1 ? 's' : ''}</div>
          <ul className="mt-1 space-y-0.5">{critical.slice(0, 3).map((a) => <li key={a.id}>{a.message}</li>)}</ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile icon="IndianRupee" title="Revenue today" value={moneyShort(s.revenue.today)} sub={<Delta pct={s.revenue.delta_pct} />} to="/m/analytics/analytics">
          <Pair label="Collected" value={moneyShort(s.revenue.collected)} />
          <Pair label="Collections vs last week" value={<Delta pct={s.revenue.collected_delta_pct} what="LW" />} />
          <Pair label="Bills raised" value={number(s.revenue.bills)} />
        </Tile>
        <Tile icon="Stethoscope" title="OP today" value={number(s.op.today)} sub={<Delta pct={s.op.delta_pct} what="same day last week" />}>
          <Pair label="Seen" value={number(s.op.seen)} />
          <Pair label="Waiting now" value={number(s.op.waiting)} />
          <Pair label="Avg wait" value={minutes(s.op.wait_min)} />
        </Tile>
        <Tile icon="BedDouble" title="Inpatients now" value={number(s.ip.census)} sub={<span className="text-ink-2">{number(s.ip.admitted_today)} admitted · {number(s.ip.discharged_today)} discharged today</span>}>
          <Pair label="Admissions vs last week" value={<Delta pct={s.ip.delta_pct} what="LW" />} />
          <Pair label="Discharges pending" value={number(s.ip.discharge_pending)} strong={s.ip.discharge_pending > 20} />
          <Pair label="Discharge TAT today" value={minutes(s.ip.discharge_tat_min)} />
        </Tile>
        <Tile icon="Percent" title="Bed occupancy" value={`${number(s.occupancy.pct)}%`} sub={<span className="text-ink-2">{number(s.occupancy.occupied)} of {number(s.occupancy.total)} beds · ICU {s.occupancy.icu_pct ?? '—'}%</span>} to="/m/ipd">
          {s.occupancy.by_type.slice(0, 6).map((t) => <Meter key={t.type} label={t.type} pct={t.pct} detail={`${t.occupied}/${t.total}`} />)}
          <Pair label="Beds being cleaned" value={`${number(s.occupancy.cleaning)}${s.occupancy.bed_turnaround_min ? ` · ${minutes(s.occupancy.bed_turnaround_min)}` : ''}`} />
        </Tile>
        <Tile icon="Siren" title="Emergency now" value={number(s.er.now)} sub={<span className="text-ink-2">{number(s.er.visits_today)} visits today</span>} alert={s.er.waiting > 10}>
          <Pair label="Waiting" value={number(s.er.waiting)} strong={s.er.waiting > 10} />
          <Pair label="In treatment / observation" value={`${s.er.in_treatment} / ${s.er.observation}`} />
          <Pair label="Door-to-doctor (avg)" value={minutes(s.er.door_to_doctor_min)} />
        </Tile>
        <Tile icon="Receipt" title="Billing" value={moneyShort(s.billing.unbilled)} sub={<span className="text-ink-2">unbilled charges</span>} to="/m/finance/finance-console">
          <Pair label="Outstanding on bills" value={moneyShort(s.billing.outstanding)} />
          <Pair label="Pending refunds" value={moneyShort(s.billing.pending_refunds)} />
          <Pair label="Refunded today" value={moneyShort(s.billing.refunds_today)} />
        </Tile>
        <Tile icon="Pill" title="Pharmacy sales today" value={moneyShort(s.pharmacy.sales_today)} sub={<Delta pct={s.pharmacy.delta_pct} />} alert={s.pharmacy.stockouts > 0}>
          <Pair label="Drugs out of stock" value={number(s.pharmacy.stockouts)} strong={s.pharmacy.stockouts > 0} />
        </Tile>
        <Tile icon="FlaskConical" title="Laboratory" value={number(s.lab.pending)} sub={<span className="text-ink-2">pending of {number(s.lab.orders_today)} ordered today</span>} alert={s.lab.critical_unack > 0}>
          <Pair label="Avg TAT today" value={minutes(s.lab.tat_min)} />
          <Pair label="Critical results unacknowledged" value={number(s.lab.critical_unack)} strong={s.lab.critical_unack > 0} />
        </Tile>
        <Tile icon="ScanLine" title="Radiology" value={number(s.radiology.pending)} sub={<span className="text-ink-2">pending of {number(s.radiology.orders_today)} today</span>}>
          <Pair label="Avg TAT today" value={minutes(s.radiology.tat_min)} />
        </Tile>
      </div>

      <section className="rounded-2xl border border-line bg-surface">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
          <BellRing className="size-4 text-brand-700 dark:text-brand-400" /> Alerts
          {s.new_alerts > 0 && <Badge tone="red">{s.new_alerts} new</Badge>}
          <Link to="/m/command/alert_rules" className="ml-auto text-xs font-normal text-brand-700 hover:underline dark:text-brand-300">Alert rules →</Link>
        </header>
        {!s.alerts.length ? (
          <Empty icon="BellOff" title="No open alerts">Thresholds from the alert rules are checked on every refresh.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {s.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-2 px-4 py-2.5">
                <Badge tone={SEV[a.severity] ?? 'gray'}>{a.severity}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{a.message}</p>
                  <p className="text-xs text-ink-3">{ago(a.triggered_at)} · {a.status}{a.escalated ? ' · escalated' : ''} · <Link to={`/m/command/alerts?r=${a.id}`} className="hover:underline">{a.code}</Link></p>
                </div>
                {canAck && a.status === 'Open' && (
                  <Button size="xs" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id)}>Acknowledge</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
