import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Badge, Button, Card, Empty, ErrorBox, FieldWrap, Input, Modal, PageHeader, Select, Spinner, StatTile, StatusBadge } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { dateTime, money, todayISO } from '@/lib/format'
import { K, KIND_LABEL, MODE_LABEL, type RolePerms, type Row } from './api'
import { ExportButtons, SearchBox, useSlashFocus, type Col } from './listing'
import { AdmissionPicker, BalancePill, newPayLine, PayLines, payLinesBody, payLinesValid, payerLabel, type PayLine, PageGuard } from './ui'

interface DeskRow {
  id: string; code: string; kind: string; mode: string; amount: number; reference: string | null; remarks: string | null; paid_at: string
  status: string; received_by: string | null; invoice_id: string | null; encounter_id: string | null; patient_id: string; p_name: string; p_uhid: string; ip_no: string | null
}
interface Desk {
  range: { from: string; to: string }; rows: DeskRow[]
  totals: { advances: number; receipts: number; refunds: number; adjusted: number; net_collection: number }
  by_mode: { mode: string; amount: number }[]
  inhouse: { admissions: number; billed: number; advance: number; to_collect: number }
  due: Row[]; permissions: RolePerms
}
const COLS: Col<DeskRow>[] = [
  { label: 'Receipt', value: (r) => r.code }, { label: 'Date', value: (r) => r.paid_at }, { label: 'Patient', value: (r) => r.p_name },
  { label: 'UHID', value: (r) => r.p_uhid }, { label: 'IP no', value: (r) => r.ip_no }, { label: 'Type', value: (r) => KIND_LABEL[r.kind] ?? r.kind },
  { label: 'Mode', value: (r) => MODE_LABEL[r.mode] ?? r.mode }, { label: 'Amount', value: (r) => (r.kind === 'REFUND' ? -r.amount : r.amount) },
  { label: 'Reference', value: (r) => r.reference }, { label: 'Received by', value: (r) => r.received_by }, { label: 'Status', value: (r) => r.status },
]

/** Payment desk — advances and receipts across admissions, mode-wise collection, in-house dues. */
export default function PaymentDesk({ embedded }: { embedded?: boolean }) {
  return <PageGuard page="payment-desk"><PaymentDeskScreen embedded={embedded} /></PageGuard>
}

