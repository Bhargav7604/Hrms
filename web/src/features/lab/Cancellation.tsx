import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, Empty, ErrorBox, FieldWrap, Input, Segmented, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { PatientCell, ResultView, type Worklist, type WorkRow } from '@/pages/bespoke/lab-worklist'
import { KIND } from './Rejected'
import { LabShell } from './shell'

interface Hist { rows: { id: string; kind: keyof typeof KIND; at: string; by?: string | null; reason?: string | null; test?: string | null
  order: { code: string; status: string }; patient: { name: string; uhid?: string | null } }[] }

export default function ResultCancellation() {
  const qc = useQueryClient()
  const [scan, setScan] = useState('')
  const [term, setTerm] = useState('')
  const [pick, setPick] = useState<WorkRow | null>(null)
  const [action, setAction] = useState<'cancel' | 'reject'>('cancel')
  const [reason, setReason] = useState('')
  const found = useQuery({
    queryKey: ['x', 'orders', 'worklist', 'LAB', 'cancel-search', term],
    queryFn: () => api<Worklist>('/orders/worklist', { query: { category: 'LAB', q: term } }),
    enabled: term.length >= 3,
  })
  const hist = useQuery({ queryKey: ['x', 'lab', 'rejected', 'cancel-history'], queryFn: () => api<Hist>('/lab/rejected', { query: { kind: 'all' } }) })
  const m = useMutation({
    mutationFn: () => api(`/lab/results/${pick!.id}/${action}`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success(action === 'cancel' ? `Result of ${pick!.code} cancelled — the test is back on the bench` : `${pick!.code} sent for re-run`)
      setPick(null); setReason('')
      qc.invalidateQueries({ queryKey: ['x', 'lab'] }); qc.invalidateQueries({ queryKey: ['x', 'orders'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const rows = (found.data?.rows ?? []).filter((r) => r.status === 'Resulted' || r.status === 'Verified')
  const history = (hist.data?.rows ?? []).filter((r) => r.kind === 'cancelled' || r.kind === 'rerun').slice(0, 15)

  return (
    <LabShell screen="cancellation" icon="Ban" title="Result cancellation"
      subtitle="Withdraw a wrong result (mislabelled sample, transcription error, analyser fault). The values stay in the order's history and the audit trail; an authorised report is withdrawn from the wards.">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-3">
          <div className="flex max-w-2xl gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
              <Input autoFocus value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setTerm(scan.trim()) }}
                className="pl-8 font-mono" placeholder="Barcode / order no. / UHID / patient, Enter" aria-label="Find a result" />
            </div>
            <Button variant="primary" onClick={() => setTerm(scan.trim())}>Find</Button>
          </div>
          {found.isLoading && <Spinner />}
          {found.error && <ErrorBox error={found.error} />}
          {term && found.data && rows.length === 0 && <Empty icon="SearchX" title="No resulted or authorised test matches" />}
          {rows.length > 0 && (
            <Card pad={false}>
              <ul className="divide-y divide-line">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 ${pick?.id === r.id ? 'bg-brand-50 dark:bg-brand-500/10' : ''}`} onClick={() => { setPick(r); setAction(r.status === 'Resulted' ? 'reject' : 'cancel') }}>
                      <span className="min-w-0 flex-1"><PatientCell p={r.patient} location={r.location} /></span>
                      <span className="text-sm text-ink">{r.test.name}<span className="block font-mono text-[11px] text-ink-3">{r.code}</span></span>
                      <StatusBadge status={r.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {pick && (
            <Card title={<>{pick.test.name} · {pick.patient.name} <StatusBadge status={pick.status} /></>}>
              <ResultView o={pick} />
              <div className="mt-4 space-y-3 border-t border-line pt-3">
                <Segmented value={action} onChange={setAction} options={[
                  { key: 'cancel', label: 'Cancel result' },
                  ...(pick.status === 'Resulted' ? [{ key: 'reject' as const, label: 'Send for re-run' }] : []),
                ]} />
                <FieldWrap label="Reason" required help="At least 5 characters — recorded in the audit trail">
                  <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sample belonged to another patient (mislabelled tube)" />
                </FieldWrap>
                {pick.status === 'Verified' && <p className="text-sm text-amber-800 dark:text-amber-200">This report is authorised — cancelling withdraws it and alerts the treating team.</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setPick(null)}>Close</Button>
                  <Button variant="danger" disabled={reason.trim().length < 5} loading={m.isPending} onClick={() => m.mutate()}>{action === 'cancel' ? 'Cancel result' : 'Send for re-run'}</Button>
                </div>
              </div>
            </Card>
          )}
        </div>
        <Card title="Recent cancellations & re-runs" pad={false}>
          {hist.isLoading ? <Spinner /> : history.length === 0 ? <Empty icon="Inbox" title="None in the last 7 days" /> : (
            <ul className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.id} className="px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2"><Badge tone={KIND[h.kind].tone}>{KIND[h.kind].label}</Badge><span className="text-[11px] text-ink-3">{dateTime(h.at)}</span></div>
                  <div className="mt-0.5 text-ink">{h.test} · {h.patient.name} <span className="font-mono text-[11px] text-ink-3">{h.order.code}</span></div>
                  <div className="text-xs text-ink-2">{h.reason} — {h.by}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </LabShell>
  )
}
