import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Kbd, Segmented, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { ago, dateTime } from '@/lib/format'
import type { BespokeProps } from './index'
import { PriorityBadge, ResultView, Timeline, type WorkRow } from './lab-worklist'

interface Inbox { rows: WorkRow[]; scope: string; wards: string[]; counts: { critical_unack: number; unread: number; total: number } }
type Scope = 'mine' | 'ward' | 'all'

const isOpenCritical = (r: WorkRow) => r.critical && !r.acknowledged_at

export default function ResultInbox(_: BespokeProps) {
  const qc = useQueryClient()
  const role = useMeta().data?.user.role ?? ''
  const [scope, setScope] = useState<Scope>(role === 'nurse' ? 'ward' : 'mine')
  const [ward, setWard] = useState<string | null>(null)
  const [days, setDays] = useState('3')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const clinician = ['doctor', 'nurse', 'admin', 'management'].includes(role)
  const inbox = useQuery({
    queryKey: ['x', 'orders', 'inbox', scope, ward, days, unreadOnly],
    enabled: clinician,
    queryFn: () => api<Inbox>('/orders/inbox', { query: { scope, ward: scope === 'ward' ? ward : undefined, days, unread_only: unreadOnly || undefined } }),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  })
  const rows = useMemo(() => inbox.data?.rows ?? [], [inbox.data])
  const groups = useMemo(() => [
    { key: 'critical', title: 'Critical — acknowledge now', rows: rows.filter(isOpenCritical) },
    { key: 'new', title: 'New results', rows: rows.filter((r) => !isOpenCritical(r) && !r.read) },
    { key: 'read', title: 'Seen', rows: rows.filter((r) => !isOpenCritical(r) && r.read) },
  ], [rows])
  const ordered = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const current = ordered.find((r) => r.id === selected) ?? null

  const markRead = useMutation({
    mutationFn: (ids: string[]) => api('/orders/inbox/read', { method: 'POST', body: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['x', 'orders', 'inbox'] }),
  })
  const marked = useRef(new Set<string>())
  const { mutate: mark } = markRead
  useEffect(() => {
    if (current && !current.read && !marked.current.has(current.id)) {
      marked.current.add(current.id)
      mark([current.id])
    }
  }, [current, mark])
  useEffect(() => {
    if (!selected && ordered.length) setSelected(ordered[0].id)
  }, [ordered, selected])

  const onKey = (e: React.KeyboardEvent) => {
    const i = ordered.findIndex((r) => r.id === selected)
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); const n = ordered[Math.min(i + 1, ordered.length - 1)]; if (n) setSelected(n.id) }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); const n = ordered[Math.max(i - 1, 0)]; if (n) setSelected(n.id) }
  }
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])

  const c = inbox.data?.counts
  if (!clinician) {
    return <Card><Empty icon="Inbox" title="The result inbox is for clinicians">Doctors and nurses see results for their patients here. Use the laboratory or radiology worklists to manage reports.</Empty></Card>
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
        <Segmented value={scope} onChange={(s) => { setScope(s); setSelected(null) }} options={[
          { key: 'mine', label: 'My patients' }, { key: 'ward', label: 'Ward' }, { key: 'all', label: 'All' },
        ]} />
        {scope === 'ward' && (
          <div className="w-64"><RefPicker refName="mdm.wards" value={ward} onChange={(id) => { setWard(id); setSelected(null) }} placeholder="My department's wards" /></div>
        )}
        <Select value={days} onChange={(e) => setDays(e.target.value)} className="max-w-36 shrink-0" aria-label="Period">
          <option value="1">Last 24 hours</option><option value="3">Last 3 days</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option>
        </Select>
        <label className="inline-flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" className="size-4 accent-brand-700" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
        </label>
        {c && (
          <div className="ml-auto flex items-center gap-2">
            {c.critical_unack > 0 && <Badge tone="red" className="pulse-critical font-bold">{c.critical_unack} critical unacknowledged</Badge>}
            <Badge tone="blue">{c.unread} unread</Badge>
            <span className="text-xs text-ink-3">{c.total} results</span>
            {c.unread > 0 && (
              <Button size="xs" variant="ghost" loading={markRead.isPending}
                onClick={() => markRead.mutate(rows.filter((r) => !r.read && !isOpenCritical(r)).map((r) => r.id).slice(0, 200))}>Mark all seen</Button>
            )}
          </div>
        )}
      </div>

      {inbox.isLoading && <Spinner label="Loading results…" />}
      {inbox.error && <ErrorBox error={inbox.error} />}
      {inbox.data && (rows.length === 0 ? (
        <Card><Empty icon="Inbox" title="No results in this period">{scope === 'mine' ? 'Results for patients you ordered for or admitted appear here.' : 'Try a longer period or another scope.'}</Empty></Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[420px_minmax(0,1fr)]">
          <div ref={listRef} tabIndex={0} onKeyDown={onKey} role="listbox" aria-label="Results"
            className="max-h-[calc(100vh-260px)] overflow-y-auto rounded-xl border border-line bg-surface outline-none scroll-thin focus-visible:ring-2 focus-visible:ring-brand-600/30">
            {groups.filter((g) => g.rows.length).map((g) => (
              <div key={g.key}>
                <div className={cn('sticky top-0 z-[1] border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide',
                  g.key === 'critical' ? 'border-red-300 bg-red-600 text-white' : 'border-line bg-surface-2 text-ink-3')}>
                  {g.title} · {g.rows.length}
                </div>
                {g.rows.map((r) => <InboxItem key={r.id} r={r} active={r.id === selected} onSelect={() => setSelected(r.id)} />)}
              </div>
            ))}
            <p className="px-3 py-2 text-[11px] text-ink-3"><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move between results</p>
          </div>
          {current ? <ResultDetail key={current.id} r={current} /> : <Card><Empty icon="MousePointerClick" title="Select a result" /></Card>}
        </div>
      ))}
    </div>
  )
}

