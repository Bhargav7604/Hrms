import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Badge, Card, Empty, ErrorBox, FieldWrap, Input, Segmented, Spinner, StatusBadge, type BadgeTone } from '@/components/ui'
import { useDebounced } from '@/components/fields'
import { api } from '@/lib/api'
import { dateTime, todayISO } from '@/lib/format'
import { Kpi, LabShell } from './shell'

type Kind = 'all' | 'sample' | 'rerun' | 'cancelled' | 'rollback'
interface Row {
  id: string; kind: Exclude<Kind, 'all'>; at: string; by?: string | null; role?: string | null; reason?: string | null
  order: { id: string; code: string; status: string; sample_barcode?: string | null; recollect_count?: number | null }
  patient: { id: string; name: string; uhid?: string | null }; location: string; test?: string | null; section?: string | null
  previous_values: { parameter: string; value?: string | null }[]; verified_by?: string | null
}
interface Res { rows: Row[]; counts: Record<string, number>; from: string; to: string }

export const KIND: Record<Exclude<Kind, 'all'>, { label: string; tone: BadgeTone }> = {
  sample: { label: 'Sample rejected', tone: 'red' }, rerun: { label: 'Sent for re-run', tone: 'amber' },
  cancelled: { label: 'Result cancelled', tone: 'violet' }, rollback: { label: 'Authorisation rolled back', tone: 'blue' },
}

const weekAgo = () => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10) }

export function RejectedRegister({ initialKind = 'all', screen = 'rejected', title = 'Rejected reports', icon = 'FileX2' }: { initialKind?: Kind; screen?: string; title?: string; icon?: string }) {
  const [kind, setKind] = useState<Kind>(initialKind)
  const [from, setFrom] = useState(weekAgo())
  const [to, setTo] = useState(todayISO())
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const list = useQuery({
    queryKey: ['x', 'lab', 'rejected', kind, from, to, dq],
    queryFn: () => api<Res>('/lab/rejected', { query: { kind, date_from: from, date_to: to, q: dq || undefined } }),
    placeholderData: (p) => p,
  })
  const c = list.data?.counts ?? {}
  return (
    <LabShell screen={screen} icon={icon} title={title}
      subtitle="Every rejected sample, re-run, cancelled result and withdrawn authorisation — who, when and why — with the current state of the test. A NABH quality indicator (sample rejection rate)."
      actions={(
        <div className="flex flex-wrap gap-2">
          <Kpi icon="TestTubeDiagonal" label="Samples rejected" value={c.sample ?? 0} />
          <Kpi icon="RotateCcw" label="Re-runs" value={c.rerun ?? 0} />
          <Kpi icon="Ban" label="Cancelled" value={c.cancelled ?? 0} />
          <Kpi icon="Undo2" label="Rolled back" value={c.rollback ?? 0} />
        </div>
      )}>
      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-2.5">
        <FieldWrap label="Show">
          <Segmented value={kind} onChange={setKind} options={[{ key: 'all', label: 'All' }, { key: 'sample', label: 'Samples' }, { key: 'rerun', label: 'Re-runs' }, { key: 'cancelled', label: 'Cancelled' }, { key: 'rollback', label: 'Roll-backs' }]} />
        </FieldWrap>
        <FieldWrap label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" /></FieldWrap>
        <FieldWrap label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" /></FieldWrap>
        <FieldWrap label="Search" className="min-w-56 flex-1">
          <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" placeholder="Order / patient / UHID / test / reason" /></div>
        </FieldWrap>
      </div>
      <Card pad={false}>
        {list.isLoading && <Spinner />}
        {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
        {list.data && list.data.rows.length === 0 && <Empty icon="CircleCheck" title="Nothing in this period" />}
        {list.data && list.data.rows.length > 0 && (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2">
                <tr>{['When', 'Event', 'Patient', 'Test', 'Order', 'Reason', 'By', 'Withdrawn values', 'Now'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {list.data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{dateTime(r.at)}</td>
                    <td className="px-3 py-2"><Badge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Badge></td>
                    <td className="max-w-48 px-3 py-2"><Link to={`/patients/${r.patient.id}`} className="block truncate text-ink hover:underline">{r.patient.name}</Link><div className="truncate text-xs text-ink-3">{r.patient.uhid} · {r.location}</div></td>
                    <td className="px-3 py-2 text-ink">{r.test}<div className="text-xs text-ink-3">{r.section}</div></td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.order.code}{r.order.recollect_count ? <div className="text-ink-3">recollected ×{r.order.recollect_count}</div> : null}</td>
                    <td className="max-w-64 px-3 py-2 text-ink">{r.reason}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{r.by}<div className="text-ink-3">{r.role}</div></td>
                    <td className="max-w-56 px-3 py-2 text-xs text-ink-2">{r.previous_values.slice(0, 4).map((v) => `${v.parameter} ${v.value}`).join(' · ')}{r.verified_by && <div className="text-ink-3">was authorised by {r.verified_by}</div>}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.order.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </LabShell>
  )
}

export default function RejectedReports() {
  return <RejectedRegister />
}
