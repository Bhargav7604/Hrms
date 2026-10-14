import { useState, type ReactNode } from 'react'
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Segmented } from './ui'

/** Categorical slots in fixed order (validated palette, see dataviz guidance). */
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)']

const axis = { stroke: 'var(--axis)', tick: { fill: 'var(--ink-3)', fontSize: 11 }, tickLine: false }
const grid = <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />

function ChartTooltip({ active, payload, label, fmt }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; fmt: (v: number) => string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-ink">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 text-ink-2">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums text-ink">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export interface SeriesDef { key: string; label: string }

/** Wraps a chart with a chart/table toggle so values are never colour-only. */
export function ChartFrame({ title, subtitle, children, table, height = 240 }: {
  title: string; subtitle?: string; children: ReactNode; table: { columns: string[]; rows: (string | number)[][] }; height?: number
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="text-xs text-ink-3">{subtitle}</p>}
        </div>
        <Segmented value={view} onChange={setView} options={[{ key: 'chart', label: 'Chart' }, { key: 'table', label: 'Table' }]} />
      </header>
      {view === 'chart' ? (
        <div style={{ height }}>{children}</div>
      ) : (
        <div className="overflow-auto scroll-thin" style={{ maxHeight: height }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-ink-2"><tr>{table.columns.map((c) => <th key={c} className="px-2 py-1.5 text-left font-medium">{c}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i} className="border-t border-line">{r.map((v, j) => <td key={j} className="px-2 py-1 tabular-nums">{v}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function Bars({ data, x, series, fmt = (v) => String(v), horizontal, stacked }: {
  data: Record<string, unknown>[]; x: string; series: SeriesDef[]; fmt?: (v: number) => string; horizontal?: boolean; stacked?: boolean
}) {
  const multi = series.length > 1
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} barGap={2} barCategoryGap={horizontal ? 6 : '20%'}
        margin={{ top: 4, right: 8, bottom: 0, left: horizontal ? 8 : -8 }}>
        {horizontal ? <CartesianGrid stroke="var(--grid)" horizontal={false} /> : grid}
        {horizontal ? (
          <>
            <XAxis type="number" {...axis} tickFormatter={(v) => fmt(v)} />
            <YAxis type="category" dataKey={x} {...axis} width={130} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} {...axis} />
            <YAxis {...axis} tickFormatter={(v) => fmt(v)} width={64} />
          </>
        )}
        <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<ChartTooltip fmt={fmt} />} />
        {multi && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i]} stackId={stacked ? 'a' : undefined}
            radius={stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={28} stroke="var(--surface)" strokeWidth={stacked ? 2 : 0} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

export function Lines({ data, x, series, fmt = (v) => String(v) }: {
  data: Record<string, unknown>[]; x: string; series: SeriesDef[]; fmt?: (v: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        {grid}
        <XAxis dataKey={x} {...axis} />
        <YAxis {...axis} tickFormatter={(v) => fmt(v)} width={64} />
        <Tooltip cursor={{ stroke: 'var(--axis)' }} content={<ChartTooltip fmt={fmt} />} />
        {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />}
        {series.map((s, i) => (
          <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={SERIES[i]} strokeWidth={2}
            dot={{ r: 3, strokeWidth: 2, stroke: 'var(--surface)', fill: SERIES[i] }} activeDot={{ r: 5 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
