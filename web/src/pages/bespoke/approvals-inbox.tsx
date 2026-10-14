import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, Card, Empty, Modal, Segmented, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { ago, dateTime, money } from '@/lib/format'
import type { Rec } from '@/lib/types'
import type { BespokeProps } from './index'

const FLOW_LABEL: Record<string, string> = {
  'billing.discount': 'Bill discount', 'billing.refund': 'Refund', 'billing.credit_note': 'Credit note',
  'procurement.purchase_order': 'Purchase order', 'inventory.adjustment': 'Stock adjustment', 'hr.leave': 'Leave',
}

export default function ApprovalsInbox(_: BespokeProps) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const [status, setStatus] = useState<'Pending' | 'Approved' | 'Rejected'>('Pending')
  const [deciding, setDeciding] = useState<{ a: Rec; approve: boolean } | null>(null)
  const [comments, setComments] = useState('')
  const q = useQuery({ queryKey: ['approvals', 'inbox', status], queryFn: () => api<Rec[]>('/workflow/inbox', { query: { status } }) })
  const decide = useMutation({
    mutationFn: () => api<{ final?: boolean; next_step?: Rec }>(`/workflow/approvals/${deciding!.a.id}/decide`, { method: 'POST', body: { approve: deciding!.approve, comments: comments || undefined } }),
    onSuccess: (r) => {
      toast.success(r.next_step ? `Approved — forwarded to ${r.next_step.approver_role}` : deciding!.approve ? 'Approved' : 'Rejected')
      setDeciding(null); setComments('')
      qc.invalidateQueries({ queryKey: ['approvals'] })
      qc.invalidateQueries({ queryKey: ['x'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Segmented value={status} onChange={setStatus} options={[{ key: 'Pending', label: 'Pending' }, { key: 'Approved', label: 'Approved' }, { key: 'Rejected', label: 'Rejected' }]} />
        <span className="text-xs text-ink-3">Flows are configured in Workflow Builder → Flows, without code changes.</span>
      </div>
      {q.isLoading && <Spinner />}
      {q.data?.length === 0 && <Empty icon="BadgeCheck" title={status === 'Pending' ? 'You are all caught up' : `No ${status.toLowerCase()} requests`} />}
      <div className="grid gap-3 lg:grid-cols-2">
        {q.data?.map((a) => {
          const subject = reg.entity(`${a.subject_module}.${a.subject_entity}`)
          return (
            <Card key={a.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="violet">{FLOW_LABEL[a.flow] ?? a.flow}</Badge>
                    <span className="text-xs text-ink-3">Step {a.step} · {a.approver_role}</span>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="mt-2 text-sm text-ink">{a.summary}</p>
                  <p className="mt-1 text-xs text-ink-3">Requested by {a.requested_by} · {ago(a.created_at)} ({dateTime(a.created_at)})</p>
                  {a.decided_by && <p className="mt-1 text-xs text-ink-2">Decided by {a.decided_by} {dateTime(a.decided_at)}{a.comments ? ` — “${a.comments}”` : ''}</p>}
                  {subject && <Link className="mt-1 inline-block text-xs text-brand-700 hover:underline dark:text-brand-300" to={`/m/${subject.module}/${subject.key}?r=${a.subject_id}`}>Open {subject.singular.toLowerCase()} →</Link>}
                </div>
                <div className="text-right">
                  {a.amount !== null && a.amount !== undefined && <div className="text-lg font-semibold tabular-nums text-ink">{money(a.amount)}</div>}
                  {a.status === 'Pending' && (
                    <div className="mt-2 flex gap-1.5">
                      <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDeciding({ a, approve: false })}>Reject</Button>
                      <Button size="sm" variant="success" onClick={() => setDeciding({ a, approve: true })}>Approve</Button>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )
        })}
      </div>
      <Modal open={!!deciding} onClose={() => setDeciding(null)} size="sm" title={deciding?.approve ? 'Approve request' : 'Reject request'}
        footer={<><Button variant="ghost" onClick={() => setDeciding(null)}>Cancel</Button>
          <Button variant={deciding?.approve ? 'success' : 'danger'} loading={decide.isPending} disabled={!deciding?.approve && comments.trim().length < 3} onClick={() => decide.mutate()}>
            {deciding?.approve ? 'Approve' : 'Reject'}</Button></>}>
        <p className="mb-2 text-sm text-ink-2">{deciding?.a.summary}</p>
        <Textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} placeholder={deciding?.approve ? 'Comments (optional)' : 'Reason for rejection (required)'} />
      </Modal>
    </div>
  )
}
