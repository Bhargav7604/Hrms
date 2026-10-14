import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Empty, FieldWrap, Input, Kbd, Modal, Segmented, Select, Spinner, Textarea } from '@/components/ui'
import { RefPicker, useDebounced } from '@/components/fields'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { date, dateTime, money } from '@/lib/format'
import { BillPrint, PaymentLines, toPayments, type Bill, type PayLine } from './common'
import { PharmShell } from './shell'

interface Batch { batch: string | null; expiry?: string | null; days_left?: number | null; qty: number; mrp?: number | null }
interface Item {
  id: string; code: string; name: string; generic?: string | null; strength?: string | null; form?: string | null; type?: string | null; uom?: string | null
  schedule: string; high_alert: boolean; gst_percent: number; mrp?: number | null; pack_size: number; available: number; batches: Batch[]
  margin_percent?: number | null; max_discount_percent: number; default_discount_percent: number
}
interface Line { key: string; item: Item; qty: string; unit: 'Unit' | 'Strip'; batch: string; discount: string }
interface QuoteLine { line: number; item_id: string; batch?: string | null; expiry?: string | null; qty: number; strips?: number | null; mrp: number; gross: number
  discount_percent: number; max_discount_percent: number; discount: number; gst_percent: number; taxable: number; gst: number; amount: number; rule?: string | null }
interface Alert { type: string; label: string; severity: string; item: string; message: string; blocking?: boolean }
interface Quote {
  lines: QuoteLine[]; problems: { line: number; item: string; message: string; blocking: boolean }[]; alerts: Alert[]; blocking: { message: string }[]
  requires_override: boolean; copay: number; org_payable: number
  totals: { gross: number; discount: number; taxable: number; cgst: number; sgst: number; gst: number; round_off: number; net: number; items: number }
  prescription?: { code: string; items: { item_id: string; qty?: number | null }[] } | null
}
interface Config {
  credit_orgs: { id: string; name: string; org_type?: string; discount_percent?: number; copay_percent?: number; credit_limit?: number | null }[]
  shift: { id: string; code: string; counter: string; opened_at: string } | null; can_sell: boolean; return_days: number
}
type SaleType = 'Walk-in (OTC)' | 'Prescription' | 'Credit'

let seq = 0
const newKey = () => `l${++seq}`

