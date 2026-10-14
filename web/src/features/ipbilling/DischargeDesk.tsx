import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useDebounced } from '@/components/fields'
import { Pager } from '@/components/list'
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { date, dateTime, money, todayISO } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { K, type ListResult, type PrintFormat, type Row } from './api'
import { DocumentsModal } from './DischargeDocs'
import { DischargeWizard } from './DischargeWizard'
import { ExportButtons, SearchBox, useSlashFocus, type Col } from './listing'
import { AdmissionPicker, BalancePill, CopyButton, payerLabel, PrintPreview, PageGuard } from './ui'

const COLS: Col<Row>[] = [
  { label: 'IP no', value: (r) => r.ip_no }, { label: 'UHID', value: (r) => r.patient.uhid }, { label: 'Patient', value: (r) => r.patient.name },
  { label: 'Gender', value: (r) => r.patient.gender }, { label: 'Age', value: (r) => r.patient.age }, { label: 'Mobile', value: (r) => r.patient.phone },
  { label: 'Ward', value: (r) => r.ward?.name }, { label: 'Bed', value: (r) => r.bed?.bed_no }, { label: 'Consultant', value: (r) => r.doctor },
  { label: 'Discharged on', value: (r) => r.discharged_at }, { label: 'Discharge type', value: (r) => r.discharge_type }, { label: 'Net bill', value: (r) => r.net },
  { label: 'Balance', value: (r) => r.balance },
]

/** Discharge desk: queue of patients being discharged + discharged patients with post-discharge actions. */
export default function DischargeDesk({ embedded }: { embedded?: boolean }) {
  return <PageGuard page="discharge-desk"><DischargeDeskScreen embedded={embedded} /></PageGuard>
}

function DischargeDeskScreen({ embedded }: { embedded?: boolean }) {
  const [params, setParams] = useSearchParams()
  const wizard = params.get('admission')
  const openWizard = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('admission', id); else p.delete('admission')
    setParams(p, { replace: !id })
  }
  return (
    <div className="space-y-4">
      {!embedded && <PageHeader icon="DoorOpen" title="Discharge" subtitle="Settle the bill → discharge details → release the bed." />}
      <Queue onOpen={openWizard} />
      <Discharged />
      {wizard && <DischargeWizard admissionId={wizard} onClose={() => openWizard(null)} />}
    </div>
  )
}

