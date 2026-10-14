import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, Empty, ErrorBox, PageHeader, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, minutes } from '@/lib/format'
import { ReasonDialog, Table, td } from './ui'

interface Row { id: string; code: string; department: string; status: string; hold_reason?: string | null; waiting_minutes: number | null; admission: { id: string; code: string; discharge_type?: string; initiated_at?: string }; patient: { name: string; uhid: string }; bed?: string; ward?: string }

/** Departmental discharge clearances waiting for the signed-in role. */
export default function Clearances() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['x', 'discharge', 'clearance-queue'], queryFn: () => api<{ rows: Row[]; departments: string[] }>('/ipchart/clearances/pending'), refetchInterval: 60_000 })
  const [hold, setHold] = useState<Row | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['x', 'discharge'] })
  const clear = useMutation({ mutationFn: (r: Row) => api(`/ipchart/clearances/${r.id}/clear`, { method: 'POST', body: {} }), onSuccess: (_, r) => { toast.success(`${r.department} cleared for ${r.patient.name}`); refresh() }, onError: (e) => toast.error(errorMessage(e)) })
  const doHold = useMutation({ mutationFn: ({ r, reason }: { r: Row; reason: string }) => api(`/ipchart/clearances/${r.id}/hold`, { method: 'POST', body: { reason } }), onSuccess: () => { toast.success('Put on hold'); setHold(null); refresh() }, onError: (e) => toast.error(errorMessage(e)) })
  return (
    <div className="space-y-4">
      <PageHeader icon="ClipboardCheck" title="Discharge clearances" subtitle={q.data ? `Sign-offs waiting for ${q.data.departments.join(', ')}` : 'Departmental sign-offs for patients being discharged.'} />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.rows.length ? <Empty icon="ClipboardCheck" title="Nothing waiting for your department">Clearances appear here when a doctor or nurse initiates a discharge.</Empty> : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <Table head={['Patient', 'Ward / bed', 'Admission', 'Department', 'Waiting', 'Status', '']}>
            {q.data!.rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className={td}><span className="font-medium text-ink">{r.patient.name}</span><div className="text-xs text-ink-3">{r.patient.uhid}</div></td>
                <td className={td}>{r.ward}<div className="text-xs text-ink-3">Bed {r.bed}</div></td>
                <td className={td}><Link to={`/ip/admissions/${r.admission.id}`} className="font-mono text-xs hover:underline">{r.admission.code}</Link><div className="text-xs text-ink-3">{r.admission.discharge_type} · {dateTime(r.admission.initiated_at)}</div></td>
                <td className={td}>{r.department}</td>
                <td className={td}>{minutes(r.waiting_minutes)}</td>
                <td className={td}><Badge tone={r.status === 'On Hold' ? 'red' : 'amber'}>{r.status}</Badge>{r.hold_reason && <div className="text-xs text-ink-3">{r.hold_reason}</div>}</td>
                <td className={`${td} whitespace-nowrap text-right`}>
                  <Button size="xs" variant="success" loading={clear.isPending && clear.variables?.id === r.id} onClick={() => clear.mutate(r)}>Clear</Button>
                  {r.status === 'Pending' && <Button size="xs" variant="ghost" onClick={() => setHold(r)}>Hold</Button>}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <ReasonDialog open={!!hold} title="Put clearance on hold" confirm="Put on hold" tone="primary" busy={doHold.isPending} onClose={() => setHold(null)} onConfirm={(reason) => hold && doHold.mutate({ r: hold, reason })} />
    </div>
  )
}
