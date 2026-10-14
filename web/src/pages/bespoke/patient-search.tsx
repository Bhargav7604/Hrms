import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useDebounced } from '@/components/fields'
import { NewButton } from '@/components/records'
import { Avatar, Badge, Card, Empty, Input, Spinner, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { age, date } from '@/lib/format'
import type { ListResult } from '@/lib/types'
import type { BespokeProps } from './index'

/** Master Patient Index search across UHID, name, mobile, ABHA and ID (last 4). */
export default function PatientSearch(_: BespokeProps) {
  const nav = useNavigate()
  const reg = useRegistry()
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const res = useQuery({
    queryKey: ['m', 'registration', 'patients', 'mpi', dq],
    queryFn: () => api<ListResult>('/m/registration/patients', { query: { q: dq, limit: 50, sort: 'title' } }),
    enabled: dq.trim().length >= 2,
  })
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-72 flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-3" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" placeholder="UHID, name, mobile number, ABHA or last 4 digits of ID" />
          </div>
          <NewButton entity={reg.entity('registration.merge_requests')} label="Request merge" variant="secondary" />
        </div>
      </Card>
      {res.isFetching && <Spinner />}
      {res.data && res.data.rows.length === 0 && <Empty icon="SearchX" title="No patient found">Check the spelling or search by mobile number.</Empty>}
      {res.data && res.data.rows.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {res.data.rows.map((p) => (
            <button key={p.id} onClick={() => nav(`/patients/${p.id}`)} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left hover:border-brand-600/40">
              <Avatar name={p.title} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ink">{p.title}</span>
                  <StatusBadge status={p.status} />
                </div>
                <div className="text-xs text-ink-2"><span className="font-mono">{p.code}</span> · {[age(p.dob), p.gender].filter(Boolean).join(' ')} · {p.phone}</div>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-ink-3">
                  {p.abha_id && <Badge tone="cyan">ABHA</Badge>}
                  {p.category && p.category !== 'General' && <Badge tone="violet">{p.category}</Badge>}
                  <span>Registered {date(p.created_at)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {!dq && <Empty icon="Users" title="Search the master patient index">One UHID per person across OPD, IPD, ER, lab, pharmacy and billing.</Empty>}
    </div>
  )
}
