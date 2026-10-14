/**
 * Command Centre — the role-aware home dashboard. Headline KPIs with deltas and sparklines, tabs
 * (Overview · Money · Patients · Beds & IP · TAT & Diagnostics · Alerts) and only what the user's
 * role can open: the server filters every tile, queue, chart and link by the permission matrix and
 * keeps money for finance-facing roles; quick actions are filtered here with canPage.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, BellRing, CheckCircle2, Star, Target } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, Input, Popover, Spinner, StatusBadge } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { ago, dateTime, minutes, number } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { DashboardBar, TvFrame, useAutoRefresh, useDashParams, useTvMode, queryOf } from './controls'
import {
  BarList, CardShell, ChartView, chartTable, Donut, fmtValue, Gauge, KpiTile, MiniTable, StatusPill, TrendChart, WardOccupancy,
} from './kit'
import type { AttentionItem, Catalogue, CommandResponse, NamedValue, TatSnapshot, Tile, TopList, Trend, Ward } from './types'

const TAB_META: Record<string, { label: string; icon: string }> = {
  overview: { label: 'Overview', icon: 'LayoutGrid' }, money: { label: 'Money', icon: 'IndianRupee' }, patients: { label: 'Patients', icon: 'Users' },
  beds: { label: 'Beds & IP', icon: 'BedDouble' }, tat: { label: 'TAT & Diagnostics', icon: 'Timer' }, alerts: { label: 'Alerts', icon: 'ShieldAlert' },
}

/** Quick actions — each shown only when the role can open the page. */
const QUICK: { label: string; icon: string; color: string; module: string; page: string }[] = [
  { label: 'Register patient', icon: 'UserPlus', color: 'bg-sky-600', module: 'registration', page: 'patient-registration' },
  { label: 'New OP bill', icon: 'ReceiptText', color: 'bg-emerald-600', module: 'billing', page: 'billing-desk' },
  { label: 'OP worklist', icon: 'Stethoscope', color: 'bg-cyan-700', module: 'opd', page: 'doctor-workbench' },
  { label: 'Appointments', icon: 'CalendarPlus', color: 'bg-indigo-600', module: 'appointments', page: 'booking-desk' },
  { label: 'Admit patient', icon: 'BedDouble', color: 'bg-violet-600', module: 'ipd', page: 'bed-board' },
  { label: 'Lab orders', icon: 'FlaskConical', color: 'bg-orange-600', module: 'lab', page: 'lab-worklist' },
  { label: 'Pharmacy billing', icon: 'Pill', color: 'bg-rose-600', module: 'pharmacy', page: 'pharmacy-dispensing' },
  { label: 'Patients', icon: 'Users', color: 'bg-teal-600', module: 'registration', page: 'patient-search' },
  { label: 'Queue console', icon: 'ListOrdered', color: 'bg-sky-700', module: 'queue', page: 'queue-console' },
  { label: 'Nursing station', icon: 'HeartPulse', color: 'bg-pink-600', module: 'nursing', page: 'nursing-station' },
  { label: 'Order entry', icon: 'ListPlus', color: 'bg-cyan-600', module: 'orders', page: 'cpoe' },
  { label: 'Result inbox', icon: 'Inbox', color: 'bg-amber-600', module: 'orders', page: 'result-inbox' },
  { label: 'Radiology worklist', icon: 'ScanLine', color: 'bg-slate-600', module: 'radiology', page: 'rad-worklist' },
  { label: 'Discharge board', icon: 'LogOut', color: 'bg-violet-700', module: 'discharge', page: 'discharge-board' },
  { label: 'Stock console', icon: 'Warehouse', color: 'bg-emerald-700', module: 'inventory', page: 'stock-console' },
  { label: 'Finance console', icon: 'Landmark', color: 'bg-teal-700', module: 'finance', page: 'finance-console' },
  { label: 'My approvals', icon: 'BadgeCheck', color: 'bg-amber-700', module: 'workflow', page: 'approvals-inbox' },
  { label: 'Duty roster', icon: 'CalendarClock', color: 'bg-indigo-700', module: 'roster', page: 'roster-planner' },
  { label: 'Payroll', icon: 'Wallet', color: 'bg-green-700', module: 'payroll', page: 'payroll-console' },
  { label: 'My self-service', icon: 'UserRound', color: 'bg-slate-700', module: 'ess', page: 'self-service' },
]

