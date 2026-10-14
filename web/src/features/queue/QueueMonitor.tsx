import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { Badge, Button, cn, Empty, ErrorBox, PageHeader, Select, Spinner, StatTile, Switch } from '@/components/ui'
import { api } from '@/lib/api'
import { minutes, time } from '@/lib/format'
import { useQueueAccess } from './access'
import type { Monitor, MonitorLine } from './types'
import { isDoctorQueue } from './ui'

const LONG_WAIT = 30
const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false }) : '—')

/** Opens the Counter Console on a queue (the console resolves `?queue=` to a counter or cabin). */
export const consolePath = (queue: string) => `/m/queue/queue-console?queue=${encodeURIComponent(queue)}`

/**
 * Queue Monitor: every line's live state side by side — waiting, called, in service, held, the
 * longest wait (the figure a queue is judged on), estimated wait and capacity. Polls every 10 s
 * (and refreshes on realtime token changes).
 */
export function QueueMonitor() {
  const access = useQueueAccess()
  const nav = useNavigate()
  const [kind, setKind] = useState('')
  const [dept, setDept] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const q = useQuery({
    queryKey: ['x', 'queue', 'monitor', { kind, dept }],
    queryFn: () => api<Monitor>('/queue/monitor', { query: { kind, department_id: dept } }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  })
  const m = q.data
  // a filter value that disappears from the lists (e.g. no cabins today) falls back to "All"
  useEffect(() => {
    if (!m) return
    if (kind && !m.kinds.includes(kind)) setKind('')
    if (dept && !m.departments.some((d) => d.id === dept)) setDept('')
  }, [m, kind, dept])

  const lines = (m?.lines ?? []).filter((l) => !activeOnly || l.waiting + l.called + l.in_service + l.held > 0)
  const k = m?.kpis
  const open = access.console ? (l: MonitorLine) => nav(consolePath(l.queue)) : undefined

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Waiting" icon="Users" value={k?.waiting ?? '—'} hint={k ? `${k.held} held · ${k.issued} issued today` : undefined} />
        <StatTile label="Called" icon="Megaphone" value={k?.called ?? '—'} />
        <StatTile label="In service" icon="UserCheck" value={k?.in_service ?? '—'} />
        <StatTile label="Longest wait" icon="Hourglass" value={k?.longest_wait_min != null ? minutes(k.longest_wait_min) : '—'}
          tone={(k?.longest_wait_min ?? 0) > LONG_WAIT ? 'alert' : 'default'} hint="oldest waiting token" />
        <StatTile label="At capacity" icon="Ban" value={k?.at_capacity ?? '—'} tone={k?.at_capacity ? 'alert' : 'default'} hint="lines at today's cap" />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <label className="min-w-40">
          <span className="mb-1 block text-xs font-medium text-ink-2">Kind</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            <option value="">All kinds</option>
            {m?.kinds.map((x) => <option key={x}>{x}</option>)}
          </Select>
        </label>
        <label className="min-w-52">
          <span className="mb-1 block text-xs font-medium text-ink-2">Department</span>
          <Select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {m?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </label>
        <label className="flex h-9 items-center gap-2 text-sm text-ink-2">
          <Switch checked={activeOnly} onChange={setActiveOnly} label="Only lines with tokens" size="sm" /> Only lines with tokens
        </label>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-ink-3" aria-live="polite">
            <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500 align-middle" />
            Live — refreshes every 10 s{m ? ` · updated ${clock(m.updated_at)}` : ''}
          </span>
          <Button size="sm" onClick={() => q.refetch()} disabled={q.isFetching} title="Refresh now">
            <RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <Spinner />}
      {m && lines.length === 0 && (
        activeOnly && m.lines.length
          ? <Empty icon="Smile" title="No tokens on any line right now">Switch off “Only lines with tokens” to see every line.</Empty>
          : <Empty icon="ListOrdered" title="No queues match">Lines appear here from Queues, Counters & Cabins and today's doctor schedules.</Empty>
      )}
      {lines.length > 0 && (
        <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', q.isFetching && q.isPlaceholderData && 'opacity-70')}>
          {lines.map((l) => <LineCard key={l.queue} line={l} onOpen={open} />)}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, alert }: { label: string; value: ReactNode; alert?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cn('tabular text-lg font-semibold leading-tight', alert ? 'text-red-600 dark:text-red-400' : 'text-ink')}>{value}</div>
    </div>
  )
}

function LineCard({ line: l, onOpen }: { line: MonitorLine; onOpen?: (l: MonitorLine) => void }) {
  const doctor = isDoctorQueue(l.queue)
  const sub = [l.code, l.kind, l.owner && l.owner !== l.name ? l.owner : null, l.department].filter(Boolean).join(' · ')
  const longAlert = (l.longest_wait_min ?? 0) > LONG_WAIT
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">{l.name}</h3>
          <p className="truncate text-xs text-ink-3" title={sub}>{sub}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="tabular rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2 ring-1 ring-line">{l.queue}</span>
          {l.at_capacity && <Badge tone="red" dot>At capacity</Badge>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        <Metric label="Waiting" value={l.waiting} />
        <Metric label="Called" value={l.called} />
        <Metric label="In svc" value={l.in_service} />
        <Metric label="Held" value={l.held} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Metric label="Longest wait" value={l.longest_wait_min != null ? minutes(l.longest_wait_min) : '—'} alert={longAlert} />
        <Metric label="Est. wait" value={minutes(l.est_wait_min)} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line pt-2 text-[11px] text-ink-3">
        <span className="min-w-0 truncate">
          Last issued {l.last_issued ? <span className="tabular text-ink-2">{l.last_issued.label} {time(l.last_issued.at)}</span> : '—'}
          {' · '}last called {l.last_called
            ? <span className="tabular text-ink-2">{l.last_called.label} {time(l.last_called.at)}{l.last_called.counter ? ` · ${l.last_called.counter}` : ''}</span>
            : '—'}
        </span>
        <span className="shrink-0">
          {doctor ? `Cabin${l.room ? ` ${l.room}` : ''}` : `${l.counters} counter${l.counters === 1 ? '' : 's'}${l.counters ? ` (${l.open_counters} open)` : ''}`}
          {' · '}{l.capacity ? `cap ${l.capacity} (${l.issued} issued)` : 'no cap'}
        </span>
      </div>
    </>
  )
  const cls = cn('block w-full rounded-xl border bg-surface p-4 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
    l.at_capacity ? 'border-red-300 dark:border-red-500/40' : 'border-line')
  if (!onOpen) return <section className={cls}>{body}</section>
  return (
    <button type="button" onClick={() => onOpen(l)} title={`Open ${l.name} in the Counter Console`}
      className={cn(cls, 'transition-colors hover:border-brand-600/50 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600')}>
      {body}
    </button>
  )
}

/** Full page at /queue/monitor. */
export default function QueueMonitorPage() {
  const access = useQueueAccess()
  useEffect(() => {
    const prev = document.title
    document.title = 'Queue Monitor · Vlack HRMS'
    return () => { document.title = prev }
  }, [])
  if (!access.ready) return <Spinner />
  if (!access.monitor) return <Empty icon="Lock" title="Queue Monitor is not available for your role" />
  return (
    <div>
      <PageHeader icon="Gauge" title="Queue Monitor"
        subtitle="Every line's live state, side by side. The longest wait is the figure a queue is judged on."
        actions={<QueueLinks access={access} current="monitor" />} />
      <QueueMonitor />
    </div>
  )
}

/** Cross-links between the queue screens, only those the role can open. */
export function QueueLinks({ access, current }: { access: ReturnType<typeof useQueueAccess>; current: 'monitor' | 'register' | 'reports' | 'console' }) {
  const items = [
    current !== 'monitor' && access.monitor && { to: '/queue/monitor', label: 'Queue Monitor' },
    current !== 'console' && access.console && { to: '/m/queue/queue-console', label: 'Counter Console' },
    access.issue && { to: '/queue/issue', label: 'Issue token' },
    current !== 'register' && access.register && { to: '/queue/register', label: 'Token Register' },
    current !== 'reports' && access.reports && { to: '/queue/reports', label: 'Token Reports' },
  ].filter(Boolean) as { to: string; label: string }[]
  return (
    <>
      {items.map((i) => (
        <Link key={i.to} to={i.to} className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-brand-700 hover:bg-surface-2 dark:text-brand-300">{i.label} →</Link>
      ))}
    </>
  )
}