function Queue({ onOpen }: { onOpen: (id: string) => void }) {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const list = useQuery({
    queryKey: K.queue(dq),
    queryFn: () => api<ListResult>('/ipbilling/discharge/queue', { query: { q: dq || undefined } }),
    refetchInterval: 60_000,
    placeholderData: (p) => p,
  })
  const rows = list.data?.rows ?? []
  return (
    <Card pad={false} title={<span className="flex items-center gap-2">Discharge queue <Badge tone="blue">{list.data?.total ?? '…'}</Badge></span>} icon="BedDouble"
      actions={<div className="flex items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter the queue" className="h-8 w-48" aria-label="Filter the discharge queue" />
        <AdmissionPicker tab="admitted" placeholder="Any admitted patient…" onPick={(r) => onOpen(r.id)} />
      </div>}>
      {list.isLoading ? <Spinner /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : !rows.length ? (
        <Empty icon="CircleCheck" title={dq ? 'Nobody in the queue matches' : 'No patients waiting for discharge'}>Patients enter the queue when a doctor, nurse or this desk initiates discharge.</Empty>
      ) : (
        <div className="max-h-[420px] overflow-auto scroll-thin">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>{['#', 'Patient details', 'Date of admission', 'Ward / consultant', 'Sponsor', 'Net bill', 'Total outstanding', 'Actions'].map((h, i) => (
                <th key={h} className={`px-3 py-2 font-medium ${i >= 5 && i <= 6 ? 'text-right' : i === 7 ? 'text-right' : 'text-left'}`}>{h}</th>))}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                  <td className="px-3 py-2 text-ink-3">{i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{r.patient.name}</div>
                    <div className="text-xs text-ink-3">IP {r.ip_no} · UHID {r.patient.uhid}{r.patient.phone ? ` · ${r.patient.phone}` : ''}</div>
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">{date(r.admitted_at)}<div className="text-ink-3">{r.initiated_at ? `initiated ${dateTime(r.initiated_at)}` : ''}</div></td>
                  <td className="px-3 py-2 text-xs"><div className="uppercase text-ink-2">{[r.ward?.name, r.bed?.bed_no].filter(Boolean).join(' · ')}</div><div className="text-ink-3">{r.doctor}</div></td>
                  <td className="px-3 py-2 text-xs">{payerLabel(r)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.net)}</td>
                  <td className={`px-3 py-2 text-right font-medium tabular-nums ${r.balance > 0.009 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>{money(Math.max(0, r.balance))}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="xs" variant="primary" onClick={() => onOpen(r.id)}>Open</Button>
                      <Button size="xs" onClick={() => nav(`/ip/billing/${r.id}`)}>View bill</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Discharged() {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [print, setPrint] = useState<{ row: Row; format: PrintFormat; title: string } | null>(null)
  const [docs, setDocs] = useState<Row | null>(null)
  const search = useRef<HTMLInputElement>(null)
  useSlashFocus(search)
  useEffect(() => setPage(1), [dq, from, to])
  const query = { q: dq || undefined, date_from: from || undefined, date_to: to || undefined, page, limit }
  const list = useQuery({ queryKey: K.discharged(query), queryFn: () => api<ListResult>('/ipbilling/discharge/discharged', { query }), placeholderData: (p) => p })
  const rows = list.data?.rows ?? []
  return (
    <Card pad={false} title="Discharged patients" icon="LogOut">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchBox inputRef={search} value={q} onChange={setQ} placeholder="Patient name / UHID / IP number / mobile…" />
        <div className="flex items-center gap-1.5 text-sm">
          <Icon name="CalendarDays" className="size-4 text-ink-3" />
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" aria-label="From date" />
          <span className="text-ink-3">–</span>
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" aria-label="To date" />
          <button type="button" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => { setFrom(''); setTo('') }}>All dates</button>
        </div>
        <span className="ml-auto" />
        <ExportButtons title="Discharged patients" columns={COLS} fetchAll={async () => (await api<ListResult>('/ipbilling/discharge/discharged', { query: { ...query, page: 1, limit: 200 } })).rows} />
      </div>
      {list.isLoading ? <Spinner /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : !rows.length ? (
        <Empty icon="LogOut" title="No discharges in this period" />
      ) : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>{['S.no', 'IP no', 'Patient', 'Ward / bed', 'Consultant', 'Discharged on', 'Net bill', 'Balance', 'Actions'].map((h, i) => (
                <th key={h} className={`px-3 py-2 font-medium ${i === 6 ? 'text-right' : i === 8 ? 'text-right' : 'text-left'}`}>{h}</th>))}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                  <td className="px-3 py-2 text-ink-3">{(page - 1) * limit + i + 1}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1 whitespace-nowrap"><Link to={`/ip/billing/${r.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{r.ip_no}</Link><CopyButton value={r.ip_no} /></span>
                    <span className="block text-xs text-ink-3">{r.patient.uhid}</span>
                  </td>
                  <td className="px-3 py-2"><div className="font-medium text-ink">{r.patient.name}</div>
                    <div className="text-xs uppercase text-ink-3">{[r.patient.gender, r.patient.age != null ? `${r.patient.age} yr` : null, r.patient.phone].filter(Boolean).join(' · ')}</div></td>
                  <td className="px-3 py-2 text-xs uppercase text-ink-2">{[r.ward?.name, r.bed?.bed_no].filter(Boolean).join(' / ')}</td>
                  <td className="px-3 py-2 text-xs">{r.doctor ?? '—'}<div className="text-ink-3">{r.department}</div></td>
                  <td className="px-3 py-2 text-xs tabular-nums">{dateTime(r.discharged_at)}{r.discharge_type && r.discharge_type !== 'Routine' && <div><Badge tone="amber">{r.discharge_type}</Badge></div>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.net)}</td>
                  <td className="px-3 py-2"><BalancePill balance={r.balance} /></td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="xs" icon="Sparkles" onClick={() => setPrint({ row: r, format: 'casesheet', title: `Case Sheet · ${r.patient.name}` })}>Smart Report</Button>
                      <Link to={`/patients/${r.patient.id}`} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"><Icon name="FlaskConical" className="size-3.5" />Reports</Link>
                      <Button size="xs" variant="ghost" icon="Paperclip" onClick={() => setDocs(r)}>Documents</Button>
                      <PrintMenu onPick={(format, title) => setPrint({ row: r, format, title: `${title} · ${r.patient.name}` })} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pager page={page} limit={limit} total={list.data.total} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1) }} fetching={list.isFetching} />}
      {print && <PrintPreview open onClose={() => setPrint(null)} admissionId={print.row.id} format={print.format} title={print.title} />}
      {docs && <DocumentsModal admissionId={docs.id} patientName={docs.patient.name} onClose={() => setDocs(null)} />}
    </Card>
  )
}

function PrintMenu({ onPick }: { onPick: (f: PrintFormat, title: string) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const items: [PrintFormat, string][] = [['checkout', 'Check-out slip'], ['final', 'Final bill'], ['summarised', 'Summarised bill'], ['nonmed', 'Non-medical bill'],
    ['pharmacy', 'Pharmacy bill'], ['interim', 'Receipts'], ['sponsor_tpa', 'Insurance / TPA bill'], ['sponsor_corporate', 'Corporate bill'], ['detailed_gst', 'Detailed bill with GST']]
  return (
    <div ref={box} className="relative">
      <Button size="xs" variant="ghost" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}><Printer className="size-3.5" />Print</Button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-line bg-surface py-1 text-sm shadow-xl">
          {items.map(([f, l]) => <button key={f} role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => { setOpen(false); onPick(f, l) }}>{l}</button>)}
        </div>
      )}
    </div>
  )
}
