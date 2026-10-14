/**
 * Dashboard widget library: KPI tiles (delta pill + sparkline + drill-down), chart cards with a
 * table toggle, revenue-trend-vs-comparison, donut with legend, ranked bar list, ward occupancy,
 * turnaround gauge. Colours: validated categorical slots var(--s1…s6) in fixed order; status uses
 * good / warning / critical with an icon and a text label, never colour alone; one axis per chart.
 */
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, Info, Minus, Table2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { SERIES } from '@/components/charts'
import { cn } from '@/components/ui'
import { minutes, moneyShort, number } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { ChartSpec, Fmt, NamedValue, Tile, TopList, Ward } from './types'

// ------------------------------------------------------------------ formatting

export function fmtValue(v: unknown, fmt?: string | null): string {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) return '—'
  const n = Number(v)
  switch (fmt) {
    case 'money': return moneyShort(n).replace(' L', 'L').replace(' Cr', 'Cr')
    case 'percent': return `${Number.isInteger(n) ? n : n.toFixed(1)}%`
    case 'minutes': return minutes(n)
    case 'days': return `${n.toFixed(1)} d`
    case 'text': return String(v)
    default: return Number.isFinite(n) ? number(Math.round(n * 10) / 10) : String(v)
  }
}

export const axisFmt = (fmt?: string | null) => (v: number) => (fmt === 'money' ? moneyShort(v).replace(' L', 'L').replace(' Cr', 'Cr') : fmt === 'percent' ? `${v}%` : number(v))

const TONES: Record<string, string> = { s1: 'var(--s1)', s2: 'var(--s2)', s3: 'var(--s3)', s4: 'var(--s4)', s5: 'var(--s5)', s6: 'var(--s6)' }
export const tone = (t?: string) => TONES[t ?? 's1'] ?? 'var(--s1)'

const shortDate = (iso?: string | null) => {
  if (!iso) return ''
  const [, m, d] = iso.split('-').map(Number)
  return `${String(d).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`
}

// ------------------------------------------------------------------ small pieces

/** % change pill. Colour shows good / bad (not direction); the sign and arrow carry direction in text. */
export function DeltaPill({ pct, verdict }: { pct: number | null | undefined; verdict?: string | null }) {
  if (pct === null || pct === undefined) return null
  const up = pct > 0
  const flat = Math.abs(pct) < 0.05
  const cls = verdict === 'better' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
    : verdict === 'worse' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' : 'bg-surface-2 text-ink-2'
  const Arrow = flat ? Minus : up ? ArrowUpRight : ArrowDownRight
  const label = `${flat ? 'No change' : `${up ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}%`}${verdict && verdict !== 'same' ? ` — ${verdict}` : ''}`
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums', cls)} aria-label={label} title={label}>
      <Arrow className="size-3" aria-hidden />{flat ? '0%' : `${up ? '+' : '−'}${Math.abs(pct) >= 1000 ? Math.round(Math.abs(pct)).toLocaleString('en-IN') : Math.abs(pct).toFixed(1)}%`}
    </span>
  )
}

