import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Lock, MoreHorizontal, Search, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Select, Spinner, StatusBadge, Tabs, Textarea } from '@/components/ui'
import { api } from '@/lib/api'
import { date, dateTime, money, todayISO } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { K, useBill, useBillMutation, type Bill, type Line } from './api'
import {
  AdminChargesModal, BreakdownModal, CostEstimateModal, FormatsModal, GstModal, IncludeModal, NoShowModal, PreauthModal,
  ReceiptModal, RefundModal, ReopenModal, SponsorModal, TermsModal, VoidModal, WardModal,
} from './BillModals'
import { DischargeWizard } from './DischargeWizard'
import {
  AdmissionPicker, Copyable, KeyHints, PatientAvatar, PrintPreview, Saving, ServiceSearch, Switch,
  type ServiceHit, type ServiceSearchHandle, PageGuard } from './ui'

type Tab = 'orders' | 'consultation' | 'package'
type ModalKey = 'formats' | 'sponsor' | 'ward' | 'receipt' | 'refund' | 'gst' | 'noshow' | 'admin' | 'breakdown' | 'terms'
  | 'reopen' | 'include' | 'preauth' | 'estimate' | 'discharge' | null

const GROUP_ICON: Record<string, string> = {
  INVESTIGATION: 'FlaskConical', PROCEDURE: 'Scissors', CONSULTATION: 'Stethoscope', 'ROOM & NURSING': 'BedDouble',
  PHARMACY: 'Pill', PACKAGE: 'Package', OTHER: 'Shapes',
}

/** IP Approximate Bill — the live, auto-saving working bill for one admission. */
export default function WorkingBill() {
  return <PageGuard page="ip-billing"><WorkingBillScreen /></PageGuard>
}

