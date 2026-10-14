import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useDebounced } from '@/components/fields'
import { Pager } from '@/components/list'
import { Button, cn, Empty, ErrorBox, Input, PageHeader, Select, Spinner } from '@/components/ui'
import { api, apiUrl } from '@/lib/api'
import { date, minutes, time, todayISO } from '@/lib/format'
import { useQueueAccess } from './access'
import { QueueLinks } from './QueueMonitor'
import { PRIORITIES, TOKEN_SOURCES, TOKEN_STATUSES, type Monitor, type RegisterPage } from './types'
import { PriorityBadge, statusLabel, TokenStatus } from './ui'

/** Today's lines (shared with the Queue Monitor cache) as queue filter options. */
export function useQueueOptions() {
  const q = useQuery({
    queryKey: ['x', 'queue', 'monitor', { kind: '', dept: '' }],
    queryFn: () => api<Monitor>('/queue/monitor'),
    staleTime: 60_000,
  })
  return useMemo(() => (q.data?.lines ?? []).map((l) => ({ key: l.queue, label: l.name === l.queue ? l.queue : `${l.name} · ${l.queue}` }))
    .sort((a, b) => a.label.localeCompare(b.label)), [q.data])
}

const td = 'whitespace-nowrap px-3 py-1.5'
const sub = 'block truncate text-xs text-ink-3'

/**
 * Token Register: every token in a date range with its queue, status, priority, source, patient,
 * issue / call / done times, counter, wait and service minutes. Paged; CSV export of the filters.
 */
export function TokenRegister() {
  const [from, setFrom] = useState(todayISO)
  const [to, setTo] = useState(todayISO)
  const [queue, setQueue] = useState('')
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('')
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 300)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(50)
  const queues = useQueueOptions()

  const filters = { date_from: from, date_to: to, queue, status, priority, source, q: dq }
  const key = JSON.stringify(filters)
  useEffect(() => { setPage(1) }, [key, limit])
  const list = useQuery({
    queryKey: ['x', 'queue', 'register', filters, page, limit],
    queryFn: () => api<RegisterPage>('/queue/register', { query: { ...filters, page, limit } }),
    placeholderData: keepPreviousData,
  })
  const rows = list.data?.rows ?? []
  const filtered = !!(queue || status || priority || source || dq)
  const reset = () => { setQueue(''); setStatus(''); setPriority(''); setSource(''); setQ('') }
  const multiDay = from !== to

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-center gap-1 text-xs text-ink-2">
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value || todayISO())} className="h-9 w-36" aria-label="From date" />
          <span>to</span>
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value || from)} className="h-9 w-36" aria-label="To date" />
        </div>
        <Select value={queue} onChange={(e) => setQueue(e.target.value)} className="w-56" aria-label="Queue">
          <option value="">All queues</option>
          {queue && !queues.some((o) => o.key === queue) && <option value={queue}>{queue}</option>}
          {queues.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36" aria-label="Status">
          <option value="">All statuses</option>
          {TOKEN_STATUSES.map((s) => <option key={s} value={s}>{s === 'Skipped' ? 'Held (skipped)' : s}</option>)}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-40" aria-label="Priority">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
        </Select>
        <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-36" aria-label="Source">
          <option value="">All sources</option>
          {TOKEN_SOURCES.map((s) => <option key={s}>{s}</option>)}
        </Select>
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="UHID, name or token no." className="pl-8" aria-label="Search tokens"
            data-list-search="" onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() } }} />
        </div>
        {filtered && <Button size="sm" variant="ghost" onClick={reset}><X className="size-4" /> Clear</Button>}
        <a href={apiUrl('/queue/register', { ...filters, format: 'csv' }, true)} download
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink shadow-sm hover:bg-surface-2"
          title="Download the register with these filters as CSV (audited)">
          <Download className="size-4" /> CSV
        </a>
      </div>

      {list.error && <ErrorBox error={list.error} />}
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>
                {['Token', 'Queue', 'Status · counter', 'Priority · source', 'Patient', 'Issued · called · done', 'Wait · service'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className={cn(list.isFetching && list.isPlaceholderData && 'opacity-70')}>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line align-top last:border-0 hover:bg-surface-2">
                  <td className={td}>
                    <span className="tabular block font-semibold text-ink">{r.label}</span>
                    <span className={sub}>{multiDay ? date(r.date) : r.code}</span>
                  </td>
                  <td className={cn(td, 'max-w-48')} title={`${r.queue_name} · ${r.queue}`}>
                    <span className="block truncate text-ink">{r.queue_name}</span>
                    {r.queue_name !== r.queue && <span className={sub}>{r.queue}</span>}
                  </td>
                  <td className={cn(td, 'max-w-48')}>
                    <TokenStatus status={r.status} transferredTo={r.transferred_to} />
                    {r.counter && <span className={cn(sub, 'mt-0.5')} title={r.counter}>{r.counter}</span>}
                  </td>
                  <td className={td}>
                    {r.priority && r.priority !== 'Normal' ? <PriorityBadge p={r.priority} /> : <span className="text-ink-2">Normal</span>}
                    <span className={sub}>{r.source ?? '—'}</span>
                  </td>
                  <td className={cn(td, 'max-w-56')}>
                    {r.patient_id && r.patient ? (
                      <Link to={`/patients/${r.patient_id}`} className="block truncate text-brand-700 hover:underline dark:text-brand-300">{r.patient}</Link>
                    ) : <span className="text-ink-3">Walk-in</span>}
                    {r.uhid && <span className={sub}>{r.uhid}</span>}
                  </td>
                  <td className={cn(td, 'tabular')}>
                    <span className="block text-ink">{time(r.issued_at)}</span>
                    <span className={sub}>
                      called {r.called_at ? time(r.called_at) : '—'}{r.calls && r.calls > 1 ? ` (×${r.calls})` : ''} · done {r.served_at ? time(r.served_at) : '—'}
                    </span>
                  </td>
                  <td className={cn(td, 'tabular')}>
                    <span className={cn('block', (r.wait_min ?? 0) > 30 ? 'font-medium text-red-600 dark:text-red-400' : 'text-ink')}>{r.wait_min != null ? minutes(r.wait_min) : '—'}</span>
                    <span className={sub}>service {r.service_min != null ? minutes(r.service_min) : '—'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.isLoading && <Spinner />}
        {list.data && rows.length === 0 && (
          <Empty icon="Ticket" title={filtered ? 'No tokens match the filters' : 'No tokens in this period'}>
            {status ? `Status: ${statusLabel(status)}. ` : ''}Change the dates or clear the filters.
          </Empty>
        )}
        {list.data && list.data.total > 0 && (
          <Pager page={page} limit={limit} total={list.data.total} onPage={setPage} onLimit={setLimit} fetching={list.isFetching} />
        )}
      </div>
    </div>
  )
}

/** Full page at /queue/register. */
export default function TokenRegisterPage() {
  const access = useQueueAccess()
  useEffect(() => {
    const prev = document.title
    document.title = 'Token Register · Vlack HRMS'
    return () => { document.title = prev }
  }, [])
  if (!access.ready) return <Spinner />
  if (!access.register) return <Empty icon="Lock" title="The token register is not available for your role" />
  return (
    <div>
      <PageHeader icon="ClipboardList" title="Token Register" subtitle="Every token issued — who, which line, when it was called and how long it took."
        actions={<QueueLinks access={access} current="register" />} />
      <TokenRegister />
    </div>
  )
}