function useCommand(tab: string, params: ReturnType<typeof useDashParams>['params'], interval: number | false) {
  return useQuery({
    queryKey: ['dash', 'cc', tab, params],
    queryFn: () => api<CommandResponse>('/dashboards/command', { query: { ...queryOf(params), tab } }),
    placeholderData: (p) => (p?.tab === tab ? p : undefined),
    refetchInterval: interval,
    staleTime: 30_000,
  })
}

function TileGrid({ tiles, compare, lg }: { tiles?: Tile[]; compare?: string; lg?: boolean }) {
  if (!tiles?.length) return null
  return (
    <div className={cn('grid gap-3', tiles.length >= 6 ? 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6' : tiles.length >= 4 ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 md:grid-cols-3')}>
      {tiles.map((t) => <KpiTile key={t.key} t={t} compareText={t.key === 'revenue_total' ? compare : ''} size={lg ? 'lg' : 'md'} />)}
    </div>
  )
}

function TrendCard({ trend, compare, info }: { trend: Trend; compare?: string | null; info?: string }) {
  const money = trend.format === 'money'
  return (
    <CardShell title={money ? 'Revenue trend' : `${trend.label} trend`} icon={money ? 'IndianRupee' : 'TrendingUp'} info={info}
      subtitle={`${money ? 'OP + IP + pharmacy, daily' : 'Daily'}${compare ? ' · vs comparison period (dashed)' : ''}`}
      footer={{ label: money ? 'Revenue summary' : `${trend.label} report`, to: trend.link }}
      table={{ columns: ['Date', trend.label, 'Comparison'], rows: trend.points.map((p) => [p.date, fmtValue(p.value, trend.format), fmtValue(p.compare, trend.format)]) }}>
      <TrendChart points={trend.points} format={trend.format} label={money ? 'Revenue' : trend.label} compareLabel={compare} height={270} />
    </CardShell>
  )
}

const ATT_TONE: Record<string, string> = { amber: 'bg-amber-500', blue: 'bg-sky-600', red: 'bg-red-600' }
const ATT_BADGE: Record<string, 'amber' | 'blue' | 'red'> = { amber: 'amber', blue: 'blue', red: 'red' }

function AttentionCard({ items, clear, onAlerts }: { items: AttentionItem[]; clear: AttentionItem[]; onAlerts?: () => void }) {
  return (
    <CardShell title="Needs attention" icon="ShieldAlert" subtitle="Live queues for this branch">
      {!items.length && !clear.length && <p className="py-6 text-center text-sm text-ink-3">Nothing for your role to watch here.</p>}
      <ul className="space-y-2">
        {items.map((a) => {
          const body = (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface py-2 pl-0 pr-2 hover:bg-surface-2">
              <span className={cn('h-10 w-1 shrink-0 rounded-r', ATT_TONE[a.tone])} />
              <Icon name={a.icon} className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{a.label}</span>
                <span className="block truncate text-xs text-ink-3">{a.sub}</span>
              </span>
              <Badge tone={ATT_BADGE[a.tone]}>{number(a.count)}</Badge>
              {a.link && <ArrowRight className="size-4 text-ink-3" />}
            </div>
          )
          return <li key={a.key}>{a.link ? <Link to={a.link} aria-label={`${a.label}: ${a.count}`}>{body}</Link> : body}</li>
        })}
      </ul>
      {clear.length > 0 && (
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 dark:bg-emerald-500/10">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300"><CheckCircle2 className="size-3.5" /> Clear right now</p>
          <ul className="mt-1 space-y-0.5 text-xs text-emerald-900/80 dark:text-emerald-200/80">{clear.map((c) => <li key={c.key}>{c.label}</li>)}</ul>
        </div>
      )}
      {onAlerts && (
        <button type="button" onClick={onAlerts} className="no-print mt-3 inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:underline dark:text-red-300">
          Open the alerts board <ArrowRight className="size-3" />
        </button>
      )}
    </CardShell>
  )
}

