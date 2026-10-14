import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { addDays, format, parseISO, subDays } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { Bars, ChartFrame, Lines } from '@/components/charts'
import { Card, cn, Empty, ErrorBox, Input, PageHeader, Segmented, Select, Spinner, StatTile } from '@/components/ui'
import { api } from '@/lib/api'
import { minutes, number } from '@/lib/format'
import { useQueueAccess } from './access'
import { QueueLinks } from './QueueMonitor'
import { useQueueOptions } from './TokenRegister'
import type { Reports } from './types'

const iso = (d: Date) => format(d, 'yyyy-MM-dd')
const dayLabel = (d: string) => format(parseISO(d), 'dd MMM')
const mins = (v: number) => `${Math.round(v)} min`
const m1 = (v: number | null | undefined) => (v == null ? '—' : minutes(v))

type Range = '1' | '7' | '30' | 'custom'
const RANGES: { key: Range; label: string }[] = [{ key: '1', label: 'Today' }, { key: '7', label: '7 days' }, { key: '30', label: '30 days' }, { key: 'custom', label: 'Custom' }]

/**
 * Token Reports: volumes and waits for a date range (default the last 7 days) — totals, tokens and
 * average wait by hour of issue, volumes by day, a by-queue table (avg / p90 / max wait, service)
 * and the mix by source and priority.
 */