export default function PharmacyCounter() {
  const qc = useQueryClient()
  const meta = useMeta()
  const [params, setParams] = useSearchParams()
  const cfg = useQuery({ queryKey: ['x', 'pharmacy', 'counter-config'], queryFn: () => api<Config>('/op-pharmacy/config') })
  const [saleType, setSaleType] = useState<SaleType>('Walk-in (OTC)')
  const [patient, setPatient] = useState<string | null>(null)
  const [rx, setRx] = useState('')
  const [org, setOrg] = useState('')
  const [customer, setCustomer] = useState('')
  const [phone, setPhone] = useState('')
  const [doctor, setDoctor] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [pays, setPays] = useState<PayLine[]>([{ mode: 'CASH', amount: '', reference: '' }])
  const [tendered, setTendered] = useState('')
  const [override, setOverride] = useState('')
  const [counselled, setCounselled] = useState(false)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [done, setDone] = useState<Bill | null>(null)
  const [printing, setPrinting] = useState<Bill | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const body = useMemo(() => ({
    patient_id: patient ?? undefined, prescription_id: rx || undefined, sale_type: saleType, credit_org: saleType === 'Credit' ? org || undefined : undefined,
    customer_name: customer.trim() || undefined, customer_phone: phone.trim() || undefined, doctor_name: doctor.trim() || undefined,
    items: lines.filter((l) => Number(l.qty) > 0).map((l) => ({ item_id: l.item.id, qty: Number(l.qty), unit: l.unit, pack_size: l.item.pack_size,
      batch: l.batch || undefined, discount_percent: l.discount === '' ? undefined : Number(l.discount) })),
  }), [patient, rx, saleType, org, customer, phone, doctor, lines])
  const dbody = useDebounced(body, 350)
  const ready = dbody.items.length > 0 && !(saleType === 'Credit' && (!org || !patient)) && !(saleType === 'Prescription' && !rx && !doctor.trim())
  const quote = useQuery({
    queryKey: ['x', 'pharmacy', 'quote', dbody],
    queryFn: () => api<Quote>('/op-pharmacy/quote', { method: 'POST', body: dbody }),
    enabled: ready && !!cfg.data?.can_sell,
    placeholderData: (p) => p,
    retry: false,
  })
  const net = quote.data?.totals.net ?? 0
  const payNow = saleType === 'Credit' ? quote.data?.copay ?? 0 : net
  useEffect(() => { setPays((cur) => (cur.length === 1 && cur[0].mode === 'CASH' ? [{ ...cur[0], amount: payNow ? payNow.toFixed(2) : '' }] : cur)) }, [payNow])

  const rxs = useQuery({
    queryKey: ['x', 'pharmacy', 'patient-rx', patient],
    queryFn: () => api<{ rows: { id: string; code: string; status: string; prescribed_at?: string; diagnosis?: string; items: { drug?: string; qty?: number }[] }[]; refs: Record<string, string> }>(
      '/m/opd/prescriptions', { query: { patient_id: patient, status: 'Active,Partially Dispensed', limit: 10 } }),
    enabled: !!patient,
  })

  // a parked draft or a prescription brought from the queue: ?draft=<bill id>
  useEffect(() => {
    const id = params.get('draft')
    if (!id) return
    api<Bill & { lines: (Bill['lines'][number])[] }>(`/op-pharmacy/bills/${id}`).then(async (b) => {
      if (b.status !== 'Draft') { toast.error(`${b.code} is ${b.status}`); return }
      const items = await Promise.all(b.lines.map((l) => api<{ rows: Item[] }>('/op-pharmacy/items', { query: { q: l.name, limit: 5 } }).then((r) => r.rows.find((x) => x.id === l.item))))
      setDraftId(b.id); setSaleType(b.sale_type as SaleType); setPatient(b.patient_id ?? null); setCustomer(b.customer_name ?? ''); setPhone(b.customer_phone ?? '')
      setDoctor(b.doctor_name ?? ''); setRx(b.prescription ?? ''); setOrg(b.credit_org ?? '')
      setLines(b.lines.flatMap((l, i) => items[i] ? [{ key: newKey(), item: items[i]!, qty: String(l.qty), unit: (l.unit as 'Unit' | 'Strip') ?? 'Unit', batch: l.batch ?? '', discount: l.discount_percent != null ? String(l.discount_percent) : '' }] : []))
      toast.message(`Draft ${b.code} loaded`)
    }).catch((e) => toast.error(errorMessage(e)))
    setParams({}, { replace: true })
  }, [params, setParams])

  const addItem = (it: Item) => {
    setLines((cur) => {
      const ex = cur.find((l) => l.item.id === it.id && !l.batch)
      if (ex) return cur.map((l) => (l === ex ? { ...l, qty: String(Number(l.qty) + 1) } : l))
      return [...cur, { key: newKey(), item: it, qty: '1', unit: it.pack_size > 1 ? 'Strip' : 'Unit', batch: '', discount: '' }]
    })
  }
  const loadRx = (id: string) => {
    setRx(id)
    const r = rxs.data?.rows.find((x) => x.id === id)
    if (!r) return
    setSaleType('Prescription')
    Promise.all((r.items ?? []).filter((x) => x.drug).map(async (x) => {
      const res = await api<{ rows: Item[] }>('/op-pharmacy/items', { query: { q: (rxs.data?.refs ?? {})[x.drug!] ?? '', limit: 10 } })
      const it = res.rows.find((y) => y.id === x.drug)
      return it ? { key: newKey(), item: it, qty: String(x.qty ?? 1), unit: 'Unit' as const, batch: '', discount: '' } : null
    })).then((ls) => setLines(ls.filter(Boolean) as Line[]))
  }
  const reset = useCallback(() => {
    setLines([]); setPatient(null); setRx(''); setOrg(''); setCustomer(''); setPhone(''); setDoctor(''); setOverride(''); setCounselled(false)
    setPays([{ mode: 'CASH', amount: '', reference: '' }]); setTendered(''); setDraftId(null); setSaleType('Walk-in (OTC)')
    setTimeout(() => searchRef.current?.focus(), 50)
  }, [])

  const bill = useMutation({
    mutationFn: (draft: boolean) => api<{ bill: Bill }>('/op-pharmacy/bills', {
      method: 'POST', body: { ...body, draft, draft_id: draftId ?? undefined, payments: draft ? [] : toPayments(pays), override_reason: override.trim() || undefined, counselled },
    }),
    onSuccess: (r, draft) => {
      qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] })
      if (draft) { toast.success(`Draft ${r.bill.code} saved`); reset(); return }
      setDone(r.bill)
      reset()
    },
    onError: (e) => toast.error(errorMessage(e), { duration: e instanceof ApiError && e.code === 'OVERRIDE_REQUIRED' ? 8000 : 5000 }),
  })

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'F9' && lines.length && !bill.isPending) { e.preventDefault(); bill.mutate(false) }
      if (e.key === 'F8' && lines.length && !bill.isPending) { e.preventDefault(); bill.mutate(true) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [lines.length, bill])

  const q = quote.data
  const byLine = (i: number) => (q?.lines ?? []).filter((x) => x.line === i + 1)
  const problem = (i: number) => (q?.problems ?? []).find((p) => p.line === i + 1)
  const blocking = q?.blocking ?? []
  const severe = (q?.alerts ?? []).filter((a) => ['Contraindicated', 'Major'].includes(a.severity) && !a.blocking)
  const paid = toPayments(pays).reduce((s, p) => s + p.amount, 0)
  const cash = toPayments(pays).filter((p) => p.mode === 'CASH').reduce((s, p) => s + p.amount, 0)
  const change = tendered ? Number(tendered) - cash : 0
  const orgRow = cfg.data?.credit_orgs.find((o) => o.id === org)

  if (cfg.isLoading) return <Spinner />
  const shift = cfg.data?.shift
  return (
    <PharmShell screen="counter" icon="ShoppingCart" title="Pharmacy billing"
      subtitle="OP pharmacy counter — walk-in, prescription and credit sales from the OP Pharmacy store, first-expiry-first-out."
      actions={(
        <div className="flex items-center gap-2 text-xs text-ink-2">
          {shift ? <Badge tone="green">{shift.counter} · open since {dateTime(shift.opened_at)}</Badge> : <Link to="/pharmacy/shift"><Badge tone="red">No open shift — open one to bill</Badge></Link>}
          <span className="hidden lg:inline"><Kbd>F2</Kbd> search · <Kbd>F8</Kbd> draft · <Kbd>F9</Kbd> bill</span>
        </div>
      )}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <Card pad>
            <div className="flex flex-wrap items-end gap-3">
              <FieldWrap label="Sale type">
                <Segmented value={saleType} onChange={(v) => { setSaleType(v); if (v !== 'Credit') setOrg('') }}
                  options={[{ key: 'Walk-in (OTC)', label: 'Walk-in' }, { key: 'Prescription', label: 'Prescription' }, { key: 'Credit', label: 'Credit' }]} />
              </FieldWrap>
              <FieldWrap label={saleType === 'Credit' ? 'Patient (required)' : 'Patient (optional)'} className="min-w-64 flex-1">
                <RefPicker refName="registration.patients" kind="patient" value={patient} onChange={(id, row) => { setPatient(id); setRx(''); if (row) { setCustomer(''); setPhone('') } }} placeholder="UHID / name / mobile" />
              </FieldWrap>
              {saleType === 'Credit' && (
                <FieldWrap label="Credit organisation" required>
                  <Select value={org} onChange={(e) => setOrg(e.target.value)} className="w-60"><option value="">Choose…</option>{cfg.data?.credit_orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
                </FieldWrap>
              )}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {!patient && <FieldWrap label="Customer name"><Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Walk-in customer" /></FieldWrap>}
              {!patient && <FieldWrap label="Mobile"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Needed for a due" /></FieldWrap>}
              {patient && (
                <FieldWrap label="Hospital prescription">
                  <Select value={rx} onChange={(e) => loadRx(e.target.value)}>
                    <option value="">{rxs.data?.rows.length ? 'Choose to load its medicines…' : 'No open prescription'}</option>
                    {rxs.data?.rows.map((r) => <option key={r.id} value={r.id}>{r.code} · {date(r.prescribed_at)}{r.diagnosis ? ` · ${r.diagnosis}` : ''} ({r.status})</option>)}
                  </Select>
                </FieldWrap>
              )}
              <FieldWrap label="Prescriber" help={saleType === 'Prescription' && !rx ? 'Required for an outside prescription' : undefined}>
                <Input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="Dr. name (outside prescription)" />
              </FieldWrap>
            </div>
            {orgRow && <p className="mt-2 text-xs text-ink-2">{orgRow.org_type} · agreed discount {orgRow.discount_percent ?? 0}% · patient co-pay {orgRow.copay_percent ?? 0}%{orgRow.credit_limit ? ` · limit ${money(orgRow.credit_limit, true)}` : ''}</p>}
          </Card>

          <ItemSearch inputRef={searchRef} onPick={addItem} disabled={!cfg.data?.can_sell} />

          <Card pad={false}>
            {lines.length === 0 ? <Empty icon="Pill" title="Search a medicine to start the bill">Brand, generic, item code or barcode. Tablets and capsules sell by strip or by unit.</Empty> : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-surface-2 text-xs text-ink-2">
                    <tr>{['Item', 'Batch', 'Qty', 'Disc %', 'MRP', 'GST', 'Amount', ''].map((h) => <th key={h} className="px-2.5 py-2 text-left font-medium">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const ql = byLine(i)
                      const p = problem(i)
                      const amount = ql.reduce((s, x) => s + x.amount, 0)
                      const units = ql.reduce((s, x) => s + x.qty, 0)
                      const set = (patch: Partial<Line>) => setLines((cur) => cur.map((x) => (x.key === l.key ? { ...x, ...patch } : x)))
                      return (
                        <tr key={l.key} className={cn('border-t border-line align-top', p && 'bg-red-50/70 dark:bg-red-500/5')}>
                          <td className="px-2.5 py-2">
                            <div className="font-medium text-ink">{l.item.name} {l.item.schedule !== 'None' && <Badge tone={['H1', 'X', 'Narcotic'].includes(l.item.schedule) ? 'red' : 'amber'}>Sch {l.item.schedule}</Badge>}</div>
                            <div className="text-xs text-ink-3">{l.item.generic}{l.item.strength ? ` · ${l.item.strength}` : ''} · stock {l.item.available} {l.item.uom}</div>
                            {p && <div className="text-xs font-medium text-red-700 dark:text-red-300">{p.message}</div>}
                            {ql.length > 1 && <div className="text-[11px] text-ink-3">FEFO split: {ql.map((x) => `${x.batch} ×${x.qty}`).join(', ')}</div>}
                          </td>
                          <td className="px-2.5 py-2">
                            <Select value={l.batch} onChange={(e) => set({ batch: e.target.value })} className="h-8 w-40 text-xs" aria-label="Batch">
                              <option value="">Auto (FEFO){ql[0] ? ` · ${ql[0].batch}` : ''}</option>
                              {l.item.batches.map((b) => <option key={b.batch ?? 'nb'} value={b.batch ?? ''}>{b.batch} · exp {b.expiry ? date(b.expiry) : '—'} · {b.qty}</option>)}
                            </Select>
                            {ql[0]?.expiry && <div className="mt-0.5 text-[11px] text-ink-3">Exp {date(ql[0].expiry)}</div>}
                          </td>
                          <td className="px-2.5 py-2">
                            <div className="flex items-center gap-1">
                              <Input type="number" min={1} className="h-8 w-16 tabular" value={l.qty} onChange={(e) => set({ qty: e.target.value })} aria-label="Quantity" />
                              {l.item.pack_size > 1 ? (
                                <Select value={l.unit} onChange={(e) => set({ unit: e.target.value as Line['unit'] })} className="h-8 w-24 text-xs" aria-label="Unit">
                                  <option value="Strip">Strip ({l.item.pack_size})</option><option value="Unit">{l.item.uom ?? 'Unit'}</option>
                                </Select>
                              ) : <span className="text-xs text-ink-3">{l.item.uom}</span>}
                            </div>
                            {units > 0 && l.unit === 'Strip' && <div className="mt-0.5 text-[11px] text-ink-3">{units} {l.item.uom}</div>}
                          </td>
                          <td className="px-2.5 py-2">
                            <Input type="number" min={0} max={ql[0]?.max_discount_percent ?? 0} step="0.5" className="h-8 w-20 tabular" value={l.discount}
                              placeholder={ql[0] ? String(ql[0].discount_percent) : '0'} onChange={(e) => set({ discount: e.target.value })} aria-label="Discount percent" />
                            {ql[0] && <div className="mt-0.5 text-[11px] text-ink-3">max {ql[0].max_discount_percent}%</div>}
                          </td>
                          <td className="px-2.5 py-2 tabular text-ink-2">{ql[0] ? money(ql[0].mrp) : money(l.item.mrp)}<div className="text-[11px] text-ink-3">/ {l.item.uom}</div></td>
                          <td className="px-2.5 py-2 tabular text-xs text-ink-2">{l.item.gst_percent}%</td>
                          <td className="px-2.5 py-2 tabular font-medium text-ink">{ql.length ? money(amount) : '—'}</td>
                          <td className="px-2.5 py-2"><button aria-label={`Remove ${l.item.name}`} className="text-ink-3 hover:text-red-600" onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}><Trash2 className="size-4" /></button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {q && q.alerts.length > 0 && (
            <Card title="Drug safety" pad>
              <ul className="space-y-1 text-sm">
                {q.alerts.map((a, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Badge tone={a.blocking || a.severity === 'Contraindicated' ? 'red' : a.severity === 'Major' ? 'amber' : 'gray'}>{a.blocking ? 'Blocked' : a.severity}</Badge>
                    <span className="text-ink">{a.message}</span>
                  </li>
                ))}
              </ul>
              {severe.length > 0 && blocking.length === 0 && (
                <FieldWrap label="Override reason" required className="mt-3" help="Serious alerts need a documented reason (recorded as a pharmacist intervention)">
                  <Textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="e.g. Prescriber confirmed; patient counselled on bleeding signs" />
                </FieldWrap>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-3 xl:sticky xl:top-20 xl:self-start">
          <Card title={draftId ? 'Bill (from draft)' : 'Bill'} pad>
            {quote.isFetching && !q && <Spinner />}
            <dl className="space-y-1 text-sm">
              {([['Gross (MRP)', q?.totals.gross], ['Discount', q ? -q.totals.discount : undefined], ['Taxable value', q?.totals.taxable], ['CGST', q?.totals.cgst], ['SGST', q?.totals.sgst], ['Round off', q?.totals.round_off]] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between text-ink-2"><dt>{k}</dt><dd className="tabular">{v == null ? '—' : money(v)}</dd></div>
              ))}
              <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold text-ink"><dt>Net payable</dt><dd className="tabular">{money(net)}</dd></div>
              {saleType === 'Credit' && q && <div className="flex justify-between text-sm text-ink-2"><dt>Co-pay now · {orgRow?.name} pays</dt><dd className="tabular">{money(q.copay)} · {money(q.org_payable)}</dd></div>}
            </dl>
            <div className="mt-3 border-t border-line pt-3">
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Payment</h4>
              <PaymentLines lines={pays} onChange={setPays} due={payNow} />
              <div className="mt-2 flex items-center gap-2">
                <Input type="number" min={0} className="h-8 w-28 tabular" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="Cash tendered" aria-label="Cash tendered" />
                {tendered && <span className={cn('text-sm tabular', change < 0 ? 'text-red-700 dark:text-red-300' : 'text-ink')}>{change < 0 ? `Short ${money(-change)}` : `Return ${money(change)}`}</span>}
              </div>
              {net - paid > 0.009 && saleType !== 'Credit' && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{money(net - paid)} will be kept as due{!patient && !phone.trim() ? ' — enter the mobile number' : ''}.</p>}
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4 accent-brand-700" checked={counselled} onChange={(e) => setCounselled(e.target.checked)} />Patient counselled on dosage</label>
            {blocking.length > 0 && <p className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white">{blocking[0].message}</p>}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button disabled={!lines.length || bill.isPending} loading={bill.isPending && bill.variables === true} onClick={() => bill.mutate(true)}>Save draft</Button>
              <Button variant="primary" icon="Printer" disabled={!lines.length || !q || blocking.length > 0 || !shift || (severe.length > 0 && override.trim().length < 5)}
                loading={bill.isPending && bill.variables === false} onClick={() => bill.mutate(false)}>Bill</Button>
            </div>
            {lines.length > 0 && <Button size="xs" variant="ghost" className="mt-2" onClick={reset}>Clear bill</Button>}
          </Card>
          <Link to="/pharmacy/bills?status=Draft" className="block text-center text-xs text-brand-700 hover:underline dark:text-brand-300">Parked drafts →</Link>
        </div>
      </div>

      {done && (
        <Modal open onClose={() => setDone(null)} size="sm" title={`Bill ${done.code} · ${done.status}`}
          footer={<><Button variant="ghost" onClick={() => setDone(null)}>New sale</Button><Button variant="primary" icon="Printer" onClick={() => { setPrinting(done); setDone(null) }}>Print bill</Button></>}>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-ink-2">Customer</dt><dd className="text-ink">{done.patient ?? done.customer_name}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Net</dt><dd className="font-semibold tabular text-ink">{money(done.net)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Paid</dt><dd className="tabular">{money(done.paid)}</dd></div>
            {done.due > 0 && <div className="flex justify-between text-amber-700 dark:text-amber-300"><dt>{done.credit_org_name ? `Billed to ${done.credit_org_name}` : 'Due'}</dt><dd className="tabular">{money(done.due)}</dd></div>}
          </dl>
        </Modal>
      )}
      {printing && <BillPrint bill={printing} hospital={meta.data?.hospital.name ?? ''} onDone={() => setPrinting(null)} />}
    </PharmShell>
  )
}

function ItemSearch({ onPick, inputRef, disabled }: { onPick: (it: Item) => void; inputRef: React.RefObject<HTMLInputElement | null>; disabled?: boolean }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 200)
  const [hi, setHi] = useState(0)
  const res = useQuery({ queryKey: ['x', 'pharmacy', 'items', dq], queryFn: () => api<{ rows: Item[] }>('/op-pharmacy/items', { query: { q: dq } }), enabled: dq.trim().length >= 2 })
  const rows = res.data?.rows ?? []
  useEffect(() => setHi(0), [dq])
  const pick = (it: Item) => {
    if (it.available <= 0) { toast.error(`${it.name} is out of stock in the OP pharmacy`); return }
    onPick(it); setQ('')
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-3 size-4 text-ink-3" />
      <Input ref={inputRef} autoFocus disabled={disabled} value={q} onChange={(e) => setQ(e.target.value)} className="h-10 pl-9 text-base" aria-label="Search medicine"
        placeholder="Search medicine — brand, generic, code or scan barcode  (F2)"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(rows.length - 1, h + 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)) }
          if (e.key === 'Enter' && rows[hi]) { e.preventDefault(); pick(rows[hi]) }
          if (e.key === 'Escape') setQ('')
        }} />
      {q.trim().length >= 2 && (
        <div className="absolute inset-x-0 top-11 z-30 max-h-96 overflow-y-auto rounded-xl border border-line bg-surface shadow-xl scroll-thin">
          {res.isLoading && <Spinner />}
          {res.data && rows.length === 0 && <p className="px-3 py-3 text-sm text-ink-3">No item matches “{q}”.</p>}
          {rows.map((it, i) => (
            <button key={it.id} onMouseEnter={() => setHi(i)} onClick={() => pick(it)}
              className={cn('flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-0', i === hi && 'bg-surface-2')}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">{it.name} {it.schedule !== 'None' && <Badge tone={['H1', 'X', 'Narcotic'].includes(it.schedule) ? 'red' : 'amber'}>Sch {it.schedule}</Badge>}{it.high_alert && <Badge tone="red" className="ml-1">High alert</Badge>}</span>
                <span className="block truncate text-xs text-ink-3">{it.generic}{it.strength ? ` · ${it.strength}` : ''}{it.form ? ` · ${it.form}` : ''} · {it.code}</span>
              </span>
              <span className="text-right text-xs">
                <span className={cn('block font-medium tabular', it.available > 0 ? 'text-ink' : 'text-red-700 dark:text-red-300')}>{it.available > 0 ? `${it.available} ${it.uom ?? ''}` : 'Out of stock'}</span>
                <span className="block text-ink-3">{money(it.mrp)}/{it.uom}{it.pack_size > 1 ? ` · strip ${money(Number(it.mrp ?? 0) * it.pack_size)}` : ''}</span>
                {it.batches[0]?.expiry && <span className={cn('block', (it.batches[0].days_left ?? 999) < 90 ? 'text-amber-700 dark:text-amber-300' : 'text-ink-3')}>exp {date(it.batches[0].expiry)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