function TargetSetter({ code, current, onSaved }: { code: string; current: number | null; onSaved: () => void }) {
  const [v, setV] = useState(current === null ? '' : String(current))
  const [busy, setBusy] = useState(false)
  const pctTarget = code === 'TAT-LAB-SLA'
  return (
    <Popover align="right" className="w-56 p-3" trigger={({ toggle }) => (
      <button type="button" onClick={toggle} className="no-print inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline dark:text-brand-300" title="Set target">
        <Target className="size-3" />{current === null ? 'Set target' : 'Edit target'}
      </button>
    )}>
      {(close) => (
        <form onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await api('/dashboards/targets', { method: 'POST', body: { code, target: v === '' ? null : Number(v) } })
            toast.success('Target saved')
            onSaved()
            close()
          } catch (err) { toast.error(errorMessage(err)) } finally { setBusy(false) }
        }}>
          <label className="text-xs font-medium text-ink-2" htmlFor={`t-${code}`}>{pctTarget ? 'Target (% within SLA)' : 'Target median (minutes)'}</label>
          <Input id={`t-${code}`} type="number" min={0} max={pctTarget ? 100 : 100000} value={v} onChange={(e) => setV(e.target.value)} className="mt-1 h-8" autoFocus />
          <p className="mt-1 text-[11px] text-ink-3">Leave empty for “No target set”. Stored in the metric dictionary.</p>
          <Button size="sm" variant="primary" type="submit" loading={busy} className="mt-2 w-full">Save</Button>
        </form>
      )}
    </Popover>
  )
}

