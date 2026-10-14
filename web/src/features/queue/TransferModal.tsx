import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Badge, Button, cn, ErrorBox, FieldWrap, Input, Modal, Spinner } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import type { Monitor, QToken, TransferResult } from './types'
import { groupLines, statusLabel } from './ui'

/**
 * Send a token to another line (e.g. Registration → Billing). The current token closes as
 * transferred and the patient gets the next number in the new line with the same priority.
 */
export function TransferModal({ token, onClose, onDone }: { token: QToken; onClose: () => void; onDone?: (r: TransferResult) => void }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 150).trim().toLowerCase()
  const lines = useQuery({
    queryKey: ['x', 'queue', 'monitor', { kind: '', dept: '' }],
    queryFn: () => api<Monitor>('/queue/monitor'),
    staleTime: 30_000,
  })
  const groups = useMemo(() => groupLines((lines.data?.lines ?? []).filter((l) => l.queue !== token.queue
    && (!dq || [l.name, l.queue, l.kind, l.department, l.owner, l.room].some((v) => v?.toLowerCase().includes(dq))))), [lines.data, token.queue, dq])
  const chosen = lines.data?.lines.find((l) => l.queue === target)

  const transfer = useMutation({
    mutationFn: () => api<TransferResult>(`/queue/transfer/${token.id}`, { method: 'POST', body: { queue: target, reason: reason.trim() || undefined } }),
    onSuccess: (r) => {
      toast.success(`${r.from} → ${r.token.label} in ${r.queue_name}`)
      qc.invalidateQueries({ queryKey: ['x', 'queue'] })
      onDone?.(r)
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  return (
    <Modal open onClose={onClose} size="md" title={<span className="inline-flex items-center gap-2"><ArrowRightLeft className="size-4" /> Transfer token {token.label}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!target} loading={transfer.isPending} onClick={() => transfer.mutate()}>
          Transfer{chosen ? ` to ${chosen.name}` : ''}
        </Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-2">
          {token.patient ? <><span className="font-medium text-ink">{token.patient.name}</span> · {token.patient.uhid} · </> : null}
          {statusLabel(token.status)} in {token.queue}. The patient gets the next token in the new line with the same priority{token.priority && token.priority !== 'Normal' ? ` (${token.priority})` : ''}.
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a line — billing, pharmacy, a doctor…" className="pl-8" aria-label="Find a line" />
        </div>
        {lines.error && <ErrorBox error={lines.error} />}
        <div className="max-h-[42vh] overflow-y-auto rounded-lg border border-line scroll-thin" role="radiogroup" aria-label="Transfer to">
          {lines.isLoading && <Spinner />}
          {lines.data && groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-3">No other line matches.</p>}
          {groups.map((g) => (
            <div key={g.key}>
              <div className="sticky top-0 border-b border-line bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g.label}</div>
              {g.items.map((l) => (
                <button key={l.queue} type="button" role="radio" aria-checked={target === l.queue} onClick={() => setTarget(l.queue)}
                  className={cn('flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2',
                    target === l.queue && 'bg-brand-50 ring-1 ring-inset ring-brand-600/40 dark:bg-brand-500/10')}>
                  <span className={cn('size-3.5 shrink-0 rounded-full border-2', target === l.queue ? 'border-brand-700 bg-brand-700' : 'border-line-2')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{l.name}</span>
                    <span className="block truncate text-xs text-ink-3">{[l.queue, l.kind, l.room && `Room ${l.room}`].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="tabular shrink-0 text-xs text-ink-2">{l.waiting} waiting</span>
                  {l.at_capacity && <Badge tone="red" dot>At capacity</Badge>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <FieldWrap label="Reason (optional)">
          <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Registration done — send to billing" />
        </FieldWrap>
      </div>
    </Modal>
  )
}