export function Sparkline({ values, color = 'var(--s1)', width = 64, height = 26, label }: { values: number[]; color?: string; width?: number; height?: number; label?: string }) {
  if (!values || values.length < 2 || values.every((v) => !v)) return null
  const max = Math.max(...values), min = Math.min(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (width - 4) + 2},${height - 3 - ((v - min) / span) * (height - 6)}`).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? 'trend'} className="shrink-0 overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DrillLink({ to, label }: { to?: string | null; label: string }) {
  if (!to) return null
  return (
    <Link to={to} className="no-print rounded-md p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={`Open ${label} detail`} title="Open the detailed report">
      <ArrowUpRight className="size-4" />
    </Link>
  )
}

/** KPI tile: coloured top border, icon, value, delta pill with good/bad semantics, comparison text, sparkline, drill-down. */
export function KpiTile({ t, compareText, size = 'md' }: { t: Tile; compareText?: string; size?: 'md' | 'lg' }) {
  const color = tone(t.tone)
  const cmp = t.point ? null : t.previous !== undefined && t.previous !== null && compareText !== undefined
    ? `vs ${fmtValue(t.previous, t.format)}${compareText ? ` in ${compareText}` : ''}` : null
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-line border-t-[3px] bg-surface px-4 pb-3 pt-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
      style={{ borderTopColor: color }}>
      <header className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
        <span className="grid size-5 place-items-center rounded-md" style={{ color }}><Icon name={t.icon ?? 'Activity'} className="size-3.5" /></span>
        <span className="line-clamp-2 leading-tight" title={t.label}>{t.label}</span>
        <span className="ml-auto shrink-0"><DrillLink to={t.link} label={t.label} /></span>
      </header>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className={cn('font-semibold tracking-tight text-ink tabular-nums', size === 'lg' ? 'text-[26px] leading-8' : 'text-2xl')}>{fmtValue(t.value, t.format)}</span>
        {t.spark && <Sparkline values={t.spark} color={color} label={`${t.label} trend`} />}
      </div>
      <div className="mt-1 flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-ink-3">
        <DeltaPill pct={t.delta_pct} verdict={t.verdict} />
        <span className="truncate">{cmp && t.delta_pct !== null && t.delta_pct !== undefined ? cmp : t.sub || cmp || ''}</span>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ cards

export function CardShell({ title, subtitle, icon, info, children, footer, table, actions, className, bodyClass }: {
  title: ReactNode; subtitle?: ReactNode; icon?: string; info?: string; children: ReactNode; footer?: { label: string; to?: string | null } | null
  table?: { columns: string[]; rows: (string | number)[][] } | null; actions?: ReactNode; className?: string; bodyClass?: string
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <section className={cn('flex min-w-0 flex-col rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)] print-area', className)}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {icon && <span className="grid size-6 place-items-center rounded-md bg-surface-2 text-brand-700 dark:text-brand-300"><Icon name={icon} className="size-3.5" /></span>}
            <span className="truncate">{title}</span>
            {info && <span title={info} aria-label={info} className="text-ink-3"><Info className="size-3.5" /></span>}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </div>
        <div className="no-print flex items-center gap-1">
          {actions}
          {table && (
            <button type="button" onClick={() => setAsTable(!asTable)} aria-pressed={asTable} title={asTable ? 'Show chart' : 'Show as table'}
              className={cn('rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink', asTable && 'bg-surface-2 text-ink')}>
              <Table2 className="size-4" /><span className="sr-only">{asTable ? 'Show chart' : 'Show as table'}</span>
            </button>
          )}
        </div>
      </header>
      <div className={cn('min-h-0 flex-1 px-4 py-3', bodyClass)}>
        {asTable && table ? <MiniTable columns={table.columns} rows={table.rows} /> : children}
      </div>
      {footer?.to && (
        <footer className="no-print border-t border-line px-4 py-2">
          <Link to={footer.to} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
            {footer.label} <ArrowRight className="size-3" />
          </Link>
        </footer>
      )}
    </section>
  )
}

export function MiniTable({ columns, rows, max = 320 }: { columns: string[]; rows: (string | number)[][]; max?: number }) {
  return (
    <div className="overflow-auto scroll-thin" style={{ maxHeight: max }}>
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-2 text-ink-2">
          <tr>{columns.map((c, i) => <th key={c} className={cn('px-2 py-1.5 font-medium', i ? 'text-right' : 'text-left')}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((v, j) => <td key={j} className={cn('px-2 py-1 tabular-nums', j ? 'text-right' : 'text-left text-ink')}>{v}</td>)}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={columns.length} className="px-2 py-4 text-center text-ink-3">No data</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ charts

const axis = { stroke: 'var(--axis)', tick: { fill: 'var(--ink-3)', fontSize: 11 }, tickLine: false }

function Tip({ active, payload, label, fmts, labelFmt }: {
  active?: boolean; payload?: { name: string; value: number; color: string; dataKey: string; payload: Record<string, unknown> }[]; label?: string
  fmts: Record<string, string>; labelFmt?: (l: string, p?: Record<string, unknown>) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-ink">{labelFmt ? labelFmt(String(label ?? ''), payload[0]?.payload) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-ink-2">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums text-ink">{fmtValue(p.value, fmts[p.dataKey] ?? 'number')}</span>
        </div>
      ))}
    </div>
  )
}

const typeToFmt = (t: string): Fmt => (t === 'money' ? 'money' : t === 'percent' ? 'percent' : t === 'minutes' ? 'minutes' : t === 'days' ? 'days' : 'number')

/** Daily series against the comparison period (dashed, neutral) — one axis. */
export function TrendChart({ points, format, label, compareLabel, height = 260, kind = 'area' }: {
  points: { date: string; value: number; compare: number | null; compare_date: string | null }[]; format: string; label: string
  compareLabel?: string | null; height?: number; kind?: 'area' | 'line' | 'bar'
}) {
  const data = points.map((p) => ({ ...p, day: shortDate(p.date) }))
  const hasCmp = points.some((p) => p.compare !== null)
  const fmts = { value: format, compare: format }
  const labelFmt = (_l: string, p?: Record<string, unknown>) => `${shortDate(p?.date as string)}${p?.compare_date ? ` · vs ${shortDate(p.compare_date as string)}` : ''}`
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -4 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--s3)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--s3)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="day" {...axis} minTickGap={16} />
          <YAxis {...axis} tickFormatter={axisFmt(format)} width={56} />
          <Tooltip cursor={{ stroke: 'var(--axis)' }} content={<Tip fmts={fmts} labelFmt={labelFmt} />} />
          <Legend iconType="plainline" iconSize={14} wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />
          {kind === 'bar'
            ? <Bar dataKey="value" name={label} fill="var(--s3)" radius={[4, 4, 0, 0]} maxBarSize={24} />
            : kind === 'line'
              ? <Line type="monotone" dataKey="value" name={label} stroke="var(--s3)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              : <Area type="monotone" dataKey="value" name={label} stroke="var(--s3)" strokeWidth={2} fill="url(#trendFill)" activeDot={{ r: 4 }} />}
          {hasCmp && <Line type="monotone" dataKey="compare" name={compareLabel ? `Comparison (${compareLabel})` : 'Comparison period'} stroke="var(--ink-3)"
            strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={{ r: 3 }} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Donut with the total in the centre and a value + share legend (≤ 6 slices; the rest fold into "Others"). */
export function Donut({ rows, format = 'money', centerLabel, height = 190 }: { rows: NamedValue[]; format?: string; centerLabel: string; height?: number }) {
  const sorted = [...rows].filter((r) => r.value > 0).sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, sorted.length > 6 ? 5 : 6)
  const rest = sorted.slice(head.length)
  const slices = [...head.map((r, i) => ({ ...r, fill: SERIES[i] })),
    ...(rest.length ? [{ name: `Others (${rest.length})`, value: rest.reduce((a, b) => a + b.value, 0), fill: 'var(--ink-3)' }] : [])]
  const total = slices.reduce((a, b) => a + b.value, 0)
  if (!total) return <p className="py-8 text-center text-sm text-ink-3">No data in this period</p>
  return (
    <div>
      <div className="relative" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<Tip fmts={{ value: format }} />} />
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" stroke="var(--surface)" strokeWidth={2} isAnimationActive={false} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div><div className="text-lg font-semibold text-ink tabular-nums">{fmtValue(total, format)}</div><div className="text-[11px] text-ink-3">{centerLabel}</div></div>
        </div>
      </div>
      <ul className="mt-3 space-y-1.5">
        {slices.map((s) => (
          <li key={s.name} className="flex items-center gap-2 text-xs">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.fill }} />
            <span className="min-w-0 flex-1 truncate text-ink">{s.name}</span>
            <span className="tabular-nums text-ink">{fmtValue(s.value, format)}</span>
            <span className="w-10 text-right tabular-nums text-ink-3">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Ranked horizontal bars with value and share, plus an "Others · N more" row. */
export function BarList({ list, format = 'money', color = 'var(--s3)' }: { list: TopList; format?: string; color?: string }) {
  const max = Math.max(...list.rows.map((r) => r.value), list.others?.value ?? 0, 1)
  if (!list.rows.length) return <p className="py-8 text-center text-sm text-ink-3">No data in this period</p>
  const row = (name: string, value: number, share: number | null | undefined, c: string, extra?: string) => (
    <li key={name}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-ink">{name}</span>
        <span className="flex shrink-0 gap-3 tabular-nums"><span className="font-medium text-ink">{fmtValue(value, format)}</span><span className="w-10 text-right text-ink-3">{share ?? 0}%</span></span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-surface-2"><div className="h-1.5 rounded-full" style={{ width: `${(value / max) * 100}%`, background: c }} /></div>
      {extra && <div className="mt-0.5 text-[11px] text-ink-3">{extra}</div>}
    </li>
  )
  return (
    <ul className="space-y-3">
      {list.rows.map((r) => row(r.name, r.value, r.share, color))}
      {list.others && list.others.count > 0 && row('Others', list.others.value, list.others.share, 'var(--ink-3)', `${list.others.count} more`)}
    </ul>
  )
}

const BAND: Record<Ward['band'], { cls: string; bar: string; icon: string; label: string }> = {
  Full: { cls: 'text-red-700 dark:text-red-300', bar: 'var(--color-critical)', icon: 'CircleAlert', label: 'Full' },
  Busy: { cls: 'text-amber-700 dark:text-amber-300', bar: 'var(--color-warning)', icon: 'CircleDot', label: 'Busy' },
  Available: { cls: 'text-emerald-700 dark:text-emerald-300', bar: 'var(--color-good)', icon: 'CircleCheck', label: 'Available' },
}

export function WardOccupancy({ rows, show = 6 }: { rows: Ward[]; show?: number }) {
  const [all, setAll] = useState(false)
  const list = all ? rows : rows.slice(0, show)
  if (!rows.length) return <p className="py-8 text-center text-sm text-ink-3">No wards configured</p>
  return (
    <div>
      <ul className="space-y-3">
        {list.map((w) => {
          const b = BAND[w.band]
          return (
            <li key={w.ward}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium uppercase tracking-wide text-ink">{w.ward}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', b.cls)}><Icon name={b.icon} className="size-3" />{b.label}</span>
                  <span className="w-11 text-right font-semibold tabular-nums text-ink">{w.pct}%</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-2" role="meter" aria-valuenow={w.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${w.ward} occupancy`}>
                <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, w.pct)}%`, background: b.bar }} />
              </div>
              <div className="mt-0.5 text-[11px] text-ink-3">{w.occupied} in {w.operational} beds{w.blocked ? ` · ${w.blocked} blocked` : ''}</div>
            </li>
          )
        })}
      </ul>
      {rows.length > show && (
        <button type="button" className="no-print mt-3 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${rows.length} wards`}
        </button>
      )}
      <div className="mt-3 flex flex-wrap gap-3 border-t border-line pt-2 text-[11px] text-ink-2">
        <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: 'var(--color-critical)' }} />Full ≥ 90%</span>
        <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: 'var(--color-warning)' }} />Busy ≥ 75%</span>
        <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: 'var(--color-good)' }} />Available &lt; 75%</span>
      </div>
    </div>
  )
}

