import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn, ErrorBox, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { CardShell, ChartView, chartTable, fmtValue, KpiTile, TrendChart } from './kit'
import type { CompareInfo, RangeInfo, WidgetData, WidgetSpec } from './types'
import { queryOf, type DashParams } from './controls'

/** 12-column grid spans (static class names so Tailwind keeps them). */
const SPAN: Record<number, string> = {
  2: 'col-span-6 sm:col-span-4 lg:col-span-2', 3: 'col-span-6 md:col-span-4 lg:col-span-3', 4: 'col-span-12 md:col-span-6 lg:col-span-4',
  5: 'col-span-12 md:col-span-6 lg:col-span-5', 6: 'col-span-12 lg:col-span-6', 7: 'col-span-12 lg:col-span-7', 8: 'col-span-12 lg:col-span-8',
  9: 'col-span-12 lg:col-span-9', 10: 'col-span-12 lg:col-span-10', 11: 'col-span-12 lg:col-span-11', 12: 'col-span-12',
}
const HEIGHT: Record<number, number> = { 1: 0, 2: 230, 3: 340, 4: 460 }
export const spanClass = (w: number) => SPAN[w] ?? SPAN[6]

export interface WidgetsResponse { range: RangeInfo; compare: CompareInfo | null; widgets: Record<string, WidgetData>; as_of: string }

export function useWidgets(key: string, widgets: WidgetSpec[], params: DashParams, interval: number | false, refresh = 0) {
  return useQuery({
    queryKey: ['dash', 'widgets', key, params, widgets.map((w) => JSON.stringify(w)).join('|'), refresh],
    queryFn: () => api<WidgetsResponse>('/dashboards/widgets', { method: 'POST', body: { widgets, ...queryOf(params), refresh: refresh > 0 } }),
    enabled: widgets.length > 0,
    placeholderData: (p) => p,
    refetchInterval: interval,
    staleTime: 30_000,
  })
}

function cell(v: unknown, type: string): ReactNode {
  if (type === 'status') return <StatusBadge status={v as string} />
  if (type === 'datetime') return dateTime(v)
  if (type === 'bool') return v === null || v === undefined ? '—' : v ? 'Yes' : 'No'
  if (['money', 'number', 'percent', 'minutes', 'days'].includes(type)) return fmtValue(v, type)
  return v === null || v === undefined || v === '' ? '—' : String(v)
}

export function WidgetBody({ spec, data, compare }: { spec: WidgetSpec; data?: WidgetData; compare?: CompareInfo | null }) {
  const h = HEIGHT[spec.h] || 230
  if (!data) return <div className="h-full min-h-24 animate-pulse rounded-xl bg-surface-2" />
  if (data.error) return <CardShell title={spec.title || 'Widget'}><ErrorBox error={data.error} /></CardShell>
  if (data.tile) return <KpiTile t={{ ...data.tile, label: spec.title || data.tile.label }} compareText={compare?.label} />
  if (data.trend) {
    const tr = data.trend
    const kind = spec.type === 'bar' ? 'bar' : spec.type === 'line' ? 'line' : 'area'
    return (
      <CardShell title={spec.title || tr.label} subtitle={`${fmtValue(tr.total, tr.format)} in the period${tr.compare_total !== null ? ` · ${fmtValue(tr.compare_total, tr.format)} in ${compare?.label ?? 'the comparison period'}` : ''}`}
        footer={tr.link ? { label: 'Open report', to: tr.link } : null}
        table={{ columns: ['Date', tr.label, 'Comparison'], rows: tr.points.map((p) => [p.date, fmtValue(p.value, tr.format), fmtValue(p.compare, tr.format)]) }}>
        <TrendChart points={tr.points} format={tr.format} label={tr.label} compareLabel={compare?.label} height={h} kind={kind} />
      </CardShell>
    )
  }
  if (data.chart) {
    const ctype = (spec.type === 'kpi' || spec.type === 'table' || spec.type === 'list' ? 'bar' : spec.type) as 'bar' | 'line' | 'area' | 'donut'
    const cs = { ...data.chart, type: ctype, horizontal: ctype === 'bar' && data.chart.data.length > 6 && !/date|period|day|hour/.test(data.chart.x) }
    return (
      <CardShell title={spec.title} footer={data.link ? { label: 'Open report', to: data.link } : null} table={chartTable(cs)}>
        <ChartView spec={cs} height={h} />
      </CardShell>
    )
  }
  if (data.table) {
    const t = data.table
    return (
      <CardShell title={spec.title} subtitle={t.total > t.rows.length ? `Top ${t.rows.length} of ${t.total}` : `${t.total} rows`}
        footer={data.link ? { label: 'Open report', to: data.link } : null} bodyClass="px-0 py-0">
        <div className="overflow-auto scroll-thin" style={{ maxHeight: Math.max(h, 200) }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-ink-2">
              <tr>{t.columns.map((c) => <th key={c.key} className={cn('whitespace-nowrap px-3 py-1.5 font-medium', ['money', 'number', 'percent', 'minutes', 'days'].includes(c.type) ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {t.rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  {t.columns.map((c, j) => (
                    <td key={c.key} className={cn('whitespace-nowrap px-3 py-1.5 text-ink', ['money', 'number', 'percent', 'minutes', 'days'].includes(c.type) && 'text-right tabular-nums')}>
                      {j === 0 && typeof r._link === 'string' ? <Link to={r._link} className="text-brand-700 hover:underline dark:text-brand-300">{cell(r[c.key], c.type)}</Link> : cell(r[c.key], c.type)}
                    </td>
                  ))}
                </tr>
              ))}
              {!t.rows.length && <tr><td colSpan={t.columns.length} className="px-3 py-6 text-center text-ink-3">No rows in this period</td></tr>}
            </tbody>
          </table>
        </div>
      </CardShell>
    )
  }
  return null
}

/** Renders a dashboard layout. Widgets the role may not see come back `denied` and are not shown at all. */
export function WidgetGrid({ widgets, data, compare, edit }: {
  widgets: WidgetSpec[]; data?: Record<string, WidgetData>; compare?: CompareInfo | null
  edit?: (w: WidgetSpec, index: number) => ReactNode
}) {
  const visible = widgets.filter((w) => edit || !data?.[w.id]?.denied)
  return (
    <div className="grid grid-cols-12 gap-3">
      {visible.map((w, i) => (
        <div key={w.id} className={cn(spanClass(w.w), 'relative min-w-0')}>
          {edit && edit(w, i)}
          {data?.[w.id]?.denied ? (
            <div className="grid h-24 place-items-center rounded-xl border border-dashed border-line-2 text-xs text-ink-3">Your role cannot see this widget's data</div>
          ) : <WidgetBody spec={w} data={data?.[w.id]} compare={compare} />}
        </div>
      ))}
    </div>
  )
}
