import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Badge, Card, cn, Empty, ErrorBox, Input, Select, Spinner, StatusBadge } from '@/components/ui'
import { useDebounced } from '@/components/fields'
import { NewButton, RecordDrawer, useEntity } from '@/components/records'
import { api } from '@/lib/api'
import { money, minutes } from '@/lib/format'
import { Kpi, LabShell } from './shell'

interface Svc {
  id: string; code: string; name: string; short_name?: string | null; section?: string | null; method?: string | null; sample_type?: string | null
  container?: string | null; sample_volume?: string | null; tat_minutes?: number | null; rate?: number | null; status: string; outsourced: boolean
  reference_lab?: string | null; analyzer?: string | null; department?: string | null; prep_instructions?: string | null; parameter_count: number
  parameters: { parameter: string; unit?: string | null; ref_low?: number | null; ref_high?: number | null; critical_low?: number | null; critical_high?: number | null; method?: string | null; delta_percent?: number | null }[]
}

export default function AllServices() {
  const ent = useEntity('lab.tests')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 250)
  const [section, setSection] = useState('')
  const [status, setStatus] = useState('Active')
  const [openId, setOpenId] = useState<string | null>(null)
  const list = useQuery({
    queryKey: ['x', 'lab', 'services', dq, section, status],
    queryFn: () => api<{ rows: Svc[]; sections: Record<string, number>; total: number }>('/lab/services', { query: { q: dq || undefined, section: section || undefined, status: status || undefined } }),
    placeholderData: (p) => p,
  })
  const rows = list.data?.rows ?? []
  const secs = list.data?.sections ?? {}
  const open = rows.find((r) => r.id === openId)
  return (
    <LabShell screen="services" icon="BookOpen" title="All services"
      subtitle="The laboratory test catalogue: section, method, sample and container, turnaround and rate, with parameters and reference limits."
      actions={<div className="flex items-center gap-2"><Kpi icon="FlaskConical" label="Tests" value={list.data?.total ?? '—'} /><Kpi icon="Truck" label="Out-sourced" value={rows.filter((r) => r.outsourced).length} />{ent && <NewButton entity={ent} label="New test" />}</div>}>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" placeholder="Test name / code / method" aria-label="Search tests" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36" aria-label="Status"><option value="">All</option><option>Active</option><option>Inactive</option></Select>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[['', 'All sections', Object.values(secs).reduce((a, b) => a + b, 0)] as const, ...Object.entries(secs).map(([k, v]) => [k, k, v] as const)].map(([k, label, n]) => (
          <button key={k || 'all'} onClick={() => setSection(k)}
            className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium', section === k ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-surface text-ink-2 hover:bg-surface-2')}>
            {label}<span className={cn('rounded-full px-1.5 tabular', section === k ? 'bg-white/20' : 'bg-surface-2')}>{n}</span>
          </button>
        ))}
      </div>
      <Card pad={false}>
        {list.isLoading && <Spinner />}
        {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
        {list.data && rows.length === 0 && <Empty icon="SearchX" title="No tests match" />}
        {rows.length > 0 && (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-2">
                <tr>{['Code', 'Test', 'Section', 'Method', 'Sample', 'Container', 'TAT', 'Rate', 'Parameters', 'Status'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => setOpenId(r.id)} className="cursor-pointer border-t border-line hover:bg-surface-2">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-ink-2">{r.code}</td>
                    <td className="px-3 py-2 font-medium text-ink">{r.name}{r.short_name && <span className="ml-1 text-xs text-ink-3">({r.short_name})</span>}{r.outsourced && <Badge tone="violet" className="ml-1.5">Out-sourced</Badge>}</td>
                    <td className="px-3 py-2 text-ink-2">{r.section}</td>
                    <td className="px-3 py-2 text-xs text-ink-2">{r.method ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-ink-2">{r.sample_type}{r.sample_volume && ` · ${r.sample_volume}`}</td>
                    <td className="px-3 py-2 text-xs text-ink-2">{r.container ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{minutes(r.tat_minutes)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular text-ink">{money(r.rate)}</td>
                    <td className="px-3 py-2 tabular text-ink-2">{r.parameter_count}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && ent && (
        <RecordDrawer entity={ent} id={open.id} onClose={() => setOpenId(null)}>
          {() => (
            <div className="space-y-2 px-5 pt-4">
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge tone="blue">{open.section}</Badge>{open.analyzer && <Badge tone="gray">Analyser: {open.analyzer}</Badge>}
                {open.reference_lab && <Badge tone="violet">Reference lab: {open.reference_lab}</Badge>}{open.department && <Badge tone="gray">{open.department}</Badge>}
              </div>
              {open.parameters.length > 0 && (
                <table className="w-full text-xs">
                  <thead className="text-ink-3"><tr>{['Parameter', 'Unit', 'Reference', 'Critical', 'Method', 'Δ check'].map((h) => <th key={h} className="py-1 text-left font-medium">{h}</th>)}</tr></thead>
                  <tbody>{open.parameters.map((p) => (
                    <tr key={p.parameter} className="border-t border-line text-ink">
                      <td className="py-1">{p.parameter}</td><td>{p.unit}</td>
                      <td className="tabular">{p.ref_low ?? '—'} – {p.ref_high ?? '—'}</td>
                      <td className="tabular text-red-700 dark:text-red-300">{p.critical_low != null || p.critical_high != null ? `< ${p.critical_low ?? '—'} · > ${p.critical_high ?? '—'}` : '—'}</td>
                      <td>{p.method ?? '—'}</td><td>{p.delta_percent != null ? `${p.delta_percent}%` : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              <p className="text-xs text-ink-3">Age- and sex-specific ranges, reflex and delta rules are kept in Lab setup.</p>
            </div>
          )}
        </RecordDrawer>
      )}
    </LabShell>
  )
}
