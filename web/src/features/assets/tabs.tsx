import { ArrowRight } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame } from '@/components/charts'
import { Badge, cn, Empty, Segmented, StatusBadge } from '@/components/ui'
import { date, money, moneyShort, number } from '@/lib/format'
import { Icon } from '@/lib/icons'
import {
  CountChart, DaysPill, Delta, flowValue, hours, KpiTile, Panel, pctText, SeverityBadge, type Accent, type useAssetAccess,
} from './parts'
import type { Dashboard, DueKind, DueWindow, MonthRow, OpenRecord, TicketRow, Urgency } from './types'

export interface TabProps {
  d: Dashboard
  drill: (bucket: string, title: string) => void
  open: (rec: OpenRecord) => void
  goTab: (tab: string) => void
  access: ReturnType<typeof useAssetAccess>
}

const KIND_ICON: Record<DueKind, string> = { calibration: 'Gauge', pm: 'Wrench', electrical_safety: 'Zap', warranty: 'ShieldCheck', amc: 'FileText' }
const COVER_KINDS: DueKind[] = ['warranty', 'amc']
const isCover = (k: DueKind) => COVER_KINDS.includes(k)

function Grid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-3', className)}>{children}</div>
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
      {children} <ArrowRight className="size-3.5" aria-hidden />
    </button>
  )
}

function Row({ onClick, children, className }: { onClick?: () => void; children: ReactNode; className?: string }) {
  return onClick ? (
    <li><button type="button" onClick={onClick} className={cn('flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-surface-2', className)}>{children}</button></li>
  ) : <li className={cn('flex items-start gap-3 px-4 py-2.5', className)}>{children}</li>
}

// ------------------------------------------------------------------ overview

