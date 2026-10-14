import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, cn, Empty, ErrorBox, Input, Segmented, Select, Spinner } from '@/components/ui'
import { useDebounced } from '@/components/fields'
import { api, errorMessage } from '@/lib/api'
import { dateTime, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { PriorityBadge, TatCell } from '@/pages/bespoke/lab-worklist'
import { LabelPrint, type SampleLabel } from './labels'
import { Kpi, LabShell } from './shell'
import type { LabRow } from './types'

interface Tube { container?: string | null; sample_type?: string | null; volume?: string | null; tests: string[]; order_ids: string[] }
interface Group {
  patient: LabRow['patient']; location: string; ward?: string | null; bed?: string | null; ward_id?: string | null; ip_no?: string | null
  patient_type: 'IP' | 'OP' | 'ER'; orders: LabRow[]; priority: string; oldest: string; recollect: boolean; tubes: Tube[]; tube_count: number
}
interface Res {
  patients: Group[]; wards: { id: string; name: string; orders: number; patients: number }[]
  totals: { patients: number; orders: number; tubes: number; stat: number; recollect: number }; generated_at: string
}

const tubeKey = (o: LabRow) => o.test.container || o.test.sample_type || o.id

export default function SampleCollection() {
  const qc = useQueryClient()
  const [location, setLocation] = useState<'all' | 'IP' | 'OP' | 'ER'>('all')
  const [ward, setWard] = useState('')
  const [priority, setPriority] = useState('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [point, setPoint] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [labels, setLabels] = useState<SampleLabel[] | null>(null)

  const list = useQuery({
    queryKey: ['x', 'lab', 'collection', location, ward, priority, dq],
    queryFn: () => api<Res>('/lab/collection', { query: { location, ward: ward || undefined, priority: priority || undefined, q: dq || undefined } }),
    refetchInterval: 60_000,
    placeholderData: (p) => p,
  })
  const collect = useMutation({
    mutationFn: () => api<{ labels: SampleLabel[]; patients: number; tubes: number; orders: number }>('/lab/collection/bulk', {
      method: 'POST', body: { order_ids: [...sel], collection_point: point.trim() || undefined },
    }),
    onSuccess: (r) => {
      toast.success(`Collected ${r.orders} test${r.orders > 1 ? 's' : ''} from ${r.patients} patient${r.patients > 1 ? 's' : ''} in ${r.tubes} tube${r.tubes > 1 ? 's' : ''}`)
      setLabels(r.labels)
      setSel(new Set())
      qc.invalidateQueries({ queryKey: ['x', 'lab'] })
      qc.invalidateQueries({ queryKey: ['x', 'orders'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const groups = list.data?.patients ?? []
  const summary = useMemo(() => {
    const byPatient = new Map<string, Set<string>>()
    for (const g of groups) for (const o of g.orders) if (sel.has(o.id)) {
      const s = byPatient.get(g.patient.id) ?? new Set<string>()
      s.add(tubeKey(o))
      byPatient.set(g.patient.id, s)
    }
    return { patients: byPatient.size, tubes: [...byPatient.values()].reduce((n, s) => n + s.size, 0) }
  }, [groups, sel])
  const setMany = (ids: string[], on: boolean) => setSel((cur) => { const n = new Set(cur); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n })
  const t = list.data?.totals

  return (
    <LabShell screen="collection" icon="Syringe" title="Sample collection"
      subtitle="Pending lab orders grouped by patient. Tests that share a container go in one tube — tick patients or tests, collect in one round and print a label for every tube."
      actions={t && (
        <div className="flex flex-wrap gap-2">
          <Kpi icon="Users" label="Patients" value={t.patients} />
          <Kpi icon="FlaskConical" label="Tests" value={t.orders} />
          <Kpi icon="TestTube" label="Tubes" value={t.tubes} />
          <Kpi icon="Siren" label="STAT" value={t.stat} tone={t.stat ? 'alert' : undefined} />
          <Kpi icon="RotateCcw" label="Recollect" value={t.recollect} tone={t.recollect ? 'alert' : undefined} />
        </div>
      )}>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
        <Segmented value={location} onChange={(v) => { setLocation(v); if (v !== 'IP' && v !== 'all') setWard('') }}
          options={[{ key: 'all', label: 'All' }, { key: 'IP', label: 'In-patients' }, { key: 'OP', label: 'OP' }, { key: 'ER', label: 'ER' }]} />
        <Select value={ward} onChange={(e) => setWard(e.target.value)} className="w-60" aria-label="Ward">
          <option value="">All wards</option>
          {(list.data?.wards ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} — {w.patients} pt / {w.orders} tests</option>)}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-36" aria-label="Priority">
          <option value="">All priorities</option><option>STAT</option><option>Urgent</option><option>Routine</option>
        </Select>
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" placeholder="Patient / UHID / IP no / bed / test" aria-label="Search" />
        </div>
        <Button variant="ghost" className="px-2.5" aria-label="Refresh" onClick={() => list.refetch()}><RefreshCw className={cn('size-4', list.isFetching && 'animate-spin')} /></Button>
      </div>

      {list.isLoading && <Spinner />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data && groups.length === 0 && <Empty icon="Syringe" title="Nothing to collect">No pending lab orders match these filters.</Empty>}

      <div className="space-y-2 pb-20">
        {groups.map((g) => {
          const ids = g.orders.map((o) => o.id)
          const all = ids.every((i) => sel.has(i))
          const some = !all && ids.some((i) => sel.has(i))
          return (
            <article key={g.patient.id} className={cn('rounded-xl border bg-surface', g.priority === 'STAT' ? 'border-red-300 dark:border-red-500/40' : 'border-line', (all || some) && 'ring-2 ring-brand-600/30')}>
              <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
                <input type="checkbox" className="size-4 accent-brand-700" checked={all} ref={(el) => { if (el) el.indeterminate = some }}
                  aria-label={`Collect all for ${g.patient.name}`} onChange={(e) => setMany(ids, e.target.checked)} />
                <Link to={`/patients/${g.patient.id}`} className="font-medium text-ink hover:underline">{g.patient.name}</Link>
                <span className="font-mono text-xs text-ink-2">{g.patient.uhid}</span>
                <span className="text-xs text-ink-2">{g.patient.age != null ? `${g.patient.age}y` : ''} {g.patient.gender?.[0] ?? ''}</span>
                {g.ward ? <Badge tone="green"><Icon name="BedDouble" className="size-3" />{g.ward} · {g.bed}</Badge> : <Badge tone={g.patient_type === 'ER' ? 'red' : 'blue'}>{g.location}</Badge>}
                <PriorityBadge priority={g.priority} />
                {g.recollect && <Badge tone="red">Recollect</Badge>}
                <span className="ml-auto text-xs text-ink-2">{g.tube_count} tube{g.tube_count > 1 ? 's' : ''} · {g.orders.length} test{g.orders.length > 1 ? 's' : ''} · oldest {time(g.oldest)}</span>
              </header>
              <div className="grid gap-2 p-2.5 md:grid-cols-2 xl:grid-cols-3">
                {g.tubes.map((tb, i) => (
                  <div key={i} className="rounded-lg border border-line bg-surface-2/50 p-2">
                    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2">
                      <Icon name="TestTube" className="size-3.5" />{tb.container ?? tb.sample_type ?? 'Sample'}{tb.volume && ` · ${tb.volume}`}
                    </div>
                    <ul className="space-y-1">
                      {g.orders.filter((o) => tb.order_ids.includes(o.id)).map((o) => (
                        <li key={o.id}>
                          <label className="flex cursor-pointer items-start gap-2 text-sm">
                            <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={sel.has(o.id)} onChange={(e) => setMany([o.id], e.target.checked)} />
                            <span className="min-w-0 flex-1">
                              <span className="text-ink">{o.test.name}</span>{o.priority !== 'Routine' && <> <PriorityBadge priority={o.priority} /></>}
                              <span className="block text-[11px] text-ink-3"><span className="font-mono">{o.code}</span> · {dateTime(o.ordered_at)}{o.recollect_reason && <span className="text-red-700 dark:text-red-300"> · rejected: {o.recollect_reason}</span>}</span>
                            </span>
                            <TatCell r={o} />
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </article>
          )
        })}
      </div>

      {sel.size > 0 && (
        <div className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 py-2.5 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <span className="text-sm text-ink"><b>{sel.size}</b> test{sel.size > 1 ? 's' : ''} · <b>{summary.patients}</b> patient{summary.patients > 1 ? 's' : ''} · <b>{summary.tubes}</b> tube{summary.tubes > 1 ? 's' : ''}</span>
            <Input value={point} onChange={(e) => setPoint(e.target.value)} className="w-64" placeholder="Collection point (e.g. Ward 3 morning round)" aria-label="Collection point" />
            <Button variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>
            <Button variant="primary" icon="Printer" loading={collect.isPending} onClick={() => collect.mutate()} className="ml-auto">Collect & print {summary.tubes} label{summary.tubes > 1 ? 's' : ''}</Button>
          </div>
        </div>
      )}
      {labels && <LabelPrint labels={labels} onClose={() => setLabels(null)} />}
    </LabShell>
  )
}