function InboxItem({ r, active, onSelect }: { r: WorkRow; active: boolean; onSelect: () => void }) {
  const abnormal = r.result_values.filter((v) => v.flag && v.flag !== 'Normal')
  const crit = isOpenCritical(r)
  return (
    <button type="button" role="option" aria-selected={active} onClick={onSelect}
      className={cn('flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-left last:border-0',
        active ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2', crit && !active && 'bg-red-50 dark:bg-red-500/10')}>
      <span className="flex items-center justify-between gap-2">
        <span className={cn('truncate text-sm', r.read && !crit ? 'text-ink-2' : 'font-semibold text-ink')}>{r.patient.name}</span>
        <span className="shrink-0 text-[11px] text-ink-3">{ago(r.verified_at ?? r.resulted_at)}</span>
      </span>
      <span className="flex items-center gap-1.5 text-xs">
        {!r.read && !crit && <span className="size-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}
        <span className="truncate text-ink">{r.test.name}</span>
        {crit && <Badge tone="red" className="font-bold">CRITICAL</Badge>}
        {r.critical && !crit && <Badge tone="gray">Critical · ack</Badge>}
        {r.status === 'Resulted' && <Badge tone="amber">Preliminary</Badge>}
      </span>
      <span className="truncate text-[11px] text-ink-3">
        {r.patient.uhid} · {r.location}{abnormal.length ? ` · ${abnormal.length} abnormal: ${abnormal.slice(0, 2).map((v) => `${v.parameter} ${v.value}`).join(', ')}` : r.impression ? ` · ${r.impression}` : ''}
      </span>
    </button>
  )
}

function ResultDetail({ r }: { r: WorkRow }) {
  const qc = useQueryClient()
  const role = useMeta().data?.user.role ?? ''
  const [readBack, setReadBack] = useState(true)
  const [note, setNote] = useState('')
  const canAck = ['doctor', 'nurse', 'admin'].includes(role)
  const ack = useMutation({
    mutationFn: () => api(`/orders/${r.id}/acknowledge`, { method: 'POST', body: { read_back: readBack, note: note || undefined } }),
    onSuccess: () => { toast.success('Critical result acknowledged and recorded in the audit trail'); qc.invalidateQueries({ queryKey: ['x', 'orders'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Card pad={false} className={cn(isOpenCritical(r) && 'border-red-400 dark:border-red-500/60')}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <Link to={`/patients/${r.patient.id}`} className="text-base font-semibold text-ink hover:underline">{r.patient.name}</Link>
          <div className="text-xs text-ink-2"><span className="font-mono">{r.patient.uhid}</span>{r.patient.age != null && ` · ${r.patient.age}y`}{r.patient.gender && ` ${r.patient.gender}`} · {r.location}</div>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/patients/${r.patient.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink shadow-sm hover:bg-surface-2">Open patient</Link>
          <Link to={`/m/orders/cpoe?patient=${r.patient.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink shadow-sm hover:bg-surface-2">Order follow-up</Link>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">{r.test.name}</h3>
          <span className="font-mono text-xs text-ink-3">{r.code}</span>
          <StatusBadge status={r.status} />
          {r.status === 'Resulted' && <Badge tone="amber">Preliminary — not yet authorised</Badge>}
          <PriorityBadge priority={r.priority} />
        </div>
        <Timeline o={r} />
        {r.clinical_notes && <p className="text-xs text-ink-2">Indication: {r.clinical_notes}</p>}

        {isOpenCritical(r) && (
          <div className="space-y-2 rounded-lg border-2 border-red-500 bg-red-50 p-3 dark:bg-red-500/10">
            <p className="text-sm font-semibold text-red-800 dark:text-red-200">Critical result — acknowledge after acting on it</p>
            {canAck ? (
              <>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" className="size-4 accent-brand-700" checked={readBack} onChange={(e) => setReadBack(e.target.checked)} />
                  Value read back and confirmed with the reporting lab / radiologist
                </label>
                <FieldWrap label="Action taken (recorded with the acknowledgement)">
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Platelet transfusion ordered, repeat CBC in 6 h" />
                </FieldWrap>
                <Button variant="danger" icon="BellRing" loading={ack.isPending} onClick={() => ack.mutate()}>Acknowledge critical result</Button>
              </>
            ) : <p className="text-xs text-ink-2">Only doctors and nurses can acknowledge critical results.</p>}
          </div>
        )}
        {r.critical && r.acknowledged_at && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-2">Critical result acknowledged by <b className="text-ink">{r.acknowledged_by}</b> · {dateTime(r.acknowledged_at)}</p>
        )}

        <ResultView o={r} />
        {r.pacs_url && (
          <a href={r.pacs_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-brand-700 hover:underline dark:text-brand-300">
            <ExternalLink className="size-4" /> Open images in PACS viewer {r.accession_no && <span className="font-mono text-xs">({r.accession_no})</span>}
          </a>
        )}
        <p className="text-xs text-ink-3">
          {r.ordering_doctor && <>Ordered by {r.ordering_doctor}{r.verbal_order && ' (verbal)'} · </>}
          {r.resulted_by && <>Resulted by {r.resulted_by} · </>}
          {r.verified_by && <>Authorised by {r.verified_by}</>}
        </p>
      </div>
    </Card>
  )
}
