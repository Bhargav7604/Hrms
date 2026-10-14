import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, Empty, ErrorBox, FieldWrap, Input, Modal, Spinner, StatusBadge, Tabs, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, money } from '@/lib/format'
import { ReturnDialog } from './Bills'
import type { Bill } from './common'
import { MODE_LABEL, PharmShell, usePharmAccess } from './shell'

interface Ret { id: string; code: string; status: string; bill: string; bill_code?: string | null; customer_name?: string | null; patient?: string | null; reason: string
  refund_mode?: string | null; refund_amount?: number | null; adjusted_to_due?: number | null; requested_by?: string | null; requested_at?: string | null
  approved_by?: string | null; approved_at?: string | null; rejection_reason?: string | null; lines: { name: string; batch?: string | null; qty: number; amount?: number | null }[] }

export default function Returns() {
  const acc = usePharmAccess()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'Requested' | 'Approved' | 'Rejected'>('Requested')
  const [billNo, setBillNo] = useState('')
  const [bill, setBill] = useState<Bill | null>(null)
  const [rejecting, setRejecting] = useState<Ret | null>(null)
  const list = useQuery({ queryKey: ['x', 'pharmacy', 'returns', tab], queryFn: () => api<{ rows: Ret[] }>('/op-pharmacy/returns', { query: { status: tab } }) })
  const find = useMutation({
    mutationFn: async () => {
      const r = await api<{ rows: { id: string; code: string }[] }>('/op-pharmacy/bills', { query: { q: billNo.trim(), status: 'Paid,Due', date_from: '2000-01-01', date_to: '2100-01-01', limit: 5 } })
      const hit = r.rows.find((x) => x.code.toLowerCase() === billNo.trim().toLowerCase()) ?? r.rows[0]
      if (!hit) throw new Error(`No billed sale ${billNo}`)
      return api<Bill>(`/op-pharmacy/bills/${hit.id}`)
    },
    onSuccess: setBill,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const approve = useMutation({
    mutationFn: (id: string) => api<{ refund: number; adjusted_to_due: number }>(`/op-pharmacy/returns/${id}/approve`, { method: 'POST' }),
    onSuccess: (r) => { toast.success(`Return approved — restocked; refund ${money(r.refund)}${r.adjusted_to_due ? `, ${money(r.adjusted_to_due)} adjusted against due` : ''}`); qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <PharmShell screen="returns" icon="Undo2" title="Returns" subtitle="Take medicines back against a bill (batch-wise, within the return window), then approve: stock is restored to the same batch and the refund is paid or adjusted against the bill's due.">
      {acc.sell && (
        <Card title="New return" className="mb-4">
          <div className="flex flex-wrap items-end gap-2">
            <FieldWrap label="Bill no"><Input value={billNo} onChange={(e) => setBillNo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && billNo.trim()) find.mutate() }} className="w-48 font-mono" placeholder="PHB-000123" /></FieldWrap>
            <Button variant="primary" disabled={!billNo.trim()} loading={find.isPending} onClick={() => find.mutate()}>Find bill</Button>
          </div>
        </Card>
      )}
      <Tabs className="mb-3" value={tab} onChange={setTab} tabs={[{ key: 'Requested', label: 'Awaiting approval' }, { key: 'Approved', label: 'Approved' }, { key: 'Rejected', label: 'Rejected' }]} />
      <Card pad={false}>
        {list.isLoading && <Spinner />}
        {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
        {list.data && list.data.rows.length === 0 && <Empty icon="Undo2" title="No returns here" />}
        {list.data && list.data.rows.length > 0 && (
          <ul className="divide-y divide-line">
            {list.data.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 text-sm">
                  <div className="font-medium text-ink">{r.code} · bill <span className="font-mono">{r.bill_code}</span> · {r.patient ?? r.customer_name}</div>
                  <div className="text-xs text-ink-2">{r.lines.map((l) => `${l.name} ×${l.qty}${l.batch ? ` (${l.batch})` : ''}`).join(', ')}</div>
                  <div className="text-xs text-ink-3">{r.reason} · requested by {r.requested_by} {dateTime(r.requested_at)}{r.approved_by && ` · ${r.status.toLowerCase()} by ${r.approved_by}`}{r.rejection_reason && ` — ${r.rejection_reason}`}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-right text-sm"><span className="block font-semibold tabular">{money(r.refund_amount)}</span><span className="text-[11px] text-ink-3">{MODE_LABEL[r.refund_mode ?? ''] ?? r.refund_mode}{r.adjusted_to_due ? ` · ${money(r.adjusted_to_due)} vs due` : ''}</span></span>
                  <StatusBadge status={r.status} />
                  {acc.sell && r.status === 'Requested' && <>
                    <Button size="xs" variant="ghost" className="text-red-700" onClick={() => setRejecting(r)}>Reject</Button>
                    <Button size="xs" variant="success" loading={approve.isPending && approve.variables === r.id} onClick={() => approve.mutate(r.id)}>Approve & refund</Button>
                  </>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {bill && <ReturnDialog b={bill} onClose={() => setBill(null)} onDone={() => { qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] }); setTab('Requested') }} />}
      {rejecting && <RejectDialog r={rejecting} onClose={() => setRejecting(null)} />}
    </PharmShell>
  )
}

function RejectDialog({ r, onClose }: { r: Ret; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: () => api(`/op-pharmacy/returns/${r.id}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: () => { toast.success('Return rejected'); qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} size="sm" title={`Reject ${r.code}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={m.isPending} onClick={() => m.mutate()}>Reject</Button></>}>
      <FieldWrap label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Strip cut / seal broken" autoFocus /></FieldWrap>
    </Modal>
  )
}