/** Semi-circle gauge with an optional target marker. */
export function Gauge({ pct, target, size = 150 }: { pct: number | null; target: number | null; size?: number }) {
  const r = size / 2 - 10, cx = size / 2, cy = size / 2
  const arc = (p: number) => {
    const a = Math.PI * (1 - Math.max(0, Math.min(100, p)) / 100)
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
  }
  const [ex, ey] = arc(pct ?? 0)
  const good = target === null || pct === null ? 'var(--s1)' : pct >= target ? 'var(--color-good)' : 'var(--color-critical)'
  const t = target !== null ? arc(target) : null
  return (
    <svg width={size} height={size / 2 + 12} viewBox={`0 0 ${size} ${size / 2 + 12}`} role="img" aria-label={`${pct ?? 0}%${target !== null ? ` against a target of ${target}%` : ''}`}>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="var(--surface-2)" strokeWidth={12} strokeLinecap="round" />
      {pct !== null && pct > 0 && <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${ex} ${ey}`} fill="none" stroke={good} strokeWidth={12} strokeLinecap="round" />}
      {t && <line x1={t[0]} y1={t[1]} x2={cx + (r + 9) * Math.cos(Math.PI * (1 - (target ?? 0) / 100))} y2={cy - (r + 9) * Math.sin(Math.PI * (1 - (target ?? 0) / 100))}
        stroke="var(--ink)" strokeWidth={2.5} />}
      <text x={cx} y={cy - 4} textAnchor="middle" className="fill-[var(--ink)] text-xl font-semibold">{pct === null ? '—' : `${Math.round(pct)}%`}</text>
    </svg>
  )
}

/** Generic chart for report- and metric-bound widgets (bar · line · area · donut). */
export function ChartView({ spec, height = 240 }: { spec: ChartSpec; height?: number }) {
  const { type, x, y, data } = spec
  const fmts = Object.fromEntries(y.map((s) => [s.key, typeToFmt(s.type)]))
  const f0 = typeToFmt(y[0]?.type ?? 'number')
  if (!data.length) return <p className="py-8 text-center text-sm text-ink-3">No data in this period</p>
  if (type === 'donut') {
    return <Donut rows={data.map((d) => ({ name: String(d[x] ?? '—'), value: Number(d[y[0]?.key] ?? 0) }))} format={f0} centerLabel={y[0]?.label ?? 'Total'} height={Math.min(height, 190)} />
  }
  const multi = y.length > 1
  const tickFmt = (v: unknown) => {
    const s = String(v ?? '')
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? shortDate(s) : s.length > 18 ? `${s.slice(0, 17)}…` : s
  }
  const legend = multi && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />
  const grid = <CartesianGrid stroke="var(--grid)" vertical={!!spec.horizontal} horizontal={!spec.horizontal} />
  if (type === 'bar') {
    const h = spec.horizontal
    const hh = h ? Math.max(height, data.length * 26 + 40) : height
    return (
      <div style={{ height: hh }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout={h ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, bottom: 0, left: h ? 4 : -6 }} barGap={2}>
            {grid}
            {h ? <><XAxis type="number" {...axis} tickFormatter={axisFmt(f0)} /><YAxis type="category" dataKey={x} {...axis} width={140} tickFormatter={tickFmt} /></>
              : <><XAxis dataKey={x} {...axis} tickFormatter={tickFmt} minTickGap={8} /><YAxis {...axis} tickFormatter={axisFmt(f0)} width={56} /></>}
            <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<Tip fmts={fmts} labelFmt={(l) => tickFmt(l)} />} />
            {legend}
            {y.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i % SERIES.length]} stackId={spec.stacked ? 'a' : undefined} maxBarSize={26}
                radius={spec.stacked ? 0 : h ? [0, 4, 4, 0] : [4, 4, 0, 0]} stroke="var(--surface)" strokeWidth={spec.stacked ? 2 : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {type === 'area' ? (
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -6 }}>
            {grid}
            <XAxis dataKey={x} {...axis} tickFormatter={tickFmt} minTickGap={12} />
            <YAxis {...axis} tickFormatter={axisFmt(f0)} width={56} />
            <Tooltip cursor={{ stroke: 'var(--axis)' }} content={<Tip fmts={fmts} labelFmt={(l) => tickFmt(l)} />} />
            {legend}
            {y.map((s, i) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SERIES[i]} strokeWidth={2} fill={SERIES[i]} fillOpacity={0.08} />)}
          </ComposedChart>
        ) : (
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -6 }}>
            {grid}
            <XAxis dataKey={x} {...axis} tickFormatter={tickFmt} minTickGap={12} />
            <YAxis {...axis} tickFormatter={axisFmt(f0)} width={56} />
            <Tooltip cursor={{ stroke: 'var(--axis)' }} content={<Tip fmts={fmts} labelFmt={(l) => tickFmt(l)} />} />
            {legend}
            {y.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SERIES[i]} strokeWidth={2} dot={data.length < 20 ? { r: 3, strokeWidth: 2, stroke: 'var(--surface)', fill: SERIES[i] } : false} />)}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

export function chartTable(spec: ChartSpec): { columns: string[]; rows: (string | number)[][] } {
  return {
    columns: [spec.x.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), ...spec.y.map((s) => s.label)],
    rows: spec.data.map((d) => [String(d[spec.x] ?? '—'), ...spec.y.map((s) => fmtValue(d[s.key], typeToFmt(s.type)))]),
  }
}

export function StatusPill({ ok, text }: { ok: boolean | null; text: string }) {
  if (ok === null) return <span className="text-[11px] text-ink-3">{text}</span>
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
      {ok ? <Check className="size-3" /> : <Icon name="CircleAlert" className="size-3" />}{text}
    </span>
  )
}
