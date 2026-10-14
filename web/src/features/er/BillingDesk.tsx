import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Badge, cn, Empty, ErrorBox, Input, PageHeader, Segmented, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, money } from '@/lib/format'
import { erKey, type VisitSummary } from './api'
import { BillingPanel } from './chart/Billing'
import { StateBadge, UnmappedBadge } from './ui'

type State = 'Awaiting billing' | 'Active' | 'Closed'

/** ER billing counter: visits awaiting billing → bill, collect, close. */
export default function BillingDesk({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<State>('Awaiting billing')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const list = useQuery({
    queryKey: erKey('billing-desk', state, q),
    queryFn: () => api<{ rows: VisitSummary[]; counts: { awaiting_billing: number; active: number; closed_today: number } }>('/er/billing', { query: { state, q: q || undefined } }),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  })
  const rows = list.data?.rows ?? []
  const c = list.data?.counts
  return (
    <div className="space-y-3">
      {!embedded && <PageHeader icon="IndianRupee" title="ER billing" subtitle="Bill the ER visit's charges, collect payment and close the visit." />}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={state} onChange={(s) => { setState(s); setSel(null) }} options={[
          { key: 'Awaiting billing', label: `Awaiting billing${c ? ` (${c.awaiting_billing})` : ''}` },
          { key: 'Active', label: `In the ER${c ? ` (${c.active})` : ''}` },
          { key: 'Closed', label: `Closed today${c ? ` (${c.closed_today})` : ''}` },
        ]} />
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ER no, UHID, name, mobile…" className="pl-8" />
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
        <section className="rounded-xl border border-line bg-surface">
          {list.isLoading ? <Spinner /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : !rows.length ? (
            <Empty icon="ReceiptText" title={state === 'Awaiting billing' ? 'Nothing awaiting billing' : 'No visits'} />
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((v) => (
                <li key={v.id}>
                  <button type="button" onClick={() => setSel(v.id)} aria-pressed={sel === v.id}
                    className={cn('w-full px-3 py-2.5 text-left hover:bg-surface-2', sel === v.id && 'bg-brand-50 dark:bg-brand-500/10')}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{v.patient.name}</span>
                      {v.patient.temporary && <UnmappedBadge />}
                      <span className="ml-auto"><StateBadge state={v.state} /></span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-3">
                      <span>{v.code}</span><span>{v.patient.uhid}</span><span>{v.outcome ?? `arrived ${dateTime(v.arrived_at)}`}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                      {!!v.unbilled && <Badge tone="amber">Unbilled {money(v.unbilled)}</Badge>}
                      {v.bill && <Badge tone={Number(v.bill.balance) > 0 ? 'red' : 'green'}>{v.bill.code} · due {money(v.bill.balance)}</Badge>}
                      {v.mlc && <Badge tone="violet">MLC</Badge>}
                      <Badge>{v.payer}</Badge>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div>{sel ? <BillingPanel visitId={sel} /> : <Empty icon="MousePointerClick" title="Choose an ER visit">Its charges, bills and payments appear here.</Empty>}</div>
      </div>
    </div>
  )
}
