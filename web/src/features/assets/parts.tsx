import { ArrowDown, ArrowUp, ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { ChartFrame, SERIES } from '@/components/charts'
import { Badge, cn, type BadgeTone } from '@/components/ui'
import { useAuth, useMeta, useRegistry } from '@/lib/auth'
import { moneyShort, number } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { CountRow, Flow, Urgency } from './types'

// ------------------------------------------------------------------ access (mirrors the engine's role rules)

const FINANCE_ROLES = ['admin', 'management', 'stores']

/**
 * Who may open the dashboard (the roles & permissions matrix: page "asset-dashboard" of module "assets"),
 * see asset finance (stores / management / admin — enforced by the engine too), and open which records from it.
 */
export function useAssetAccess() {
  const { user } = useAuth()
  const meta = useMeta()
  const reg = useRegistry()
  const role = user?.role ?? meta.data?.user.role ?? ''
  return {
    ready: !!meta.data,
    role,
    dashboard: reg.canPage('assets', 'asset-dashboard'),
    finance: FINANCE_ROLES.includes(role),
    canRead: (fqn: string) => reg.canEntity(fqn, 'read'),
  }
}

// ------------------------------------------------------------------ formatting

export const OTHERS_COLOR = 'var(--ink-3)'

export function hours(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return v >= 48 ? `${number(Math.round((v / 24) * 10) / 10)} d` : `${number(Math.round(v * 10) / 10)} h`
}

export function flowValue(f: Pick<Flow, 'format'>, v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (f.format === 'currency') return moneyShort(v)
  if (f.format === 'hours') return hours(v)
  if (f.format === 'percent') return `${number(v)}%`
  return number(v)
}

export const pctText = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`)

/** "43 d overdue" style pill; status is always spelled out, never colour alone. */
export function DaysPill({ days, urgency, cover, grace = 0 }: { days: number; urgency: Urgency | null; cover?: boolean; grace?: number }) {
  let tone: BadgeTone = 'gray'
  let text: string
  if (cover && days < 0) { tone = 'red'; text = `Expired ${-days} d ago` }
  else if (days < 0 && urgency === 'overdue') { tone = 'red'; text = `${-days} d overdue` }
  else if (days < 0) { tone = 'amber'; text = `${-days} d past due · in ${grace} d grace` }
  else if (days === 0) { tone = 'amber'; text = cover ? 'Expires today' : 'Due today' }
  else { tone = days <= 7 ? 'amber' : 'blue'; text = `${cover ? 'Expires' : 'Due'} in ${days} d` }
  return <Badge tone={tone} className="tabular">{text}</Badge>
}

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const s = severity ?? 'Medium'
  const tone: BadgeTone = s === 'Critical' ? 'red' : s === 'High' ? 'amber' : s === 'Medium' ? 'blue' : 'gray'
  return <Badge tone={tone} dot>{s}</Badge>
}

// ------------------------------------------------------------------ tiles

export type Accent = 'brand' | 'good' | 'warning' | 'serious' | 'critical' | 'neutral'
const ACCENT: Record<Accent, string> = {
  brand: 'border-t-brand-600',
  good: 'border-t-good',
  warning: 'border-t-warning',
  serious: 'border-t-serious',
  critical: 'border-t-critical',
  neutral: 'border-t-line-2',
}

/** KPI tile with a coloured top edge and an optional drill-through (the whole tile is the button). */
export function KpiTile({ icon, label, value, caption, accent = 'brand', onDrill, extra }: {
  icon: string; label: string; value: ReactNode; caption?: ReactNode; accent?: Accent; onDrill?: () => void; extra?: ReactNode
}) {
  const body = (
    <>
      <span className="flex items-start gap-1.5 text-xs font-medium leading-tight text-ink-2">
        <Icon name={icon} className="mt-px size-3.5 shrink-0" />
        <span className="line-clamp-2 min-w-0">{label}</span>
        {onDrill && <ArrowUpRight className="no-print ml-auto size-3.5 shrink-0 text-ink-3 group-hover:text-brand-700 dark:group-hover:text-brand-300" aria-hidden />}
      </span>
      <span className="mt-1 text-2xl font-semibold tracking-tight text-ink tabular">{value}</span>
      {caption && <span className="mt-0.5 line-clamp-2 text-xs text-ink-3">{caption}</span>}
      {extra}
    </>
  )
  const cls = cn('group flex min-w-0 flex-col rounded-xl border border-line border-t-[3px] bg-surface px-3.5 py-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] break-inside-avoid', ACCENT[accent])
  return onDrill ? (
    <button type="button" onClick={onDrill} className={cn(cls, 'transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand-600')}
      aria-label={`${label}: show the assets`}>
      {body}
    </button>
  ) : <div className={cls}>{body}</div>
}

export function Delta({ flow, compareLabel }: { flow: Flow; compareLabel: string }) {
  if (flow.delta_pct === null) {
    return <span className="text-xs text-ink-3">{flow.previous === null ? 'No comparison data' : `${flowValue(flow, flow.previous)} ${compareLabel.toLowerCase()}`}</span>
  }
  const up = flow.delta_pct >= 0
  const good = flow.better === 'neutral' || flow.delta_pct === 0 ? null : (flow.better === 'up') === up
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs', good === null ? 'text-ink-2' : good ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
      {up ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />}
      <b className="font-semibold tabular">{up ? '+' : '−'}{Math.abs(flow.delta_pct).toFixed(1)}%</b>
      <span className="text-ink-3">vs {flowValue(flow, flow.previous)} {compareLabel.toLowerCase()}</span>
    </span>
  )
}

export function Panel({ title, icon, subtitle, actions, children, className, pad = true }: {
  title: ReactNode; icon?: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)] break-inside-avoid', className)}>
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {icon && <Icon name={icon} className="size-4 text-brand-700 dark:text-brand-400" />}{title}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </div>
        {actions && <div className="no-print flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

// ------------------------------------------------------------------ donut

export interface Slice { key: string | null; label: string; count: number; pct: number; color: string; more?: number }

/** Up to six slices in the validated categorical order; the rest fold into a grey "Others". */
export function toSlices(rows: CountRow[], max = 6): Slice[] {
  const total = rows.reduce((s, r) => s + r.count, 0)
  const head = rows.length > max ? rows.slice(0, max) : rows
  const out: Slice[] = head.map((r, i) => ({ ...r, color: r.key === null ? OTHERS_COLOR : SERIES[i % SERIES.length] }))
  if (rows.length > max) {
    const rest = rows.slice(max)
    const n = rest.reduce((s, r) => s + r.count, 0)
    out.push({ key: null, label: 'Others', count: n, pct: total ? Math.round((n * 1000) / total) / 10 : 0, color: OTHERS_COLOR, more: rest.length })
  }
  return out
}

function DonutTip({ active, payload, total }: { active?: boolean; payload?: { payload: Slice }[]; total: number }) {
  if (!active || !payload?.length) return null
  const s = payload[0].payload
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="flex items-center gap-2 font-medium text-ink"><span className="size-2 rounded-full" style={{ background: s.color }} />{s.label}</div>
      <div className="mt-0.5 tabular text-ink-2">{number(s.count)} of {number(total)} · {pctText(s.pct)}</div>
    </div>
  )
}

export function Donut({ rows, unit = 'Assets', onPick, max = 6 }: {
  rows: CountRow[]; unit?: string; onPick?: (key: string) => void; max?: number
}) {
  const slices = toSlices(rows, max)
  const total = slices.reduce((s, r) => s + r.count, 0)
  return (
    <div className="flex h-full flex-col">
      <div className="relative h-40 shrink-0">
        {total > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={slices.filter((s) => s.count > 0)} dataKey="count" nameKey="label" innerRadius="66%" outerRadius="96%"
                startAngle={90} endAngle={-270} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}
                onClick={(d) => { const x = d as unknown as Slice & { payload?: Slice }; const k = x.payload?.key ?? x.key; if (k && onPick) onPick(k) }}
                className={onPick ? 'cursor-pointer' : undefined}>
                {slices.filter((s) => s.count > 0).map((s) => <Cell key={s.label} fill={s.color} />)}
              </Pie>
              <Tooltip content={<DonutTip total={total} />} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="mx-auto mt-2 size-36 rounded-full border-[14px] border-surface-2" aria-hidden />
        )}
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="text-2xl font-semibold tabular text-ink">{number(total)}</div>
            <div className="text-xs text-ink-3">{unit}</div>
          </div>
        </div>
      </div>
      <ul className="mt-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto scroll-thin">
        {slices.map((s) => {
          const pickable = !!(onPick && s.key && s.count)
          const row = (
            <>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ink">{s.label}{s.more ? <span className="text-ink-3"> · {s.more} more</span> : null}</span>
              <span className="w-10 text-right font-medium tabular text-ink">{number(s.count)}</span>
              <span className="w-12 text-right text-xs tabular text-ink-3">{pctText(s.pct)}</span>
            </>
          )
          return (
            <li key={s.label}>
              {pickable ? (
                <button type="button" onClick={() => onPick!(s.key!)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-surface-2">{row}</button>
              ) : <div className="flex items-center gap-2 px-1.5 py-1 text-sm">{row}</div>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ------------------------------------------------------------------ horizontal meter bars

export function MeterList({ rows, onPick, color = 'var(--s1)', emptyText = 'Nothing to show yet' }: {
  rows: CountRow[]; onPick?: (key: string) => void; color?: string; emptyText?: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  if (!rows.some((r) => r.count > 0)) return <p className="py-6 text-center text-sm text-ink-3">{emptyText}</p>
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const pickable = !!(onPick && r.key && r.count)
        const inner = (
          <>
            <span className="flex items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{r.label}</span>
              <span className="font-medium tabular text-ink">{number(r.count)}</span>
              <span className="w-12 text-right text-xs tabular text-ink-3">{pctText(r.pct)}</span>
            </span>
            <span className="mt-1 block h-2 rounded-full bg-surface-2 ring-1 ring-inset ring-line">
              <span className="block h-2 rounded-full" style={{ width: `${Math.max(r.count ? 2 : 0, (r.count / max) * 100)}%`, background: r.key === null ? OTHERS_COLOR : color }} />
            </span>
            {r.more ? <span className="mt-0.5 block text-[11px] text-ink-3">{r.more} more</span> : null}
          </>
        )
        return (
          <li key={r.label}>
            {pickable ? (
              <button type="button" onClick={() => onPick!(r.key!)} className="block w-full rounded-md px-1 py-0.5 text-left hover:bg-surface-2">{inner}</button>
            ) : <div className="px-1 py-0.5">{inner}</div>}
          </li>
        )
      })}
    </ul>
  )
}

/** Chart card with the shared chart ↔ table toggle (components/charts ChartFrame). */
export function CountChart({ title, subtitle, rows, kind, onPick, height, unit, color, keyLabel = 'Group' }: {
  title: string; subtitle?: string; rows: CountRow[]; kind: 'donut' | 'bars'; onPick?: (key: string) => void
  height?: number; unit?: string; color?: string; keyLabel?: string
}) {
  const rowsForTable = kind === 'donut' ? toSlices(rows) : rows
  return (
    <ChartFrame title={title} subtitle={subtitle} height={height ?? (kind === 'donut' ? Math.min(380, 196 + rowsForTable.length * 30) : Math.max(120, rows.length * 44))}
      table={{ columns: [keyLabel, 'Assets', '%'], rows: rowsForTable.map((r) => [r.label, r.count, pctText(r.pct)]) }}>
      {kind === 'donut' ? <Donut rows={rows} onPick={onPick} unit={unit} /> : <div className="h-full overflow-y-auto pr-1 scroll-thin"><MeterList rows={rows} onPick={onPick} color={color} /></div>}
    </ChartFrame>
  )
}