function PaymentDeskScreen({ embedded }: { embedded?: boolean }) {
  const nav = useNavigate()
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [kind, setKind] = useState('')
  const [mode, setMode] = useState('')
  const [collectFor, setCollectFor] = useState<{ id: string; name: string; ip: string; due: number } | null>(null)
  const search = useRef<HTMLInputElement>(null)
  useSlashFocus(search)
  const query = { date_from: from, date_to: to, q: dq || undefined, kind: kind || undefined, mode: mode || undefined }
  const desk = useQuery({ queryKey: K.desk(query), queryFn: () => api<Desk>('/ipbilling/payment-desk', { query }), placeholderData: (p) => p, refetchInterval: 60_000 })
  const d = desk.data
  return (
    <div className="space-y-4">
      {!embedded && <PageHeader icon="Wallet" title="Payment Desk" subtitle="Advances, receipts and refunds across in-patient admissions." />}
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From date" />
        <span className="text-ink-3">–</span>
        <Input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To date" />
        <span className="ml-auto" />
        {d?.permissions.collect && <AdmissionPicker tab="admitted" placeholder="Collect advance for… (patient / IP no)" onPick={(r) => setCollectFor({ id: r.id, name: r.patient.name, ip: r.ip_no, due: Math.max(0, r.balance) })} />}
      </div>
      {desk.isLoading ? <Spinner /> : desk.error ? <ErrorBox error={desk.error} /> : d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile icon="PiggyBank" label="Advances" value={money(d.totals.advances, true)} />
            <StatTile icon="ReceiptText" label="Bill payments" value={money(d.totals.receipts, true)} />
            <StatTile icon="Undo2" label="Refunds" value={money(d.totals.refunds, true)} />
            <StatTile icon="Banknote" label="Net collection" value={money(d.totals.net_collection, true)} hint={d.by_mode.map((m) => `${MODE_LABEL[m.mode] ?? m.mode} ${money(m.amount, true)}`).join(' · ') || 'No collections'} />
            <StatTile icon="BedDouble" label="In-house to collect" value={money(d.inhouse.to_collect, true)} hint={`${d.inhouse.admissions} admissions · ${money(d.inhouse.advance, true)} advance held`} tone={d.inhouse.to_collect > 0 ? 'alert' : 'default'} />
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card pad={false} title="Receipts" icon="ReceiptText">
              <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
                <SearchBox inputRef={search} value={q} onChange={setQ} placeholder="Patient, UHID, IP no, receipt no…" />
                <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-36" aria-label="Type">
                  <option value="">All types</option>{['DEPOSIT', 'PAYMENT', 'REFUND', 'ADJUSTMENT'].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </Select>
                <Select value={mode} onChange={(e) => setMode(e.target.value)} className="w-36" aria-label="Mode">
                  <option value="">All modes</option>{['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'WALLET', 'INSURANCE', 'DEPOSIT', 'SALARY'].map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                </Select>
                <span className="ml-auto" />
                <ExportButtons title={`IP receipts ${from} to ${to}`} columns={COLS} fetchAll={async () => d.rows} />
              </div>
              {!d.rows.length ? <Empty icon="Wallet" title="No receipts in this period" /> : (
                <div className="max-h-[560px] overflow-auto scroll-thin">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
                      <tr>{['Receipt', 'Date', 'Patient', 'Type', 'Mode', 'Amount', 'Reference', 'Status'].map((h) => <th key={h} className={`px-3 py-2 font-medium ${h === 'Amount' ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {d.rows.map((r) => (
                        <tr key={r.id} className="border-b border-line last:border-0">
                          <td className="px-3 py-1.5 font-mono text-xs">{r.code}</td>
                          <td className="px-3 py-1.5 text-xs text-ink-2">{dateTime(r.paid_at)}<div className="text-ink-3">{r.received_by}</div></td>
                          <td className="px-3 py-1.5">
                            {r.encounter_id ? <Link to={`/ip/billing/${r.encounter_id}`} className="font-medium text-ink hover:underline">{r.p_name}</Link> : <span className="font-medium">{r.p_name}</span>}
                            <div className="text-xs text-ink-3">{r.p_uhid}{r.ip_no ? ` · ${r.ip_no}` : ''}</div>
                          </td>
                          <td className="px-3 py-1.5"><Badge tone={r.kind === 'REFUND' ? 'red' : r.kind === 'DEPOSIT' ? 'violet' : r.kind === 'ADJUSTMENT' ? 'gray' : 'green'}>{KIND_LABEL[r.kind] ?? r.kind}</Badge></td>
                          <td className="px-3 py-1.5 text-xs">{MODE_LABEL[r.mode] ?? r.mode}</td>
                          <td className="px-3 py-1.5 text-right font-medium tabular-nums">{r.kind === 'REFUND' ? '−' : ''}{money(r.amount)}</td>
                          <td className="max-w-48 truncate px-3 py-1.5 text-xs text-ink-2" title={r.remarks ?? r.reference ?? ''}>{r.reference ?? r.remarks ?? '—'}</td>
                          <td className="px-3 py-1.5"><StatusBadge status={r.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card pad={false} title="In-house patients with a balance" icon="AlertTriangle">
              {!d.due.length ? <Empty icon="CircleCheck" title="Every in-house patient's share is covered" /> : (
                <ul className="max-h-[600px] divide-y divide-line overflow-y-auto scroll-thin">
                  {d.due.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2">
                      <button type="button" className="min-w-0 text-left" onClick={() => nav(`/ip/billing/${r.id}`)}>
                        <span className="block truncate text-sm font-medium text-ink hover:underline">{r.patient.name}</span>
                        <span className="block truncate text-xs text-ink-3">{r.ip_no} · {[r.ward?.name, r.bed?.bed_no].filter(Boolean).join(' · ')} · {payerLabel(r)}</span>
                        <span className="block text-xs text-ink-3">Net {money(r.net)} · paid {money(r.paid)}</span>
                      </button>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <BalancePill balance={r.balance} />
                        {d.permissions.collect && <Button size="xs" onClick={() => setCollectFor({ id: r.id, name: r.patient.name, ip: r.ip_no, due: r.balance })}>Collect</Button>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
      {collectFor && <CollectModal target={collectFor} onClose={() => setCollectFor(null)} />}
    </div>
  )
}

function CollectModal({ target, onClose }: { target: { id: string; name: string; ip: string; due: number }; onClose: () => void }) {
  const qc = useQueryClient()
  const [lines, setLines] = useState<PayLine[]>([newPayLine(target.due ? String(target.due) : '')])
  const [remarks, setRemarks] = useState('')
  useEffect(() => setLines([newPayLine(target.due ? String(target.due) : '')]), [target.due])
  const m = useMutation({
    mutationFn: () => api<{ receipts: { code: string; amount: number }[] }>(`/ipbilling/admissions/${target.id}/receipts`, { method: 'POST', body: { lines: payLinesBody(lines), remarks: remarks || undefined } }),
    onSuccess: (r) => { toast.success(`Receipt ${r.receipts.map((x) => x.code).join(', ')}`); qc.invalidateQueries({ queryKey: K.all }); onClose() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const err = payLinesValid(lines)
  return (
    <Modal open onClose={onClose} title={`Advance / receipt · ${target.name} (${target.ip})`} size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="success" disabled={!!err} loading={m.isPending} onClick={() => m.mutate()}>Collect {money(lines.reduce((s, l) => s + Number(l.amount || 0), 0))}</Button></>}>
      <div className="space-y-3">
        {target.due > 0 && <p className="text-sm text-ink-2">Patient balance: <b className="text-amber-700 dark:text-amber-300">{money(target.due)}</b></p>}
        <PayLines lines={lines} onChange={setLines} due={target.due || undefined} autoFocus />
        <FieldWrap label="Remarks"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional — printed on the receipt" /></FieldWrap>
      </div>
    </Modal>
  )
}
