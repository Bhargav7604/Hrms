import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Bars, ChartFrame, Lines } from '@/components/charts'
import { Card, cn, Empty, ErrorBox, Input, Segmented, Spinner, StatTile } from '@/components/ui'
import { api } from '@/lib/api'
import { minutes, money, moneyShort, number, todayISO } from '@/lib/format'
import type { BespokeProps } from './index'

type Group = 'day' | 'week' | 'month'
type Preset = '7' | '14' | '30' | '90' | 'mtd' | 'custom'
type Point = {
  period: string; op: number; op_seen: number; ip: number; er: number; revenue: number; collections: number; refunds: number
  pharmacy: number; lab_orders: number; lab_tat: number | null; rad_orders: number; rad_tat: number | null
}
type Slice = { name: string; revenue: number; lines?: number; bills?: number }
interface Doctor { doctor_id: string | null; name: string; department?: string | null; booked: number; seen: number; no_show: number; op_revenue: number; ip_revenue: number }
interface Totals { revenue: number; collections: number; bills: number; op: number; op_seen: number; ip: number; er: number; discharges: number; alos_days: number | null }
interface Analytics {
  range: { from: string; to: string; group: Group; days: number; previous: { from: string; to: string } }
  kpis: Totals & { lab_tat_min: number | null; rad_tat_min: number | null; lab_orders: number; rad_orders: number; occupancy_pct: number; pharmacy: number; arpob: number | null }
  previous: Totals; series: Point[]; by_department: Slice[]; by_category: Slice[]; by_sponsor: Slice[]; by_patient_category: Slice[]
  doctors: Doctor[]; top_diagnoses: { diagnosis: string; admissions: number }[]
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function presetRange(p: Preset): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  if (p === 'mtd') from.setDate(1)
  else from.setDate(to.getDate() - (Number(p) - 1))
  return { from: iso(from), to: iso(to) }
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function periodLabel(p: string, g: Group) {
  const [y, m, d] = p.split('-').map(Number)
  if (g === 'month') return `${MONTHS[m - 1]} ${String(y).slice(2)}`
  return `${g === 'week' ? 'w/c ' : ''}${d} ${MONTHS[m - 1]}`
}
const short = (v: number) => moneyShort(v)
const pct = (cur: number, prev: number) => (prev ? ((cur - prev) / prev) * 100 : null)

function Delta({ cur, prev, label }: { cur: number; prev: number; label: string }) {
  const d = pct(cur, prev)
  if (d === null) return <span>No data for {label}</span>
  const up = d >= 0
  return (
    <span className="inline-flex items-center gap-0.5">
      {up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
      {up ? '+' : '−'}{Math.abs(d).toFixed(1)}% vs {label}
    </span>
  )
}

function SliceChart({ title, subtitle, data, unit = 'Revenue' }: { title: string; subtitle?: string; data: Slice[]; unit?: string }) {
  const rows = data.slice(0, 12)
  const total = data.reduce((a, b) => a + b.revenue, 0)
  return (
    <ChartFrame title={title} subtitle={subtitle} height={Math.max(180, rows.length * 30 + 30)}
      table={{ columns: ['Name', unit, 'Share'], rows: data.map((r) => [r.name, money(r.revenue, true), total ? `${((r.revenue / total) * 100).toFixed(1)}%` : '—']) }}>
      {rows.length ? <Bars data={rows} x="name" horizontal series={[{ key: 'revenue', label: unit }]} fmt={short} />
        : <Empty icon="ChartBar" title="No revenue in this range" />}
    </ChartFrame>
  )
}

type DocSort = 'seen' | 'booked' | 'no_show' | 'op_revenue' | 'ip_revenue'

function DoctorTable({ rows }: { rows: Doctor[] }) {
  const [sort, setSort] = useState<DocSort>('seen')
  const sorted = useMemo(() => [...rows].sort((a, b) => (b[sort] as number) - (a[sort] as number)), [rows, sort])
  const cols: [DocSort | null, string][] = [[null, 'Doctor'], [null, 'Department'], ['booked', 'Booked'], ['seen', 'Seen'], ['no_show', 'No-show'], ['op_revenue', 'OP consult revenue'], ['ip_revenue', 'IP revenue (attending)']]
  if (!rows.length) return <Empty icon="Stethoscope" title="No OPD appointments in this range" />
  return (
    <div className="max-h-[420px] overflow-auto scroll-thin">
      <table className="w-full text-sm">
        <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
          <tr>{cols.map(([k, label]) => (
            <th key={label} className={cn('whitespace-nowrap px-3 py-2 font-medium', k ? 'text-right' : 'text-left')}>
              {k ? <button className={cn('hover:text-ink', sort === k && 'text-ink underline')} onClick={() => setSort(k)}>{label}</button> : label}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.doctor_id ?? d.name} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-3 py-1.5 text-ink">{d.name}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-ink-2">{d.department ?? '—'}</td>
              <td className="px-3 py-1.5 text-right tabular">{number(d.booked)}</td>
              <td className="px-3 py-1.5 text-right tabular">{number(d.seen)}</td>
              <td className="px-3 py-1.5 text-right tabular">{number(d.no_show)} <span className="text-ink-3">({d.booked ? ((d.no_show / d.booked) * 100).toFixed(0) : 0}%)</span></td>
              <td className="px-3 py-1.5 text-right tabular">{money(d.op_revenue, true)}</td>
              <td className="px-3 py-1.5 text-right tabular">{money(d.ip_revenue, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AnalyticsPage(_: BespokeProps) {
  const [preset, setPreset] = useState<Preset>('14')
  const [range, setRange] = useState(() => presetRange('14'))
  const [group, setGroup] = useState<Group>('day')
  const choose = (p: Preset) => {
    setPreset(p)
    if (p !== 'custom') {
      setRange(presetRange(p))
      setGroup(p === '90' ? 'week' : 'day')
    }
  }
  const q = useQuery({
    queryKey: ['x', 'analytics', range.from, range.to, group],
    queryFn: () => api<Analytics>('/insights/analytics', { query: { from: range.from, to: range.to, group } }),
    placeholderData: (p) => p,
    staleTime: 60_000,
  })
  const d = q.data
  const series = useMemo(() => (d?.series ?? []).map((p) => ({ ...p, label: periodLabel(p.period, d!.range.group) })), [d])
  const prevLabel = d ? `previous ${d.range.days} d` : ''

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2 rounded-xl border border-brand-600/20 bg-brand-50/60 px-3 py-2 text-sm dark:bg-brand-500/5">
        <span className="text-ink-2">More analytics:</span>
        <Link to="/reports" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Reports Hub</Link>
        <span className="text-ink-3">·</span>
        <Link to="/dashboards" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Dashboards catalogue</Link>
        <span className="text-ink-3">·</span>
        <Link to="/dashboards/designer" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Dashboard Designer</Link>
      </div>
      <div className="no-print flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <Segmented value={preset} onChange={choose} options={[
          { key: '7', label: '7 days' }, { key: '14', label: '14 days' }, { key: '30', label: '30 days' }, { key: '90', label: '90 days' },
          { key: 'mtd', label: 'Month to date' }, { key: 'custom', label: 'Custom' },
        ]} />
        <div className="flex items-center gap-1 text-xs text-ink-2">
          <Input type="date" className="h-8 w-36" value={range.from} max={range.to} aria-label="From"
            onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })) }} />
          <span>to</span>
          <Input type="date" className="h-8 w-36" value={range.to} min={range.from} max={todayISO()} aria-label="To"
            onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })) }} />
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-2">
          Group by
          <Segmented value={group} onChange={setGroup} options={[{ key: 'day', label: 'Day' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' }]} />
        </div>
      </div>

      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <Spinner label="Crunching numbers…" />}
      {d && (
        <div className={cn('space-y-4', q.isFetching && 'opacity-80')}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile icon="IndianRupee" label="Revenue (billed)" value={moneyShort(d.kpis.revenue)} hint={<Delta cur={d.kpis.revenue} prev={d.previous.revenue} label={prevLabel} />} />
            <StatTile icon="Wallet" label="Collections" value={moneyShort(d.kpis.collections)} hint={<Delta cur={d.kpis.collections} prev={d.previous.collections} label={prevLabel} />} />
            <StatTile icon="Stethoscope" label="OP visits" value={number(d.kpis.op)} hint={<Delta cur={d.kpis.op} prev={d.previous.op} label={prevLabel} />} />
            <StatTile icon="BedDouble" label="Admissions" value={number(d.kpis.ip)} hint={<Delta cur={d.kpis.ip} prev={d.previous.ip} label={prevLabel} />} />
            <StatTile icon="Siren" label="ER visits" value={number(d.kpis.er)} hint={<Delta cur={d.kpis.er} prev={d.previous.er} label={prevLabel} />} />
            <StatTile icon="Percent" label="Bed occupancy now" value={`${number(d.kpis.occupancy_pct)}%`} hint={`ALOS ${d.kpis.alos_days ?? '—'} d · ARPOB ${d.kpis.arpob ? money(d.kpis.arpob, true) : '—'}/day`} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile icon="FlaskConical" label="Lab orders · avg TAT" value={number(d.kpis.lab_orders)} hint={`Avg TAT ${minutes(d.kpis.lab_tat_min)}`} />
            <StatTile icon="ScanLine" label="Radiology studies · avg TAT" value={number(d.kpis.rad_orders)} hint={`Avg TAT ${minutes(d.kpis.rad_tat_min)}`} />
            <StatTile icon="Pill" label="Pharmacy sales" value={moneyShort(d.kpis.pharmacy)} hint="Pharmacy bills + counter dispensing" />
            <StatTile icon="LogOut" label="Discharges" value={number(d.kpis.discharges)} hint={<Delta cur={d.kpis.discharges} prev={d.previous.discharges} label={prevLabel} />} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartFrame title="Patient volumes" subtitle={`OP appointments, admissions and ER visits per ${group}`}
              table={{ columns: ['Period', 'OP booked', 'OP seen', 'Admissions', 'ER'], rows: series.map((p) => [p.label, p.op, p.op_seen, p.ip, p.er]) }}>
              <Lines data={series} x="label" series={[{ key: 'op', label: 'OP' }, { key: 'ip', label: 'Admissions' }, { key: 'er', label: 'ER' }]} fmt={(v) => number(v)} />
            </ChartFrame>
            <ChartFrame title="Revenue vs collections" subtitle="Net billed vs money received (payments + deposits)"
              table={{ columns: ['Period', 'Revenue', 'Collections', 'Refunds'], rows: series.map((p) => [p.label, money(p.revenue, true), money(p.collections, true), money(p.refunds, true)]) }}>
              <Bars data={series} x="label" series={[{ key: 'revenue', label: 'Revenue' }, { key: 'collections', label: 'Collections' }]} fmt={short} />
            </ChartFrame>
            <SliceChart title="Revenue by department" subtitle="Charges at point of service (service or treating department)" data={d.by_department} />
            <SliceChart title="Revenue by sponsor" subtitle="Bills by payer: self-pay, insurance, schemes, corporates" data={d.by_sponsor} />
            <SliceChart title="Revenue by service category" subtitle="Charges grouped by tariff category" data={d.by_category} />
            <SliceChart title="Revenue by patient category" subtitle="General, staff, senior citizen, VIP, international…" data={d.by_patient_category} />
            <ChartFrame title="Investigation turnaround" subtitle={`Average order → report minutes per ${group}`}
              table={{ columns: ['Period', 'Lab orders', 'Lab TAT', 'Radiology', 'Radiology TAT'], rows: series.map((p) => [p.label, p.lab_orders, minutes(p.lab_tat), p.rad_orders, minutes(p.rad_tat)]) }}>
              <Lines data={series} x="label" series={[{ key: 'lab_tat', label: 'Lab TAT (min)' }, { key: 'rad_tat', label: 'Radiology TAT (min)' }]} fmt={(v) => `${Math.round(v)}m`} />
            </ChartFrame>
            <ChartFrame title="Investigation volume" subtitle={`Lab and radiology orders per ${group}`}
              table={{ columns: ['Period', 'Lab', 'Radiology'], rows: series.map((p) => [p.label, p.lab_orders, p.rad_orders]) }}>
              <Bars data={series} x="label" stacked series={[{ key: 'lab_orders', label: 'Lab' }, { key: 'rad_orders', label: 'Radiology' }]} fmt={(v) => number(v)} />
            </ChartFrame>
            <ChartFrame title="Pharmacy sales" subtitle={`Per ${group}`}
              table={{ columns: ['Period', 'Sales'], rows: series.map((p) => [p.label, money(p.pharmacy, true)]) }}>
              {d.kpis.pharmacy > 0 ? <Bars data={series} x="label" series={[{ key: 'pharmacy', label: 'Pharmacy sales' }]} fmt={short} />
                : <Empty icon="Pill" title="No pharmacy sales in this range" />}
            </ChartFrame>
            <Card title="Top admission diagnoses" icon="ClipboardList">
              {d.top_diagnoses.length ? (
                <ul className="space-y-1.5 text-sm">
                  {d.top_diagnoses.map((t) => {
                    const max = d.top_diagnoses[0].admissions || 1
                    return (
                      <li key={t.diagnosis} className="grid grid-cols-[1fr_auto] items-center gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-ink">{t.diagnosis}</div>
                          <div className="mt-0.5 h-1.5 rounded-full bg-surface-2"><div className="h-1.5 rounded-full" style={{ width: `${(t.admissions / max) * 100}%`, background: 'var(--s1)' }} /></div>
                        </div>
                        <span className="tabular text-ink-2">{t.admissions}</span>
                      </li>
                    )
                  })}
                </ul>
              ) : <Empty icon="ClipboardList" title="No admissions in this range" />}
            </Card>
          </div>

          <Card pad={false} title="Doctor-wise OP volume and revenue" icon="Stethoscope">
            <DoctorTable rows={d.doctors} />
          </Card>
        </div>
      )}
    </div>
  )
}
