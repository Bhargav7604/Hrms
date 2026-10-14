import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, CircleCheck, Loader2, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker, useDebounced } from '@/components/fields'
import {
  Avatar, Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Kbd, PageHeader, Select, Spinner, Tabs, Textarea,
} from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useAuth, useRegistry } from '@/lib/auth'
import { date, money } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import {
  computeTotals, newKey, REF_MODES, type Bill, type CatalogItem, type CounterContext, type CounterPatient, type DraftState, type Line, type PayLine,
} from './api'
import { BillsModal, DraftsModal, HistoryModal, PriceCheckModal, TemplatesModal } from './modals'

type Tab = 'services' | 'consultation' | 'packages'

export function useCounterAccess() {
  const reg = useRegistry()
  const { user } = useAuth()
  return reg.canPage('appointments', 'op-billing', 'edit') && ['billing', 'front_office', 'admin'].includes(user?.role ?? '')
}

export default function BillingCounter() {
  const { billId } = useParams()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const allowed = useCounterAccess()
  const ctx = useQuery({ queryKey: ['x', 'billing', 'counter-context'], queryFn: () => api<CounterContext>('/opbilling/context'), enabled: allowed, staleTime: 5 * 60_000 })
  const [bill, setBill] = useState<Bill | null>(null)
  const [state, setState] = useState<DraftState | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const [modal, setModal] = useState<null | 'bills' | 'drafts' | 'templates' | 'price' | 'history'>(null)
  const [done, setDone] = useState<Bill | null>(null)
  const rev = useRef(0)

  const open = useCallback(async (id: string) => {
    try {
      const b = await api<Bill>(`/opbilling/drafts/${id}`)
      if (b.label.status !== 'DRAFT') { setDone(b); setBill(null); setState(null); return }
      setBill(b)
      setState(b.state)
      setDone(null)
      setSaveState('saved')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [])

  const start = useMutation({
    mutationFn: (body: { patient_id: string; charge_ids?: string[]; counter?: string }) => api<Bill>('/opbilling/drafts', { method: 'POST', body }),
    onSuccess: (b) => { setBill(b); setState(b.state); setDone(null); setSaveState('saved'); nav(`/op/billing/${b.id}`, { replace: true }) },
    onError: (e) => toast.error(errorMessage(e)),
  })

  // deep links: /op/billing/<id>, /op/billing?patient=<id>&charges=a,b
  useEffect(() => {
    if (!allowed) return
    if (billId && billId !== bill?.id) void open(billId)
  }, [billId, allowed, open, bill?.id])
  useEffect(() => {
    const pid = params.get('patient')
    if (!allowed || !pid || billId) return
    const charges = (params.get('charges') ?? '').split(',').filter(Boolean)
    start.mutate({ patient_id: pid, charge_ids: charges })
    setParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, params])

  // autosave (debounced); server normalises prices and returns its totals
  const dstate = useDebounced(state, 700)
  useEffect(() => {
    if (!bill || !dstate || saveState !== 'dirty') return
    const sent = rev.current
    setSaveState('saving')
    api<{ state: DraftState; totals: Bill['totals'] }>(`/opbilling/drafts/${bill.id}`, { method: 'PUT', body: dstate })
      .then((r) => {
        if (rev.current === sent) { setState(r.state); setSaveState('saved') } else setSaveState('dirty')
      })
      .catch((e) => { setSaveState('error'); toast.error(errorMessage(e)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dstate])

  const edit = useCallback((fn: (s: DraftState) => DraftState) => {
    rev.current += 1
    setState((s) => (s ? fn(s) : s))
    setSaveState('dirty')
  }, [])

  const totals = useMemo(() => (state ? computeTotals(state) : null), [state])
  const lineTotals = useMemo(() => new Map((totals?.lines ?? []).map((l) => [l.key, l])), [totals])

  const confirmBill = useMutation({
    mutationFn: () => api<Bill>(`/opbilling/drafts/${bill!.id}/confirm`, { method: 'POST', body: { state } }),
    onSuccess: (b) => {
      setDone(b); setBill(null); setState(null)
      qc.invalidateQueries({ queryKey: ['x', 'billing'] })
      if (b.approval_required) toast.warning(`Bill ${b.code} is waiting for discount approval`)
      else toast.success(`Bill ${b.code} confirmed`)
      if (ctx.data?.print_on_save && !b.approval_required) window.open(`/op/bills/${b.id}/print`, '_blank')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const postIp = useMutation({
    mutationFn: () => api<{ encounter: { code: string }; charges: unknown[]; advances: unknown[] }>(`/opbilling/drafts/${bill!.id}/post-to-ip`, { method: 'POST', body: { state } }),
    onSuccess: (r) => { toast.success(`${r.charges.length} item(s) posted to IP account ${r.encounter.code}`); reset() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const discard = useMutation({
    mutationFn: () => api(`/opbilling/drafts/${bill!.id}/discard`, { method: 'POST', body: { reason: 'Discarded at the counter' } }),
    onSuccess: () => { toast.success('Draft discarded'); reset() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const reset = () => { setBill(null); setState(null); setDone(null); setSaveState('idle'); nav('/op/billing', { replace: true }) }

  const canConfirm = !!state?.lines.length && !confirmBill.isPending && saveState !== 'saving'
  useShortcuts('OP billing counter', [
    { keys: 'F9', label: 'Save & confirm the bill', run: () => { if (canConfirm) confirmBill.mutate() }, allowInInput: true },
    { keys: 'alt+n', label: 'New bill (clear patient)', run: () => reset(), allowInInput: true },
  ], allowed)

  if (!allowed) return <Empty icon="Lock" title="OP billing is for the billing and front-office counters">Your role cannot bill patients.</Empty>
  if (ctx.isLoading) return <Spinner />
  if (ctx.error) return <ErrorBox error={ctx.error} />
  const c = ctx.data!
  const p = bill?.patient
  const ip = p?.encounter?.kind === 'IP'
  const needsApproval = !!totals && totals.discount > 0 && totals.discount_percent > c.discount_approval_percent

  return (
    <div className="space-y-3">
      <PageHeader icon="Receipt" title="OP / IP Billing"
        badge={bill ? <><span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink-2 ring-1 ring-line">{bill.code}</span>
          <Badge tone="amber">DRAFT · PENDING</Badge></> : undefined}
        actions={<>
          <Link to="/ip/billing" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-sm text-ink-2 shadow-sm hover:bg-surface-2">IP billing</Link>
          {p && <Button size="sm" icon="History" onClick={() => setModal('history')}>Previous consultations</Button>}
          {bill && <SaveTick state={saveState} />}
          <Button size="sm" icon="FileText" onClick={() => setModal('bills')}>View bills</Button>
          <Button size="sm" icon="Files" onClick={() => setModal('drafts')}>View drafts</Button>
          <Button size="sm" icon="LayoutTemplate" disabled={!bill} onClick={() => setModal('templates')}>Templates</Button>
          <Button size="sm" icon="Tag" onClick={() => setModal('price')}>Price check</Button>
          {bill && <Button size="sm" variant="ghost" className="text-red-600" icon="Trash2" loading={discard.isPending}
            onClick={() => { if (window.confirm('Discard this draft bill?')) discard.mutate() }}>Discard draft</Button>}
          {bill && !ip && <Button size="sm" variant="success" icon="CircleCheck" disabled={!canConfirm} loading={confirmBill.isPending} onClick={() => confirmBill.mutate()}>Save & confirm <Kbd>F9</Kbd></Button>}
        </>}
      />

      {done && <ConfirmedPanel bill={done} onNew={reset} onReload={(id) => open(id)} />}

      {!done && !bill && <PatientFinder starting={start.isPending} onPick={(pt) => start.mutate({ patient_id: pt.id, counter: pt.encounter?.kind === 'ER' ? 'ER' : undefined })} />}

      {bill && state && totals && p && (
        <>
          <PatientBanner bill={bill} state={state} ctx={c} edit={edit} onClear={() => { if (state.lines.length && !window.confirm('Leave this draft? It stays saved under View drafts.')) return; reset() }} />
          {ip && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-300 bg-sky-50 px-4 py-2.5 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
              <span>Admitted — IP {p.encounter?.code}. Services added here go to the IP account and are billed on the final IP bill; payments are taken as an advance.</span>
              <Button size="sm" variant="primary" className="ml-auto" disabled={!state.lines.length} loading={postIp.isPending} onClick={() => postIp.mutate()}>Post to IP account</Button>
            </div>
          )}
          <TotalsStrip t={totals} />
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
            <ServicesPanel bill={bill} state={state} edit={edit} lineTotals={lineTotals} allowLineDiscount={c.allow_line_discount} patientId={p.id} />
            <PaymentsPanel state={state} totals={totals} ctx={c} edit={edit} ip={ip} needsApproval={needsApproval} deposit={bill.deposit_balance ?? 0}
              confirming={confirmBill.isPending} canConfirm={canConfirm} onConfirm={() => confirmBill.mutate()} />
          </div>
          <Extras state={state} edit={edit} />
        </>
      )}

      <BillsModal open={modal === 'bills'} onClose={() => setModal(null)} />
      <DraftsModal open={modal === 'drafts'} onClose={() => setModal(null)} onOpen={(id) => { setModal(null); nav(`/op/billing/${id}`) }} />
      <PriceCheckModal open={modal === 'price'} onClose={() => setModal(null)} />
      {bill && <TemplatesModal open={modal === 'templates'} onClose={() => setModal(null)} patientId={bill.patient_id} lines={state?.lines ?? []}
        onApply={(lines) => { edit((s) => ({ ...s, lines: [...s.lines, ...lines.map((l) => ({ ...l, key: newKey() }))] })); setModal(null) }} />}
      {p && <HistoryModal open={modal === 'history'} onClose={() => setModal(null)} patientId={p.id} />}
    </div>
  )
}

// ------------------------------------------------------------------ patient finder

function PatientFinder({ onPick, starting }: { onPick: (p: CounterPatient) => void; starting: boolean }) {
  const [f, setF] = useState({ uhid: '', name: '', aadhaar: '', mobile: '' })
  const [kind, setKind] = useState<'' | 'ER' | 'IP'>('')
  const [hi, setHi] = useState(0)
  const df = useDebounced(f, 300)
  const num = (s: string) => s.replace(/\D/g, '')
  const enough = df.uhid.trim().length >= 5 || df.name.trim().length >= 2 || num(df.aadhaar).length >= 4 || num(df.mobile).length >= 5
  const list = useQuery({
    queryKey: ['x', 'billing', 'patients', df, kind],
    queryFn: () => api<CounterPatient[]>('/opbilling/patients', { query: { ...df, kind: kind || undefined } }),
    enabled: enough || !!kind,
  })
  const rows = list.data ?? []
  useEffect(() => setHi(0), [list.data])
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && rows[hi]) { e.preventDefault(); onPick(rows[hi]) }
  }
  const field = (k: keyof typeof f, label: string, ph: string, autoFocus = false) => (
    <FieldWrap label={label}><Input autoFocus={autoFocus} value={f[k]} placeholder={ph} onKeyDown={onKey} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></FieldWrap>
  )
  return (
    <Card pad={false}>
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
        {field('uhid', 'UHID', 'Min 5 characters', true)}
        {field('name', 'Name', 'Patient name')}
        {field('aadhaar', 'Aadhaar', 'Full 12 digits or last 4')}
        {field('mobile', 'Mobile', 'Min 5 digits')}
        <FieldWrap label="Currently in">
          <Select value={kind} onChange={(e) => setKind(e.target.value as '' | 'ER' | 'IP')} className="w-36">
            <option value="">Any (OP)</option><option value="ER">Emergency (ER)</option><option value="IP">Admitted (IP)</option>
          </Select>
        </FieldWrap>
      </div>
      <div className="border-t border-line">
        {starting && <Spinner label="Opening a draft bill…" />}
        {!starting && !enough && !kind && <Empty icon="Search" title="Find the patient to start a bill">Search by UHID, name, Aadhaar or mobile. Use ↑ ↓ and Enter to pick.</Empty>}
        {list.isFetching && !rows.length && <Spinner />}
        {(enough || kind) && list.data && !rows.length && <Empty icon="UserX" title="No patient found">Check the spelling or register the patient first.</Empty>}
        <ul role="listbox" className="divide-y divide-line">
          {rows.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === hi}>
              <button type="button" onMouseEnter={() => setHi(i)} onClick={() => onPick(r)}
                className={cn('flex w-full items-center gap-3 px-4 py-2 text-left', i === hi ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
                <Avatar name={r.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">{r.name}
                    {r.encounter && <Badge tone={r.encounter.kind === 'IP' ? 'blue' : r.encounter.kind === 'ER' ? 'red' : 'green'}>{r.encounter.kind} · {r.encounter.code}</Badge>}
                    {r.category !== 'General' && <Badge tone="violet">{r.category}</Badge>}
                  </span>
                  <span className="block text-xs text-ink-2">{[r.uhid, r.phone, r.age != null ? `${r.age}y ${r.gender?.[0] ?? ''}` : null, `Registered ${date(r.registered_at)}`].filter(Boolean).join(' · ')}</span>
                  {r.sponsor && <span className="block text-xs text-ink-3">{r.sponsor}</span>}
                </span>
                {i === hi && <span className="text-xs text-ink-3">↵ Enter</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ banner, totals

function PatientBanner({ bill, state, ctx, edit, onClear }: { bill: Bill; state: DraftState; ctx: CounterContext; edit: (fn: (s: DraftState) => DraftState) => void; onClear: () => void }) {
  const p = bill.patient
  const kv = (label: string, value: ReactNode) => (
    <div className="min-w-0"><div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}</div><div className="truncate text-sm text-ink">{value || '—'}</div></div>
  )
  return (
    <Card pad={false}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2 px-4 py-3">
        <Avatar name={p.name} />
        {kv('UHID', <Link to={`/patients/${p.id}`} className="font-mono text-brand-700 hover:underline dark:text-brand-300">{p.uhid}</Link>)}
        {kv('Name', p.name)}
        {kv('Age / sex', [p.age != null ? `${p.age} yr` : null, p.gender].filter(Boolean).join(' / '))}
        {kv('Mobile', p.phone)}
        {kv('Aadhaar', p.aadhaar ? `XXXX XXXX ${p.aadhaar.slice(-4)}` : null)}
        <div className="w-36">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Category</div>
          <Select className="h-8" value={state.category ?? 'General'} onChange={(e) => edit((s) => ({ ...s, category: e.target.value }))}>
            {ctx.categories.map((o) => <option key={o}>{o}</option>)}
          </Select>
        </div>
        <div className="w-52">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Sponsor</div>
          <Select className="h-8" value={state.payer === 'Self' ? '' : state.sponsor_id ?? ''}
            onChange={(e) => {
              const sp = ctx.sponsors.find((x) => x.id === e.target.value)
              edit((s) => sp ? { ...s, payer: sp.type === 'Insurer' || sp.type === 'TPA' ? 'Insurance' : sp.type === 'Government Scheme' ? 'Government Scheme' : 'Corporate',
                sponsor_id: sp.id, sponsor_name: sp.name, patient_share_value: s.payer === 'Self' ? 0 : s.patient_share_value } : { ...s, payer: 'Self', sponsor_id: null, sponsor_name: null })
            }}>
            <option value="">Self pay</option>
            {ctx.sponsors.map((s) => <option key={s.id} value={s.id}>{s.name}{s.type ? ` (${s.type})` : ''}</option>)}
          </Select>
        </div>
        {kv('Tariff', state.category === 'International' ? 'International' : 'Default')}
        {kv('Doctor', bill.visit?.doctor)}
        {kv('Visit', [bill.counter === 'ER' ? 'ER' : null, bill.visit?.visit_type, bill.visit?.priority !== 'Normal' ? bill.visit?.priority : null].filter(Boolean).join(' · ') || 'Normal')}
        {kv('Visit reason', bill.visit?.reason)}
        {ctx.camps.length > 0 && (
          <div className="w-40">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Camp</div>
            <Select className="h-8" value={state.camp_id ?? ''} onChange={(e) => edit((s) => ({ ...s, camp_id: e.target.value || null }))}>
              <option value="">— None —</option>{ctx.camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        )}
        <button type="button" onClick={onClear} className="ml-auto rounded-md p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10" aria-label="Clear patient" title="Clear patient"><X className="size-5" /></button>
      </div>
    </Card>
  )
}

function TotalsStrip({ t }: { t: ReturnType<typeof computeTotals> }) {
  const cell = (label: string, value: ReactNode, cls?: string) => (
    <div className="min-w-0"><div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}</div><div className={cn('tabular text-base font-semibold text-ink', cls)}>{value}</div></div>
  )
  return (
    <div className="grid grid-cols-4 gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 md:grid-cols-8">
      {cell('Gross', money(t.gross))}
      {cell('Item disc.', `− ${money(t.item_discount)}`, 'text-ink-2')}
      {cell('Net', money(t.net))}
      {cell('Patient payable', money(t.patient_payable))}
      {cell('Sponsor', money(t.sponsor_amount))}
      {cell('Paid (now)', money(t.paid_now))}
      {cell('Saved', money(t.saved), 'text-emerald-700 dark:text-emerald-400')}
      {cell('Balance', money(t.balance), 'rounded-md bg-amber-50 px-1 text-lg dark:bg-amber-500/10')}
    </div>
  )
}

// ------------------------------------------------------------------ services

function ServicesPanel({ bill, state, edit, lineTotals, allowLineDiscount, patientId }: {
  bill: Bill; state: DraftState; edit: (fn: (s: DraftState) => DraftState) => void; lineTotals: Map<string, { net: number }>; allowLineDiscount: boolean; patientId: string
}) {
  const [tab, setTab] = useState<Tab>('services')
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const dq = useDebounced(q, 250)
  const input = useRef<HTMLInputElement>(null)
  const cat = useQuery({
    queryKey: ['x', 'billing', 'catalog', tab, dq, patientId],
    queryFn: () => api<CatalogItem[]>('/opbilling/catalog', { query: { tab, q: dq, patient_id: patientId } }),
    enabled: tab === 'packages' || dq.trim().length >= 2,
  })
  useShortcuts('OP billing counter', [{ keys: '/', label: 'Search services', run: () => input.current?.focus() }])
  useEffect(() => setHi(0), [cat.data])
  const add = (it: CatalogItem) => {
    const ln: Line = {
      key: newKey(), kind: it.kind, service_id: it.service_id ?? null, package_id: it.package_id ?? null, code: it.code, name: it.name, category: it.category,
      consultant_id: it.kind === 'consultation' ? it.consultant_id : null, consultant_name: it.kind === 'consultation' ? it.name : null,
      qty: 1, rate: it.rate, disc_type: '%', disc_value: 0, tax_percent: it.tax_percent ?? 0, rate_editable: it.rate_editable, follow_up: it.follow_up,
    }
    edit((s) => ({ ...s, lines: [...s.lines, ln], prescribed_by: s.prescribed_by ?? (it.kind === 'consultation' ? it.consultant_id : s.prescribed_by) }))
    setQ('')
    input.current?.focus()
  }
  const items = cat.data ?? []
  const upd = (key: string, patch: Partial<Line>) => edit((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  const unbilled = (bill.unbilled ?? []).filter((u) => !state.lines.some((l) => l.charge_id === u.id))
  const total = state.lines.reduce((a, l) => a + (lineTotals.get(l.key)?.net ?? 0), 0)
  return (
    <Card pad={false} title={<span className="flex items-center gap-2">Services <span className="text-xs font-normal text-ink-3">{state.lines.length} items · {money(total)}</span></span>}
      actions={state.lines.length ? <Button size="xs" variant="ghost" className="text-red-600" icon="Trash2" onClick={() => { if (window.confirm('Remove every line?')) edit((s) => ({ ...s, lines: [] })) }}>Clear all</Button> : undefined}>
      <div className="space-y-2 p-3">
        <Tabs<Tab> value={tab} onChange={(t) => { setTab(t); setQ(''); input.current?.focus() }}
          tabs={[{ key: 'services', label: 'Services' }, { key: 'consultation', label: 'Consultation' }, { key: 'packages', label: 'Health checkups / profiles' }]} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input ref={input} className="pl-8" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={tab === 'consultation' ? 'Search a doctor for consultation…' : tab === 'packages' ? 'Filter health checks and profiles…' : 'Search a service by name or code… ( / )'}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
              else if (e.key === 'Enter' && items[hi]) { e.preventDefault(); add(items[hi]) }
            }} />
          {(dq.trim().length >= 2 || tab === 'packages') && (q || tab === 'packages') && items.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl scroll-thin">
              {items.map((it, i) => (
                <li key={`${it.service_id ?? it.package_id ?? it.consultant_id}`}>
                  <button type="button" onMouseEnter={() => setHi(i)} onClick={() => add(it)}
                    className={cn('flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm', i === hi ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2')}>
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{it.name}{it.follow_up && <Badge tone="cyan" className="ml-2">follow-up</Badge>}</span>
                      <span className="block truncate text-xs text-ink-3">{[it.code, it.category, it.department, it.specialization, it.inclusions?.slice(0, 4).join(', ')].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="tabular shrink-0 text-ink-2">{money(it.rate)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {tab === 'consultation' && !q && <p className="text-center text-xs text-ink-3">Type a doctor's name or code to search. A visit within the follow-up window is priced as a follow-up.</p>}
        {unbilled.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1.5 text-xs">
            <span className="text-ink-2">Captured, not yet billed:</span>
            {unbilled.map((u) => (
              <button key={u.id} type="button" className="rounded-md bg-surface px-2 py-0.5 text-ink ring-1 ring-line hover:ring-brand-600"
                onClick={() => edit((s) => ({ ...s, lines: [...s.lines, { key: newKey(), kind: 'charge', charge_id: u.id, code: u.code, name: u.description ?? 'Charge', qty: 1, rate: u.amount ?? 0, disc_type: '%', disc_value: 0, tax_percent: 0 }] }))}>
                + {u.description} · {money(u.amount)}
              </button>
            ))}
          </div>
        )}
      </div>
      {state.lines.length === 0 ? <Empty icon="ListPlus" title="No services added">Add services, a consultation or a health check above.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-line bg-surface-2 text-xs text-ink-2">
              <tr>{['#', 'Code', 'Service', 'Consultant', 'Qty', 'Rate', 'Disc', 'Value', 'Net', ''].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {state.lines.map((l, i) => (
                <tr key={l.key} className="border-b border-line last:border-0">
                  <td className="px-2 py-1 text-xs text-ink-3">{i + 1}</td>
                  <td className="px-2 py-1 font-mono text-xs text-ink-2">{l.code ?? '—'}</td>
                  <td className="px-2 py-1 text-ink">{l.name}{l.kind === 'charge' && <Badge tone="gray" className="ml-1.5">captured</Badge>}</td>
                  <td className="px-2 py-1 text-ink-2">{l.consultant_name ?? '—'}</td>
                  <td className="px-2 py-1"><Input type="number" min={1} className="h-8 w-16" value={l.qty} disabled={l.kind === 'consultation'}
                    onChange={(e) => upd(l.key, { qty: Math.max(1, Number(e.target.value) || 1) })} /></td>
                  <td className="px-2 py-1">{l.rate_editable
                    ? <Input type="number" min={0} className="h-8 w-24" value={l.rate} onChange={(e) => upd(l.key, { rate: Math.max(0, Number(e.target.value) || 0) })} />
                    : <span className="tabular text-ink-2">{money(l.rate)}</span>}</td>
                  <td className="px-2 py-1"><Select className="h-8 w-14 px-1.5" value={l.disc_type} disabled={!allowLineDiscount} onChange={(e) => upd(l.key, { disc_type: e.target.value as Line['disc_type'] })}><option>%</option><option>₹</option></Select></td>
                  <td className="px-2 py-1"><Input type="number" min={0} className="h-8 w-20" value={l.disc_value} disabled={!allowLineDiscount}
                    onChange={(e) => upd(l.key, { disc_value: Math.max(0, Number(e.target.value) || 0) })} /></td>
                  <td className="tabular px-2 py-1 text-right font-medium text-ink">{money(lineTotals.get(l.key)?.net)}</td>
                  <td className="px-2 py-1"><button type="button" className="rounded p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10" aria-label={`Remove ${l.name}`}
                    onClick={() => edit((s) => ({ ...s, lines: s.lines.filter((x) => x.key !== l.key) }))}><Trash2 className="size-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ payments

function PaymentsPanel({ state, totals, ctx, edit, ip, needsApproval, deposit, confirming, canConfirm, onConfirm }: {
  state: DraftState; totals: ReturnType<typeof computeTotals>; ctx: CounterContext; edit: (fn: (s: DraftState) => DraftState) => void; ip: boolean
  needsApproval: boolean; deposit: number; confirming: boolean; canConfirm: boolean; onConfirm: () => void
}) {
  const left = Math.max(0, Math.round(totals.balance * 100) / 100)
  const [row, setRow] = useState<PayLine>({ mode: ctx.default_payment_mode || 'CASH', amount: 0, reference: '' })
  useEffect(() => { setRow((r) => ({ ...r, amount: left })) }, [left])
  const addRow = () => {
    if (!(row.amount > 0)) return
    if (REF_MODES.has(row.mode) && !row.reference?.trim()) { toast.error(`Enter the ${row.mode} reference`); return }
    if (row.mode === 'DEPOSIT' && row.amount > deposit) { toast.error(`Only ${money(deposit)} of advance is unused`); return }
    edit((s) => ({ ...s, pay_lines: [...s.pay_lines, { ...row, reference: row.reference || null }] }))
    setRow({ mode: ctx.default_payment_mode || 'CASH', amount: 0, reference: '' })
  }
  const sel = (v: string, on: (v: '%' | '₹') => void) => <Select className="w-16 px-2" value={v} onChange={(e) => on(e.target.value as '%' | '₹')}><option>%</option><option>₹</option></Select>
  return (
    <Card title="Payments" icon="Wallet">
      <div className="space-y-3 text-sm">
        <div className="flex justify-between"><span className="text-ink-2">Patient due</span><span className="tabular font-medium">{money(totals.patient_payable)}</span></div>
        <div className="flex justify-between"><span className="text-ink-2">Sponsor due</span><span className="tabular font-medium">{money(totals.sponsor_amount)}</span></div>
        <div className="grid grid-cols-2 gap-2">
          {state.payer !== 'Self' && (
            <FieldWrap label="Patient pays" help={`Patient ${money(totals.patient_payable)} · Sponsor ${money(totals.sponsor_amount)}`}>
              <div className="flex gap-1">{sel(state.patient_share_type, (t) => edit((s) => ({ ...s, patient_share_type: t })))}
                <Input type="number" min={0} value={state.patient_share_value} onChange={(e) => edit((s) => ({ ...s, patient_share_value: Math.max(0, Number(e.target.value) || 0) }))} /></div>
            </FieldWrap>
          )}
          <FieldWrap label="Bill discount">
            <div className="flex gap-1">{sel(state.bill_disc_type, (t) => edit((s) => ({ ...s, bill_disc_type: t })))}
              <Input type="number" min={0} value={state.bill_disc_value} onChange={(e) => edit((s) => ({ ...s, bill_disc_value: Math.max(0, Number(e.target.value) || 0) }))} /></div>
          </FieldWrap>
        </div>
        {totals.discount > 0 && (
          <FieldWrap label="Discount remarks" required help={needsApproval ? `${totals.discount_percent}% is above the ${ctx.discount_approval_percent}% policy — the bill waits for approval; collect payment after approval.` : `${totals.discount_percent}% of gross`}>
            <Input value={state.discount_remarks ?? ''} placeholder="Reason…" onChange={(e) => edit((s) => ({ ...s, discount_remarks: e.target.value }))} />
          </FieldWrap>
        )}
        <div className="grid grid-cols-2 gap-2">
          <FieldWrap label="Prescribed by">
            <RefPicker refName="employees.employees" kind="doctor" filter={{ category: 'Doctor' }} value={state.prescribed_by ?? null}
              onChange={(idv) => edit((s) => ({ ...s, prescribed_by: idv }))} placeholder="Doctor" />
          </FieldWrap>
          <FieldWrap label="Lead source" required={ctx.require_lead_source}>
            <Select value={state.lead_source ?? ''} onChange={(e) => edit((s) => ({ ...s, lead_source: e.target.value || null }))}>
              <option value="">Select lead source</option>{ctx.lead_sources.map((o) => <option key={o}>{o}</option>)}
            </Select>
          </FieldWrap>
        </div>
        {state.pay_lines.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {state.pay_lines.map((pl, i) => (
              <li key={i} className="flex items-center gap-2 px-2.5 py-1.5">
                <Badge tone="blue">{pl.mode}</Badge><span className="flex-1 truncate text-xs text-ink-3">{pl.reference}</span>
                <span className="tabular font-medium">{money(pl.amount)}</span>
                <button type="button" className="rounded p-0.5 text-red-600" aria-label="Remove payment" onClick={() => edit((s) => ({ ...s, pay_lines: s.pay_lines.filter((_, j) => j !== i) }))}><X className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
        {!needsApproval && (
          <>
            <div className="text-xs text-ink-2">{ip ? 'Advance to collect' : 'Left to settle now'}: <span className="tabular font-semibold text-ink">{money(left)}</span>{deposit > 0 && <span className="ml-2 text-ink-3">· advance available {money(deposit)}</span>}</div>
            <div className="flex gap-1.5">
              <Select className="w-28" value={row.mode} onChange={(e) => setRow({ ...row, mode: e.target.value })}>
                {ctx.pay_modes.filter((m) => m !== 'DEPOSIT' || deposit > 0).map((m) => <option key={m}>{m}</option>)}
              </Select>
              <Input type="number" min={0} className="w-24" value={row.amount} onChange={(e) => setRow({ ...row, amount: Math.max(0, Number(e.target.value) || 0) })} />
              {REF_MODES.has(row.mode) && <Input className="min-w-0 flex-1" placeholder="Txn / UTR" value={row.reference ?? ''} onChange={(e) => setRow({ ...row, reference: e.target.value })} />}
              <Button variant="primary" onClick={addRow} disabled={!(row.amount > 0)}>Add</Button>
            </div>
          </>
        )}
        {!ip && (
          <Button variant="success" className="h-10 w-full" disabled={!canConfirm} loading={confirming} onClick={onConfirm}>
            <CircleCheck className="size-4" /> {needsApproval ? 'Save & send for approval' : 'Save & confirm'} (F9)
          </Button>
        )}
      </div>
    </Card>
  )
}

function Extras({ state, edit }: { state: DraftState; edit: (fn: (s: DraftState) => DraftState) => void }) {
  const [open, setOpen] = useState(!!(state.coupon_code || state.referral || state.notes))
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
        Loyalty / coupon / referral / notes <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="grid gap-3 border-t border-line p-4 sm:grid-cols-3">
          <FieldWrap label="Coupon / loyalty code"><Input value={state.coupon_code ?? ''} onChange={(e) => edit((s) => ({ ...s, coupon_code: e.target.value }))} /></FieldWrap>
          <FieldWrap label="Referral"><Input value={state.referral ?? ''} onChange={(e) => edit((s) => ({ ...s, referral: e.target.value }))} /></FieldWrap>
          <FieldWrap label="Notes (printed as remarks)"><Textarea rows={1} value={state.notes ?? ''} onChange={(e) => edit((s) => ({ ...s, notes: e.target.value }))} /></FieldWrap>
        </div>
      )}
    </div>
  )
}

function SaveTick({ state }: { state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' }) {
  if (state === 'saving') return <span className="inline-flex items-center gap-1 text-xs text-ink-3"><Loader2 className="size-3.5 animate-spin" /> Saving…</span>
  if (state === 'saved') return <span className="inline-flex items-center gap-1 text-xs text-ink-3"><Check className="size-3.5 text-emerald-600" /> Saved</span>
  if (state === 'error') return <span className="text-xs text-red-600">Not saved</span>
  if (state === 'dirty') return <span className="text-xs text-ink-3">Unsaved…</span>
  return null
}

function ConfirmedPanel({ bill, onNew, onReload }: { bill: Bill; onNew: () => void; onReload: (id: string) => void }) {
  const pending = bill.label.status === 'PENDING APPROVAL'
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4">
        <CircleCheck className={cn('size-10', pending ? 'text-amber-500' : 'text-emerald-600')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-lg font-semibold text-ink">Bill {bill.code}
            <Badge tone={pending ? 'amber' : bill.label.sub === 'PAID' ? 'green' : 'blue'}>{bill.label.status}{bill.label.sub ? ` · ${bill.label.sub}` : ''}</Badge></div>
          <div className="text-sm text-ink-2">{bill.patient.name} · {bill.patient.uhid} · Net {money(bill.net ?? bill.totals.net)} · Paid {money(bill.paid)}
            {bill.sponsor_due ? ` · Sponsor due ${money(bill.sponsor_due)}` : ''}</div>
          {pending && <div className="mt-1 text-sm text-amber-700 dark:text-amber-300">Discount approval {bill.approval?.code} is with {bill.approval?.approver_role}. Collect the payment from the OP bills register once it is approved.</div>}
          {(bill.payments ?? []).length > 0 && <div className="mt-1 text-xs text-ink-3">Receipts: {(bill.payments ?? []).map((p) => `${p.code} ${p.mode} ${money(p.amount)}`).join(' · ')}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!pending && <Button icon="Printer" onClick={() => window.open(`/op/bills/${bill.id}/print`, '_blank')}>Print</Button>}
          <Button icon="RefreshCw" onClick={() => onReload(bill.id)}>Refresh</Button>
          <Button variant="primary" icon="Plus" onClick={onNew}>New bill</Button>
        </div>
      </div>
    </Card>
  )
}

