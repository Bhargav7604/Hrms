import { useQuery } from '@tanstack/react-query'
import { ScanBarcode } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Badge, Button, Card, cn, Empty, ErrorBox, Input, Spinner, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { date, dateTime, minutes, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { Barcode } from './labels'
import { LabShell } from './shell'
import type { LabRow } from './types'

interface Event { at: string; label: string; kind: string; by?: string | null; role?: string | null; note?: string | null; order?: string | null; test?: string | null }
interface TubeTrack {
  barcode: string | null; patient: LabRow['patient']; location: string; orders: LabRow[]; status: string; elapsed_minutes?: number | null
  sample?: { code: string; status: string; sample_type?: string | null; container?: string | null; collected_at?: string | null; received_at?: string | null
    received_by?: string | null; rejection_reason?: string | null; rejected_by?: string | null; collection_point?: string | null } | null
  events: Event[]
}

const KIND_ICON: Record<string, [string, string]> = {
  order: ['ClipboardList', 'text-ink-2'], collect: ['Syringe', 'text-brand-700 dark:text-brand-300'], receive: ['PackageCheck', 'text-brand-700 dark:text-brand-300'],
  result: ['ClipboardPen', 'text-brand-700 dark:text-brand-300'], verify: ['ShieldCheck', 'text-emerald-600'], print: ['Printer', 'text-ink-2'],
  reject: ['TestTubeDiagonal', 'text-red-600'], rollback: ['Undo2', 'text-red-600'], cancel: ['Ban', 'text-red-600'], rerun: ['RotateCcw', 'text-amber-600'],
  critical: ['Siren', 'text-red-600'], amend: ['Pencil', 'text-amber-600'], review: ['Activity', 'text-amber-600'], reflex: ['GitBranchPlus', 'text-violet-600'],
  outsource: ['Truck', 'text-violet-600'], process: ['Cog', 'text-ink-2'], status: ['Circle', 'text-ink-2'],
}

export default function TrackSamples() {
  const [params, setParams] = useSearchParams()
  const [scan, setScan] = useState(params.get('q') ?? '')
  const term = params.get('q') ?? ''
  const q = useQuery({
    queryKey: ['x', 'lab', 'track', term],
    queryFn: () => api<{ tubes: TubeTrack[] }>('/lab/track', { query: { q: term } }),
    enabled: term.length >= 3,
    retry: false,
  })
  const go = () => { if (scan.trim().length >= 3) setParams({ q: scan.trim() }) }
  return (
    <LabShell screen="track" icon="Route" title="Track samples" subtitle="Scan a tube, or enter an order number or UHID, to see every step from order to report — who did what and when.">
      <div className="mb-4 flex max-w-2xl gap-2">
        <div className="relative flex-1">
          <ScanBarcode className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input autoFocus value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go() }}
            className="pl-8 font-mono" placeholder="Barcode / order no. / UHID, Enter" aria-label="Barcode, order number or UHID" />
        </div>
        <Button variant="primary" onClick={go}>Track</Button>
      </div>
      {!term && <Empty icon="Route" title="Scan a barcode to start">A UHID lists the patient's tubes from the last 90 days.</Empty>}
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      <div className="space-y-4">
        {q.data?.tubes.map((t) => (
          <Card key={t.barcode ?? t.orders[0].id} pad={false}>
            <div className="grid gap-4 p-4 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div className="space-y-3">
                {t.barcode && <div className="rounded-lg bg-white p-2"><Barcode value={t.barcode} className="h-10 w-full" /><div className="text-center font-mono text-sm text-black">{t.barcode}</div></div>}
                <div>
                  <Link to={`/patients/${t.patient.id}`} className="font-medium text-ink hover:underline">{t.patient.name}</Link>
                  <div className="text-xs text-ink-3">{t.patient.uhid} · {t.location}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2"><StatusBadge status={t.status} />{t.sample && <Badge tone="gray">Tube {t.sample.status}</Badge>}
                  {t.elapsed_minutes != null && <span className="text-xs text-ink-2">{minutes(t.elapsed_minutes)} since order</span>}</div>
                {t.sample && (
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-ink-3">Sample</dt><dd className="text-ink">{t.sample.container ?? t.sample.sample_type ?? '—'}</dd>
                    <dt className="text-ink-3">Collected</dt><dd className="text-ink">{dateTime(t.sample.collected_at)}</dd>
                    {t.sample.collection_point && <><dt className="text-ink-3">At</dt><dd className="text-ink">{t.sample.collection_point}</dd></>}
                    <dt className="text-ink-3">Received</dt><dd className="text-ink">{t.sample.received_at ? `${time(t.sample.received_at)} · ${t.sample.received_by ?? ''}` : '—'}</dd>
                    {t.sample.rejection_reason && <><dt className="text-ink-3">Rejected</dt><dd className="text-red-700 dark:text-red-300">{t.sample.rejection_reason} · {t.sample.rejected_by}</dd></>}
                  </dl>
                )}
                <ul className="space-y-1">
                  {t.orders.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-2 py-1 text-sm">
                      <span className="min-w-0"><span className="block truncate text-ink">{o.test.name}</span><span className="font-mono text-[11px] text-ink-3">{o.code}</span></span>
                      <StatusBadge status={o.status} />
                    </li>
                  ))}
                </ul>
              </div>
              <ol className="relative space-y-3 border-l border-line pl-5">
                {t.events.map((e, i) => {
                  const [icon, tone] = KIND_ICON[e.kind] ?? KIND_ICON.status
                  return (
                    <li key={i} className="relative">
                      <span className="absolute -left-[31px] grid size-5 place-items-center rounded-full border border-line bg-surface"><Icon name={icon} className={cn('size-3', tone)} /></span>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium text-ink">{e.label}</span>
                        <span className="text-xs text-ink-3">{date(e.at)} {time(e.at)}</span>
                        {e.order && <span className="font-mono text-[11px] text-ink-3">{e.order}{e.test && t.orders.length > 1 ? ` · ${e.test}` : ''}</span>}
                      </div>
                      <div className="text-xs text-ink-2">{e.by}{e.role ? ` (${e.role})` : ''}{e.note && <> — {e.note}</>}</div>
                    </li>
                  )
                })}
                {t.events.length === 0 && <li className="text-sm text-ink-3">No recorded events.</li>}
              </ol>
            </div>
          </Card>
        ))}
      </div>
    </LabShell>
  )
}
