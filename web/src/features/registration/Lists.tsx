import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Badge, Button, Empty, ErrorBox, Input, Modal, Segmented, Spinner, StatusBadge } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, time, todayISO } from '@/lib/format'
import type { Rec } from '@/lib/types'
import type { DraftRow } from './api'

/** Draft registrations — resume or discard. Used as a modal from the form and as the /registration/drafts page. */
export function DraftList({ onResume, canWrite, compact }: { onResume?: (id: string) => void; canWrite: boolean; compact?: boolean }) {
  const qc = useQueryClient()
  const [scope, setScope] = useState<'all' | 'mine'>('all')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const list = useQuery({
    queryKey: ['x', 'registration', 'drafts', scope, dq],
    queryFn: () => api<DraftRow[]>('/registration/drafts', { query: { mine: scope === 'mine', q: dq || undefined } }),
  })
  const discard = useMutation({
    mutationFn: (id: string) => api(`/registration/drafts/${id}/discard`, { method: 'POST' }),
    onSuccess: () => { toast.success('Draft discarded'); qc.invalidateQueries({ queryKey: ['x', 'registration', 'drafts'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or mobile…" className="h-8 w-64" />
        <Segmented value={scope} onChange={setScope} options={[{ key: 'all', label: 'All desks' }, { key: 'mine', label: 'Saved by me' }]} />
        {list.data && <span className="ml-auto text-xs text-ink-3">{list.data.length} draft{list.data.length === 1 ? '' : 's'}</span>}
      </div>
      {list.isLoading && <Spinner />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data?.length === 0 && <Empty icon="FilePen" title="No draft registrations">Use “Save as draft” when a patient has to step away mid-registration.</Empty>}
      {!!list.data?.length && (
        <div className={compact ? 'max-h-[55vh] overflow-y-auto scroll-thin' : ''}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>{['Draft', 'Patient', 'Mobile', 'Consulting doctor', 'Saved', 'By', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-1.5 font-mono text-xs text-ink-2">{d.code}</td>
                  <td className="px-3 py-1.5"><div className="font-medium text-ink">{d.name}</div>{d.notes && <div className="text-xs text-ink-3">{d.notes}</div>}</td>
                  <td className="tabular px-3 py-1.5 text-ink-2">{d.phone ?? '—'}</td>
                  <td className="px-3 py-1.5 text-ink-2">{d.doctor_name ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-ink-2">{dateTime(d.saved_at)}</td>
                  <td className="px-3 py-1.5 text-ink-2">{d.saved_by_name ?? '—'}{d.mine && <Badge tone="violet" className="ml-1">me</Badge>}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    {canWrite && onResume && <Button size="xs" variant="primary" onClick={() => onResume(d.id)}>Resume</Button>}
                    {canWrite && <Button size="xs" variant="ghost" className="ml-1 text-red-600" loading={discard.isPending && discard.variables === d.id}
                      onClick={() => { if (confirm(`Discard draft ${d.code}?`)) discard.mutate(d.id) }}>Discard</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function DraftsModal({ open, onClose, onResume, canWrite }: { open: boolean; onClose: () => void; onResume: (id: string) => void; canWrite: boolean }) {
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Draft registrations">
      {open && <DraftList compact canWrite={canWrite} onResume={(id) => { onClose(); onResume(id) }} />}
    </Modal>
  )
}

interface Registered { total: number; rows: (Rec & { age?: number; registered_by?: string })[] }

/** Patients registered in a day (View Registered). */
export function RegisteredModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [day, setDay] = useState(todayISO())
  const [scope, setScope] = useState<'all' | 'mine'>('mine')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const list = useQuery({
    queryKey: ['x', 'registration', 'registered', day, scope, dq],
    queryFn: () => api<Registered>('/registration/registered', { query: { date_from: day, mine: scope === 'mine', q: dq || undefined } }),
    enabled: open,
  })
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Registered patients">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={day} max={todayISO()} onChange={(e) => setDay(e.target.value)} className="h-8 w-40" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, UHID or mobile…" className="h-8 w-64" />
          <Segmented value={scope} onChange={setScope} options={[{ key: 'mine', label: 'Registered by me' }, { key: 'all', label: 'All desks' }]} />
          {list.data && <span className="ml-auto text-xs text-ink-3">{list.data.total} patient{list.data.total === 1 ? '' : 's'}</span>}
        </div>
        {list.isLoading && <Spinner />}
        {list.error && <ErrorBox error={list.error} />}
        {list.data?.rows.length === 0 && <Empty icon="Users" title="No registrations">Nobody was registered{scope === 'mine' ? ' by you' : ''} on this day.</Empty>}
        {!!list.data?.rows.length && (
          <div className="max-h-[55vh] overflow-y-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>{['UHID', 'Patient', 'Age / sex', 'Mobile', 'Category', 'Time', 'By', 'Status'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {list.data.rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-1.5 font-mono text-xs"><Link to={`/patients/${r.id}`} className="text-brand-700 hover:underline dark:text-brand-300" onClick={onClose}>{r.code}</Link></td>
                    <td className="px-3 py-1.5 text-ink">{r.title}</td>
                    <td className="px-3 py-1.5 text-ink-2">{[r.age != null ? `${r.age}y` : null, r.gender].filter(Boolean).join(' · ')}</td>
                    <td className="tabular px-3 py-1.5 text-ink-2">{r.phone}</td>
                    <td className="px-3 py-1.5 text-ink-2">{r.category}</td>
                    <td className="tabular px-3 py-1.5 text-ink-2">{time(r.created_at)}</td>
                    <td className="px-3 py-1.5 text-ink-2">{r.registered_by ?? '—'}</td>
                    <td className="px-3 py-1.5"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  )
}
