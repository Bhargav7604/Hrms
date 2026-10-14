import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useDebounced } from '@/components/fields'
import { Pager } from '@/components/list'
import { Badge, Card, cn, Empty, ErrorBox, PageHeader, Spinner, StatusBadge, Tabs } from '@/components/ui'
import { api } from '@/lib/api'
import { date, money } from '@/lib/format'
import { K, type ListResult, type Row } from './api'
import { ExportButtons, SearchBox, useSlashFocus, type Col } from './listing'
import { AdmissionPicker, BalancePill, CopyButton, PatientAvatar, payerLabel, PageGuard } from './ui'

type Tab = 'admitted' | 'all' | 'discharged'
const COLS: Col<Row>[] = [
  { label: 'IP no', value: (r) => r.ip_no }, { label: 'Patient', value: (r) => r.patient.name }, { label: 'UHID', value: (r) => r.patient.uhid },
  { label: 'Mobile', value: (r) => r.patient.phone }, { label: 'Ward', value: (r) => r.ward?.name }, { label: 'Bed', value: (r) => r.bed?.bed_no },
  { label: 'Sponsor', value: (r) => payerLabel(r) }, { label: 'Admitted', value: (r) => r.admitted_at }, { label: 'Status', value: (r) => r.status },
  { label: 'Net', value: (r) => r.net }, { label: 'Paid', value: (r) => r.paid }, { label: 'Balance', value: (r) => r.balance },
]

/** IP Approximate Bill — patient list (Admitted / All / Discharged). */
export default function BillList({ embedded }: { embedded?: boolean }) {
  return <PageGuard page="ip-billing"><BillListScreen embedded={embedded} /></PageGuard>
}

function BillListScreen({ embedded }: { embedded?: boolean }) {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'admitted'
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [sort, setSort] = useState('-admitted')
  const search = useRef<HTMLInputElement>(null)
  useSlashFocus(search)
  const query = { tab, q: dq || undefined, page, limit, sort }
  const list = useQuery({
    queryKey: K.list(query),
    queryFn: () => api<ListResult>('/ipbilling/admissions', { query }),
    placeholderData: (p) => p,
  })
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }); setPage(1) }
  const sortBy = (k: string) => { setSort(sort === `-${k}` ? k : `-${k}`); setPage(1) }
  const SortHead = ({ k, children, className }: { k: string; children: string; className?: string }) => (
    <th className={cn('px-3 py-2 text-left font-medium', className)} aria-sort={sort.endsWith(k) ? (sort.startsWith('-') ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => sortBy(k)}>{children}
        {sort === `-${k}` ? <ArrowDown className="size-3" /> : sort === k ? <ArrowUp className="size-3" /> : null}</button>
    </th>
  )
  const counts = list.data?.counts
  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader icon="FileSpreadsheet" title="IP Approximate Bill" subtitle="Select a patient to load their working bill"
          actions={<AdmissionPicker onPick={(r) => nav(`/ip/billing/${r.id}`)} />} />
      )}
      {embedded && <div className="flex justify-end"><AdmissionPicker onPick={(r) => nav(`/ip/billing/${r.id}`)} /></div>}
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'admitted', label: 'Admitted', count: counts?.admitted }, { key: 'all', label: 'All', count: counts?.all },
        { key: 'discharged', label: 'Discharged', count: counts?.discharged },
      ]} />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <SearchBox inputRef={search} value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Search IP no, UHID, name, mobile…" />
          <span className="ml-auto" />
          <ExportButtons title={`IP bills — ${tab}`} columns={COLS}
            fetchAll={async () => (await api<ListResult>('/ipbilling/admissions', { query: { ...query, page: 1, limit: 200 } })).rows} />
        </div>
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : !list.data?.rows.length ? (
          <Empty icon="BedDouble" title={dq ? 'No admissions match' : tab === 'discharged' ? 'No discharged patients' : 'No admitted patients'} />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>
                  <th className="w-12 px-3 py-2 text-left font-medium">S.no</th>
                  <SortHead k="ip">IP no</SortHead>
                  <SortHead k="patient">Patient</SortHead>
                  <th className="px-3 py-2 text-left font-medium">Ward / bed</th>
                  <th className="px-3 py-2 text-left font-medium">Sponsor</th>
                  <SortHead k="admitted">Admitted</SortHead>
                  <SortHead k="status">Status</SortHead>
                  <th className="px-3 py-2 text-right font-medium">Net</th>
                  <th className="px-3 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((r, i) => (
                  <tr key={r.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2/70" onClick={() => nav(`/ip/billing/${r.id}`)}>
                    <td className="px-3 py-2 text-ink-3">{(page - 1) * limit + i + 1}</td>
                    <td className="whitespace-nowrap px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <Link to={`/ip/billing/${r.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{r.ip_no}</Link>
                      <span className="ml-1 inline-block align-middle"><CopyButton value={r.ip_no} /></span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <PatientAvatar p={r.patient} size="sm" />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink">{r.patient.name}</div>
                          <div className="truncate text-xs text-ink-3">{[r.patient.uhid, r.patient.age != null ? `${r.patient.age}y` : null, r.patient.gender?.[0], r.patient.phone].filter(Boolean).join(' · ')}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs uppercase text-ink-2">{[r.ward?.name, r.bed?.bed_no].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-2 text-xs">{r.payer_type === 'Self' ? 'Self-pay' : <Badge tone="violet">{payerLabel(r)}</Badge>}</td>
                    <td className="px-3 py-2 text-xs tabular-nums">{date(r.admitted_at)}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{money(r.net)}</td>
                    <td className="px-3 py-2 text-right"><BalancePill balance={r.balance} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && <Pager page={page} limit={limit} total={list.data.total} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1) }} fetching={list.isFetching} />}
      </Card>
    </div>
  )
}
