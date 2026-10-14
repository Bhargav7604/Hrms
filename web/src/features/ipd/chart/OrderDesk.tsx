import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useDebounced } from '@/components/fields'
import { Badge, Button, cn, Empty, ErrorBox, FieldWrap, Input, Modal, Select, Spinner, Switch, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { dateTime, money, nowLocal } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { useShortcuts } from '@/lib/shortcuts'
import { chartScope, K, type ChargeRow, type ChartHeader, type Medicine, type OrderRow, type SafetyAlert, type Service } from '../api'
import { Amount, ReasonDialog, SearchSelect, Section, StageBadge, Table, td } from '../ui'
import { OrderDetailModal } from './OrderDetail'

type Props = { h: ChartHeader }
const isOpen = (h: ChartHeader) => h.admission.status === 'Admitted' || h.admission.status === 'Discharge Initiated'

/** Live tariff search (investigations / services / procedures / grade heads). */
function ServicePicker({ kind, value, onPick, autoFocus, placeholder }: { kind: string; value: Service | null; onPick: (s: Service | null) => void; autoFocus?: boolean; placeholder: string }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 200)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const res = useQuery({ queryKey: ['x', 'billing', 'svc', kind, dq], queryFn: () => api<{ rows: Service[] }>('/ipchart/services', { query: { kind, q: dq, limit: 25 } }), enabled: open, staleTime: 60_000 })
  const rows = res.data?.rows ?? []
  const pick = (s?: Service) => { if (s) { onPick(s); setOpen(false); setQ('') } }
  return (
    <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <Icon name="Search" className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
      <Input data-search autoFocus={autoFocus} value={open ? q : value?.name ?? ''} placeholder={placeholder} className="pl-8"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((x) => Math.min(x + 1, rows.length - 1)) } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((x) => Math.max(x - 1, 0)) } else if (e.key === 'Enter') { e.preventDefault(); pick(rows[hi]) } else if (e.key === 'Escape') setOpen(false)
        }} />
      {open && (
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
          {res.isLoading && <div className="px-3 py-2 text-sm text-ink-3">Searching…</div>}
          {!res.isLoading && rows.length === 0 && <div className="px-3 py-2 text-sm text-ink-3">No matching service</div>}
          {rows.map((s, i) => (
            <button type="button" key={s.id} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)} onMouseEnter={() => setHi(i)}
              className={cn('flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm', i === hi && 'bg-surface-2')}>
              <span className="min-w-0"><span className="block truncate text-ink">{s.name}</span><span className="text-xs text-ink-3">{s.code} · {s.category}{s.sample_type ? ` · ${s.sample_type}` : ''}{s.modality ? ` · ${s.modality}` : ''}</span></span>
              {s.rate != null && <span className="shrink-0 text-xs tabular-nums text-ink-2">{money(s.rate)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ================================================================== investigations

interface InvData {
  rows: OrderRow[]; counts: Record<string, number>
  indents?: { indent_no: string; billed: number; collected: number; due: number; status: string; orders: number; at: string }[]
  advance_available?: number; payer?: string
}
interface Line { svc: Service; qty: number; discount: number; mode: 'amount' | 'percent'; priority: string }

export function InvestigationsPage({ h }: Props) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const p = h.permissions
  const q = useQuery({ queryKey: K.investigations(aid, 'investigations'), queryFn: () => api<InvData>(`/ipchart/admissions/${aid}/investigations`) })
  const [lines, setLines] = useState<Line[]>([])
  const [cur, setCur] = useState<Line | null>(null)
  const [notes, setNotes] = useState('')
  const [reason, setReason] = useState('')
  const [dups, setDups] = useState<{ test: string; code: string; status: string; ordered_at: string }[] | null>(null)
  const [detail, setDetail] = useState<{ id: string; mode: 'track' | 'report' } | null>(null)
  const [voiding, setVoiding] = useState<OrderRow | null>(null)
  const [collect, setCollect] = useState<{ indent_no: string; due: number } | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const box = useRef<HTMLDivElement>(null)
  useShortcuts('Investigations', [{ keys: '/', label: 'Search tests', run: () => (box.current?.querySelector('input[data-search]') as HTMLInputElement | null)?.focus() }])
  const amt = (l: Line) => { const g = (l.svc.rate ?? 0) * l.qty; const d = l.mode === 'percent' ? (g * l.discount) / 100 : l.discount; return { g, d, n: Math.max(0, g - d) } }
  const order = useMutation({
    mutationFn: (confirm: boolean) => api<{ indent_no: string; count: number; total?: number }>(`/ipchart/admissions/${aid}/investigations`, {
      method: 'POST', body: { items: lines.map((l) => ({ service_id: l.svc.id, qty: l.qty, discount: l.discount, discount_mode: l.mode, priority: l.priority })), clinical_notes: notes || null, discount_reason: reason || null, confirm_duplicates: confirm },
    }),
    onSuccess: (r) => { toast.success(`${r.count} investigation(s) ordered · ${r.indent_no}${r.total != null ? ` · ${money(r.total)}` : ''}`); setLines([]); setNotes(''); setReason(''); setDups(null); chartScope(qc, aid) },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE_ORDER') { setDups((e.details?.warnings as { test: string; code: string; status: string; ordered_at: string }[]) ?? []); return }
      toast.error(errorMessage(e))
    },
  })
  const voidIt = useMutation({
    mutationFn: ({ id, reason: r }: { id: string; reason: string }) => api(`/ipchart/admissions/${aid}/void`, { method: 'POST', body: { target: 'order', id, reason: r } }),
    onSuccess: () => { toast.success('Order cancelled — its charge is reversed'); setVoiding(null); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  const addLine = () => { if (cur) { if (lines.some((l) => l.svc.id === cur.svc.id)) { toast.error('Already in this order'); return } setLines([...lines, cur]); setCur(null) } }
  const d = q.data
  const rows = (d?.rows ?? []).filter((r) => !search || `${r.test} ${r.code} ${r.indent_no ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const pageRows = rows.slice((page - 1) * 15, page * 15)
  const anyDisc = lines.some((l) => l.discount > 0)
  const canReport = p.tabs.investigations
  return (
    <div className="space-y-4">
      {p.order && isOpen(h) && (
        <Section title="Order investigations" icon="FlaskConical" tone="violet" actions={p.collect && d?.indents?.some((i) => i.due > 0) ? <Badge tone="amber">Payment due on {d.indents.filter((i) => i.due > 0).length} indent(s)</Badge> : undefined}>
          <div ref={box} className="grid items-end gap-2 lg:grid-cols-[minmax(0,1fr)_auto_5rem_6rem_7rem_auto]">
            <FieldWrap label="Service"><ServicePicker kind="investigation" value={cur?.svc ?? null} placeholder="Search any test, scan or service… (press / to focus)" onPick={(s) => setCur(s ? { svc: s, qty: 1, discount: 0, mode: 'amount', priority: 'Routine' } : null)} /></FieldWrap>
            <FieldWrap label="Priority"><Select value={cur?.priority ?? 'Routine'} disabled={!cur} onChange={(e) => cur && setCur({ ...cur, priority: e.target.value })}>{['Routine', 'Urgent', 'STAT'].map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap>
            <FieldWrap label="Qty"><Input type="number" min={1} max={20} value={cur?.qty ?? 1} disabled={!cur} onChange={(e) => cur && setCur({ ...cur, qty: Math.max(1, Number(e.target.value) || 1) })} /></FieldWrap>
            {p.money ? <FieldWrap label="Rate"><div className="h-9 rounded-lg bg-surface-2 px-3 py-2 text-right text-sm tabular-nums">{cur ? money(cur.svc.rate ?? 0) : '—'}</div></FieldWrap> : <span />}
            {p.discount ? (
              <FieldWrap label="Discount">
                <div className="flex"><Select className="w-14 rounded-r-none px-1" value={cur?.mode ?? 'amount'} disabled={!cur} onChange={(e) => cur && setCur({ ...cur, mode: e.target.value as 'amount' | 'percent' })}><option value="amount">₹</option><option value="percent">%</option></Select>
                  <Input type="number" min={0} className="rounded-l-none" value={cur?.discount ?? 0} disabled={!cur} onChange={(e) => cur && setCur({ ...cur, discount: Math.max(0, Number(e.target.value) || 0) })} /></div>
              </FieldWrap>
            ) : <span />}
            <Button icon="Plus" disabled={!cur} onClick={addLine}>Add</Button>
          </div>
          {lines.length > 0 && (
            <div className="mt-3 space-y-2">
              <Table head={['Test', 'Priority', 'Qty', ...(p.money ? ['Rate', 'Discount', 'Total'] : []), '']}>
                {lines.map((l, i) => {
                  const a = amt(l)
                  return (
                    <tr key={l.svc.id} className="border-t border-line">
                      <td className={td}>{l.svc.name} <span className="text-xs text-ink-3">{l.svc.code}</span></td>
                      <td className={td}>{l.priority !== 'Routine' ? <Badge tone="red">{l.priority}</Badge> : 'Routine'}</td>
                      <td className={td}>{l.qty}</td>
                      {p.money && <><td className={td}><Amount v={l.svc.rate ?? 0} /></td><td className={td}>{a.d ? <Amount v={-a.d} /> : '—'}</td><td className={td}><Amount v={a.n} className="font-medium" /></td></>}
                      <td className={`${td} text-right`}><button type="button" className="text-ink-3 hover:text-red-600" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="X" className="size-4" /></button></td>
                    </tr>
                  )
                })}
              </Table>
              <div className="grid gap-2 sm:grid-cols-2">
                <FieldWrap label="Clinical indication"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. ? community acquired pneumonia" /></FieldWrap>
                {anyDisc && <FieldWrap label="Discount reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></FieldWrap>}
              </div>
              <div className="flex items-center justify-end gap-3">
                {p.money && <span className="text-sm text-ink-2">Total <b className="text-ink">{money(lines.reduce((s, l) => s + amt(l).n, 0))}</b></span>}
                <span className="text-xs text-ink-3">Non-doctor orders are recorded as verbal orders of {h.doctor?.name ?? 'the primary consultant'}</span>
                <Button variant="primary" loading={order.isPending} disabled={anyDisc && reason.trim().length < 3} onClick={() => order.mutate(false)}>Place order ({lines.length})</Button>
              </div>
            </div>
          )}
        </Section>
      )}
      {d?.indents && d.indents.length > 0 && (
        <Section title="Indent payments" icon="Receipt" tone="amber" subtitle={d.payer === 'Cash' ? `Advance after the running bill: ${money(d.advance_available)}` : 'Sponsored stay — investigations go on the sponsor bill'} pad={false}>
          <ul className="divide-y divide-line">
            {d.indents.map((i) => (
              <li key={i.indent_no} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
                <span className="font-mono text-xs font-medium text-ink">{i.indent_no}</span>
                <span className="text-ink-2">Billed <b className="text-ink">{money(i.billed)}</b></span>
                <span className="text-ink-2">Collected <b className="text-ink">{money(i.collected)}</b></span>
                <Badge tone={i.status === 'Paid' || i.status === 'Covered by advance' ? 'green' : i.status === 'Payment due' ? 'red' : i.status === 'Cancelled' ? 'gray' : 'blue'}>{i.status}</Badge>
                {p.collect && i.due > 0 && i.status !== 'Cancelled' && <Button size="xs" className="ml-auto" icon="IndianRupee" onClick={() => setCollect({ indent_no: i.indent_no, due: i.due })}>Collect payment</Button>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Ordered investigations" icon="ListChecks" tone="blue" pad={false}
        actions={<div className="relative w-56"><Icon name="Search" className="pointer-events-none absolute left-2 top-2 size-4 text-ink-3" /><Input className="h-8 pl-7 text-xs" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Search investigations…" /></div>}>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !rows.length ? <Empty icon="FlaskConical" title="No investigations on this stay" /> : (
          <>
            <Table head={['Item', 'Qty', ...(p.money ? ['Rate', 'Disc', 'Total'] : []), 'Status', 'Track', 'Created by', 'Created at', '']}>
              {pageRows.map((r) => (
                <tr key={r.id} className={cn('border-t border-line', r.stage === 'Cancelled' && 'opacity-70')}>
                  <td className={td}><span className={cn('font-medium text-ink', r.stage === 'Cancelled' && 'line-through')}>{r.test}</span>{r.priority !== 'Routine' && <Badge tone="red" className="ml-1">{r.priority}</Badge>}
                    <div className="text-xs text-ink-3">{r.code}{r.indent_no ? ` · Indent ${r.indent_no}` : ''}{r.ordering_doctor ? ` · ${r.ordering_doctor}` : ''}</div>
                    {r.stage === 'Cancelled' && r.voided_by && <div className="text-xs text-red-600">Voided by {r.voided_by}{r.voided_at ? ` · ${dateTime(r.voided_at)}` : ''}{r.void_reason ? ` — ${r.void_reason}` : ''}</div>}</td>
                  <td className={td}>{r.qty}</td>
                  {p.money && <><td className={td}><Amount v={r.rate} /></td><td className={td}>{r.discount ? <Amount v={r.discount} /> : '—'}</td><td className={td}><Amount v={r.total} /></td></>}
                  <td className={td}><StageBadge stage={r.stage} critical={r.critical} /></td>
                  <td className={td}>{canReport && <span className="inline-flex gap-1">
                    <button type="button" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline dark:text-brand-300" onClick={() => setDetail({ id: r.id, mode: 'track' })}><Icon name="Route" className="size-3.5" />Track</button>
                    {r.report_ready && <button type="button" title="View report" aria-label="View report" className="text-emerald-700 dark:text-emerald-300" onClick={() => setDetail({ id: r.id, mode: 'report' })}><Icon name="FileText" className="size-4" /></button>}
                  </span>}</td>
                  <td className={`${td} text-xs`}>{r.created_by ?? '—'}</td>
                  <td className={`${td} whitespace-nowrap text-xs`}>{dateTime(r.ordered_at)}</td>
                  <td className={`${td} text-right`}>{r.can_void && isOpen(h) && <Button size="xs" variant="ghost" className="text-red-600" onClick={() => setVoiding(r)}>Void</Button>}</td>
                </tr>
              ))}
            </Table>
            <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-2">
              <span>{rows.length} records</span>
              <span className="flex items-center gap-1"><Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button>Page {page} of {Math.max(1, Math.ceil(rows.length / 15))}<Button size="xs" variant="ghost" disabled={page * 15 >= rows.length} onClick={() => setPage(page + 1)}>›</Button></span>
            </div>
          </>
        )}
      </Section>
      {dups && (
        <Modal open onClose={() => setDups(null)} title="Already ordered in the last 24 hours" footer={<><Button variant="ghost" onClick={() => setDups(null)}>Go back</Button><Button variant="warning" loading={order.isPending} onClick={() => order.mutate(true)}>Order anyway</Button></>}>
          <ul className="space-y-1 text-sm">{dups.map((x) => <li key={x.code}><b>{x.test}</b> · {x.code} · {x.status} · {dateTime(x.ordered_at)}</li>)}</ul>
        </Modal>
      )}
      {detail && <OrderDetailModal id={detail.id} mode={detail.mode} onClose={() => setDetail(null)} />}
      <ReasonDialog open={!!voiding} title={`Void ${voiding?.test ?? ''}`} message="The order is cancelled and its unbilled charge reversed. The void is kept with your name and the time." confirm="Void order"
        busy={voidIt.isPending} onClose={() => setVoiding(null)} onConfirm={(r) => voiding && voidIt.mutate({ id: voiding.id, reason: r })} />
      {collect && <CollectModal aid={aid} indent={collect} onClose={() => setCollect(null)} />}
    </div>
  )
}

function CollectModal({ aid, indent, onClose }: { aid: string; indent: { indent_no: string; due: number }; onClose: () => void }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState('CASH')
  const [amount, setAmount] = useState(String(indent.due))
  const [ref, setRef] = useState('')
  const go = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${aid}/collect`, { method: 'POST', body: { indent_no: indent.indent_no, mode, amount: Number(amount), reference: ref || null } }),
    onSuccess: () => { toast.success(`Collected ${money(Number(amount))} for ${indent.indent_no}`); chartScope(qc, aid); onClose() }, onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title={`Collect payment · ${indent.indent_no}`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={go.isPending} disabled={!(Number(amount) > 0) || (mode !== 'CASH' && !ref.trim())} onClick={() => go.mutate()}>Collect {money(Number(amount) || 0)}</Button></>}>
      <div className="grid gap-3">
        <p className="text-sm text-ink-2">Due {money(indent.due)} — booked as an advance against this stay.</p>
        <FieldWrap label="Mode"><Select value={mode} onChange={(e) => setMode(e.target.value)}>{['CASH', 'CARD', 'UPI', 'WALLET', 'BANK', 'CHEQUE'].map((m) => <option key={m}>{m}</option>)}</Select></FieldWrap>
        <FieldWrap label="Amount (₹)"><Input type="number" min={0} max={indent.due} value={amount} onChange={(e) => setAmount(e.target.value)} /></FieldWrap>
        {mode !== 'CASH' && <FieldWrap label="Transaction / cheque reference" required><Input value={ref} onChange={(e) => setRef(e.target.value)} /></FieldWrap>}
      </div>
    </Modal>
  )
}

// ================================================================== service request

export function ServiceRequestPage({ h }: Props) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const [svc, setSvc] = useState<Service | null>(null)
  const [qty, setQty] = useState(1)
  const [priority, setPriority] = useState('Routine')
  const [when, setWhen] = useState('')
  const [notes, setNotes] = useState('')
  const list = useQuery({ queryKey: K.investigations(aid, 'services'), queryFn: () => api<InvData>(`/ipchart/admissions/${aid}/investigations`, { query: { scope: 'services' } }) })
  const go = useMutation({
    mutationFn: () => api<{ code: string; service: string }>(`/ipchart/admissions/${aid}/service-requests`, { method: 'POST', body: { service_id: svc!.id, qty, priority, notes: notes || null, scheduled_at: when || null } }),
    onSuccess: (r) => { toast.success(`${r.service} requested · ${r.code}`); setSvc(null); setQty(1); setNotes(''); setWhen(''); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="space-y-4">
      {h.permissions.order && isOpen(h) && (
        <Section title="Service request" icon="ConciergeBell" tone="teal" subtitle="Physiotherapy, dietitian, dialysis, nursing procedures — raised for the department to act on.">
          <div className="grid items-end gap-2 lg:grid-cols-[minmax(0,1fr)_5rem_8rem_13rem]">
            <FieldWrap label="Service"><ServicePicker kind="service" value={svc} onPick={setSvc} placeholder="Search services…" /></FieldWrap>
            <FieldWrap label="Sessions"><Input type="number" min={1} max={60} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></FieldWrap>
            <FieldWrap label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}>{['Routine', 'Urgent', 'STAT'].map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap>
            <FieldWrap label="Needed at"><Input type="datetime-local" min={nowLocal()} value={when} onChange={(e) => setWhen(e.target.value)} /></FieldWrap>
          </div>
          <div className="mt-2 flex items-end gap-2">
            <FieldWrap label="Notes" className="flex-1"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Chest physiotherapy TDS" /></FieldWrap>
            <Button variant="primary" disabled={!svc} loading={go.isPending} onClick={() => go.mutate()}>Request</Button>
          </div>
        </Section>
      )}
      <Section title="Service requests on this stay" icon="ListChecks" tone="blue" pad={false}>
        {list.isLoading ? <Spinner /> : !list.data?.rows.length ? <Empty icon="ConciergeBell" title="No service requests yet" /> : (
          <Table head={['Service', 'Sessions', 'Status', 'Requested by', 'At']}>
            {list.data.rows.map((r) => (
              <tr key={r.id} className="border-t border-line"><td className={td}>{r.test}<div className="text-xs text-ink-3">{r.code}{r.notes ? ` · ${r.notes}` : ''}</div></td><td className={td}>{r.qty}</td><td className={td}><StageBadge stage={r.stage} /></td><td className={`${td} text-xs`}>{r.created_by}</td><td className={`${td} text-xs`}>{dateTime(r.ordered_at)}</td></tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  )
}

// ================================================================== medication indent + medicines on this stay

interface IndentRow { id: string; code: string; status: string; category: string; store: string; raised_by?: string; raised_at: string; issued_at?: string; remarks?: string; voided_by?: string; void_reason?: string; can_cancel: boolean; items: { name: string; qty: number; issued_qty?: number | null; packing: string }[] }
interface LedgerRow { id: string; at: string; medicine: string; item_code?: string; batch?: string | null; qty: number; source: string; kind: string; reference?: string; store?: string; amount?: number }
interface Advised extends Medicine { dose?: string; route?: string; frequency?: string; duration_days?: number | null; suggested_qty: number; prescription?: string }

export function MedicationPage({ h }: Props) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const p = h.permissions
  const [category, setCategory] = useState('Normal')
  const [generic, setGeneric] = useState(false)
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 200)
  const [item, setItem] = useState<Medicine | null>(null)
  const [qty, setQty] = useState(1)
  const [cart, setCart] = useState<{ m: Medicine; qty: number }[]>([])
  const [remarks, setRemarks] = useState('')
  const [alerts, setAlerts] = useState<SafetyAlert[] | null>(null)
  const [override, setOverride] = useState('')
  const [advisedOpen, setAdvisedOpen] = useState(false)
  const [lq, setLq] = useState('')
  const search = useQuery({ queryKey: ['x', 'pharmacy', 'med-search', dq, generic], queryFn: () => api<{ rows: Medicine[] }>('/ipchart/medicines', { query: { q: dq, generic } }), enabled: dq.trim().length >= 2 && !item })
  const indents = useQuery({ queryKey: K.indents(aid), queryFn: () => api<{ rows: IndentRow[] }>(`/ipchart/admissions/${aid}/indents`) })
  const ledger = useQuery({ queryKey: K.medicines(aid), queryFn: () => api<{ rows: LedgerRow[]; totals?: { issued: number; returned: number; net: number } }>(`/ipchart/admissions/${aid}/medicines`) })
  const advised = useQuery({ queryKey: ['x', 'pharmacy', 'advised', aid], queryFn: () => api<{ rows: Advised[] }>(`/ipchart/admissions/${aid}/advised-medications`), enabled: advisedOpen })
  const raise = useMutation({
    mutationFn: () => api<{ indent: { code: string }; alerts: SafetyAlert[] }>(`/ipchart/admissions/${aid}/indents`, { method: 'POST', body: { category, store: 'IP Pharmacy', items: cart.map((c) => ({ item_id: c.m.id, qty: c.qty })), remarks: remarks || null, override_reason: override || null } }),
    onSuccess: (r) => {
      toast.success(`Indent ${r.indent.code} sent to the IP pharmacy`)
      if (r.alerts.length) toast.warning(r.alerts.slice(0, 3).map((a) => a.message).join(' · '), { duration: 10000 })
      setCart([]); setRemarks(''); setAlerts(null); setOverride(''); chartScope(qc, aid)
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'OVERRIDE_REQUIRED' || e.code === 'INDENT_BLOCKED')) { setAlerts((e.details?.alerts as SafetyAlert[]) ?? []); return }
      toast.error(errorMessage(e))
    },
  })
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/ipchart/admissions/${aid}/void`, { method: 'POST', body: { target: 'indent', id, reason } }),
    onSuccess: () => { toast.success('Indent cancelled'); setCancelling(null); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  const [cancelling, setCancelling] = useState<IndentRow | null>(null)
  const add = (m: Medicine, n: number) => { if (cart.some((c) => c.m.id === m.id)) setCart(cart.map((c) => (c.m.id === m.id ? { ...c, qty: c.qty + n } : c))); else setCart([...cart, { m, qty: n }]) }
  const ledgerRows = (ledger.data?.rows ?? []).filter((r) => !lq || `${r.medicine} ${r.item_code} ${r.batch}`.toLowerCase().includes(lq.toLowerCase()))
  const blocking = alerts?.some((a) => a.blocking)
  return (
    <div className="space-y-4">
      {p.indent && isOpen(h) && (
        <Section title="Order medication — raise an indent" icon="ClipboardPlus" tone="green"
          actions={<><Button size="sm" icon="Stethoscope" onClick={() => setAdvisedOpen(true)}>Doctor's advised medications</Button><Button size="sm" icon="ListOrdered" onClick={() => document.getElementById('indent-summary')?.scrollIntoView({ behavior: 'smooth' })}>Indent summary & orders</Button></>}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-md bg-surface-2 px-2 py-1 text-xs font-medium ring-1 ring-line">Category:
              <select className="ml-1 bg-transparent font-semibold uppercase" value={category} onChange={(e) => setCategory(e.target.value)}>{['Normal', 'Urgent', 'STAT', 'Discharge medication'].map((c) => <option key={c} value={c}>{c} indent</option>)}</select></span>
            <span className="rounded-md bg-surface-2 px-2 py-1 text-xs font-medium ring-1 ring-line">Stock point: <b>IP Pharmacy</b></span>
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-ink-2"><Switch size="sm" checked={generic} onChange={setGeneric} label="Generic search" /> Generic search</label>
          </div>
          <div className="mt-3 grid items-end gap-2 lg:grid-cols-[minmax(0,1fr)_7rem_10rem_6rem_auto]">
            <FieldWrap label={generic ? 'Generic name' : 'Item name'}>
              <div className="relative">
                <Icon name="Search" className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
                <Input className="pl-8" value={item ? item.name : q} placeholder="Search medicines…" onChange={(e) => { setItem(null); setQ(e.target.value) }} />
                {!item && dq.trim().length >= 2 && (
                  <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
                    {search.isLoading ? <div className="px-3 py-2 text-sm text-ink-3">Searching…</div> : !search.data?.rows.length ? <div className="px-3 py-2 text-sm text-ink-3">No medicine found</div>
                      : search.data.rows.map((m) => (
                        <button type="button" key={m.id} onClick={() => { setItem(m); setQty(1) }} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2">
                          <span className="min-w-0"><span className="block truncate text-ink">{m.name}{m.high_alert && <Badge tone="red" className="ml-1">High alert</Badge>}</span><span className="text-xs text-ink-3">{m.generic} · {m.packing}{m.schedule && m.schedule !== 'None' ? ` · Sch ${m.schedule}` : ''}</span></span>
                          <span className={cn('shrink-0 text-xs', (m.available ?? 0) > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600')}>{m.available ?? 0} in stock</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </FieldWrap>
            <FieldWrap label="Available qty"><div className="h-9 rounded-lg bg-surface-2 px-3 py-2 text-sm tabular-nums">{item ? item.available ?? 0 : 0}</div></FieldWrap>
            <FieldWrap label="Packing"><div className="h-9 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs">{item?.packing ?? '—'}</div></FieldWrap>
            <FieldWrap label="Required qty"><Input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></FieldWrap>
            <Button icon="Plus" disabled={!item} onClick={() => { if (item) { add(item, qty); setItem(null); setQ('') } }}>Add</Button>
          </div>
          {cart.length > 0 && (
            <div className="mt-3 space-y-2">
              <Table head={['Medicine', 'Packing', 'Available', 'Qty', '']}>
                {cart.map((c, i) => (
                  <tr key={c.m.id} className="border-t border-line">
                    <td className={td}>{c.m.name}<div className="text-xs text-ink-3">{c.m.generic}</div></td><td className={`${td} text-xs`}>{c.m.packing}</td>
                    <td className={td}><span className={(c.m.available ?? 0) < c.qty ? 'text-red-600' : ''}>{c.m.available ?? 0}</span></td>
                    <td className={td}><Input type="number" min={1} className="h-8 w-20" value={c.qty} onChange={(e) => setCart(cart.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))} /></td>
                    <td className={`${td} text-right`}><button type="button" aria-label="Remove" className="text-ink-3 hover:text-red-600" onClick={() => setCart(cart.filter((_, j) => j !== i))}><Icon name="X" className="size-4" /></button></td>
                  </tr>
                ))}
              </Table>
              {alerts && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm dark:border-red-500/40 dark:bg-red-500/10">
                  <div className="mb-1 font-semibold text-red-800 dark:text-red-200">Safety alerts</div>
                  <ul className="space-y-0.5 text-red-800 dark:text-red-200">{alerts.map((a, i) => <li key={i}>[{a.severity}] {a.message}{a.blocking ? ' — blocked' : ''}</li>)}</ul>
                  {!blocking && <FieldWrap label="Override reason (prescriber informed)" className="mt-2"><Input value={override} onChange={(e) => setOverride(e.target.value)} /></FieldWrap>}
                </div>
              )}
              <div className="flex items-end gap-2">
                <FieldWrap label="Remarks" className="flex-1"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></FieldWrap>
                <Button variant="primary" icon="Send" loading={raise.isPending} disabled={!!blocking || (!!alerts && override.trim().length < 5)} onClick={() => raise.mutate()}>Raise indent ({cart.length})</Button>
              </div>
            </div>
          )}
        </Section>
      )}
      <Section id="indent-summary" title="Indent summary & orders" icon="ListOrdered" tone="teal" pad={false}>
        {indents.isLoading ? <Spinner /> : !indents.data?.rows.length ? <Empty icon="Pill" title="No indents raised on this stay" /> : (
          <Table head={['Indent', 'Items', 'Raised', 'Status', '']}>
            {indents.data.rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className={td}><span className="font-mono text-xs font-medium">{r.code}</span><div className="text-xs text-ink-3">{r.category} · {r.store}</div></td>
                <td className={td}>{r.items.map((i) => <div key={i.name} className="text-xs">{i.name} × {i.qty}{i.issued_qty != null ? <span className="text-ink-3"> (issued {i.issued_qty})</span> : ''}</div>)}</td>
                <td className={`${td} text-xs`}>{r.raised_by}<div className="text-ink-3">{dateTime(r.raised_at)}</div></td>
                <td className={td}><Badge tone={r.status === 'Raised' ? 'amber' : r.status === 'Cancelled' ? 'gray' : 'green'}>{r.status}</Badge>{r.voided_by && <div className="text-xs text-red-600">by {r.voided_by}: {r.void_reason}</div>}</td>
                <td className={`${td} text-right`}>{r.can_cancel && <Button size="xs" variant="ghost" className="text-red-600" onClick={() => setCancelling(r)}>Cancel</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section title="Medicines on this stay" icon="Pill" tone="pink" subtitle="Everything given or billed to this admission — ward indents, IP pharmacy direct billing, the pharmacy counter and returns."
        actions={<div className="relative w-56"><Icon name="Search" className="pointer-events-none absolute left-2 top-2 size-4 text-ink-3" /><Input className="h-8 pl-7 text-xs" value={lq} onChange={(e) => setLq(e.target.value)} placeholder="Search medicine or code…" /></div>} pad={false}>
        {ledger.isLoading ? <Spinner /> : ledger.error ? <div className="p-4"><ErrorBox error={ledger.error} /></div> : !ledgerRows.length ? <Empty icon="Pill" title="No medicines issued yet" /> : (
          <>
            <Table head={['Given / billed', 'Medicine', 'Batch', 'Qty', ...(p.money ? ['Amount'] : []), 'Source', 'Reference']}>
              {ledgerRows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className={`${td} whitespace-nowrap text-xs`}>{dateTime(r.at)}</td>
                  <td className={td}>{r.kind === 'return' ? 'Return: ' : ''}{r.medicine}{r.batch ? <span className="text-ink-3"> (Batch {r.batch})</span> : ''} <span className="text-xs text-ink-3">{r.item_code}</span>{r.kind === 'return' && <Badge tone="gray" className="ml-1">Returned</Badge>}</td>
                  <td className={`${td} text-xs`}>{r.batch ?? '—'}</td>
                  <td className={`${td} tabular-nums`}>{Math.abs(r.qty)}</td>
                  {p.money && <td className={`${td} text-right`}><Amount v={r.amount} /></td>}
                  <td className={td}><Badge tone={r.kind === 'indent' ? 'blue' : r.kind === 'direct' ? 'amber' : r.kind === 'counter' ? 'violet' : 'gray'}>{r.source}</Badge></td>
                  <td className={`${td} text-xs`}>{r.reference ?? '—'}<div className="text-ink-3">{r.store}</div></td>
                </tr>
              ))}
            </Table>
            {p.money && ledger.data?.totals && <div className="border-t border-line px-4 py-2 text-right text-xs text-ink-2">Issued {money(ledger.data.totals.issued)} · Returned {money(ledger.data.totals.returned)} · <b className="text-ink">Net {money(ledger.data.totals.net)}</b></div>}
          </>
        )}
      </Section>
      {advisedOpen && (
        <Modal open size="lg" onClose={() => setAdvisedOpen(false)} title="Doctor's advised medications" footer={<Button onClick={() => setAdvisedOpen(false)}>Done</Button>}>
          {advised.isLoading ? <Spinner /> : !advised.data?.rows.length ? <Empty icon="Pill" title="No active prescriptions for this patient" /> : (
            <Table head={['Medicine', 'Dose', 'Available', '']}>
              {advised.data.rows.map((m) => (
                <tr key={m.id + (m.prescription ?? '')} className="border-t border-line">
                  <td className={td}>{m.name}<div className="text-xs text-ink-3">{m.prescription}</div></td>
                  <td className={`${td} text-xs`}>{[m.dose, m.route, m.frequency, m.duration_days ? `${m.duration_days}d` : null].filter(Boolean).join(' · ')}</td>
                  <td className={td}>{m.available ?? 0}</td>
                  <td className={`${td} text-right`}><Button size="xs" icon="Plus" onClick={() => { add(m, m.suggested_qty || 1); toast.success(`${m.name} added to the indent`) }}>Add</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Modal>
      )}
      <ReasonDialog open={!!cancelling} title={`Cancel indent ${cancelling?.code ?? ''}`} confirm="Cancel indent" busy={cancel.isPending} onClose={() => setCancelling(null)}
        onConfirm={(reason) => cancelling && cancel.mutate({ id: cancelling.id, reason })} />
    </div>
  )
}

// ================================================================== pharmacy return

interface Returnable { dispense_id: string; dispense: string; store: string; dispensed_at: string; item_id: string; name: string; batch?: string | null; dispensed_qty: number; returnable_qty: number; rate?: number }
export function PharmacyReturnPage({ h }: Props) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const q = useQuery({ queryKey: K.returnable(aid), queryFn: () => api<{ rows: Returnable[]; returns: { id: string; code: string; status: string; reason: string; at: string; items: number; refund_amount?: number }[]; reasons: string[] }>(`/ipchart/admissions/${aid}/returnable`) })
  const [sel, setSel] = useState<Record<string, number>>({})
  const [reason, setReason] = useState('Discharge — unused medicines')
  const key = (r: Returnable) => `${r.dispense_id}|${r.item_id}|${r.batch ?? ''}`
  const byDispense = useMemo(() => {
    const m = new Map<string, Returnable[]>()
    for (const r of q.data?.rows ?? []) m.set(r.dispense_id, [...(m.get(r.dispense_id) ?? []), r])
    return m
  }, [q.data])
  const go = useMutation({
    mutationFn: async () => {
      const out: string[] = []
      for (const [did, rows] of byDispense) {
        const items = rows.filter((r) => (sel[key(r)] ?? 0) > 0).map((r) => ({ item_id: r.item_id, batch: r.batch, qty: sel[key(r)] }))
        if (items.length) out.push((await api<{ code: string }>(`/ipchart/admissions/${aid}/returns`, { method: 'POST', body: { dispense_id: did, items, reason } })).code)
      }
      return out
    },
    onSuccess: (codes) => { toast.success(`Return ${codes.join(', ')} sent to the pharmacy for acceptance`); setSel({}); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  const any = Object.values(sel).some((v) => v > 0)
  return (
    <div className="space-y-4">
      <Section title="Pharmacy return" icon="Undo2" tone="amber" subtitle="Return unused medicines dispensed on this stay; the pharmacist accepts, restocks the batch and credits the bill.">
        {q.isLoading ? <Spinner /> : !q.data?.rows.length ? <Empty icon="Undo2" title="Nothing returnable">Only medicines dispensed against this admission can be returned here. Ward-indent stock is returned at the IP pharmacy counter.</Empty> : (
          <>
            <Table head={['Medicine', 'Dispense', 'Batch', 'Dispensed', 'Returnable', 'Return qty']}>
              {q.data.rows.map((r) => (
                <tr key={key(r)} className="border-t border-line">
                  <td className={td}>{r.name}</td><td className={`${td} text-xs`}>{r.dispense} · {r.store}</td><td className={`${td} text-xs`}>{r.batch ?? '—'}</td>
                  <td className={td}>{r.dispensed_qty}</td><td className={td}>{r.returnable_qty}</td>
                  <td className={td}><Input type="number" min={0} max={r.returnable_qty} className="h-8 w-20" value={sel[key(r)] ?? ''} onChange={(e) => setSel({ ...sel, [key(r)]: Math.min(r.returnable_qty, Math.max(0, Number(e.target.value) || 0)) })} /></td>
                </tr>
              ))}
            </Table>
            {h.permissions.pharmacy_return && isOpen(h) && (
              <div className="mt-3 flex flex-wrap items-end justify-end gap-2">
                <FieldWrap label="Reason" className="w-72"><Select value={reason} onChange={(e) => setReason(e.target.value)}>{q.data.reasons.map((r) => <option key={r}>{r}</option>)}</Select></FieldWrap>
                <Button variant="primary" disabled={!any} loading={go.isPending} onClick={() => go.mutate()}>Send return</Button>
              </div>
            )}
          </>
        )}
      </Section>
      {!!q.data?.returns.length && (
        <Section title="Returns on this stay" icon="History" tone="blue" pad={false}>
          <Table head={['Return', 'Reason', 'Items', ...(h.permissions.money ? ['Refund'] : []), 'Status']}>
            {q.data.returns.map((r) => <tr key={r.id} className="border-t border-line"><td className={`${td} font-mono text-xs`}>{r.code}<div className="font-sans text-ink-3">{dateTime(r.at)}</div></td><td className={td}>{r.reason}</td><td className={td}>{r.items}</td>{h.permissions.money && <td className={td}><Amount v={r.refund_amount} /></td>}<td className={td}><Badge tone={r.status === 'Accepted' ? 'green' : r.status === 'Rejected' ? 'red' : 'amber'}>{r.status}</Badge></td></tr>)}
          </Table>
        </Section>
      )}
    </div>
  )
}

// ================================================================== procedure / grade charges

function ChargesTable({ h, rows, onVoid }: { h: ChartHeader; rows: ChargeRow[]; onVoid?: (c: ChargeRow) => void }) {
  if (!rows.length) return <Empty icon="Receipt" title="Nothing charged yet" />
  return (
    <Table head={['Date & time', 'Procedure / service', 'Type', 'Qty', ...(h.permissions.money ? ['Amount'] : []), 'Status', 'Entered by', '']}>
      {rows.map((c) => (
        <tr key={c.id} className={cn('border-t border-line', c.status === 'Cancelled' && 'opacity-70')}>
          <td className={`${td} whitespace-nowrap text-xs`}>{dateTime(c.at)}</td>
          <td className={td}><span className={cn(c.status === 'Cancelled' && 'line-through')}>{c.description}</span>{c.performed_by && <div className="text-xs text-ink-3">by {c.performed_by}</div>}
            {c.voided_by && <div className="text-xs text-red-600">Voided by {c.voided_by} · {dateTime(c.voided_at)} — {c.void_reason}</div>}</td>
          <td className={`${td} text-xs`}>{c.type}{c.grade ? ` · ${c.grade}` : ''}</td>
          <td className={td}>{c.qty}</td>
          {h.permissions.money && <td className={`${td} text-right`}><Amount v={c.amount} /></td>}
          <td className={td}><Badge tone={c.status === 'Cancelled' ? 'gray' : c.status === 'Billed' ? 'blue' : 'green'}>{c.status}</Badge></td>
          <td className={`${td} text-xs`}>{c.entered_by}</td>
          <td className={`${td} text-right`}>{onVoid && c.can_void && isOpen(h) && <Button size="xs" variant="ghost" className="text-red-600" onClick={() => onVoid(c)}>Void</Button>}</td>
        </tr>
      ))}
    </Table>
  )
}

export function ChargePage({ h, kind }: Props & { kind: 'procedure' | 'grade' }) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const p = h.permissions
  const list = useQuery({ queryKey: K.charges(aid), queryFn: () => api<{ rows: ChargeRow[]; total?: number }>(`/ipchart/admissions/${aid}/charges`) })
  const doctors = useQuery({ queryKey: ['x', 'ipd', 'admission-form'], queryFn: () => api<{ doctors: { id: string; name: string; department?: string | null }[] }>('/ipchart/admission-form'), enabled: kind === 'grade', staleTime: 60_000 })
  const [svc, setSvc] = useState<Service | null>(null)
  const [qty, setQty] = useState(1)
  const [grade, setGrade] = useState('')
  const [doctor, setDoctor] = useState<string | null>(null)
  const [at, setAt] = useState('')
  const [remarks, setRemarks] = useState('')
  const [voiding, setVoiding] = useState<ChargeRow | null>(null)
  const autoGrade = h.bed?.category && ['ICU', 'HDU', 'NICU', 'PICU'].includes(h.bed.category) ? 'ICU' : h.bed?.category && ['Semi-Private', 'Private', 'Deluxe', 'Suite'].includes(h.bed.category) ? 'Private' : 'General'
  const g = grade || autoGrade
  const rateFor = (s: Service | null) => !s ? null : g === 'Private' ? s.rate_private ?? s.rate : g === 'ICU' ? s.rate_icu ?? s.rate : g === 'International' ? s.rate_international ?? s.rate : s.rate
  const go = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${aid}/charges`, { method: 'POST', body: { kind, service_id: svc!.id, qty, grade: kind === 'grade' ? g : null, doctor_id: doctor, performed_at: at || null, remarks: remarks || null } }),
    onSuccess: () => { toast.success(kind === 'grade' ? 'Grade charge posted' : 'Procedure charged'); setSvc(null); setQty(1); setRemarks(''); setDoctor(null); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  const voidIt = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/ipchart/admissions/${aid}/void`, { method: 'POST', body: { target: 'charge', id, reason } }),
    onSuccess: () => { toast.success('Charge voided'); setVoiding(null); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  const rows = (list.data?.rows ?? []).filter((r) => kind === 'grade' ? r.type === 'Visit / grade' : r.type !== 'Visit / grade')
  return (
    <div className="space-y-4">
      {p.charge && isOpen(h) && (
        <Section title={kind === 'grade' ? 'Grade billing' : 'Add procedure / service charge'} icon={kind === 'grade' ? 'Layers' : 'Scissors'} tone="violet"
          subtitle={kind === 'grade' ? `Visits and services billed at the patient's tariff grade — bed ${h.bed?.bed_no ?? ''} (${h.bed?.category ?? '—'}) → ${autoGrade} grade by default.` : 'Bedside procedures, OT / ICU heads and packages charged to this stay.'}>
          <div className="grid items-end gap-2 lg:grid-cols-[minmax(0,1fr)_5rem_auto_auto]">
            <FieldWrap label="Service"><ServicePicker kind={kind === 'grade' ? 'grade' : 'procedure'} value={svc} onPick={setSvc} placeholder={kind === 'grade' ? 'Search visit / service head…' : 'Search procedure or service…'} /></FieldWrap>
            <FieldWrap label="Qty"><Input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></FieldWrap>
            {kind === 'grade' ? <FieldWrap label="Grade"><Select value={g} onChange={(e) => setGrade(e.target.value)}>{['General', 'Private', 'ICU', 'International'].map((x) => <option key={x}>{x}</option>)}</Select></FieldWrap> : <span />}
            {p.money && svc ? <div className="pb-2 text-sm text-ink-2">{money(rateFor(svc) ?? 0)} × {qty} = <b className="text-ink">{money((rateFor(svc) ?? 0) * qty)}</b></div> : <span />}
          </div>
          <div className="mt-2 grid items-end gap-2 lg:grid-cols-[minmax(0,1fr)_13rem_minmax(0,1fr)_auto]">
            <FieldWrap label={kind === 'grade' ? 'Visiting doctor' : 'Performed by'}><SearchSelect options={(doctors.data?.doctors ?? []).map((d) => ({ value: d.id, label: d.name, hint: d.department ?? undefined }))} value={doctor} onChange={setDoctor} placeholder="Optional" /></FieldWrap>
            <FieldWrap label="Done at"><Input type="datetime-local" max={nowLocal()} value={at} onChange={(e) => setAt(e.target.value)} /></FieldWrap>
            <FieldWrap label="Remarks"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></FieldWrap>
            <Button variant="primary" disabled={!svc} loading={go.isPending} onClick={() => go.mutate()}>Post charge</Button>
          </div>
        </Section>
      )}
      <Section title={kind === 'grade' ? 'Grade charges on this stay' : 'Procedures & services on this stay'} icon="Receipt" tone="blue" pad={false}
        actions={p.money && list.data?.total != null ? <span className="text-xs text-ink-2">Total live charges <b className="text-ink">{money(list.data.total)}</b></span> : undefined}>
        {list.isLoading ? <Spinner /> : <ChargesTable h={h} rows={rows} onVoid={p.void_charge ? setVoiding : undefined} />}
      </Section>
      <ReasonDialog open={!!voiding} title={`Void ${voiding?.description ?? ''}`} confirm="Void charge" busy={voidIt.isPending} onClose={() => setVoiding(null)} onConfirm={(r) => voiding && voidIt.mutate({ id: voiding.id, reason: r })} />
    </div>
  )
}

// ================================================================== equipment

interface Usage { id: string; code: string; name: string; tag?: string; type?: string; billing_rule: string; connected_at: string; disconnected_at?: string; connected_by?: string; disconnected_by?: string; units?: number; hours?: number; status: string; remarks?: string; running_units?: number; running_hours?: number; running_amount?: number; rate?: number; amount?: number; voided_by?: string; void_reason?: string }
interface EquipData { active: Usage[]; history: Usage[]; available: { id: string; name: string; tag?: string; type?: string; billing_rule: string; rate?: number }[]; configured: number }

export function EquipmentPage({ h }: Props) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const p = h.permissions
  const q = useQuery({ queryKey: K.equipment(aid), queryFn: () => api<EquipData>(`/ipchart/admissions/${aid}/equipment`), refetchInterval: 60_000 })
  const [connect, setConnect] = useState(false)
  const [manual, setManual] = useState(false)
  const [voiding, setVoiding] = useState<Usage | null>(null)
  const disconnect = useMutation({
    mutationFn: (u: Usage) => api<{ units: number; amount?: number }>(`/ipchart/equipment-usage/${u.id}/disconnect`, { method: 'POST', body: {} }),
    onSuccess: (r, u) => { toast.success(`${u.name} disconnected · ${r.units} unit(s)${r.amount != null ? ` · ${money(r.amount)} charged` : ' charged'}`); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  const voidIt = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/ipchart/admissions/${aid}/void`, { method: 'POST', body: { target: 'usage', id, reason } }),
    onSuccess: () => { toast.success('Equipment usage voided'); setVoiding(null); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  const d = q.data
  return (
    <div className="space-y-4">
      <Section title="Equipment on this patient" icon="PlugZap" tone="indigo" subtitle="Connect a machine (scan its tag); on disconnect the charge posts by the machine's rule."
        actions={p.equipment && isOpen(h) ? <Button variant="primary" size="sm" icon="Power" onClick={() => setConnect(true)}>Connect equipment</Button> : undefined}>
        {q.isLoading ? <Spinner /> : !d?.active.length ? <p className="text-sm text-ink-3">No equipment on this patient right now.</p> : (
          <Table head={['Equipment', 'Connected', 'Rule', 'Running', '']}>
            {d.active.map((u) => (
              <tr key={u.id} className="border-t border-line">
                <td className={td}><span className="font-medium text-ink">{u.name}</span><div className="text-xs text-ink-3">{u.tag} · {u.type}{u.remarks ? ` · ${u.remarks}` : ''}</div></td>
                <td className={`${td} text-xs`}>{dateTime(u.connected_at)}<div className="text-ink-3">{u.connected_by}</div></td>
                <td className={`${td} text-xs`}>{u.billing_rule}{p.money && u.rate != null ? ` · ${money(u.rate)}` : ''}</td>
                <td className={`${td} text-xs`}>{u.running_hours} h · {u.running_units} unit(s){p.money && u.running_amount != null ? ` · ${money(u.running_amount)}` : ''}</td>
                <td className={`${td} whitespace-nowrap text-right`}>
                  {p.equipment && <Button size="xs" variant="warning" loading={disconnect.isPending && disconnect.variables?.id === u.id} onClick={() => { if (confirm(`Disconnect ${u.name}? The usage charge posts now.`)) disconnect.mutate(u) }}>Disconnect</Button>}
                  {p.void_usage && <Button size="xs" variant="ghost" className="text-red-600" onClick={() => setVoiding(u)}>Void</Button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      {p.charge && isOpen(h) && (
        <div className="rounded-xl border border-line bg-surface">
          <button type="button" className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface-2" onClick={() => setManual(!manual)}><Icon name={manual ? 'ChevronDown' : 'ChevronRight'} className="size-4" />Manual equipment charge (for items not tracked as machines)</button>
          {manual && <ManualEquipment h={h} />}
        </div>
      )}
      {!!d?.history.length && (
        <Section title="Equipment history" icon="History" tone="blue" pad={false}>
          <Table head={['Equipment', 'Connected', 'Disconnected', 'Units', ...(p.money ? ['Amount'] : []), 'Status', '']}>
            {d.history.map((u) => (
              <tr key={u.id} className="border-t border-line">
                <td className={td}>{u.name}<div className="text-xs text-ink-3">{u.code} · {u.billing_rule}</div>{u.voided_by && <div className="text-xs text-red-600">Voided by {u.voided_by} — {u.void_reason}</div>}</td>
                <td className={`${td} text-xs`}>{dateTime(u.connected_at)}</td><td className={`${td} text-xs`}>{dateTime(u.disconnected_at)}<div className="text-ink-3">{u.disconnected_by}</div></td>
                <td className={td}>{u.units ?? '—'}{u.hours != null ? <span className="text-xs text-ink-3"> ({u.hours} h)</span> : ''}</td>
                {p.money && <td className={td}><Amount v={u.amount} /></td>}
                <td className={td}><Badge tone={u.status === 'Voided' ? 'gray' : 'green'}>{u.status === 'Disconnected' ? 'Charged' : u.status}</Badge></td>
                <td className={`${td} text-right`}>{p.void_usage && u.status === 'Disconnected' && <Button size="xs" variant="ghost" className="text-red-600" onClick={() => setVoiding(u)}>Void</Button>}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
      {connect && d && <ConnectModal aid={aid} d={d} money={p.money} onClose={() => setConnect(false)} />}
      <ReasonDialog open={!!voiding} title={`Void ${voiding?.name ?? ''} usage`} confirm="Void usage" busy={voidIt.isPending} onClose={() => setVoiding(null)} onConfirm={(r) => voiding && voidIt.mutate({ id: voiding.id, reason: r })} />
    </div>
  )
}

function ConnectModal({ aid, d, money: canMoney, onClose }: { aid: string; d: EquipData; money: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [tag, setTag] = useState('')
  const [eq, setEq] = useState<string | null>(null)
  const [at, setAt] = useState(nowLocal())
  const [remarks, setRemarks] = useState('')
  const go = useMutation({
    mutationFn: () => api<{ name: string }>(`/ipchart/admissions/${aid}/equipment/connect`, { method: 'POST', body: { equipment_id: eq, tag: eq ? null : tag || null, connected_at: at, remarks: remarks || null } }),
    onSuccess: (r) => { toast.success(`${r.name} connected`); chartScope(qc, aid); onClose() }, onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal open onClose={onClose} title="Connect equipment" footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" icon="Power" disabled={!eq && !tag.trim()} loading={go.isPending} onClick={() => go.mutate()}>Connect</Button></>}>
      {d.configured === 0 ? <p className="text-sm text-amber-700 dark:text-amber-300">No equipment types are set up yet — ask billing to add them under IPD › Billable Equipment.</p> : (
        <div className="grid gap-3">
          <FieldWrap label="Scan the machine tag" help="Or choose from the available machines below"><Input autoFocus value={tag} onChange={(e) => { setTag(e.target.value); setEq(null) }} onKeyDown={(e) => { if (e.key === 'Enter' && tag.trim()) go.mutate() }} placeholder="e.g. EQ-VENT-002" /></FieldWrap>
          <FieldWrap label="Equipment"><SearchSelect options={d.available.map((x) => ({ value: x.id, label: x.name, hint: [x.tag, x.type, x.billing_rule, canMoney && x.rate != null ? money(x.rate) : null].filter(Boolean).join(' · ') }))} value={eq} onChange={(v) => { setEq(v); setTag('') }} placeholder={d.available.length ? 'Choose an available machine' : 'All machines are in use'} /></FieldWrap>
          <FieldWrap label="Connected at"><Input type="datetime-local" max={nowLocal()} value={at} onChange={(e) => setAt(e.target.value)} /></FieldWrap>
          <FieldWrap label="Remarks"><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. settings, indication" /></FieldWrap>
        </div>
      )}
    </Modal>
  )
}

function ManualEquipment({ h }: Props) {
  const qc = useQueryClient()
  const aid = h.admission.id
  const [desc, setDesc] = useState('')
  const [qty, setQty] = useState(1)
  const [rate, setRate] = useState('')
  const go = useMutation({
    mutationFn: () => api(`/ipchart/admissions/${aid}/charges`, { method: 'POST', body: { kind: 'equipment', description: desc, qty, rate: Number(rate) } }),
    onSuccess: () => { toast.success('Equipment charge posted'); setDesc(''); setQty(1); setRate(''); chartScope(qc, aid) }, onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="grid items-end gap-2 border-t border-line px-4 py-3 sm:grid-cols-[minmax(0,1fr)_5rem_8rem_auto]">
      <FieldWrap label="Item"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Nebulizer (ward unit)" /></FieldWrap>
      <FieldWrap label="Qty"><Input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></FieldWrap>
      <FieldWrap label="Rate (₹)"><Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></FieldWrap>
      <Button variant="primary" disabled={!desc.trim() || rate === ''} loading={go.isPending} onClick={() => go.mutate()}>Post charge</Button>
    </div>
  )
}

// ================================================================== cancellations

export function CancellationsPage({ h }: Props) {
  const aid = h.admission.id
  const p = h.permissions
  const inv = useQuery({ queryKey: K.investigations(aid, 'investigations'), queryFn: () => api<InvData>(`/ipchart/admissions/${aid}/investigations`), enabled: p.tabs.investigations })
  const ch = useQuery({ queryKey: K.charges(aid), queryFn: () => api<{ rows: ChargeRow[] }>(`/ipchart/admissions/${aid}/charges`) })
  const voided = [
    ...(inv.data?.rows ?? []).filter((r) => r.stage === 'Cancelled').map((r) => ({ id: r.id, what: r.test, kind: 'Investigation', by: r.voided_by, at: r.voided_at, reason: r.void_reason })),
    ...(ch.data?.rows ?? []).filter((r) => r.status === 'Cancelled').map((r) => ({ id: r.id, what: r.description, kind: r.type, by: r.voided_by, at: r.voided_at, reason: r.void_reason })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return (
    <div className="space-y-4">
      <Section title="Cancellations & voids" icon="Ban" tone="pink" subtitle="Void a live order or charge from its own page (Investigations, Add procedure, Equipment, Order medication). Every void keeps who, when and why." pad={false}>
        {inv.isLoading || ch.isLoading ? <Spinner /> : !voided.length ? <Empty icon="Ban" title="Nothing has been cancelled on this stay" /> : (
          <Table head={['What', 'Type', 'Voided by', 'When', 'Reason']}>
            {voided.map((v) => <tr key={v.id} className="border-t border-line"><td className={td}>{v.what}</td><td className={`${td} text-xs`}>{v.kind}</td><td className={td}>{v.by ?? '—'}</td><td className={`${td} text-xs`}>{dateTime(v.at)}</td><td className={`${td} text-xs`}>{v.reason ?? '—'}</td></tr>)}
          </Table>
        )}
      </Section>
    </div>
  )
}