function TatCard({ tat, onSaved }: { tat: TatSnapshot; onSaved: () => void }) {
  if (!tat.gauge && !tat.items.length) return null
  const g = tat.gauge
  return (
    <CardShell title="Turnaround snapshot" icon="Timer" subtitle="Medians over the period · p90 and measurement coverage"
      footer={{ label: 'Lab TAT report', to: g?.link ?? tat.items[0]?.link }}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {g && (
          <div className="flex flex-col items-center rounded-lg bg-surface-2 px-3 py-3 text-center xl:col-span-2">
            <p className="text-xs font-medium text-ink-2">{g.label}</p>
            <Gauge pct={g.pct} target={g.target} />
            <StatusPill ok={g.on_target} text={g.target === null ? 'No target set' : `${g.on_target ? 'On target' : 'Below target'} · target ${g.target}%`} />
            <p className="mt-0.5 text-[11px] text-ink-3">{number(g.within)} within SLA · {number(g.measured)} of {number(g.total)} measured</p>
            {tat.can_set_targets && <div className="mt-1"><TargetSetter code={g.target_code} current={g.target} onSaved={onSaved} /></div>}
          </div>
        )}
        {tat.items.map((it) => (
          <div key={it.key} className="flex flex-col rounded-lg border border-line px-3 py-2.5">
            <p className="text-xs font-semibold text-ink">{it.label}</p>
            <p className="text-[11px] text-ink-3">{it.sub}</p>
            <p className="mt-1.5"><span className="text-xl font-semibold tabular-nums text-ink">{it.median === null ? '—' : minutes(it.median)}</span> <span className="text-xs text-ink-3">median</span></p>
            <p className="text-[11px] text-ink-2">p90 {it.p90 === null ? '—' : minutes(it.p90)} · {it.target === null ? 'No target set' : `target ${minutes(it.target)}`}</p>
            {it.target !== null && it.median !== null && <StatusPill ok={it.on_target} text={it.on_target ? 'On target' : 'Over target'} />}
            <div className="mt-auto pt-2">
              <div className="h-1.5 rounded-full bg-surface-2"><div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, it.coverage ?? 0)}%`, background: 'var(--s4)' }} /></div>
              <p className="mt-0.5 text-[11px] text-ink-3">{number(it.measured)} of {number(it.total)} measured ({it.coverage ?? 0}%)</p>
              <div className="flex items-center justify-between">
                {it.link ? <Link to={it.link} className="text-[11px] text-brand-700 hover:underline dark:text-brand-300">Detail</Link> : <span />}
                {tat.can_set_targets && <TargetSetter code={it.target_code} current={it.target} onSaved={onSaved} />}
              </div>
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  )
}

function DonutCard({ title, icon, rows, format = 'money', center, link, linkLabel, info }: {
  title: string; icon: string; rows: NamedValue[]; format?: string; center: string; link?: string | null; linkLabel?: string; info?: string
}) {
  return (
    <CardShell title={title} icon={icon} info={info} footer={{ label: linkLabel ?? title, to: link }}
      table={{ columns: ['Name', 'Value', 'Share'], rows: rows.map((r) => [r.name, fmtValue(r.value, format), r.share !== undefined && r.share !== null ? `${r.share}%` : '—']) }}>
      <Donut rows={rows} format={format} centerLabel={center} />
    </CardShell>
  )
}

function BarListCard({ title, icon, list, format = 'money', linkLabel, info }: { title: string; icon: string; list: TopList; format?: string; linkLabel: string; info?: string }) {
  return (
    <CardShell title={title} icon={icon} info={info} footer={{ label: linkLabel, to: list.link }}
      table={{ columns: ['Name', 'Value', 'Share'], rows: list.rows.map((r) => [r.name, fmtValue(r.value, format), `${r.share ?? 0}%`]) }}>
      <BarList list={list} format={format} />
    </CardShell>
  )
}

function ChartCard({ title, icon, rows, x, ys, type = 'bar', link, linkLabel, stacked, horizontal, height }: {
  title: string; icon?: string; rows?: Record<string, unknown>[] | null; x: string; ys: { key: string; label: string; type?: string }[]
  type?: 'bar' | 'line' | 'area' | 'donut'; link?: string | null; linkLabel?: string; stacked?: boolean; horizontal?: boolean; height?: number
}) {
  if (!rows) return null
  const spec = { type, x, y: ys.map((y) => ({ key: y.key, label: y.label, type: y.type ?? 'number' })), data: rows, stacked, horizontal }
  return (
    <CardShell title={title} icon={icon} footer={{ label: linkLabel ?? 'Open report', to: link }} table={chartTable(spec)}>
      <ChartView spec={spec} height={height ?? 240} />
    </CardShell>
  )
}

function QuickActions() {
  const reg = useRegistry()
  const nav = useNavigate()
  const items = QUICK.filter((q) => reg.canPage(q.module, q.page)).slice(0, 8)
  if (!items.length) return null
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink">Quick actions</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {items.map((q) => (
          <button key={`${q.module}.${q.page}`} type="button" onClick={() => nav(`/m/${q.module}/${q.page}`)}
            className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface px-2 py-3 text-center text-xs font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-brand-600/40 hover:bg-surface-2">
            <span className={cn('grid size-9 place-items-center rounded-lg text-white', q.color)}><Icon name={q.icon} className="size-4" /></span>
            {q.label}
          </button>
        ))}
      </div>
    </section>
  )
}

function YourDashboards() {
  const q = useQuery({ queryKey: ['dash', 'catalogue'], queryFn: () => api<Catalogue>('/dashboards'), staleTime: 60_000 })
  const d = q.data
  if (!d || !d.total) return null
  const all = d.groups.flatMap((g) => g.dashboards.filter((x) => x.kind === 'builtin'))
  const fav = [...all, ...d.custom].filter((x) => d.favourites.includes(x.key))
  const picks = [...fav, ...d.groups.map((g) => g.dashboards.find((x) => x.kind === 'builtin')).filter(Boolean) as typeof all]
  const uniq = [...new Map(picks.map((p) => [p.key, p])).values()].slice(0, 7)
  const tiles = [...uniq, ...(d.groups.some((g) => g.key === 'custom') ? [{ key: 'mine', name: 'My Dashboards', icon: 'LayoutGrid', kind: 'link' as const,
    description: 'Dashboards built in the designer — yours and the ones shared with you.' }] : [])]
  return (
    <section>
      <div className="mb-2 flex items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Your dashboards</h2>
          <p className="text-xs text-ink-3">{d.total} open to you — your favourites and a pick from each area</p>
        </div>
        <Link to="/dashboards" className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2">
          All {d.total} dashboards <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((x) => (
          <Link key={x.key} to={`/dashboards/${x.key}`} className="group flex gap-3 rounded-xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-brand-600/40">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-brand-700 dark:text-brand-300"><Icon name={x.icon} className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">{x.name}
                {'new' in x && x.new && <Badge tone="green">New</Badge>}
                {d.favourites.includes(x.key) && <Star className="size-3 fill-amber-400 text-amber-500" aria-label="Favourite" />}</span>
              <span className="mt-0.5 line-clamp-2 block text-xs text-ink-3">{x.description}</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-ink-3 group-hover:text-ink" />
          </Link>
        ))}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ tabs

type D = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function Overview({ d, cmp, onAlerts, onSaved }: { d: D; cmp?: string | null; onAlerts: () => void; onSaved: () => void }) {
  return (
    <div className="space-y-4">
      <TileGrid tiles={d.tiles} />
      <div className="grid gap-4 xl:grid-cols-3">
        {d.trend && <div className="xl:col-span-2"><TrendCard trend={d.trend} compare={cmp} info="Bills raised per day (confirmed bills, net of discount) against the same days of the comparison window." /></div>}
        <div className={cn(!d.trend && 'xl:col-span-3')}><AttentionCard items={d.attention ?? []} clear={d.clear ?? []} onAlerts={onAlerts} /></div>
      </div>
      {(d.streams || d.departments || d.wards) && (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {d.streams && <DonutCard title="Revenue by stream" icon="CircleDollarSign" rows={d.streams.rows} center="Revenue" link={d.streams.link}
            info="Charges at the point of service by stream: inpatient, OP consultations, OP laboratory, OP radiology, procedures, pharmacy." />}
          {d.departments && <BarListCard title="Top departments" icon="Building2" list={d.departments} linkLabel="Department-wise revenue" />}
          {d.wards && (
            <CardShell title="Occupancy by ward" icon="BedDouble" subtitle="In-patients now ÷ operational beds" footer={{ label: 'Bed occupancy by ward', to: d.wards.link }}
              table={{ columns: ['Ward', 'Occupied', 'Operational', 'Blocked', '%', 'Status'], rows: (d.wards.rows as Ward[]).map((w) => [w.ward, w.occupied, w.operational, w.blocked, `${w.pct}%`, w.band]) }}>
              <WardOccupancy rows={d.wards.rows} />
            </CardShell>
          )}
        </div>
      )}
      {d.tat && <TatCard tat={d.tat} onSaved={onSaved} />}
    </div>
  )
}

function Money({ d }: { d: D }) {
  return (
    <div className="space-y-4">
      <TileGrid tiles={d.tiles} />
      <div className="grid gap-4 xl:grid-cols-3">
        {d.by_type && <div className="xl:col-span-2"><ChartCard title="Revenue by bill type" icon="ChartColumnStacked" rows={d.by_type.rows} x="period" stacked link={d.by_type.link}
          ys={[{ key: 'op', label: 'OP', type: 'money' }, { key: 'ip', label: 'IP', type: 'money' }, { key: 'pharmacy', label: 'Pharmacy', type: 'money' }, { key: 'other', label: 'Other', type: 'money' }]}
          linkLabel="Revenue trend" height={270} /></div>}
        {d.modes && <DonutCard title="Collections by mode" icon="Banknote" rows={d.modes.rows} center="Collected" link={d.modes.link} linkLabel="Daily collection by mode" />}
      </div>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {d.payers && <DonutCard title="Revenue by payer" icon="Landmark" rows={d.payers.rows} center="Net billed" link={d.payers.link} linkLabel="Payer-wise revenue" />}
        {d.doctors && <BarListCard title="Top doctors by revenue" icon="Stethoscope" list={d.doctors} linkLabel="Doctor-wise revenue" />}
        {d.ageing && <BarListCard title="Outstanding ageing" icon="CalendarClock" list={{ rows: d.ageing.rows, others: null, total: 0, link: d.ageing.link }} linkLabel="Sponsor / credit outstanding" />}
      </div>
    </div>
  )
}

function Patients({ d, cmp }: { d: D; cmp?: string | null }) {
  return (
    <div className="space-y-4">
      <TileGrid tiles={d.tiles} />
      <div className="grid gap-4 xl:grid-cols-3">
        {d.trend && <div className="xl:col-span-2"><TrendCard trend={d.trend} compare={cmp} /></div>}
        {d.mix && <DonutCard title="New vs revisit" icon="Users" rows={d.mix.rows} format="number" center="Visits seen" link={d.departments?.link} linkLabel="New vs revisit analysis" />}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {d.departments && <ChartCard title="OP visits by department" icon="Building2" rows={d.departments.rows} x="group" stacked horizontal link={d.departments.link}
          ys={[{ key: 'new', label: 'New' }, { key: 'follow_up', label: 'Follow-up' }, { key: 'review', label: 'Review with reports' }]} />}
        {d.doctors && <BarListCard title="Patients seen by doctor" icon="Stethoscope" list={d.doctors} format="number" linkLabel="Doctor-wise consultations" />}
        {d.hourly && <ChartCard title="OP load by hour" icon="Clock3" rows={d.hourly.rows} x="hour" ys={[{ key: 'total', label: 'Visits' }]} link={d.hourly.link} linkLabel="Hourly OP load" />}
        {d.no_shows && (
          <CardShell title="No-shows & cancellations" icon="CalendarX2" footer={{ label: 'No-show analysis', to: d.no_shows.link }}>
            <BarList list={{ rows: d.no_shows.rows, others: null, total: 0 }} format="number" color="var(--s2)" />
          </CardShell>
        )}
      </div>
    </div>
  )
}

function Beds({ d }: { d: D }) {
  return (
    <div className="space-y-4">
      <TileGrid tiles={d.tiles} />
      <div className="grid gap-4 xl:grid-cols-3">
        {d.wards && (
          <CardShell title="Occupancy by ward" icon="BedDouble" subtitle="In-patients now ÷ operational beds" footer={{ label: 'Bed occupancy & turnover', to: d.wards.link }}
            table={{ columns: ['Ward', 'Occupied', 'Operational', 'Blocked', '%'], rows: (d.wards.rows as Ward[]).map((w) => [w.ward, w.occupied, w.operational, w.blocked, `${w.pct}%`]) }}>
            <WardOccupancy rows={d.wards.rows} show={10} />
          </CardShell>
        )}
        <div className="space-y-4 xl:col-span-2">
          {d.census && <ChartCard title="Admissions vs discharges" icon="ArrowLeftRight" rows={d.census.rows} x="date" link={d.census.link} linkLabel="Daily IP census"
            ys={[{ key: 'admissions', label: 'Admissions' }, { key: 'discharges', label: 'Discharges' }]} />}
          {d.census && <ChartCard title="Midnight census" icon="Activity" rows={d.census.rows} x="date" type="line" link={d.census.link} linkLabel="Daily IP census"
            ys={[{ key: 'closing', label: 'In-patients at midnight' }]} />}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {d.alos && <ChartCard title="ALOS by department" icon="CalendarDays" rows={d.alos.rows} x="department" horizontal ys={[{ key: 'alos', label: 'ALOS (days)', type: 'days' }]} link={d.alos.link} linkLabel="ALOS by department" />}
        {d.pending_discharges && (
          <CardShell title="Discharges awaiting settlement" icon="LogOut" footer={{ label: 'Discharge board', to: d.pending_discharges.link }}>
            {d.pending_discharges.rows.length ? (
              <MiniTable columns={['IP no', 'Patient', 'Initiated']} rows={d.pending_discharges.rows.map((r: D) => [r.ip_no, r.patient, r.initiated_at ? ago(r.initiated_at) : '—'])} />
            ) : <p className="py-6 text-center text-sm text-ink-3">No discharges waiting</p>}
          </CardShell>
        )}
        {d.long_stays && (
          <CardShell title={`Long stays (${d.long_stays.count} over 15 days)`} icon="Hourglass" footer={{ label: 'Long-stay patients', to: d.long_stays.link }}>
            {d.long_stays.rows.length ? (
              <MiniTable columns={['IP no', 'Patient', 'Days', 'Ward', 'Consultant']} rows={d.long_stays.rows.map((r: D) => [r.ip_no, r.patient, r.los_days, r.ward ?? '—', r.consultant ?? '—'])} />
            ) : <p className="py-6 text-center text-sm text-ink-3">No patient has stayed over 15 days</p>}
          </CardShell>
        )}
      </div>
    </div>
  )
}

function Tat({ d, onSaved }: { d: D; onSaved: () => void }) {
  return (
    <div className="space-y-4">
      <TileGrid tiles={d.tiles} />
      {d.tat && <TatCard tat={d.tat} onSaved={onSaved} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {d.lab_breaches && (
          <CardShell title="Lab TAT breaches by test" icon="Timer" subtitle="Collection → release against each test's SLA" footer={{ label: 'Lab TAT detail', to: d.lab_breaches.link }}>
            <MiniTable columns={['Test', 'SLA', 'Tests', 'Median', 'p90', 'Breaches', 'Within SLA']}
              rows={d.lab_breaches.rows.map((r: D) => [r.test, minutes(r.sla), r.tests, minutes(r.median), minutes(r.p90), r.breaches, r.within_pct === null ? '—' : `${r.within_pct}%`])} />
          </CardShell>
        )}
        {d.er_triage && (
          <CardShell title="ER door-to-doctor by triage" icon="Siren" footer={{ label: 'ER triage report', to: d.er_triage.link }}>
            <MiniTable columns={['Triage', 'Visits', 'Median', 'p90', 'Target', 'Within']}
              rows={d.er_triage.rows.map((r: D) => [r.triage, r.visits, minutes(r.median), minutes(r.p90), r.target === null ? '—' : minutes(r.target), r.within_pct === null ? '—' : `${r.within_pct}%`])} />
          </CardShell>
        )}
        {d.lab_volumes && <ChartCard title="Top lab tests" icon="FlaskConical" rows={d.lab_volumes.rows} x="test" horizontal ys={[{ key: 'ordered', label: 'Ordered' }]} link={d.lab_volumes.link} linkLabel="Lab test volumes" />}
        {d.backlog && (
          <CardShell title="Diagnostics backlog" icon="ListTodo" footer={{ label: 'Backlog & pending ageing', to: d.backlog.link }}>
            <div className="grid grid-cols-3 gap-2">
              {(d.backlog.summary as { label: string; value: number }[]).map((s) => (
                <div key={s.label} className="rounded-lg bg-surface-2 px-3 py-2"><p className="text-[11px] text-ink-3">{s.label}</p><p className="text-lg font-semibold tabular-nums text-ink">{number(s.value)}</p></div>
              ))}
            </div>
          </CardShell>
        )}
      </div>
    </div>
  )
}

const SEV: Record<string, 'red' | 'amber' | 'blue'> = { Critical: 'red', Warning: 'amber', Info: 'blue' }

function Alerts({ d }: { d: D }) {
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <AttentionCard items={d.attention ?? []} clear={d.clear ?? []} />
      <div className="space-y-4 xl:col-span-2">
        {d.alerts && (
          <CardShell title="Threshold alerts" icon="BellRing" subtitle="Open and acknowledged alerts from the alert rules" footer={{ label: 'All alerts', to: d.alerts_link }}>
            {d.alerts.length ? (
              <ul className="divide-y divide-line">
                {d.alerts.map((a: D) => (
                  <li key={a.id} className="flex items-start gap-3 py-2">
                    <BellRing className="mt-0.5 size-4 text-ink-3" />
                    <div className="min-w-0 flex-1"><p className="text-sm text-ink">{a.message}</p><p className="text-xs text-ink-3">{a.code} · {dateTime(a.triggered_at)}{a.escalated ? ' · escalated' : ''}</p></div>
                    <Badge tone={SEV[a.severity] ?? 'gray'}>{a.severity}</Badge>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            ) : <Empty icon="BellOff" title="No open alerts">Alert rules have nothing to report.</Empty>}
          </CardShell>
        )}
        {d.critical && (
          <CardShell title="Critical results awaiting acknowledgement" icon="AlertTriangle" footer={{ label: 'Result inbox', to: d.critical.link }}>
            {d.critical.rows.length ? (
              <MiniTable columns={['Order', 'Patient', 'Test', 'Resulted']} rows={d.critical.rows.map((r: D) => [r.order, r.patient, r.test ?? '—', r.resulted_at ? ago(r.resulted_at) : '—'])} />
            ) : <p className="py-6 text-center text-sm text-ink-3">Every critical result has been acknowledged.</p>}
          </CardShell>
        )}
      </div>
    </div>
  )
}

export default function CommandCentre() {
  const reg = useRegistry()
  const qc = useQueryClient()
  const { params, set, tab: urlTab } = useDashParams('this_month')
  const auto = useAutoRefresh()
  const frame = useRef<HTMLDivElement>(null)
  const tv = useTvMode(frame)
  const [refreshing, setRefreshing] = useState(false)
  const query = useCommand(urlTab, params, auto.interval)
  const res = query.data
  const [knownTabs, setKnownTabs] = useState<string[]>(['overview'])
  const tabs = res?.tabs ?? knownTabs
  const tab = urlTab
  useEffect(() => { if (res?.tabs) setKnownTabs(res.tabs) }, [res?.tabs])
  useEffect(() => {  // a tab this role cannot open (old link) falls back to the overview
    if (urlTab !== 'overview' && query.error instanceof ApiError && query.error.status === 403) set({ tab: undefined })
  }, [urlTab, query.error, set])

  const refresh = async () => {
    setRefreshing(true)
    try {
      const fresh = await api<CommandResponse>('/dashboards/command', { query: { ...queryOf(params), tab, refresh: 1 } })
      qc.setQueryData(['dash', 'cc', tab, params], fresh)
      qc.invalidateQueries({ queryKey: ['dash', 'catalogue'] })
    } catch (e) { toast.error(errorMessage(e)) } finally { setRefreshing(false) }
  }

  const tabBar = (
    <div className={cn('no-print sticky z-10', tv.tv ? 'top-0' : 'top-14')}><div className=" -mx-1 mb-3 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface/95 p-1 backdrop-blur scroll-thin" role="tablist" aria-label="Command Centre sections">
      {tabs.map((k) => {
        const m = TAB_META[k]
        return (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => set({ tab: k })}
            className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium', tab === k ? 'bg-brand-800 text-white dark:bg-brand-600' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
            <Icon name={m.icon} className="size-4" /> {m.label}
            {k === 'alerts' && (res?.alert_count ?? 0) > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[11px] font-semibold text-white" aria-label={`${res?.alert_count} queues need attention`}>{res?.alert_count}</span>}
          </button>
        )
      })}
    </div></div>
  )

  const nothing = res && !res.headline?.length && !res.data?.tiles?.length && !(res.data?.attention?.length)
  return (
    <TvFrame tv={tv.tv} frameRef={frame}>
      <div className="space-y-4">
        <div>
          <DashboardBar chip="Command Centre" params={params} onChange={set} range={res?.range} compare={res?.compare} updatedAt={query.dataUpdatedAt}
            fetching={query.isFetching || refreshing} onRefresh={refresh} auto={auto.secs} onAuto={auto.setSecs} tv={tv.tv} onTv={tv.toggle} />
          {res?.headline && res.headline.length > 0 && <TileGrid tiles={res.headline} compare={res.compare?.label} lg />}
        </div>
        {tabs.length > 1 && tabBar}
        {query.isLoading && <Spinner label="Loading the Command Centre…" />}
        {query.error && <ErrorBox error={query.error} />}
        {res && tab === 'overview' && res.tab === 'overview' && <Overview d={res.data} cmp={res.compare?.label} onAlerts={() => set({ tab: tabs.includes('alerts') ? 'alerts' : 'overview' })} onSaved={refresh} />}
        {res && tab === 'money' && res.tab === 'money' && <Money d={res.data} />}
        {res && tab === 'patients' && res.tab === 'patients' && <Patients d={res.data} cmp={res.compare?.label} />}
        {res && tab === 'beds' && res.tab === 'beds' && <Beds d={res.data} />}
        {res && tab === 'tat' && res.tab === 'tat' && <Tat d={res.data} onSaved={refresh} />}
        {res && tab === 'alerts' && res.tab === 'alerts' && <Alerts d={res.data} />}
        {nothing && (
          <Card title="Welcome" icon="UserRound">
            <p className="text-sm text-ink-2">Your role has no hospital dashboards. {reg.canPage('ess', 'self-service') ? 'Use My self-service for leave, payslips, roster and training.' : ''}</p>
          </Card>
        )}
        {!tv.tv && tab === 'overview' && <QuickActions />}
        {!tv.tv && tab === 'overview' && <YourDashboards />}
      </div>
    </TvFrame>
  )
}
