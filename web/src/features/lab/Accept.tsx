import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ScanBarcode } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Segmented, Select, Spinner, StatusBadge } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { minutes, time } from '@/lib/format'
import { PriorityBadge } from '@/pages/bespoke/lab-worklist'
import { Kpi, LabShell, useLabAccess } from './shell'

interface Tube {
  barcode: string | null; patient: { id: string; name: string; uhid?: string | null; age?: number | null; gender?: string | null }; location: string
  collected_at?: string | null; minutes?: number | null; delayed: boolean; priority: string; sample_type?: string | null; container?: string | null
  tests: { id: string; code: string; name?: string | null; section?: string | null }[]
}
interface Res {
  pending: Tube[]; counts: { tubes: number; tests: number; delayed: number; stat: number }; transit_alert_minutes: number; generated_at: string
  received: { barcode: string; status: string; at?: string | null; by?: string | null; reason?: string | null; patient?: { name: string; uhid?: string | null }; sample_type?: string | null }[]
}
interface ScanLog { at: string; barcode: string; ok: boolean; message: string }

const REASONS = ['Haemolysed', 'Clotted', 'Insufficient quantity', 'Wrong container', 'Unlabelled', 'Delayed transport']

export default function AcceptSamples() {
  const acc = useLabAccess()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'receive' | 'reject'>('receive')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [scan, setScan] = useState('')
  const [log, setLog] = useState<ScanLog[]>([])
  const [section, setSection] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [rejectTube, setRejectTube] = useState<Tube | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)

  const list = useQuery({
    queryKey: ['x', 'lab', 'accept', section],
    queryFn: () => api<Res>('/lab/accept', { query: { section: section || undefined } }),
    refetchInterval: 30_000,
    placeholderData: (p) => p,
  })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['x', 'lab'] }); qc.invalidateQueries({ queryKey: ['x', 'orders'] }) }
  const push = (e: ScanLog) => setLog((cur) => [e, ...cur].slice(0, 12))

  const doScan = useMutation({
    mutationFn: async (code: string) => mode === 'receive'
      ? api<{ patient: { name: string }; orders: { code: string }[] }>('/lab/accept/scan', { method: 'POST', body: { barcode: code } })
      : api<{ orders: { code: string }[] }>('/lab/accept/reject', { method: 'POST', body: { barcode: code, reason, note: note || undefined } }),
    onSuccess: (r, code) => {
      const res = r as { patient?: { name: string }; orders: { code: string }[] }
      push({ at: new Date().toISOString(), barcode: code, ok: true,
        message: mode === 'receive' ? `Received ${res.orders.length} test${res.orders.length > 1 ? 's' : ''} · ${res.patient?.name ?? ''}` : `Rejected (${reason}) — ${res.orders.length} test(s) back to collection` })
      refresh()
    },
    onError: (e, code) => { push({ at: new Date().toISOString(), barcode: code, ok: false, message: errorMessage(e) }); toast.error(errorMessage(e)) },
    onSettled: () => { setScan(''); scanRef.current?.focus() },
  })
  const bulk = useMutation({
    mutationFn: () => api<{ received: { barcode: string; orders: number }[]; skipped: string[] }>('/lab/accept/bulk', { method: 'POST', body: { barcodes: [...sel] } }),
    onSuccess: (r) => { toast.success(`Received ${r.received.length} tube${r.received.length === 1 ? '' : 's'}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`); setSel(new Set()); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const onEnter = () => {
    const code = scan.trim()
    if (!code) return
    if (mode === 'reject' && !reason) { toast.error('Choose the rejection reason first'); return }
    doScan.mutate(code)
  }
  const c = list.data?.counts
  const sections = [...new Set((list.data?.pending ?? []).flatMap((t) => t.tests.map((x) => x.section)).filter(Boolean))] as string[]

  return (
    <LabShell screen="accept" icon="PackageCheck" title="Accept samples"
      subtitle="Scan tubes as they arrive to receive them into the lab, or reject an unfit sample — its tests go straight back to the collection list for recollection."
      actions={c && (
        <div className="flex flex-wrap gap-2">
          <Kpi icon="TestTube" label="Tubes in transit" value={c.tubes} />
          <Kpi icon="FlaskConical" label="Tests" value={c.tests} />
          <Kpi icon="Siren" label="STAT" value={c.stat} tone={c.stat ? 'alert' : undefined} />
          <Kpi icon="TimerOff" label={`Over ${minutes(list.data?.transit_alert_minutes)}`} value={c.delayed} tone={c.delayed ? 'alert' : undefined} />
        </div>
      )}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          {acc.benchEdit && (
            <div className={cn('rounded-xl border p-3', mode === 'reject' ? 'border-red-300 bg-red-50/50 dark:border-red-500/40 dark:bg-red-500/5' : 'border-line bg-surface')}>
              <div className="flex flex-wrap items-end gap-2">
                <FieldWrap label="Mode"><Segmented value={mode} onChange={(m) => { setMode(m); scanRef.current?.focus() }} options={[{ key: 'receive', label: 'Receive' }, { key: 'reject', label: 'Reject' }]} /></FieldWrap>
                {mode === 'reject' && (
                  <>
                    <FieldWrap label="Reason" required>
                      <Select value={reason} onChange={(e) => setReason(e.target.value)} className="w-48"><option value="">Choose…</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</Select>
                    </FieldWrap>
                    <FieldWrap label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} className="w-56" placeholder="Optional, e.g. recollect from other arm" /></FieldWrap>
                  </>
                )}
                <FieldWrap label="Scan barcode" className="min-w-64 flex-1">
                  <div className="relative">
                    <ScanBarcode className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
                    <Input ref={scanRef} autoFocus value={scan} onChange={(e) => setScan(e.target.value)} disabled={doScan.isPending}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter() } }}
                      className="pl-8 font-mono text-base" placeholder={mode === 'receive' ? 'Scan tube barcode, Enter' : 'Scan the tube to reject, Enter'} aria-label="Scan barcode" />
                  </div>
                </FieldWrap>
              </div>
              {log.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {log.map((l, i) => (
                    <li key={i} className={cn('flex gap-2', l.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
                      <span className="tabular text-ink-3">{time(l.at)}</span><span className="font-mono">{l.barcode}</span><span>{l.ok ? '✓' : '✕'} {l.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <Card pad={false} title={<>In transit <span className="font-normal text-ink-3">· oldest first, STAT on top</span></>}
            actions={(
              <div className="flex items-center gap-2">
                <Select value={section} onChange={(e) => setSection(e.target.value)} className="h-8 w-44" aria-label="Section">
                  <option value="">All sections</option>{sections.map((s) => <option key={s}>{s}</option>)}
                </Select>
                {acc.benchEdit && sel.size > 0 && <Button size="sm" variant="primary" icon="PackageCheck" loading={bulk.isPending} onClick={() => bulk.mutate()}>Receive {sel.size}</Button>}
              </div>
            )}>
            {list.isLoading && <Spinner />}
            {list.error && <div className="p-3"><ErrorBox error={list.error} /></div>}
            {list.data && list.data.pending.length === 0 && <Empty icon="PackageCheck" title="No tubes in transit">Every collected sample has been received.</Empty>}
            {list.data && list.data.pending.length > 0 && (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-xs text-ink-2">
                    <tr>
                      {acc.benchEdit && <th className="w-8 px-3 py-2"><span className="sr-only">Select</span></th>}
                      {['Priority', 'Barcode', 'Patient', 'Sample', 'Tests', 'Collected', 'In transit', ''].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.pending.map((t) => (
                      <tr key={t.barcode ?? t.tests[0].id} className={cn('border-t border-line', t.delayed && 'bg-amber-50/60 dark:bg-amber-500/5')}>
                        {acc.benchEdit && (
                          <td className="px-3 py-2">{t.barcode && <input type="checkbox" className="size-4 accent-brand-700" aria-label={`Select ${t.barcode}`} checked={sel.has(t.barcode)}
                            onChange={(e) => setSel((cur) => { const n = new Set(cur); if (e.target.checked) n.add(t.barcode!); else n.delete(t.barcode!); return n })} />}</td>
                        )}
                        <td className="px-3 py-2"><PriorityBadge priority={t.priority} /></td>
                        <td className="px-3 py-2 font-mono text-xs">{t.barcode ?? '—'}</td>
                        <td className="max-w-52 px-3 py-2"><div className="truncate font-medium text-ink">{t.patient.name}</div><div className="truncate text-xs text-ink-3">{t.patient.uhid} · {t.location}</div></td>
                        <td className="px-3 py-2 text-xs text-ink-2">{t.container ?? t.sample_type ?? '—'}</td>
                        <td className="px-3 py-2 text-xs text-ink">{t.tests.map((x) => x.name).join(', ')}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-2">{time(t.collected_at)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs">{t.delayed ? <Badge tone="amber">{minutes(t.minutes)}</Badge> : <span className="text-ink-2">{minutes(t.minutes)}</span>}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {acc.benchEdit && t.barcode && (
                            <span className="flex justify-end gap-1">
                              <Button size="xs" variant="primary" loading={doScan.isPending && doScan.variables === t.barcode && mode === 'receive'}
                                onClick={() => { setMode('receive'); doScan.mutate(t.barcode!) }}>Receive</Button>
                              <Button size="xs" variant="ghost" className="text-red-700 dark:text-red-300" onClick={() => setRejectTube(t)}>Reject</Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Card title="Received / rejected today" pad={false}>
          {!list.data?.received.length ? <Empty icon="Inbox" title="Nothing yet today" /> : (
            <ul className="divide-y divide-line">
              {list.data.received.map((r, i) => (
                <li key={i} className="flex items-start justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-ink">{r.barcode}</div>
                    <div className="truncate text-xs text-ink-2">{r.patient?.name} · {r.sample_type ?? ''}</div>
                    {r.reason && <div className="text-xs text-red-700 dark:text-red-300">{r.reason}</div>}
                  </div>
                  <div className="shrink-0 text-right"><StatusBadge status={r.status} /><div className="mt-0.5 text-[11px] text-ink-3">{time(r.at)} · {r.by ?? ''}</div></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {rejectTube && <RejectDialog tube={rejectTube} onClose={() => setRejectTube(null)} onDone={refresh} />}
    </LabShell>
  )
}

function RejectDialog({ tube, onClose, onDone }: { tube: Tube; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => api('/lab/accept/reject', { method: 'POST', body: { barcode: tube.barcode, reason, note: note || undefined } }),
    onSuccess: () => { toast.success(`Tube ${tube.barcode} rejected — tests returned for recollection`); onDone(); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} size="sm" title={`Reject tube ${tube.barcode}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!reason} loading={m.isPending} onClick={() => m.mutate()}>Reject & request recollection</Button></>}>
      <p className="mb-3 text-sm text-ink-2">{tube.patient.name} · {tube.tests.map((t) => t.name).join(', ')}. The ward is alerted and the tests reappear on the collection list.</p>
      <div className="space-y-3">
        <FieldWrap label="Reason" required><Select value={reason} onChange={(e) => setReason(e.target.value)} autoFocus><option value="">Choose…</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</Select></FieldWrap>
        <FieldWrap label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional instruction for the collector" /></FieldWrap>
      </div>
    </Modal>
  )
}