function RegisteredChart({ rows }: { rows: MonthRow[] }) {
  return (
    <ChartFrame title="Assets registered by month" subtitle="New rows on the register (trailing 12 months)" height={240}
      table={{ columns: ['Month', 'Registered', 'Register size'], rows: rows.map((r) => [r.label, r.registered, r.register_size]) }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="assetRegFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--s1)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--s1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="label" stroke="var(--axis)" tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} />
          <YAxis allowDecimals={false} stroke="var(--axis)" tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} width={48} />
          <Tooltip cursor={{ stroke: 'var(--axis)' }} content={({ active, payload, label }) => active && payload?.length ? (
            <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
              <div className="mb-0.5 font-medium text-ink">{label}</div>
              <div className="text-ink-2">Registered <b className="tabular text-ink">{number(payload[0].value)}</b></div>
              <div className="text-ink-3">Register size {number((payload[0].payload as MonthRow).register_size)}</div>
            </div>
          ) : null} />
          <Area type="monotone" dataKey="registered" name="Registered" stroke="var(--s1)" strokeWidth={2} fill="url(#assetRegFill)"
            dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

function BreakdownList({ rows, open, limit, canOpen }: { rows: TicketRow[]; open: TabProps['open']; limit?: number; canOpen: boolean }) {
  if (!rows.length) return <Empty icon="CheckCircle2" title="No open breakdowns">Every reported fault has been resolved.</Empty>
  return (
    <ul className="divide-y divide-line">
      {rows.slice(0, limit ?? rows.length).map((t) => (
        <Row key={t.id} onClick={canOpen ? () => open({ fqn: 'assets.breakdowns', id: t.id }) : undefined}>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{t.asset_name}{t.asset_model ? ` — ${t.asset_model}` : ''}</div>
            <div className="truncate font-mono text-[11px] text-ink-3">{t.code} · {t.asset_code}{t.takes_down ? ' · took it out of service' : ''}</div>
          </div>
          <div className="shrink-0 text-right">
            <SeverityBadge severity={t.severity} />
            <div className="mt-0.5 text-[11px] text-ink-3">{date(t.reported_at)}</div>
          </div>
        </Row>
      ))}
    </ul>
  )
}

export function OverviewTab({ d, drill, open, goTab, access }: TabProps) {
  const o = d.overview
  const canAsset = access.canRead('assets.assets')
  const tiles: { icon: string; label: string; value: number; caption: string; accent: Accent; bucket: string }[] = [
    { icon: 'Wrench', label: 'Under maintenance', value: o.under_maintenance, caption: 'A work order is in progress on the asset', accent: 'warning', bucket: 'under_maintenance' },
    { icon: 'Siren', label: 'Open breakdowns', value: o.open_breakdowns, caption: 'Faults reported and not yet resolved: open, assigned, in progress, awaiting spares', accent: 'serious', bucket: 'open_breakdowns' },
    { icon: 'OctagonAlert', label: 'Critical assets down', value: o.critical_down, caption: 'High-criticality assets out of service, out for service or with a critical ticket', accent: 'critical', bucket: 'critical_down' },
    { icon: 'Truck', label: 'Outside hospital', value: o.outside_hospital, caption: 'Away for service or on a gate pass', accent: 'brand', bucket: 'outside_hospital' },
    { icon: 'Hourglass', label: 'Pending approval', value: o.pending_approval, caption: 'Transfer requests waiting for approval', accent: 'neutral', bucket: 'pending_approval' },
    { icon: 'ShieldCheck', label: 'Under warranty', value: o.under_warranty, caption: 'Warranty not yet expired (disposed assets excluded)', accent: 'good', bucket: 'under_warranty' },
  ]
  const period = d.flows
  return (
    <div className="space-y-3">
      <Grid className="grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => <KpiTile key={t.bucket} {...t} onDrill={() => drill(t.bucket, t.label)} />)}
      </Grid>

      <Panel title="Due & expiring" icon="CalendarClock" subtitle={<>Active assets · <span className="text-red-700 dark:text-red-300">overdue / expired</span> and <span className="text-amber-700 dark:text-amber-300">due within 7 days</span></>}
        actions={<LinkButton onClick={() => goTab('due')}>Open list</LinkButton>} pad={false}>
        <div className="grid divide-line sm:grid-cols-2 sm:divide-x lg:grid-cols-5">
          {d.due.cards.map((c) => (
            <button key={c.key} type="button" onClick={() => goTab('due')} className="flex items-center gap-2 border-b border-line px-4 py-3 text-left text-sm hover:bg-surface-2 lg:border-b-0">
              <Icon name={KIND_ICON[c.key]} className="size-4 text-ink-3" />
              <span className="min-w-0 flex-1 leading-tight text-ink">{c.label}</span>
              <Badge tone={c.overdue ? 'red' : 'gray'} className="tabular" >{c.overdue}<span className="sr-only"> {isCover(c.key) ? 'expired' : 'overdue'}</span></Badge>
              <Badge tone={c.due7 ? 'amber' : 'gray'} className="tabular">{c.due7}<span className="sr-only"> due within 7 days</span></Badge>
            </button>
          ))}
        </div>
      </Panel>

      <Grid className="lg:grid-cols-3">
        <CountChart title="Asset status" subtitle="Lifecycle status of every asset on the register" rows={d.charts.status} kind="donut"
          keyLabel="Status" onPick={(k) => drill(`status:${k}`, k)} />
        <CountChart title="Assets by category" rows={d.charts.category} kind="donut" keyLabel="Category"
          onPick={(k) => drill(`category:${k}`, k)} />
        <Panel title="Open breakdowns" icon="Siren" subtitle="Oldest first" pad={false}
          actions={d.open_breakdowns.length > 0 ? <LinkButton onClick={() => goTab('maintenance')}>View all</LinkButton> : undefined}>
          <div className="max-h-[352px] overflow-y-auto scroll-thin">
            <BreakdownList rows={d.open_breakdowns} open={open} limit={8} canOpen={access.canRead('assets.breakdowns')} />
          </div>
        </Panel>
      </Grid>

      <Grid className="lg:grid-cols-2">
        <CountChart title="Assets by department" rows={d.charts.department} kind="bars" keyLabel="Department"
          onPick={(k) => drill(`department:${k}`, 'Department')} />
        <CountChart title="Assets by age" subtitle="From the date put to use (or installation / purchase date)" rows={d.charts.age} kind="bars"
          keyLabel="Age" color="var(--s3)" onPick={(k) => drill(`age:${k}`, `Age ${k}`)} />
      </Grid>

      <Grid className="lg:grid-cols-3">
        <div className="lg:col-span-2"><RegisteredChart rows={d.charts.registered_by_month} /></div>
        <Panel title="Recently registered" icon="PackagePlus" pad={false}>
          {d.recent.length ? (
            <ul className="divide-y divide-line">
              {d.recent.map((a) => (
                <Row key={a.id} onClick={canAsset ? () => open({ fqn: 'assets.assets', id: a.id }) : undefined}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{a.name}</div>
                    <div className="truncate text-[11px] text-ink-3"><span className="font-mono">{a.code}</span> · {a.category}</div>
                  </div>
                  <div className="shrink-0 text-right"><StatusBadge status={a.status} /><div className="mt-0.5 text-[11px] text-ink-3">{date(a.registered_on)}</div></div>
                </Row>
              ))}
            </ul>
          ) : <Empty icon="PackagePlus" title="No assets registered yet" />}
        </Panel>
      </Grid>

      <Panel title="Activity in the period" icon="Activity" subtitle={`${d.period.label} · ${date(d.period.from)} – ${date(d.period.to)}`}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
          {period.map((f) => (
            <div key={f.key} className="min-w-0">
              <div className="text-xs text-ink-2">{f.label}</div>
              <div className="text-lg font-semibold tabular text-ink">{flowValue(f, f.value)}</div>
              {d.compare && <Delta flow={f} compareLabel={d.compare.label} />}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ due & expiring

const URGENCY_OPTIONS = (w: number): { key: 'any' | Urgency; label: string }[] => [
  { key: 'any', label: 'Any' }, { key: 'overdue', label: 'Overdue / expired' }, { key: 'due7', label: '≤ 7 days' }, { key: 'due_window', label: `≤ ${w} days` },
]

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
        active ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-ink-2 ring-line-2 hover:bg-surface-2')}>
      {children}
    </button>
  )
}

export function DueTab({ d, open, access, window: win, setWindow }: TabProps & { window: DueWindow; setWindow: (w: DueWindow) => void }) {
  const [kind, setKind] = useState<'all' | DueKind>('all')
  const [urg, setUrg] = useState<'any' | Urgency>('any')
  const items = useMemo(() => d.due.items.filter((i) => (kind === 'all' || i.kind === kind) && (
    urg === 'any' || (urg === 'overdue' ? i.urgency === 'overdue' : urg === 'due7' ? i.urgency !== 'overdue' && i.days <= 7 : i.urgency !== 'overdue')
  )), [d.due.items, kind, urg])
  const canAsset = access.canRead('assets.assets')
  const pick = (k: DueKind, u: 'any' | Urgency) => { setKind(k); setUrg(u) }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-ink-2">
          Overdue and upcoming calibration, preventive maintenance and electrical-safety tests, and expiring warranty and AMC / CMC cover,
          for active assets. Expired cover stays on the list for {d.due.expired_listed_days} days.
        </p>
        <div className="no-print"><Segmented value={String(win) as '7' | '30' | '60' | '90'} onChange={(k) => setWindow(Number(k) as DueWindow)}
          options={[7, 30, 60, 90].map((n) => ({ key: String(n) as '7' | '30' | '60' | '90', label: `${n} days` }))} /></div>
      </div>

      <Grid className="sm:grid-cols-2 lg:grid-cols-5">
        {d.due.cards.map((c) => {
          const cover = isCover(c.key)
          const cells: { u: Urgency; n: number; label: string; tone: string }[] = [
            { u: 'overdue', n: c.overdue, label: cover ? 'Expired' : 'Overdue', tone: 'text-red-700 dark:text-red-300' },
            { u: 'due7', n: c.due7, label: cover ? 'Expires ≤ 7 days' : 'Due ≤ 7 days', tone: 'text-amber-700 dark:text-amber-300' },
            { u: 'due_window', n: c.due_window, label: `${cover ? 'Expires' : 'Due'} ≤ ${win} days`, tone: 'text-sky-700 dark:text-sky-300' },
          ]
          return (
            <section key={c.key} className="rounded-xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)] break-inside-avoid">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Icon name={KIND_ICON[c.key]} className="size-4 text-ink-3" />{c.key === 'pm' ? 'Preventive maintenance' : c.label}</h4>
              <div className="mt-2 grid grid-cols-3 gap-1">
                {cells.map((x) => (
                  <button key={x.u} type="button" onClick={() => pick(c.key, x.u)} className="rounded-md px-1 py-1 text-left hover:bg-surface-2">
                    <div className={cn('text-xl font-semibold tabular', x.n ? x.tone : 'text-ink-3')}>{x.n}</div>
                    <div className="text-[11px] leading-tight text-ink-3">{x.label}</div>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </Grid>

      <Panel title="Due & expiring records" icon="CalendarClock" subtitle={`Most urgent first.${canAsset ? ' Click a row to open the asset.' : ''}`} pad={false}>
        <div className="no-print flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
          <Chip active={kind === 'all'} onClick={() => setKind('all')}>All <span className="tabular opacity-80">{d.due.total}</span></Chip>
          {d.due.cards.map((c) => (
            <Chip key={c.key} active={kind === c.key} onClick={() => setKind(c.key)}>{c.label} <span className="tabular opacity-80">{c.listed}</span></Chip>
          ))}
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
          {URGENCY_OPTIONS(win).map((o) => <Chip key={o.key} active={urg === o.key} onClick={() => setUrg(o.key)}>{o.label}</Chip>)}
        </div>
        {items.length === 0 ? (
          <Empty icon="CalendarCheck" title={d.due.total ? 'Nothing matches these filters' : 'Nothing due or expiring'}>
            {d.due.total ? 'Try another type or urgency.' : `No calibration, PM, safety test or cover falls due in the next ${win} days.`}
          </Empty>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Asset</th>
                  <th className="px-3 py-2 text-left font-medium">Department</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Details</th>
                  <th className="px-3 py-2 text-left font-medium">Due date</th>
                  <th className="px-4 py-2 text-right font-medium">Days</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={`${i.id}-${i.kind}`} onClick={canAsset ? () => open({ fqn: 'assets.assets', id: i.id }) : undefined}
                    onKeyDown={canAsset ? (e) => { if (e.key === 'Enter') open({ fqn: 'assets.assets', id: i.id }) } : undefined}
                    tabIndex={canAsset ? 0 : undefined}
                    className={cn('border-b border-line last:border-0', canAsset && 'cursor-pointer hover:bg-surface-2 focus:bg-surface-2 focus:outline-none')}>
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs text-ink-2">{i.code}</div>
                      <div className="text-ink">{i.name}{i.model ? <span className="text-ink-3"> — {i.model}</span> : null}</div>
                    </td>
                    <td className="px-3 py-2 text-ink-2">{i.department}</td>
                    <td className="whitespace-nowrap px-3 py-2"><span className="inline-flex items-center gap-1.5 text-ink"><Icon name={KIND_ICON[i.kind]} className="size-3.5 text-ink-3" />{i.kind_label}</span></td>
                    <td className="min-w-56 px-3 py-2 text-ink-2">{i.detail}{i.fail && <Badge tone="red" className="ml-1.5">Last result failed</Badge>}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular text-ink">{date(i.due)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right"><DaysPill days={i.days} urgency={i.urgency} cover={isCover(i.kind)} grace={i.grace} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.due.total > d.due.items.length && <p className="px-4 py-2 text-xs text-ink-3">Showing the {d.due.items.length} most urgent of {d.due.total}.</p>}
          </div>
        )}
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ maintenance

export function MaintenanceTab({ d, open, access, drill }: TabProps) {
  const m = d.maintenance
  const flows = d.flows.filter((f) => ['breakdowns', 'mttr_hours', 'downtime_hours', 'maintenance_cost', 'pm_compliance'].includes(f.key))
  const canTicket = access.canRead('assets.breakdowns')
  const canJob = access.canRead('assets.pm_jobs')
  const sevTone: Record<string, string> = { Critical: 'text-red-700 dark:text-red-300', High: 'text-amber-700 dark:text-amber-300' }
  return (
    <div className="space-y-3">
      <Grid className="grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        {flows.map((f) => (
          <KpiTile key={f.key} icon={f.key === 'breakdowns' ? 'Siren' : f.key === 'maintenance_cost' ? 'IndianRupee' : f.key === 'pm_compliance' ? 'ListChecks' : 'Timer'}
            label={f.label} value={flowValue(f, f.value)} accent={f.key === 'breakdowns' ? 'serious' : 'brand'}
            caption={f.key === 'mttr_hours' ? 'Reported → resolved, tickets resolved in the period' : f.key === 'downtime_hours' ? 'Breakdown + PM downtime in the period'
              : f.key === 'maintenance_cost' ? 'Repairs resolved + PM jobs done in the period' : f.key === 'pm_compliance' ? `PM jobs due in the period done within grace (${m.period.pm_due ?? 0} due)` : 'Tickets raised in the period'}
            extra={d.compare ? <span className="mt-1"><Delta flow={f} compareLabel={d.compare.label} /></span> : undefined} />
        ))}
      </Grid>

      <Grid className="lg:grid-cols-3">
        <Panel title="Open breakdowns by severity" icon="Siren" subtitle={`${d.kpis.open_breakdowns} open`}>
          <div className="grid grid-cols-4 gap-2">
            {m.by_severity.map((s) => (
              <div key={s.severity} className="rounded-lg bg-surface-2 px-2 py-2 text-center ring-1 ring-inset ring-line">
                <div className={cn('text-xl font-semibold tabular', s.count ? sevTone[s.severity] ?? 'text-ink' : 'text-ink-3')}>{s.count}</div>
                <div className="text-[11px] text-ink-2">{s.severity}</div>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => drill('critical_down', 'Critical assets down')} className="no-print mt-3 text-xs text-brand-700 hover:underline dark:text-brand-300">
            {d.overview.critical_down} high-criticality asset{d.overview.critical_down === 1 ? '' : 's'} down →
          </button>
        </Panel>
        <CountChart title="Breakdowns by root cause" subtitle="Tickets reported in the period" rows={m.root_causes} kind="bars" keyLabel="Root cause" color="var(--s2)" />
        <Panel title="PM jobs coming up" icon="CalendarClock" subtitle={`Scheduled within ${d.window} days`} pad={false}>
          {m.upcoming_jobs.length ? (
            <ul className="max-h-60 divide-y divide-line overflow-y-auto scroll-thin">
              {m.upcoming_jobs.map((j) => (
                <Row key={j.id} onClick={canJob ? () => open({ fqn: 'assets.pm_jobs', id: j.id }) : undefined}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{j.asset_name}</div>
                    <div className="truncate text-[11px] text-ink-3"><span className="font-mono">{j.code}</span> · {j.type} · {j.department}</div>
                  </div>
                  <span className="shrink-0 text-xs tabular text-ink-2">{date(j.due_date)}</span>
                </Row>
              ))}
            </ul>
          ) : <Empty icon="CalendarCheck" title="No PM jobs scheduled in the window" />}
        </Panel>
      </Grid>

      <Panel title="Open work orders" icon="ClipboardList" subtitle="Work still owed: open breakdown tickets plus PM jobs in progress or overdue" pad={false}>
        {m.work_orders.length === 0 ? <Empty icon="CheckCircle2" title="No open work orders" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Work order</th>
                  <th className="px-3 py-2 text-left font-medium">Asset</th>
                  <th className="px-3 py-2 text-left font-medium">Department</th>
                  <th className="px-3 py-2 text-left font-medium">Severity</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Age</th>
                  <th className="px-4 py-2 text-left font-medium">Assigned to</th>
                </tr>
              </thead>
              <tbody>
                {m.work_orders.map((w) => {
                  const isTicket = w.type === 'Breakdown'
                  const can = isTicket ? canTicket : canJob
                  const go = () => open({ fqn: isTicket ? 'assets.breakdowns' : 'assets.pm_jobs', id: w.id })
                  return (
                    <tr key={w.id} onClick={can ? go : undefined} tabIndex={can ? 0 : undefined} onKeyDown={can ? (e) => { if (e.key === 'Enter') go() } : undefined}
                      className={cn('border-b border-line last:border-0', can && 'cursor-pointer hover:bg-surface-2 focus:bg-surface-2 focus:outline-none')}>
                      <td className="px-4 py-2"><div className="font-mono text-xs text-ink-2">{w.code}</div><div className="text-xs text-ink">{w.type}</div></td>
                      <td className="px-3 py-2"><div className="text-ink">{w.asset_name}</div><div className="font-mono text-[11px] text-ink-3">{w.asset_code}</div></td>
                      <td className="px-3 py-2 text-ink-2">{w.department ?? '—'}</td>
                      <td className="px-3 py-2">{w.severity ? <SeverityBadge severity={w.severity} /> : <span className="text-ink-3">—</span>}</td>
                      <td className="px-3 py-2"><StatusBadge status={w.status} /></td>
                      <td className="whitespace-nowrap px-3 py-2 tabular text-ink-2">
                        {isTicket ? hours(w.age_hours) : w.days_overdue ? <Badge tone="red">{w.days_overdue} d overdue</Badge> : `Due ${date(w.reported_at)}`}
                      </td>
                      <td className="px-4 py-2 text-ink-2">{w.assigned_to ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {m.work_orders_total > m.work_orders.length && <p className="px-4 py-2 text-xs text-ink-3">Showing {m.work_orders.length} of {m.work_orders_total}.</p>}
          </div>
        )}
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ compliance & cover

function ComplianceMeter({ label, icon, c, onDrill }: { label: string; icon: string; c: Dashboard['compliance']['calibration']; onDrill?: () => void }) {
  const p = c.pct ?? 0
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="flex items-center gap-1.5 text-ink"><Icon name={icon} className="size-4 text-ink-3" />{label}</span>
        <span className="font-semibold tabular text-ink">{c.pct === null ? '—' : pctText(c.pct)}</span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-surface-2 ring-1 ring-inset ring-line" role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} compliance`}>
        <div className="h-2 rounded-full" style={{ width: `${p}%`, background: 'var(--s3)' }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-3">
        <span>{c.tracked} tracked</span>
        {c.overdue > 0 ? (onDrill ? <button type="button" onClick={onDrill} className="text-red-700 hover:underline dark:text-red-300">{c.overdue} overdue</button>
          : <span className="text-red-700 dark:text-red-300">{c.overdue} overdue</span>) : <span>0 overdue</span>}
        {c.failed > 0 && <span className="text-red-700 dark:text-red-300">{c.failed} last result failed</span>}
      </div>
    </div>
  )
}

export function ComplianceTab({ d, drill, open, access }: TabProps) {
  const c = d.compliance
  const canAsset = access.canRead('assets.assets')
  return (
    <div className="space-y-3">
      <Grid className="grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile icon="Radiation" label="AERB licences expired" value={c.aerb.expired} accent={c.aerb.expired ? 'critical' : 'good'}
          caption={`${c.aerb.expiring} expiring within 90 days · ${c.aerb.valid} valid${c.aerb.missing ? ` · ${c.aerb.missing} imaging units without a licence` : ''}`}
          onDrill={() => drill('aerb:expired', 'AERB licence expired')} />
        <KpiTile icon="ShieldCheck" label="Under warranty" value={c.warranty.under} accent="good"
          caption={`${c.warranty.expiring} expire within ${d.window} days · ${c.warranty.expired} expired`} onDrill={() => drill('under_warranty', 'Under warranty')} />
        <KpiTile icon="FileText" label="Covered (warranty / AMC / CMC)" value={pctText(c.covered_pct)} accent="brand"
          caption={`${c.cover_total} assets in or awaiting service`} onDrill={() => drill('cover:No cover', 'No cover')} />
        <KpiTile icon="HeartPulse" label="High-criticality without cover" value={c.high_uncovered} accent={c.high_uncovered ? 'critical' : 'good'}
          caption="No warranty and no AMC / CMC" onDrill={() => drill('high_uncovered', 'High-criticality without cover')} />
        <KpiTile icon="Umbrella" label="Insured" value={c.insurance.find((r) => r.key === 'Insured')?.count ?? 0} accent="neutral"
          caption={`${c.insurance.find((r) => r.key === 'Expired')?.count ?? 0} expired · ${c.insurance.find((r) => r.key === 'Not recorded')?.count ?? 0} not recorded`}
          onDrill={() => drill('insurance:Insured', 'Insured')} />
      </Grid>

      <Panel title="Calibration, safety and PM compliance" icon="BadgeCheck" subtitle="Share of tracked active assets that are not overdue">
        <div className="grid gap-5 md:grid-cols-3">
          <ComplianceMeter label="Calibration" icon="Gauge" c={c.calibration} onDrill={() => drill('due:calibration:overdue', 'Calibration overdue')} />
          <ComplianceMeter label="Electrical safety" icon="Zap" c={c.electrical_safety} onDrill={() => drill('due:electrical_safety:overdue', 'Electrical safety overdue')} />
          <ComplianceMeter label="Preventive maintenance" icon="Wrench" c={c.pm} onDrill={() => drill('pm_overdue', 'PM overdue')} />
        </div>
      </Panel>

      <Grid className="lg:grid-cols-3">
        <CountChart title="Maintenance cover" subtitle="Assets in or awaiting service" rows={c.cover} kind="donut" keyLabel="Cover"
          onPick={(k) => drill(`cover:${k}`, k)} />
        <CountChart title="AERB licences" subtitle="X-ray, CT, C-arm, cath lab and mammography units"
          rows={[
            { key: 'valid', label: 'Valid', count: c.aerb.valid, pct: 0 }, { key: 'expiring', label: 'Expiring ≤ 90 days', count: c.aerb.expiring, pct: 0 },
            { key: 'expired', label: 'Expired', count: c.aerb.expired, pct: 0 }, { key: 'missing', label: 'Imaging unit without licence', count: c.aerb.missing, pct: 0 },
            { key: 'no_expiry', label: 'Licence without expiry date', count: c.aerb.no_expiry, pct: 0 },
          ].map((r, _i, all) => ({ ...r, pct: (() => { const t = all.reduce((s, x) => s + x.count, 0); return t ? Math.round((r.count * 1000) / t) / 10 : 0 })() }))}
          kind="bars" keyLabel="Licence" color="var(--s4)" onPick={(k) => drill(`aerb:${k}`, 'AERB licence')} />
        <CountChart title="Device risk class" subtitle="Medical Devices Rules 2017" rows={c.risk_class} kind="bars" keyLabel="Risk class" color="var(--s5)"
          onPick={(k) => drill(`risk:${k}`, k)} />
      </Grid>

      <Grid className="lg:grid-cols-2">
        <CountChart title="Insurance" rows={c.insurance} kind="bars" keyLabel="Insurance" color="var(--s1)" onPick={(k) => drill(`insurance:${k}`, k)} />
        <Panel title="High-criticality assets without cover" icon="HeartPulse" subtitle="Life-support and critical-care equipment with no warranty or AMC / CMC" pad={false}>
          {c.high_uncovered_list.length ? (
            <ul className="max-h-72 divide-y divide-line overflow-y-auto scroll-thin">
              {c.high_uncovered_list.map((a) => (
                <Row key={a.id} onClick={canAsset ? () => open({ fqn: 'assets.assets', id: a.id }) : undefined}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{a.name}{a.model ? <span className="text-ink-3"> — {a.model}</span> : null}</div>
                    <div className="truncate text-[11px] text-ink-3"><span className="font-mono">{a.code}</span> · {a.department}</div>
                  </div>
                  <StatusBadge status={a.status} />
                </Row>
              ))}
            </ul>
          ) : <Empty icon="ShieldCheck" title="Every high-criticality asset is covered" />}
        </Panel>
      </Grid>
    </div>
  )
}

// ------------------------------------------------------------------ register & movement

export function RegisterTab({ d, drill, open, access }: TabProps) {
  const r = d.register
  const canTransfer = access.canRead('assets.transfers')
  const tiles: { icon: string; label: string; value: number; caption: string; accent: Accent; bucket: string }[] = [
    { icon: 'Boxes', label: 'Total assets', value: r.total, caption: 'Every row on the register, disposed assets included', accent: 'brand', bucket: 'total' },
    { icon: 'ArrowLeftRight', label: 'Pending transfer', value: r.pending_transfer, caption: 'Transfers requested, approved or in transit', accent: 'neutral', bucket: 'pending_transfer' },
    { icon: 'Truck', label: 'Outside hospital', value: r.outside_hospital, caption: 'Away for service or on a gate pass', accent: 'warning', bucket: 'outside_hospital' },
    { icon: 'MapPinOff', label: 'Lost / missing', value: r.lost, caption: 'Not found at the assigned location', accent: r.lost ? 'critical' : 'good', bucket: 'lost' },
    { icon: 'Archive', label: 'Pending disposal', value: r.pending_disposal, caption: 'Decommissioned, awaiting disposal', accent: 'serious', bucket: 'pending_disposal' },
    { icon: 'Recycle', label: 'Disposed', value: r.disposed, caption: 'Sold, scrapped, returned or written off', accent: 'neutral', bucket: 'disposed' },
  ]
  return (
    <div className="space-y-3">
      <Grid className="grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => <KpiTile key={t.bucket} {...t} onDrill={() => drill(t.bucket, t.label)} />)}
      </Grid>
      <Grid className="lg:grid-cols-2">
        <CountChart title="Where assets are" subtitle="Assets on the register, excluding disposed" rows={r.where} kind="bars" keyLabel="Location status"
          color="var(--s5)" onPick={(k) => drill(`where:${k}`, k)} />
        <CountChart title="Assets by source" rows={r.source} kind="donut" keyLabel="Source" onPick={(k) => drill(`source:${k}`, k)} />
      </Grid>
      <Grid className="lg:grid-cols-2">
        <CountChart title="Assets by ownership" rows={r.ownership} kind="donut" keyLabel="Ownership" onPick={(k) => drill(`ownership:${k}`, k)} />
        <CountChart title="Top manufacturers" subtitle="By number of assets" rows={r.manufacturers} kind="bars" keyLabel="Manufacturer"
          onPick={(k) => drill(`make:${k}`, k)} />
      </Grid>
      <Panel title="Transfers in flight" icon="ArrowLeftRight" subtitle="Requested, approved or in transit — oldest first" pad={false}>
        {r.transfers.length ? (
          <ul className="divide-y divide-line">
            {r.transfers.map((t) => (
              <Row key={t.id} onClick={canTransfer ? () => open({ fqn: 'assets.transfers', id: t.id }) : undefined}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{t.asset_name} <span className="text-ink-3">· {t.from ?? '—'} → {t.to ?? '—'}</span></div>
                  <div className="truncate text-[11px] text-ink-3"><span className="font-mono">{t.code}</span> · {t.asset_code} · {t.type ?? 'Permanent'} · requested {date(t.requested_on)}</div>
                </div>
                <StatusBadge status={t.status} />
              </Row>
            ))}
          </ul>
        ) : <Empty icon="ArrowLeftRight" title="No transfers in flight" />}
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ finance (stores, management, admin)

export function FinanceTab({ d, drill, open, access }: TabProps) {
  const f = d.finance
  if (!f) return <Empty icon="Lock" title="Asset finance is not available for your role" />
  const dep = d.flows.find((x) => x.key === 'depreciation')
  const canAsset = access.canRead('assets.assets')
  const tot = f.by_category.reduce((s, r) => ({ count: s.count + r.count, cost: s.cost + r.cost, acc: s.acc + r.acc_dep, nbv: s.nbv + r.nbv, pd: s.pd + r.period_dep }),
    { count: 0, cost: 0, acc: 0, nbv: 0, pd: 0 })
  return (
    <div className="space-y-3">
      <Grid className="grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile icon="Landmark" label="Gross block" value={moneyShort(f.cost)} caption="Cost of assets on the books" accent="brand" />
        <KpiTile icon="TrendingDown" label="Accumulated depreciation" value={moneyShort(f.acc_dep)} caption={`As at ${date(f.as_of)}`} accent="neutral" />
        <KpiTile icon="IndianRupee" label="Net book value" value={moneyShort(f.nbv)} caption="Cost less depreciation (SLM / WDV)" accent="good"
          onDrill={() => drill('nbv', 'Book value by asset')} />
        <KpiTile icon="CalendarRange" label="Depreciation in period" value={moneyShort(f.period_dep)} caption={d.period.label} accent="brand"
          extra={d.compare && dep ? <span className="mt-1"><Delta flow={dep} compareLabel={d.compare.label} /></span> : undefined} />
        <KpiTile icon="Recycle" label="Disposal proceeds" value={moneyShort(f.disposal_proceeds)} caption={`${f.disposals.length} disposed in the period`} accent="neutral" />
        <KpiTile icon="CircleHelp" label="Not costed" value={f.uncosted} caption="Assets without a purchase cost (rented, donated, vendor-owned)" accent="warning" />
      </Grid>

      <Panel title="By category" icon="Boxes" subtitle={`Depreciation in ${d.period.label} · book value as at ${date(f.as_of)}`} pad={false}>
        {f.by_category.length === 0 ? <Empty icon="Boxes" title="No costed assets yet" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[760px] text-sm tabular">
              <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-right font-medium">Assets</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Acc. depreciation</th>
                  <th className="px-3 py-2 text-right font-medium">Net book value</th>
                  <th className="px-4 py-2 text-right font-medium">Depreciation in period</th>
                </tr>
              </thead>
              <tbody>
                {f.by_category.map((r) => (
                  <tr key={r.category} className="cursor-pointer border-b border-line hover:bg-surface-2" onClick={() => drill(`category:${r.category}`, r.category)}>
                    <td className="px-4 py-2 text-ink">{r.category}</td>
                    <td className="px-3 py-2 text-right">{number(r.count)}</td>
                    <td className="px-3 py-2 text-right">{money(r.cost, true)}</td>
                    <td className="px-3 py-2 text-right">{money(r.acc_dep, true)}</td>
                    <td className="px-3 py-2 text-right font-medium text-ink">{money(r.nbv, true)}</td>
                    <td className="px-4 py-2 text-right">{money(r.period_dep, true)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-surface-2 text-sm font-semibold text-ink">
                <tr>
                  <td className="px-4 py-2">Total</td>
                  <td className="px-3 py-2 text-right">{number(tot.count)}</td>
                  <td className="px-3 py-2 text-right">{money(tot.cost, true)}</td>
                  <td className="px-3 py-2 text-right">{money(tot.acc, true)}</td>
                  <td className="px-3 py-2 text-right">{money(tot.nbv, true)}</td>
                  <td className="px-4 py-2 text-right">{money(tot.pd, true)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>

      <Grid className="lg:grid-cols-3">
        <Panel title="By depreciation method" icon="Calculator" subtitle="SLM = straight line · WDV = written-down value">
          <ul className="space-y-3">
            {f.by_method.map((m) => (
              <li key={m.method}>
                <button type="button" onClick={() => drill(`method:${m.method}`, m.method)} className="w-full rounded-md px-1 py-1 text-left hover:bg-surface-2">
                  <div className="flex items-baseline justify-between text-sm"><span className="font-medium text-ink">{m.method}</span><span className="tabular text-ink">{moneyShort(m.nbv)}</span></div>
                  <div className="text-xs text-ink-3">{m.count} assets · cost {moneyShort(m.cost)}</div>
                </button>
              </li>
            ))}
            {!f.by_method.length && <li className="text-sm text-ink-3">No assets on the books.</li>}
          </ul>
        </Panel>
        <Panel title="Disposals in the period" icon="Recycle" subtitle="Proceeds against book value at disposal" pad={false} className="lg:col-span-2">
          {f.disposals.length ? (
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Asset</th>
                    <th className="px-3 py-2 text-left font-medium">Disposed</th>
                    <th className="px-3 py-2 text-left font-medium">Method</th>
                    <th className="px-3 py-2 text-right font-medium">Book value</th>
                    <th className="px-3 py-2 text-right font-medium">Proceeds</th>
                    <th className="px-4 py-2 text-right font-medium">Gain / loss</th>
                  </tr>
                </thead>
                <tbody>
                  {f.disposals.map((x) => (
                    <tr key={x.id} onClick={canAsset ? () => open({ fqn: 'assets.assets', id: x.id }) : undefined}
                      className={cn('border-b border-line last:border-0', canAsset && 'cursor-pointer hover:bg-surface-2')}>
                      <td className="px-4 py-2"><div className="font-mono text-xs text-ink-2">{x.code}</div><div className="text-ink">{x.name}</div></td>
                      <td className="px-3 py-2 tabular text-ink-2">{date(x.disposal_date)}</td>
                      <td className="px-3 py-2 text-ink-2">{x.method ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular">{money(x.nbv_at_disposal, true)}</td>
                      <td className="px-3 py-2 text-right tabular">{money(x.proceeds, true)}</td>
                      <td className="px-4 py-2 text-right tabular">
                        <Badge tone={x.gain_loss > 0 ? 'green' : x.gain_loss < 0 ? 'red' : 'gray'}>{x.gain_loss === 0 ? 'Nil' : `${x.gain_loss > 0 ? 'Gain' : 'Loss'} ${money(Math.abs(x.gain_loss), true)}`}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon="Recycle" title="No disposals in the period" />}
        </Panel>
      </Grid>
    </div>
  )
}