export function TokenReports() {
  const today = useMemo(() => new Date(), [])
  const [range, setRange] = useState<Range>('7')
  const [from, setFrom] = useState(() => iso(subDays(today, 6)))
  const [to, setTo] = useState(() => iso(today))
  const [queue, setQueue] = useState('')
  const todays = useQueueOptions()

  const pickRange = (r: Range) => {
    setRange(r)
    if (r === 'custom') return
    setFrom(iso(subDays(today, Number(r) - 1)))
    setTo(iso(today))
  }
  const q = useQuery({
    queryKey: ['x', 'queue', 'reports', { from, to, queue }],
    queryFn: () => api<Reports>('/queue/reports', { query: { date_from: from, date_to: to, queue } }),
    placeholderData: keepPreviousData,
  })
  const r = q.data

  const queueOptions = useMemo(() => {
    const m = new Map(todays.map((o) => [o.key, o.label]))
    r?.by_queue.forEach((b) => { if (!m.has(b.queue)) m.set(b.queue, b.name === b.queue ? b.queue : `${b.name} · ${b.queue}`) })
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [todays, r])

  const hours = useMemo(() => {
    if (!r?.by_hour.length) return []
    const by = new Map(r.by_hour.map((h) => [h.hour, h]))
    const lo = Math.min(...by.keys())
    const hi = Math.max(...by.keys())
    return Array.from({ length: hi - lo + 1 }, (_, i) => {
      const h = lo + i
      const x = by.get(h)
      return { label: `${String(h).padStart(2, '0')}:00`, issued: x?.issued ?? 0, avg_wait_min: x?.avg_wait_min ?? null, avg_service_min: x?.avg_service_min ?? null }
    })
  }, [r])
  const days = useMemo(() => {
    if (!r) return []
    const by = new Map(r.by_day.map((d) => [d.date, d]))
    const out = []
    for (let d = parseISO(r.from); d <= parseISO(r.to); d = addDays(d, 1)) {
      const k = iso(d)
      const x = by.get(k)
      out.push({ date: k, label: dayLabel(k), issued: x?.issued ?? 0, served: x?.served ?? 0, held: x?.skipped ?? 0, avg_wait_min: x?.avg_wait_min ?? null })
    }
    return out
  }, [r])

  const t = r?.totals
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={RANGES} value={range} onChange={pickRange} />
        <div className="flex items-center gap-1 text-xs text-ink-2">
          <Input type="date" value={from} max={to} onChange={(e) => { setRange('custom'); setFrom(e.target.value || from) }} className="h-9 w-36" aria-label="From date" />
          <span>to</span>
          <Input type="date" value={to} min={from} onChange={(e) => { setRange('custom'); setTo(e.target.value || to) }} className="h-9 w-36" aria-label="To date" />
        </div>
        <Select value={queue} onChange={(e) => setQueue(e.target.value)} className="w-60" aria-label="Queue">
          <option value="">All queues</option>
          {queueOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {r && <span className="ml-auto text-xs text-ink-3">{format(parseISO(r.from), 'dd MMM yyyy')} – {format(parseISO(r.to), 'dd MMM yyyy')}</span>}
      </div>

      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <Spinner />}
      {r && t && (
        <div className={cn('space-y-4', q.isFetching && q.isPlaceholderData && 'opacity-70')}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Issued" icon="Ticket" value={number(t.issued)} />
            <StatTile label="Served" icon="CheckCircle2" value={number(t.served)} hint={t.issued ? `${Math.round((t.served / t.issued) * 100)}% of issued` : undefined} />
            <StatTile label="Held / skipped" icon="PauseCircle" value={number(t.skipped)} tone={t.issued && t.skipped / t.issued > 0.1 ? 'alert' : 'default'} />
            <StatTile label="Average wait" icon="Hourglass" value={m1(t.avg_wait_min)} hint="token → call" />
            <StatTile label="90th percentile wait" icon="Timer" value={m1(t.p90_wait_min)} hint="9 in 10 called within" />
            <StatTile label="Average service" icon="Stethoscope" value={m1(t.avg_service_min)} hint="call → done" />
          </div>

          {t.issued === 0 ? (
            <Card><Empty icon="ChartColumn" title="No tokens in this period">Choose a wider date range or another queue.</Empty></Card>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <ChartFrame title="Tokens by hour of issue" subtitle="When patients arrive"
                  table={{ columns: ['Hour', 'Issued', 'Avg wait', 'Avg service'], rows: hours.map((h) => [h.label, h.issued, m1(h.avg_wait_min), m1(h.avg_service_min)]) }}>
                  <Bars data={hours} x="label" series={[{ key: 'issued', label: 'Tokens issued' }]} />
                </ChartFrame>
                <ChartFrame title="Average wait by hour of issue" subtitle="Token issued → called, in minutes"
                  table={{ columns: ['Hour', 'Avg wait', 'Avg service', 'Issued'], rows: hours.map((h) => [h.label, m1(h.avg_wait_min), m1(h.avg_service_min), h.issued]) }}>
                  {hours.some((h) => h.avg_wait_min != null)
                    ? <Lines data={hours} x="label" series={[{ key: 'avg_wait_min', label: 'Average wait' }]} fmt={mins} />
                    : <div className="grid h-full place-items-center text-sm text-ink-3">No token has been called in this period yet.</div>}
                </ChartFrame>
              </div>

              <ChartFrame title="Volume by day" subtitle="Issued, served and held tokens per day"
                table={{ columns: ['Date', 'Issued', 'Served', 'Held', 'Avg wait'], rows: days.map((d) => [d.label, d.issued, d.served, d.held, m1(d.avg_wait_min)]) }}>
                <Bars data={days} x="label" series={[{ key: 'issued', label: 'Issued' }, { key: 'served', label: 'Served' }, { key: 'held', label: 'Held' }]} />
              </ChartFrame>

              <Card title="By queue" icon="ListOrdered" pad={false}>
                <div className="overflow-x-auto scroll-thin">
                  <table className="w-full text-sm">
                    <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Queue</th>
                        {['Issued', 'Served', 'Held', 'Avg wait', 'P90 wait', 'Max wait', 'Avg service'].map((h) => (
                          <th key={h} className="whitespace-nowrap px-3 py-2 text-right font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.by_queue.map((b) => (
                        <tr key={b.queue} className="border-b border-line last:border-0 hover:bg-surface-2">
                          <td className="max-w-72 truncate px-3 py-1.5">
                            <span className="text-ink">{b.name}</span>
                            {b.name !== b.queue && <span className="ml-1.5 text-xs text-ink-3">{b.queue}</span>}
                          </td>
                          <td className="tabular px-3 py-1.5 text-right">{number(b.issued)}</td>
                          <td className="tabular px-3 py-1.5 text-right">{number(b.served)}</td>
                          <td className="tabular px-3 py-1.5 text-right">{number(b.skipped)}</td>
                          <td className="tabular px-3 py-1.5 text-right">{m1(b.avg_wait_min)}</td>
                          <td className={cn('tabular px-3 py-1.5 text-right', (b.p90_wait_min ?? 0) > 30 && 'font-medium text-red-600 dark:text-red-400')}>{m1(b.p90_wait_min)}</td>
                          <td className="tabular px-3 py-1.5 text-right">{m1(b.max_wait_min)}</td>
                          <td className="tabular px-3 py-1.5 text-right">{m1(b.avg_service_min)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <ChartFrame title="By source" subtitle="How tokens were issued" height={200}
                  table={{ columns: ['Source', 'Issued', 'Share'], rows: r.by_source.map((s) => [s.source, s.issued, `${Math.round((s.issued / t.issued) * 100)}%`]) }}>
                  <Bars horizontal data={[...r.by_source].sort((a, b) => b.issued - a.issued)} x="source" series={[{ key: 'issued', label: 'Tokens' }]} />
                </ChartFrame>
                <ChartFrame title="By priority" subtitle="Tokens per priority (see the table for waits)" height={200}
                  table={{ columns: ['Priority', 'Issued', 'Avg wait'], rows: r.by_priority.map((p) => [p.priority, p.issued, m1(p.avg_wait_min)]) }}>
                  <Bars horizontal data={[...r.by_priority].sort((a, b) => b.issued - a.issued)} x="priority" series={[{ key: 'issued', label: 'Tokens' }]} />
                </ChartFrame>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Full page at /queue/reports. */
export default function TokenReportsPage() {
  const access = useQueueAccess()
  useEffect(() => {
    const prev = document.title
    document.title = 'Token Reports · Vlack HRMS'
    return () => { document.title = prev }
  }, [])
  if (!access.ready) return <Spinner />
  if (!access.reports) return <Empty icon="Lock" title="Token reports are not available for your role" />
  return (
    <div>
      <PageHeader icon="ChartColumn" title="Token Reports" subtitle="Volumes and waits by hour, day, queue, source and priority."
        actions={<QueueLinks access={access} current="reports" />} />
      <TokenReports />
    </div>
  )
}