function WorkingBillScreen() {
  const { admissionId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const bill = useBill(admissionId)
  const [modal, setModal] = useState<ModalKey>(params.get('discharge') ? 'discharge' : null)
  const [print, setPrint] = useState<{ format: 'estimate' | 'final' | 'interim'; no?: string } | null>(null)
  const [tab, setTab] = useState<Tab>('orders')
  const search = useRef<ServiceSearchHandle>(null)
  const discountInput = useRef<HTMLInputElement>(null)
  const addRef = useRef<() => void>(() => undefined)
  const b = bill.data
  const perms = b?.permissions

  const approx = useBillMutation<void>(admissionId, () => api<{ no: string }>(`/ipbilling/admissions/${admissionId}/approx`, { method: 'POST' }), {
    success: (r) => `Approximate bill ${(r as { no: string }).no} generated`,
    onDone: (r) => setPrint({ format: 'estimate', no: (r as { no: string }).no }),
  })

  const openModal = useCallback((m: ModalKey) => setModal(m), [])
  useEffect(() => {
    if (!b) return
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); addRef.current(); return }
      if (!e.altKey) return
      const k = e.code
      if (k === 'Digit1') setTab('orders')
      else if (k === 'Digit2') setTab('consultation')
      else if (k === 'Digit3') setTab('package')
      else if (k === 'KeyS') { setTab('orders'); setTimeout(() => search.current?.focus(), 0) }
      else if (k === 'KeyP') setPrint({ format: 'estimate' })
      else if (k === 'KeyC' && b.permissions.collect) setModal('receipt')
      else if (k === 'KeyG' && b.permissions.approx) approx.mutate()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [b, approx])

  if (bill.isLoading) return <div className="space-y-3"><Header /><Spinner label="Loading patient…" /></div>
  if (bill.error) return <div className="space-y-3"><Header /><ErrorBox error={bill.error} /></div>
  if (!b || !perms) return null
  const a = b.admission
  const closeModal = () => {
    setModal(null)
    if (params.get('discharge')) { const p = new URLSearchParams(params); p.delete('discharge'); setParams(p, { replace: true }) }
  }

  return (
    <div className="space-y-4">
      <Header b={b} onDischarge={() => setModal('discharge')} onPick={(id) => nav(`/ip/billing/${id}`)} />
      <Notices b={b} onReopen={() => setModal('reopen')} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <PatientCard b={b} open={openModal} />
          {perms.edit ? (
            <Card pad={false}>
              <Tabs className="px-3" value={tab} onChange={setTab} tabs={[
                { key: 'orders', label: 'Orders', icon: 'ShoppingCart' },
                { key: 'consultation', label: 'Consultation', icon: 'Stethoscope' },
                { key: 'package', label: 'Package', icon: 'Package', count: b.packages.length || undefined },
              ]} />
              <div className="p-4">
                {tab === 'orders' && <AddCharge b={b} searchRef={search} addRef={addRef} />}
                {tab === 'consultation' && <AddConsultation b={b} addRef={addRef} />}
                {tab === 'package' && <PackageTab b={b} />}
                <div className="mt-3">
                  <KeyHints items={[['Ctrl+↵', 'add'], ['Alt+S', 'search'], ['Alt+1/2/3', 'Orders / Consultation / Package'], ['Alt+P', 'print estimate'],
                    ...(perms.collect ? [['Alt+C', 'collect payment'] as [string, string]] : []), ...(perms.approx ? [['Alt+G', 'generate bill'] as [string, string]] : [])]} />
                </div>
              </div>
            </Card>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-sm text-ink-2">
              <Lock className="size-4" />{perms.closed ? 'This bill is closed. Lines are shown as billed.' : 'View only — your role cannot change this bill.'}
            </div>
          )}
          <LinesTable b={b} open={openModal} />
        </div>
        <Rail b={b} open={openModal} focusDiscount={() => discountInput.current?.focus()} discountRef={discountInput}
          goTab={(t) => { setTab(t); if (t === 'orders') setTimeout(() => search.current?.focus(), 0) }} onPrint={(no) => setPrint({ format: 'estimate', no })} />
      </div>
      <BottomBar b={b} onPrint={() => setPrint({ format: 'estimate' })} onCollect={() => setModal('receipt')} onApprox={() => approx.mutate()}
        approxPending={approx.isPending} open={openModal} onPrintFormat={(f) => setPrint({ format: f })} />

      <FormatsModal open={modal === 'formats'} onClose={closeModal} b={b} />
      <SponsorModal open={modal === 'sponsor'} onClose={closeModal} b={b} />
      <WardModal open={modal === 'ward'} onClose={closeModal} b={b} />
      <ReceiptModal open={modal === 'receipt'} onClose={closeModal} b={b} />
      <RefundModal open={modal === 'refund'} onClose={closeModal} b={b} />
      <GstModal open={modal === 'gst'} onClose={closeModal} b={b} />
      <NoShowModal open={modal === 'noshow'} onClose={closeModal} b={b} />
      <AdminChargesModal open={modal === 'admin'} onClose={closeModal} b={b} />
      <BreakdownModal open={modal === 'breakdown'} onClose={closeModal} b={b} />
      <TermsModal open={modal === 'terms'} onClose={closeModal} b={b} />
      <ReopenModal open={modal === 'reopen'} onClose={closeModal} b={b} />
      <IncludeModal open={modal === 'include'} onClose={closeModal} b={b} />
      <PreauthModal open={modal === 'preauth'} onClose={closeModal} b={b} />
      <CostEstimateModal open={modal === 'estimate'} onClose={closeModal} b={b} />
      {modal === 'discharge' && <DischargeWizard admissionId={a.id} onClose={closeModal} onBackToBill={closeModal} />}
      {print && (
        <PrintPreview open onClose={() => setPrint(null)} admissionId={a.id} format={print.format} no={print.no}
          title={`${print.format === 'estimate' ? 'Approximate bill' : print.format === 'final' ? 'Final bill' : 'Interim receipt'} · ${b.patient.name}`} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ header & notices

function Header({ b, onDischarge, onPick }: { b?: Bill; onDischarge?: () => void; onPick?: (id: string) => void }) {
  const nav = useNavigate()
  const open = b && ['Admitted', 'Discharge Initiated'].includes(b.admission.status)
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <Button variant="ghost" size="sm" icon="ChevronLeft" aria-label="Back to IP bills" onClick={() => nav('/ip/billing')} />
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-300">
          <Icon name="FileSpreadsheet" className="size-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink">IP Approximate Bill</h1>
          <p className="text-sm text-ink-2">{!b ? 'Loading the working bill…' : open ? 'Live working bill for an admitted patient' : `Closed bill — ${b.admission.status.toLowerCase()} ${b.admission.discharged_at ? date(b.admission.discharged_at) : ''}`}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {b && open && (b.permissions.discharge || b.permissions.collect) && <Button icon="LogOut" onClick={onDischarge}>Discharge</Button>}
        {b && !open && <Link to="/ip/billing/discharge" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">Discharge desk</Link>}
        <AdmissionPicker value={b?.admission.id} label={b ? `${b.admission.ip_no} — ${b.patient.name}` : undefined} onPick={(r) => onPick?.(r.id)} />
      </div>
    </div>
  )
}

function Notices({ b, onReopen }: { b: Bill; onReopen: () => void }) {
  const out: ReactNode[] = []
  const bd = b.bill_discount
  if (bd.status === 'Pending') {
    out.push(<Notice key="bd" tone="amber" icon="Hourglass">Bill discount of {bd.mode === '%' ? `${bd.value}%` : money(bd.value)} ({money(b.totals.bill_discount_pending)}) is awaiting {bd.approval?.approver_role ?? 'management'} approval{bd.approval?.code ? ` · ${bd.approval.code}` : ''}. It is not applied until approved.
      {b.permissions.approve && <Link to="/m/workflow" className="ml-2 font-medium underline">Open approvals</Link>}</Notice>)
  }
  if (bd.status === 'Rejected') out.push(<Notice key="bdr" tone="red" icon="XCircle">Bill discount was rejected. {bd.reason}</Notice>)
  const st = b.state?.status
  if (st === 'Reopen Requested') out.push(<Notice key="rr" tone="amber" icon="Hourglass">Reopen requested — waiting for management approval. The bill stays closed until it is approved.</Notice>)
  if (st === 'Reopened') {
    out.push(<Notice key="ro" tone="blue" icon="Unlock">Bill reopened after discharge ({String(b.state?.reopen_reason ?? '')}). Make the corrections, then settle it from the bottom bar.</Notice>)
  }
  if (b.permissions.closed && b.permissions.reopen && st !== 'Reopen Requested') {
    out.push(<Notice key="cl" tone="gray" icon="Lock">The patient is discharged and the bill is settled.
      <button className="ml-2 font-medium text-brand-700 underline dark:text-brand-300" onClick={onReopen}>Reopen bill</button></Notice>)
  }
  const unpriced = b.lines.filter((l) => l.unpriced && l.status !== 'Billed').length
  if (unpriced) out.push(<Notice key="up" tone="amber" icon="AlertTriangle">{unpriced} line(s) have no tariff price — review the price before settlement.</Notice>)
  return out.length ? <div className="space-y-2">{out}</div> : null
}

function Notice({ tone, icon, children }: { tone: 'amber' | 'red' | 'blue' | 'gray'; icon: string; children: ReactNode }) {
  const cls = {
    amber: 'border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    red: 'border-red-300/60 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
    blue: 'border-sky-300/60 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
    gray: 'border-line bg-surface-2 text-ink-2',
  }[tone]
  return <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', cls)}><Icon name={icon} className="mt-0.5 size-4 shrink-0" /><div>{children}</div></div>
}

// ------------------------------------------------------------------ patient card + quick actions

function PatientCard({ b, open }: { b: Bill; open: (m: ModalKey) => void }) {
  const p = b.patient
  const a = b.admission
  const perms = b.permissions
  const sponsor = b.sponsor.sponsor_name ?? (b.sponsor.payer_type === 'Self' ? 'Self-pay' : b.sponsor.payer_type)
  const actions: { key: ModalKey; label: string; icon: string; cls: string; show: boolean }[] = [
    { key: 'receipt', label: 'Advance / receipt', icon: 'Wallet', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300', show: perms.collect },
    { key: 'ward', label: 'Change ward', icon: 'BedDouble', cls: 'bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300', show: perms.edit },
    { key: 'noshow', label: 'No-show items', icon: 'ListX', cls: 'bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300', show: perms.edit },
    { key: 'sponsor', label: 'Change Sponsor', icon: 'Building2', cls: 'bg-violet-50 text-violet-800 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300', show: perms.edit },
    { key: 'gst', label: 'GST posting', icon: 'Percent', cls: 'bg-indigo-50 text-indigo-800 ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-300', show: perms.edit },
    { key: 'refund', label: 'Refund', icon: 'Undo2', cls: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300', show: perms.refund },
    { key: 'admin', label: 'Post administration charges', icon: 'FilePlus2', cls: 'bg-teal-50 text-teal-800 ring-teal-600/20 dark:bg-teal-500/10 dark:text-teal-300', show: perms.edit },
  ]
  const allergies = p.allergies ?? []
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3">
        <PatientAvatar p={p} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/patients/${p.id}`} className="text-lg font-semibold text-ink hover:underline">{p.name}</Link>
            <StatusBadge status={a.status} />
            {allergies.length ? <Badge tone="red"><Icon name="AlertTriangle" className="size-3" />Allergies: {allergies.join(', ')}</Badge>
              : <Badge tone="amber"><Icon name="AlertTriangle" className="size-3" />No allergy recorded</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
            <Copyable value={a.ip_no} />
            <span>UHID <Copyable value={p.uhid} /></span>
            {p.phone && <span>{p.phone}</span>}
            {[p.age != null ? `${p.age}y` : null, p.gender].filter(Boolean).join(' / ')}
            <Badge tone={b.sponsor.payer_type === 'Self' ? 'gray' : 'violet'}>{b.sponsor.payer_type === 'Self' ? 'GENERAL' : b.sponsor.payer_type.toUpperCase()}</Badge>
            {b.ward_category && <Badge tone="violet">{b.ward_category.toUpperCase()}</Badge>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button type="button" onClick={() => open('formats')} className="inline-flex items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2">
          <Icon name="Printer" className="size-3.5" />View bill
        </button>
        {actions.filter((x) => x.show).map((x) => (
          <button key={x.key} type="button" onClick={() => open(x.key)} className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ring-inset hover:brightness-95', x.cls)}>
            <Icon name={x.icon} className="size-3.5" />{x.label}
          </button>
        ))}
      </div>
      <dl className="mt-4 grid gap-3 border-t border-line pt-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Info icon="BedDouble" label="Ward / bed" value={[a.ward?.name, a.bed?.bed_no && `Bed ${a.bed.bed_no}`].filter(Boolean).join(' · ') || '—'} />
        <Info icon="Stethoscope" label="Consultant" value={a.doctor ?? '—'} sub={a.department ?? undefined} />
        <Info icon="Building2" label="Organisation" value={sponsor} sub={b.sponsor.tariff ? `Tariff: ${b.sponsor.tariff.name}` : undefined} />
        <Info icon="CalendarDays" label="Admitted" value={date(a.admitted_at)} sub={`${a.los_days} day(s)${a.discharged_at ? ` · discharged ${date(a.discharged_at)}` : ''}`} />
      </dl>
    </Card>
  )
}

function Info({ icon, label, value, sub }: { icon: string; label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <div className="min-w-0">
        <dt className="text-xs text-ink-3">{label}</dt>
        <dd className="truncate font-medium text-ink">{value}</dd>
        {sub && <dd className="truncate text-xs text-ink-3">{sub}</dd>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ add charge (Orders / Consultation)

function useAdd(b: Bill, reset: () => void) {
  return useBillMutation<Record<string, unknown>>(b.admission.id, (body) => api(`/ipbilling/admissions/${b.admission.id}/lines`, { method: 'POST', body }), {
    success: 'Charge added', onDone: reset,
  })
}

function DiscountInput({ mode, value, onMode, onValue, id }: { mode: '₹' | '%'; value: string; onMode: (m: '₹' | '%') => void; onValue: (v: string) => void; id?: string }) {
  return (
    <div className="flex">
      <button type="button" onClick={() => onMode(mode === '₹' ? '%' : '₹')} aria-label={`Discount in ${mode === '₹' ? 'rupees' : 'percent'} — switch`}
        className="h-9 w-9 shrink-0 rounded-l-lg border border-r-0 border-line-2 bg-surface-2 text-sm font-medium text-ink-2 hover:text-ink">{mode}</button>
      <Input id={id} type="number" min={0} step="0.01" value={value} onChange={(e) => onValue(e.target.value)} className="rounded-l-none text-right tabular-nums" aria-label="Discount" />
    </div>
  )
}

function AddCharge({ b, searchRef, addRef }: { b: Bill; searchRef: React.RefObject<ServiceSearchHandle | null>; addRef: React.MutableRefObject<() => void> }) {
  const [svc, setSvc] = useState<ServiceHit | null>(null)
  const [day, setDay] = useState(todayISO())
  const [mode, setMode] = useState<'₹' | '%'>('₹')
  const [disc, setDisc] = useState('0')
  const [qty, setQty] = useState('1')
  const [rate, setRate] = useState('0')
  const reset = () => { setSvc(null); setDisc('0'); setQty('1'); setRate('0'); setTimeout(() => searchRef.current?.focus(), 0) }
  const m = useAdd(b, reset)
  const submit = useCallback(() => {
    if (!svc || m.isPending) return
    m.mutate({ service_id: svc.id, date: day, qty: Number(qty || 1), rate: Number(rate) !== svc.rate ? Number(rate) : undefined,
      disc_mode: mode, disc_value: Number(disc || 0), tab: 'orders' })
  }, [svc, day, qty, rate, mode, disc, m])
  useEffect(() => { addRef.current = submit }, [submit, addRef])
  const minDate = b.admission.admitted_at?.slice(0, 10)
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><Icon name="ShoppingCart" className="size-4 text-brand-700 dark:text-brand-400" />Orders</h3>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px] sm:items-end">
        <FieldWrap label="Orders / service"><ServiceSearch ref={searchRef} value={svc} onChange={(s) => { setSvc(s); if (s) setRate(String(s.rate)) }} onEnter={submit} /></FieldWrap>
        <FieldWrap label="Date"><Input type="date" value={day} min={minDate} max={todayISO()} onChange={(e) => setDay(e.target.value)} /></FieldWrap>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_80px_minmax(0,1fr)_auto] sm:items-end">
        <FieldWrap label="Discount"><DiscountInput mode={mode} value={disc} onMode={setMode} onValue={setDisc} /></FieldWrap>
        <FieldWrap label="Qty"><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} className="text-right tabular-nums" /></FieldWrap>
        <FieldWrap label="Rate" help={svc && Number(rate) !== svc.rate ? `Tariff ${money(svc.rate)} — manual price` : undefined}>
          <Input type="number" min={0} step="0.01" value={rate} disabled={!b.permissions.price} onChange={(e) => setRate(e.target.value)} className="text-right tabular-nums" />
        </FieldWrap>
        <Button variant="primary" icon="Plus" disabled={!svc} loading={m.isPending} onClick={submit}>Add charge</Button>
      </div>
    </div>
  )
}

function AddConsultation({ b, addRef }: { b: Bill; addRef: React.MutableRefObject<() => void> }) {
  const [doctor, setDoctor] = useState<string | null>(null)
  const [svc, setSvc] = useState<ServiceHit | null>(null)
  const [day, setDay] = useState(todayISO())
  const [qty, setQty] = useState('1')
  const [rate, setRate] = useState('0')
  const [note, setNote] = useState('')
  const defaults = useQuery({
    queryKey: ['lookup', 'billing.services', 'ipb-visit'],
    queryFn: () => api<{ id: string; code: string; name?: string; title?: string; rate: number; category: string }[]>('/lookup/billing/services', { query: { q: 'visit', f_category: 'CONSULT', limit: 5 } }),
    staleTime: 5 * 60_000,
  })
  useEffect(() => {
    const v = defaults.data?.find((s) => s.code === 'CONS-IPD-VISIT') ?? defaults.data?.[0]
    if (v && !svc) { setSvc({ id: v.id, code: v.code, name: v.name ?? v.title ?? v.code, rate: Number(v.rate), category: v.category }); setRate(String(v.rate)) }
  }, [defaults.data, svc])
  const m = useAdd(b, () => { setQty('1'); setNote('') })
  const submit = useCallback(() => {
    if (!svc || m.isPending) return
    m.mutate({ service_id: svc.id, date: day, qty: Number(qty || 1), rate: Number(rate) !== svc.rate ? Number(rate) : undefined, tab: 'consultation',
      doctor_id: doctor ?? undefined, note: note || undefined })
  }, [svc, day, qty, rate, doctor, note, m])
  useEffect(() => { addRef.current = submit }, [submit, addRef])
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><Icon name="Stethoscope" className="size-4 text-brand-700 dark:text-brand-400" />Consultation &amp; visits</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <FieldWrap label="Doctor"><RefPicker refName="employees.employees" filter={{ category: 'Doctor' }} value={doctor} onChange={(id) => setDoctor(id)} placeholder="Visiting / cross consultant" /></FieldWrap>
        <FieldWrap label="Visit type"><ServiceSearch value={svc} category="CONSULT" placeholder="Consultation service…" onChange={(s) => { setSvc(s); if (s) setRate(String(s.rate)) }} onEnter={submit} /></FieldWrap>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[160px_80px_minmax(0,1fr)_auto] sm:items-end">
        <FieldWrap label="Date"><Input type="date" value={day} min={b.admission.admitted_at?.slice(0, 10)} max={todayISO()} onChange={(e) => setDay(e.target.value)} /></FieldWrap>
        <FieldWrap label="Visits"><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} className="text-right tabular-nums" /></FieldWrap>
        <FieldWrap label="Rate"><Input type="number" min={0} value={rate} disabled={!b.permissions.price} onChange={(e) => setRate(e.target.value)} className="text-right tabular-nums" /></FieldWrap>
        <Button variant="primary" icon="Plus" disabled={!svc} loading={m.isPending} onClick={submit}>Add visit</Button>
      </div>
      <Input className="mt-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note on the bill line (optional) — e.g. night visit, cross consultation" maxLength={120} />
    </div>
  )
}

interface PackageRow {
  id: string; code: string; name: string; specialty: string | null; price: number; sponsor_price: number | null; los_days: number | null
  room_category: string | null; exclusions: string | null; inclusions: { service_id: string; name: string | null; qty: number }[]
}

function PackageTab({ b }: { b: Bill }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<PackageRow | null>(null)
  const [price, setPrice] = useState('')
  const [day, setDay] = useState(b.admission.admitted_at?.slice(0, 10) ?? todayISO())
  const [auto, setAuto] = useState(true)
  const list = useQuery({
    queryKey: [...K.all, 'packages', b.admission.id, q],
    queryFn: () => api<PackageRow[]>('/ipbilling/packages', { query: { admission: b.admission.id, q: q || undefined } }),
  })
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/packages`, {
    method: 'POST', body: { package_id: sel!.id, price: price && Number(price) !== (sel!.sponsor_price ?? sel!.price) ? Number(price) : undefined, date: day, auto_cover: auto },
  }), { success: 'Package applied', onDone: () => setSel(null) })
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Icon name="Package" className="size-4 text-brand-700 dark:text-brand-400" />Apply a package</h3>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-lg border border-line">
          <div className="relative border-b border-line p-2">
            <Search className="pointer-events-none absolute left-4 top-4 size-4 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search packages" className="pl-8" aria-label="Search packages" />
          </div>
          <div className="max-h-56 overflow-y-auto scroll-thin">
            {list.isLoading && <Spinner />}
            {list.data?.length === 0 && <p className="px-3 py-4 text-sm text-ink-3">No active packages match.</p>}
            {list.data?.map((p) => (
              <button key={p.id} type="button" onClick={() => { setSel(p); setPrice(String(p.sponsor_price ?? p.price)) }}
                className={cn('flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2', sel?.id === p.id && 'bg-brand-50 dark:bg-brand-500/10')}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{p.name}</span>
                  <span className="block truncate text-xs text-ink-3">{p.code} · {p.los_days ?? 0} day(s) · {p.room_category ?? 'Any'} room · {p.inclusions.length} service(s)</span>
                </span>
                <span className="text-right tabular-nums">
                  {p.sponsor_price != null && p.sponsor_price !== p.price ? <><span className="block font-medium">{money(p.sponsor_price)}</span><span className="block text-xs text-ink-3 line-through">{money(p.price)}</span></> : money(p.price)}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {!sel ? <p className="rounded-lg border border-dashed border-line-2 px-3 py-6 text-center text-sm text-ink-3">Pick a package to apply it to this stay. Sponsor package prices are used automatically.</p> : (
            <>
              <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <div className="font-medium text-ink">{sel.name}</div>
                <div className="text-xs text-ink-2">Includes {sel.los_days ?? 0} day(s) stay{sel.inclusions.length ? ` and ${sel.inclusions.map((i) => `${i.name ?? 'service'} × ${i.qty}`).join(', ')}` : ''}.</div>
                {sel.exclusions && <div className="mt-1 text-xs text-ink-3">Excludes: {sel.exclusions}</div>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <FieldWrap label="Package price"><Input type="number" min={0} value={price} disabled={!b.permissions.price} onChange={(e) => setPrice(e.target.value)} className="text-right tabular-nums" /></FieldWrap>
                <FieldWrap label="Date"><Input type="date" value={day} max={todayISO()} onChange={(e) => setDay(e.target.value)} /></FieldWrap>
              </div>
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" className="accent-brand-700" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                Cover the package's services and stay days automatically</label>
              <Button variant="primary" icon="PackageCheck" loading={m.isPending} onClick={() => m.mutate()}>Apply package</Button>
            </>
          )}
        </div>
      </div>
      {b.packages.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">On this bill</div>
          {b.packages.map((p) => (
            <div key={p.line_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <span><span className="font-medium">{p.name}</span> <span className="text-ink-3">· {p.covered_count} line(s) covered ({money(p.covered_value)})</span></span>
              <span className="tabular-nums font-medium">{money(p.price)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ lines table

const PAGE_SIZES = [10, 25, 50, 100]

function LinesTable({ b, open }: { b: Bill; open: (m: ModalKey) => void }) {
  const [q, setQ] = useState('')
  const [size, setSize] = useState(25)
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [voiding, setVoiding] = useState<Line | null>(null)
  const id = b.admission.id
  const patch = useBillMutation<{ lid: string; body: Record<string, unknown> }>(id, ({ lid, body }) => api(`/ipbilling/admissions/${id}/lines/${lid}`, { method: 'PATCH', body }))
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return b.lines
    return b.lines.filter((l) => [l.name, l.service_code, l.code, l.head, l.group, String(l.after_total), String(l.rate)].some((v) => v?.toLowerCase().includes(t)))
  }, [b.lines, q])
  const pages = Math.max(1, Math.ceil(rows.length / size))
  useEffect(() => { if (page > pages) setPage(pages) }, [page, pages])
  const shown = rows.slice((page - 1) * size, page * size)
  const edit = b.permissions.edit
  const hasPackage = b.packages.some((p) => p.status !== 'Billed')
  const byPackage = useMemo(() => {
    const m = new Map<string, Line[]>()
    for (const l of b.lines) if (l.covered && l.covered_by) m.set(l.covered_by, [...(m.get(l.covered_by) ?? []), l])
    return m
  }, [b.lines])
  return (
    <Card pad={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Search these lines — service, code, amount" className="pl-8" aria-label="Search bill lines" />
        </div>
        <span className="ml-auto text-xs text-ink-3">{b.lines.length} line(s) · {b.position.unbilled_count} unbilled</span>
      </div>
      {b.lines.length === 0 ? <Empty icon="Receipt" title="No charges on this stay yet">Room rent posts every night; orders, pharmacy and procedures post as they happen. Add services above.</Empty> : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[980px] text-xs">
            <thead className="border-b border-line bg-surface-2 text-[11px] uppercase tracking-wide text-ink-2">
              <tr>
                <th className="w-8 px-2 py-2 text-left font-medium">#</th>
                <th className="w-16 px-2 py-2 text-left font-medium">In pkg</th>
                <th className="px-2 py-2 text-left font-medium">Date</th>
                <th className="px-2 py-2 text-left font-medium">Group</th>
                <th className="px-2 py-2 text-left font-medium">Code</th>
                <th className="px-2 py-2 text-left font-medium">Service / package</th>
                <th className="px-2 py-2 text-left font-medium">Ward type</th>
                <th className="w-28 px-2 py-2 text-right font-medium">Tariff price</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Discount</th>
                <th className="px-2 py-2 text-right font-medium">GST</th>
                <th className="px-2 py-2 text-right font-medium">After total</th>
                <th className="w-10 px-2 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((l, i) => {
                const pkg = l.kind === 'package'
                const open_ = expanded.has(l.id)
                const p = pkg ? b.packages.find((x) => x.line_id === l.id) : undefined
                const lineEditable = edit && !l.locked && l.status === 'Unbilled'
                return (
                  <Fragment key={l.id}>
                    <tr className={cn('border-b border-line align-middle', l.covered && 'bg-emerald-50/60 dark:bg-emerald-500/5', l.status === 'Billed' && 'text-ink-2')}>
                      <td className="px-2 py-1.5 text-ink-3">{(page - 1) * size + i + 1}</td>
                      <td className="px-2 py-1.5">
                        {pkg ? <span className="text-ink-3">—</span> : (
                          <Switch size="sm" checked={l.covered} label={l.covered ? 'Included in package — click to bill on top' : 'Billed on top — click to include in package'}
                            onChange={edit && l.status === 'Unbilled' && (hasPackage || l.covered) ? (v) => patch.mutate({ lid: l.id, body: { in_package: v } }) : undefined} />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{date(l.date)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5"><span className="inline-flex items-center gap-1 font-medium text-ink-2"><Icon name={GROUP_ICON[l.group] ?? 'Shapes'} className="size-3.5" />{l.group}</span></td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-ink-2">{l.service_code ?? '—'}</td>
                      <td className="max-w-[320px] px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          {pkg && (
                            <button type="button" aria-label={open_ ? 'Collapse package' : 'Expand package'} className="text-ink-3 hover:text-ink"
                              onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n })}>
                              {open_ ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            </button>
                          )}
                          <span className={cn('truncate', pkg && 'font-semibold text-ink')} title={l.name}>{l.name}{pkg && p ? ` (${p.covered_count} services)` : ''}</span>
                          {l.covered && <Badge tone="green">Covered</Badge>}
                          {l.unpriced && <Badge tone="amber">No price</Badge>}
                          {l.price_overridden && <Badge tone="violet">Manual price</Badge>}
                          {l.status === 'Billed' && <Badge tone="gray">{l.invoice_code ?? 'Billed'}</Badge>}
                        </div>
                        <div className="truncate text-[11px] text-ink-3">{l.source_label}{l.code ? ` · ${l.code}` : ''}</div>
                      </td>
                      <td className="px-2 py-1.5">{l.ward_type ? <Badge tone="violet">{l.ward_type.toUpperCase()}</Badge> : '—'}</td>
                      <td className="px-2 py-1.5 text-right">
                        {lineEditable && b.permissions.price && l.qty > 0 ? (
                          <CellNumber value={l.rate} label={`Tariff price for ${l.name}`} onCommit={(v) => patch.mutate({ lid: l.id, body: { rate: v } })} />
                        ) : <span className="tabular-nums">{money(l.rate)}{l.qty !== 1 && <span className="text-ink-3"> × {l.qty}</span>}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {lineEditable && !pkg && l.gross > 0 ? (
                          <CellDiscount mode={l.disc_mode} value={l.disc_value} label={`Discount for ${l.name}`}
                            onCommit={(mode, v) => patch.mutate({ lid: l.id, body: { disc_mode: mode, disc_value: v } })} />
                        ) : <span className="tabular-nums">{l.discount ? money(l.discount) : '—'}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{l.gst ? money(l.gst) : '—'}</td>
                      <td className={cn('px-2 py-1.5 text-right font-medium tabular-nums', l.covered && 'text-emerald-700 dark:text-emerald-400')}>{money(l.after_total)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {l.locked ? <span title={l.lock_reason ?? ''} aria-label={l.lock_reason ?? 'Locked'}><Lock className="ml-auto size-3.5 text-ink-3" /></span>
                          : edit && l.status === 'Unbilled' ? (
                            pkg ? <button type="button" aria-label="Remove package" className="text-red-600 hover:text-red-700" onClick={() => setVoiding(l)}><Trash2 className="ml-auto size-4" /></button>
                              : <LineMenu l={l} onVoid={() => setVoiding(l)} onToggle={hasPackage || l.covered ? () => patch.mutate({ lid: l.id, body: { in_package: !l.covered } }) : undefined} />
                          ) : null}
                      </td>
                    </tr>
                    {pkg && open_ && (
                      <tr className="border-b border-line bg-surface-2/50">
                        <td colSpan={12} className="px-10 py-2">
                          {p && p.services.length > 0 && (
                            <div className="mb-1 text-[11px] text-ink-2">Package services: {p.services.map((s) => `${s.name ?? 'Service'} (${s.used}/${s.qty})`).join(' · ')}</div>
                          )}
                          {(byPackage.get(l.id) ?? []).length === 0 ? <div className="text-[11px] text-ink-3">No lines covered by this package yet — use the "In pkg" switches or "Cover all in package".</div> : (
                            <ul className="grid gap-x-6 gap-y-0.5 text-[11px] text-ink-2 sm:grid-cols-2">
                              {(byPackage.get(l.id) ?? []).map((c) => <li key={c.id} className="flex justify-between gap-2"><span className="truncate">{date(c.date)} · {c.name}</span><span className="tabular-nums">{money(c.gross)}</span></li>)}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-xs text-ink-2">
        <label className="flex items-center gap-1.5">Rows per page
          <Select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1) }} className="h-7 w-20 text-xs" aria-label="Rows per page">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </label>
        <span>Showing {rows.length ? (page - 1) * size + 1 : 0}–{Math.min(page * size, rows.length)} of {rows.length} items</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Badge tone="green">Covered {b.totals.covered_count}</Badge>
          <Badge tone="gray">Billed on top {b.totals.on_top_count} · {money(b.totals.on_top_amount)}</Badge>
          {edit && <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => open('include')}>Include / exclude…</button>}
          <Button size="xs" variant="ghost" icon="ChevronLeft" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)} />
          <span className="tabular-nums">{page} / {pages}</span>
          <Button size="xs" variant="ghost" icon="ChevronRight" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)} />
        </span>
      </div>
      <VoidModal line={voiding} onClose={() => setVoiding(null)} b={b} />
    </Card>
  )
}

function CellNumber({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const n = Number(v)
    if (v === '' || Number.isNaN(n) || n < 0) { setV(String(value)); return }
    if (n !== value) onCommit(n)
  }
  return (
    <input type="number" min={0} step="0.01" value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(String(value)); (e.target as HTMLInputElement).blur() } }}
      className="h-7 w-24 rounded-md border border-line-2 bg-surface px-2 text-right text-xs tabular-nums text-ink focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
  )
}

function CellDiscount({ mode, value, onCommit, label }: { mode: '₹' | '%'; value: number; onCommit: (mode: '₹' | '%', v: number) => void; label: string }) {
  const [v, setV] = useState(String(value))
  const [m, setM] = useState(mode)
  useEffect(() => { setV(String(value)); setM(mode) }, [value, mode])
  const commit = (nm = m) => {
    const n = Number(v || 0)
    if (Number.isNaN(n) || n < 0) { setV(String(value)); return }
    if (n !== value || nm !== mode) onCommit(nm, n)
  }
  return (
    <span className="inline-flex">
      <button type="button" aria-label={`${label}: switch to ${m === '₹' ? 'percent' : 'rupees'}`} onClick={() => { const nm = m === '₹' ? '%' : '₹'; setM(nm); if (Number(v)) commit(nm) }}
        className="h-7 w-6 rounded-l-md border border-r-0 border-line-2 bg-surface-2 text-[11px] font-medium text-ink-2">{m}</button>
      <input type="number" min={0} step="0.01" value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={() => commit()}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(String(value)); (e.target as HTMLInputElement).blur() } }}
        className="h-7 w-16 rounded-r-md border border-line-2 bg-surface px-1.5 text-right text-xs tabular-nums text-ink focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
    </span>
  )
}

function LineMenu({ l, onVoid, onToggle }: { l: Line; onVoid: () => void; onToggle?: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div ref={box} className="relative inline-block">
      <button type="button" aria-label={`Actions for ${l.name}`} aria-haspopup="menu" className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => setOpen(!open)}>
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-line bg-surface py-1 text-left text-sm shadow-xl">
          {onToggle && <button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => { setOpen(false); onToggle() }}>{l.covered ? 'Bill on top (exclude)' : 'Include in package'}</button>}
          <button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-surface-2" onClick={() => { setOpen(false); onVoid() }}>Void charge…</button>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ right rail

function Rail({ b, open, discountRef, goTab, onPrint }: {
  b: Bill; open: (m: ModalKey) => void; focusDiscount: () => void; discountRef: React.RefObject<HTMLInputElement | null>
  goTab: (t: Tab) => void; onPrint: (no: string) => void
}) {
  const pos = b.position
  const t = b.totals
  const perms = b.permissions
  const tools: { label: string; icon: string; onClick: () => void; show: boolean }[] = [
    { label: 'Apply Package', icon: 'PackagePlus', onClick: () => goTab('package'), show: perms.edit },
    { label: 'Add Service', icon: 'Plus', onClick: () => goTab('orders'), show: perms.edit },
    { label: 'Discount', icon: 'Percent', onClick: () => discountRef.current?.focus(), show: perms.edit },
    { label: 'Include / Exclude', icon: 'ListChecks', onClick: () => open('include'), show: perms.edit },
    { label: 'Change Ward', icon: 'BedDouble', onClick: () => open('ward'), show: perms.edit },
    { label: 'Summary', icon: 'FileText', onClick: () => open('breakdown'), show: true },
  ]
  return (
    <aside className="space-y-4">
      <Card title="Billing summary" icon="Calculator" actions={<button type="button" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => open('breakdown')}>Breakdown ›</button>}>
        <div className="flex items-end justify-between gap-2">
          <div><div className="text-xs text-ink-3">Net amount</div><div className="text-2xl font-semibold tracking-tight text-ink tabular-nums">{money(pos.net)}</div></div>
          <div className="text-right"><div className="text-xs text-ink-3">{pos.balance < 0 ? 'Refundable' : 'Patient balance'}</div>
            <div className={cn('text-lg font-semibold tabular-nums', pos.balance > 0.009 ? 'text-amber-600 dark:text-amber-400' : pos.balance < -0.009 ? 'text-sky-700 dark:text-sky-300' : 'text-emerald-700 dark:text-emerald-400')}>{money(Math.abs(pos.balance))}</div></div>
        </div>
        <dl className="mt-3 grid gap-y-1.5 text-xs">
          <Kv label="Total bill" value={money(pos.gross)} />
          <Kv label="Patient paid" value={money(pos.paid)} />
          <Kv label="Discount" value={money(t.line_discount + (pos.discount - t.line_discount - t.bill_discount > 0 ? pos.discount - t.line_discount - t.bill_discount : 0))} />
          <Kv label="Bill discount" value={money(t.bill_discount)} />
          <Kv label="GST" value={money(pos.gst)} />
          <Kv label="Advance held" value={money(pos.advance)} />
          {pos.sponsor_payable > 0 && <><Kv label="Sponsor share" value={money(pos.sponsor_payable)} /><Kv label="Patient share" value={money(pos.patient_payable)} /></>}
        </dl>
        <BillDiscountForm b={b} inputRef={discountRef} />
      </Card>

      {tools.some((x) => x.show) && (
        <Card title="Billing tools" icon="Wrench">
          <div className="grid grid-cols-3 gap-2">
            {tools.filter((x) => x.show).map((x) => (
              <button key={x.label} type="button" onClick={x.onClick} className="flex flex-col items-center gap-1 rounded-lg border border-line px-1 py-2.5 text-center text-[11px] font-medium text-ink-2 hover:border-brand-600/40 hover:bg-surface-2 hover:text-ink">
                <Icon name={x.icon} className="size-4 text-brand-700 dark:text-brand-400" />{x.label}
              </button>
            ))}
          </div>
        </Card>
      )}

      <SponsorCard b={b} onEdit={() => open('terms')} onChange={() => open('sponsor')} />

      <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
        <Stat icon="CalendarDays" label="Admission duration" value={`${b.stats.los_days} Days`} hint={`Since ${date(b.stats.since)}`} />
        <Stat icon="Package" label="Packages applied" value={String(b.stats.packages)} hint={b.stats.packages ? 'Active package' : 'Open billing'} />
        <Stat icon="ShoppingCart" label="Services added" value={String(b.stats.services)} hint="Total services" />
        <Stat icon="Wallet" label="Payment status" value={b.stats.payment_status} hint={pos.balance > 0 ? `${money(pos.balance)} patient due` : pos.balance < 0 ? `${money(-pos.balance)} surplus advance` : 'Nothing due'} />
      </div>

      {b.approx_bills.length > 0 && (
        <Card title="Approximate bills" icon="History" pad={false}>
          <ul className="divide-y divide-line text-xs">
            {b.approx_bills.slice(0, 5).map((x) => (
              <li key={x.no} className="flex items-center justify-between gap-2 px-4 py-2">
                <span><span className="font-mono">{x.no}</span><span className="block text-ink-3">{dateTime(x.at)} · {x.by}</span></span>
                <span className="text-right tabular-nums">{money(x.net)}<button type="button" className="block text-brand-700 hover:underline dark:text-brand-300" onClick={() => onPrint(x.no)}>Print</button></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </aside>
  )
}

function Kv({ label, value }: { label: string; value: ReactNode }) {
  return <div className="flex justify-between gap-2"><dt className="text-ink-3">{label}</dt><dd className="font-medium tabular-nums text-ink">{value}</dd></div>
}

function Stat({ icon, label, value, hint }: { icon: string; label: string; value: string; hint: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><Icon name={icon} className="size-4" /></span>
      <span className="min-w-0"><span className="block truncate text-xs text-ink-3">{label}</span><span className="block font-semibold text-ink">{value}</span><span className="block truncate text-[11px] text-ink-3">{hint}</span></span>
    </div>
  )
}

function BillDiscountForm({ b, inputRef }: { b: Bill; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const bd = b.bill_discount
  const [mode, setMode] = useState<'%' | '₹'>(bd.mode)
  const [value, setValue] = useState(String(bd.value || ''))
  const [reason, setReason] = useState(bd.reason ?? '')
  useEffect(() => { setMode(bd.mode); setValue(bd.value ? String(bd.value) : ''); setReason(bd.status === 'Rejected' ? '' : bd.reason ?? '') }, [bd.mode, bd.value, bd.reason, bd.status])
  const m = useBillMutation<void>(b.admission.id, () => api(`/ipbilling/admissions/${b.admission.id}/bill-discount`, {
    method: 'PUT', body: { mode, value: Number(value || 0), reason: reason || undefined },
  }), { success: (r) => ((r as Bill).bill_discount?.status === 'Pending' ? 'Bill discount sent for approval' : 'Bill discount saved') })
  const dirty = mode !== bd.mode || Number(value || 0) !== bd.value || (reason || '') !== (bd.reason ?? '')
  const amount = mode === '%' ? (b.totals.taxable + b.totals.bill_discount) * Number(value || 0) / 100 : Number(value || 0)
  const base = b.totals.taxable + b.totals.bill_discount
  const over = base > 0 && amount / base * 100 > b.policy.discount_approval_percent && !b.permissions.approve
  if (!b.permissions.edit) {
    return bd.value ? <p className="mt-3 border-t border-line pt-2 text-xs text-ink-2">Bill discount {bd.mode === '%' ? `${bd.value}%` : money(bd.value)} · <StatusBadge status={bd.status} /></p> : null
  }
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="flex items-end justify-between gap-2">
        <div><div className="text-xs font-medium text-ink">Bill discount</div><div className="text-[11px] text-ink-3">On the total, after the line discounts</div></div>
        {bd.status !== 'None' && <StatusBadge status={bd.status} />}
      </div>
      <div className="flex gap-2">
        <Select value={mode} onChange={(e) => setMode(e.target.value as '%' | '₹')} className="w-20 shrink-0" aria-label="Bill discount unit"><option value="%">%</option><option value="₹">₹</option></Select>
        <Input ref={inputRef} type="number" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" className="text-right tabular-nums" aria-label="Bill discount value" />
      </div>
      {(dirty || bd.value > 0) && Number(value || 0) > 0 && (
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (printed on the bill) — e.g. senior citizen, hardship" aria-label="Bill discount reason" />
      )}
      {dirty && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-3">{Number(value || 0) > 0 ? `≈ ${money(amount)}${over ? ` · above ${b.policy.discount_approval_percent}% — needs approval` : ''}` : 'Removes the bill discount'}</span>
          <Button size="xs" variant="primary" loading={m.isPending} disabled={Number(value || 0) > 0 && !reason.trim()} onClick={() => m.mutate()}>{over ? 'Send for approval' : 'Apply'}</Button>
        </div>
      )}
    </div>
  )
}

function SponsorCard({ b, onEdit, onChange }: { b: Bill; onEdit: () => void; onChange: () => void }) {
  const s = b.sponsor
  const self = s.payer_type === 'Self'
  return (
    <Card title="Sponsor & tariff" icon="Building2" actions={b.permissions.edit ? <button type="button" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={onChange}>Change</button> : undefined}>
      <dl className="space-y-1.5 text-xs">
        <Kv label="Payer" value={self ? 'Self-pay' : s.sponsor_name ?? s.payer_type} />
        <Kv label="Prices from" value={s.tariff?.name ?? 'Hospital tariff'} />
        {!self && <>
          <Kv label="Approved amount" value={s.approved_amount != null ? money(s.approved_amount) : <span className="text-amber-600">Not recorded</span>} />
          <Kv label="Co-pay" value={`${s.co_pay_percent}%`} />
          <Kv label="Credit letter / pre-auth" value={s.credit_ref ?? '—'} />
          <Kv label="Sponsor share" value={money(b.position.sponsor_payable)} />
        </>}
      </dl>
      {!self && b.permissions.edit && <Button size="xs" className="mt-3 w-full" icon="Pencil" onClick={onEdit}>Edit approved amount / co-pay</Button>}
    </Card>
  )
}

// ------------------------------------------------------------------ sticky bottom bar

function BottomBar({ b, onPrint, onCollect, onApprox, approxPending, open, onPrintFormat }: {
  b: Bill; onPrint: () => void; onCollect: () => void; onApprox: () => void; approxPending: boolean; open: (m: ModalKey) => void
  onPrintFormat: (f: 'final' | 'interim') => void
}) {
  const perms = b.permissions
  const id = b.admission.id
  const cover = useBillMutation<boolean>(id, (covered) => api(`/ipbilling/admissions/${id}/cover-all`, { method: 'POST', body: { covered } }))
  const finalise = useBillMutation<void>(id, () => api(`/ipbilling/admissions/${id}/finalise`, { method: 'POST' }), { success: 'Final bill generated' })
  const settle = useBillMutation<void>(id, () => api(`/ipbilling/admissions/${id}/settle`, { method: 'POST', body: {} }), {
    success: (r) => ((r as { status: string }).status === 'Settled' ? 'Bill settled' : `Bill finalised — ${money((r as { due: number }).due)} still due`),
  })
  const [more, setMore] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setMore(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const unbilled = b.lines.filter((l) => l.status === 'Unbilled' && l.kind !== 'package')
  const allCovered = unbilled.length > 0 && unbilled.every((l) => l.covered)
  const hasPkg = b.packages.some((p) => p.status !== 'Billed')
  const saving = cover.isPending || finalise.isPending
  const items: { label: string; icon: string; onClick: () => void; show: boolean }[] = [
    { label: 'Interim receipt', icon: 'ReceiptText', onClick: () => onPrintFormat('interim'), show: true },
    { label: 'All bill formats…', icon: 'Printer', onClick: () => open('formats'), show: true },
    { label: 'Save as cost estimate', icon: 'Calculator', onClick: () => open('estimate'), show: perms.estimate && !perms.closed },
    { label: 'Corporate approx (pre-auth)', icon: 'ShieldCheck', onClick: () => open('preauth'), show: perms.preauth && !perms.closed && b.sponsor.payer_type !== 'Self' },
    { label: 'Generate final bill', icon: 'FileCheck', onClick: () => finalise.mutate(), show: perms.finalise && b.position.unbilled_count > 0 },
    { label: 'Print final bill', icon: 'FileText', onClick: () => onPrintFormat('final'), show: b.invoices.length > 0 },
    { label: 'Reopen bill…', icon: 'Unlock', onClick: () => open('reopen'), show: perms.reopen },
  ]
  return (
    <div className="no-print sticky bottom-0 z-20 -mx-4 border-t border-line bg-surface/95 px-4 py-2.5 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur md:-mx-6 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        {perms.edit && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <Switch checked={allCovered} label="Cover all in package" onChange={hasPkg ? (v) => cover.mutate(v) : undefined} />Cover all in package
          </label>
        )}
        <span className="text-xs text-ink-2">{b.totals.covered_count} covered · {b.totals.on_top_count} billed on top</span>
        <span className="ml-auto hidden md:inline"><Saving state={saving ? 'saving' : 'idle'} /></span>
        <Button icon="Printer" onClick={onPrint}>Print Estimate</Button>
        {perms.collect && <Button icon="Wallet" onClick={onCollect}>Collect Payment</Button>}
        <div ref={box} className="relative">
          <Button icon="ChevronDown" onClick={() => setMore(!more)} aria-haspopup="menu" aria-expanded={more}>More</Button>
          {more && (
            <div role="menu" className="absolute bottom-full right-0 mb-2 w-60 rounded-lg border border-line bg-surface py-1 text-sm shadow-xl">
              {items.filter((x) => x.show).map((x) => (
                <button key={x.label} role="menuitem" type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => { setMore(false); x.onClick() }}>
                  <Icon name={x.icon} className="size-4 text-ink-3" />{x.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {perms.settle && <Button variant="success" icon="CheckCheck" loading={settle.isPending} onClick={() => settle.mutate()}>Settle reopened bill</Button>}
        {perms.approx && !perms.closed && <Button variant="primary" icon="FileSpreadsheet" loading={approxPending} onClick={onApprox}>Generate Approx. Bill</Button>}
      </div>
    </div>
  )
}
