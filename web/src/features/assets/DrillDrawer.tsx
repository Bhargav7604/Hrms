import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Drawer, Empty, ErrorBox, Input, Spinner, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { money, moneyShort, number } from '@/lib/format'
import { DaysPill } from './parts'
import type { DashParams, DrillResult } from './types'

/** Assets behind a KPI, tile or chart slice. Clicking a row opens the asset record. */
export function DrillDrawer({ bucket, title, params, finance, canOpen, onOpen, onClose }: {
  bucket: string; title: string; params: DashParams; finance: boolean; canOpen: boolean
  onOpen: (id: string) => void; onClose: () => void
}) {
  const [q, setQ] = useState('')
  const query = { bucket, period: params.period, date_from: params.date_from, date_to: params.date_to, window: params.window }
  const r = useQuery({
    queryKey: ['x', 'assets', 'drill', query],
    queryFn: () => api<DrillResult>('/assets/drill', { query }),
  })
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    const all = r.data?.rows ?? []
    return s ? all.filter((a) => [a.code, a.name, a.model, a.make, a.department, a.category].some((v) => v?.toLowerCase().includes(s))) : all
  }, [r.data, q])
  const showMoney = finance && rows.some((a) => a.nbv !== null)

  return (
    <Drawer open onClose={onClose} width="max-w-4xl"
      title={r.data?.title ?? title}
      subtitle={r.data ? (
        <span>{number(r.data.total)} asset{r.data.total === 1 ? '' : 's'}{r.data.nbv !== null && finance ? ` · book value ${moneyShort(r.data.nbv)}` : ''}
          {r.data.total > r.data.rows.length ? ` · first ${r.data.rows.length} shown` : ''}</span>
      ) : 'Loading…'}>
      <div className="border-b border-line px-5 py-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by code, name, model, department…" className="pl-8" aria-label="Filter assets" />
        </div>
      </div>
      {r.isLoading && <Spinner />}
      {r.error && <div className="p-5"><ErrorBox error={r.error} /></div>}
      {r.data && rows.length === 0 && <Empty icon="PackageSearch" title={q ? 'No assets match the filter' : 'No assets in this group'} />}
      {rows.length > 0 && (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Asset</th>
                <th className="px-3 py-2 text-left font-medium">Department</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Next due</th>
                {showMoney && <th className="px-4 py-2 text-right font-medium">Book value</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} onClick={canOpen ? () => onOpen(a.id) : undefined}
                  onKeyDown={canOpen ? (e) => { if (e.key === 'Enter') onOpen(a.id) } : undefined}
                  tabIndex={canOpen ? 0 : undefined}
                  className={canOpen ? 'cursor-pointer border-b border-line last:border-0 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none' : 'border-b border-line last:border-0'}>
                  <td className="px-4 py-2">
                    <div className="font-mono text-xs text-ink-2">{a.code}</div>
                    <div className="text-ink">{a.name}{a.model ? <span className="text-ink-3"> — {a.model}</span> : null}</div>
                    <div className="text-xs text-ink-3">{[a.category, a.make, a.criticality?.split(' (')[0] && `${a.criticality?.split(' (')[0]} criticality`].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    <div>{a.department}</div>
                    {a.location && <div className="text-xs text-ink-3">{a.location}{a.location_status && a.location_status !== 'At assigned location' ? ` · ${a.location_status}` : ''}</div>}
                  </td>
                  <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                  <td className="px-3 py-2">
                    {a.next_due ? (
                      <div className="space-y-0.5">
                        <div className="text-xs text-ink-2">{a.next_due.kind} · {a.next_due.due}</div>
                        <DaysPill days={a.next_due.days} urgency={a.next_due.urgency} cover={a.next_due.kind === 'Warranty' || a.next_due.kind === 'AMC / CMC'} />
                      </div>
                    ) : <span className="text-ink-3">—</span>}
                  </td>
                  {showMoney && <td className="px-4 py-2 text-right tabular text-ink" title={a.cost ? `Cost ${money(a.cost, true)}` : undefined}>{a.nbv ? moneyShort(a.nbv) : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  )
}
