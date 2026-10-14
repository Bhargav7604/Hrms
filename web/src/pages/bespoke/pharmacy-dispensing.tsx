import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { RefPicker, useDebounced } from '@/components/fields'
import { EntityView, useEntity } from '@/components/records'
import {
  Avatar, Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Segmented, Select, Spinner, StatusBadge, Tabs, Textarea, type BadgeTone,
} from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { date, dateTime, money } from '@/lib/format'
import type { Rec } from '@/lib/types'
import type { BespokeProps } from './index'

type Store = 'OP Pharmacy' | 'IP Pharmacy'
interface QItem {
  item_id: string; name: string; dose?: string; route?: string; frequency?: string; duration_days?: number; instructions?: string
  prescribed: number; dispensed: number; remaining: number; uom?: string; mrp?: number; schedule?: string; high_alert?: boolean
}
interface QRow {
  id: string; code: string; status: string; prescribed_at?: string; diagnosis?: string; notes?: string; valid_till?: string; doctor?: string
  patient: { id: string; name: string; uhid: string; age?: number | null; gender?: string | null; allergies: string[]; phone?: string } | null
  encounter_id?: string | null; admission?: { id: string; code: string } | null; items: QItem[]; pending_lines: number; controlled: boolean; high_alert: boolean
}
interface Queue { store: Store; counts: Record<Store, number>; rows: QRow[] }
interface Batch { batch: string | null; expiry?: string | null; days_left?: number | null; qty: number; mrp: number }
interface Alloc { batch: string | null; expiry?: string | null; qty: number; mrp: number; amount: number }
interface PlanLine {
  item_id: string; name: string; uom?: string; qty: number; batch?: string | null; batches: Batch[]; allocation: Alloc[]; allocated: number; amount: number
  mrp?: number; schedule?: string; high_alert?: boolean; on_prescription: boolean; remaining?: number | null; dose?: string; frequency?: string
  duration_days?: number; instructions?: string
}
interface Alert { type: string; label: string; severity: 'Contraindicated' | 'Major' | 'Moderate' | 'Minor'; item: string; with?: string | null; message: string; blocking: boolean }
interface Plan { lines: PlanLine[]; alerts: Alert[]; summary: { blocking: number; severe: number; requires_override: boolean }; total: number; allergies?: string[] }
interface Line { item_id: string; qty: number; batch: string | null }

const SEVERITY_TONE: Record<string, BadgeTone> = { Contraindicated: 'red', Major: 'red', Moderate: 'amber', Minor: 'gray' }
const CONTROLLED = ['H1', 'X', 'Narcotic']

export default function PharmacyDispensing(_: BespokeProps) {
  const [tab, setTab] = useState<'dispense' | 'returns' | 'indents' | 'history' | 'alerts'>('dispense')
  const returns = useEntity('pharmacy.returns')
  const indents = useEntity('pharmacy.indents')
  const dispenses = useEntity('pharmacy.dispenses')
  const interventions = useEntity('pharmacy.interventions')
  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'dispense', label: 'Dispense', icon: 'ShoppingBag' },
        { key: 'returns', label: 'Returns', icon: 'Undo2' },
        { key: 'indents', label: 'Ward indents', icon: 'ClipboardList' },
        { key: 'history', label: 'Dispensed', icon: 'History' },
        { key: 'alerts', label: 'Rx interventions', icon: 'ShieldAlert' },
      ]} />
      {tab === 'dispense' && <DispenseDesk />}
      {tab === 'returns' && returns && <EntityView entity={returns} defaultStatus="Requested" />}
      {tab === 'indents' && indents && <EntityView entity={indents} defaultStatus="Raised" />}
      {tab === 'history' && dispenses && <EntityView entity={dispenses} />}
      {tab === 'alerts' && interventions && <EntityView entity={interventions} />}
    </div>
  )
}

function DispenseDesk() {
  const [store, setStore] = useState<Store>('OP Pharmacy')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [sel, setSel] = useState<string | null>(null)
  const [walkIn, setWalkIn] = useState<string | null | false>(false)
  const queue = useQuery({
    queryKey: ['x', 'pharmacy', 'queue', store, dq],
    queryFn: () => api<Queue>('/pharmacy/queue', { query: { store, q: dq || undefined, days: 7 } }),
    refetchInterval: 30_000,
    placeholderData: (p) => p,
  })
  const rows = queue.data?.rows ?? []
  const current = rows.find((r) => r.id === sel) ?? null
  const counts = queue.data?.counts
  return (
    <div className="grid gap-4 lg:grid-cols-[23rem_minmax(0,1fr)]">
      <Card pad={false}>
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <Segmented value={store} onChange={(s) => { setStore(s); setSel(null); setWalkIn(false) }} options={[
              { key: 'OP Pharmacy', label: `OP pharmacy${counts ? ` · ${counts['OP Pharmacy']}` : ''}` },
              { key: 'IP Pharmacy', label: `IP pharmacy${counts ? ` · ${counts['IP Pharmacy']}` : ''}` },
            ]} />
            <Button size="xs" icon="UserPlus" onClick={() => { setSel(null); setWalkIn(null) }}>{store === 'OP Pharmacy' ? 'Walk-in' : 'Without Rx'}</Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Rx, patient, diagnosis…" className="pl-8" />
          </div>
        </div>
        {queue.isLoading && <Spinner />}
        {queue.error && <div className="p-3"><ErrorBox error={queue.error} /></div>}
        {queue.data && rows.length === 0 && <Empty icon="Pill" title="No prescriptions waiting">New e-prescriptions from the last 7 days appear here automatically.</Empty>}
        <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto scroll-thin">
          {rows.map((r) => (
            <li key={r.id}>
              <button onClick={() => { setSel(r.id); setWalkIn(false) }}
                className={cn('w-full px-3 py-2 text-left hover:bg-surface-2', sel === r.id && 'bg-brand-50 dark:bg-brand-500/10')}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.patient?.name}</span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="truncate text-xs text-ink-3">{r.code} · {r.patient?.uhid} · {r.doctor ?? '—'} · {dateTime(r.prescribed_at)}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge tone="gray">{r.pending_lines} item{r.pending_lines === 1 ? '' : 's'} pending</Badge>
                  {r.admission && <Badge tone="blue">IP {r.admission.code}</Badge>}
                  {r.controlled && <Badge tone="violet">Controlled</Badge>}
                  {r.high_alert && <Badge tone="red">High-alert</Badge>}
                  {(r.patient?.allergies ?? []).length > 0 && <Badge tone="red">Allergy</Badge>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <div className="min-w-0">
        {current ? <DispenseScreen key={`${current.id}-${store}`} store={store} rx={current} patientId={current.patient!.id} onDone={() => setSel(null)} />
          : walkIn !== false ? <WalkIn store={store} patientId={walkIn} setPatient={setWalkIn} />
            : <Card><Empty icon="ShoppingBag" title="Select a prescription to dispense">Batches are picked first-expiry-first-out; allergy, interaction and duplicate-therapy checks run before every dispense.</Empty></Card>}
      </div>
    </div>
  )
}

function WalkIn({ store, patientId, setPatient }: { store: Store; patientId: string | null; setPatient: (id: string | null) => void }) {
  return (
    <div className="space-y-3">
      <Card>
        <FieldWrap label="Patient" help={store === 'IP Pharmacy' ? 'Only admitted patients can be dispensed from the IP pharmacy.' : 'Schedule H drugs need a prescription; H1 / X / narcotics cannot be sold without one.'}>
          <RefPicker refName="registration.patients" kind="patient" value={patientId} onChange={(id) => setPatient(id)} placeholder="Search UHID, name or mobile" />
        </FieldWrap>
      </Card>
      {patientId && <DispenseScreen key={`${patientId}-${store}`} store={store} rx={null} patientId={patientId} onDone={() => setPatient(null)} />}
    </div>
  )
}

function DispenseScreen({ store, rx, patientId, onDone }: { store: Store; rx: QRow | null; patientId: string; onDone: () => void }) {
  const qc = useQueryClient()
  const [lines, setLines] = useState<Line[] | null>(rx ? null : [])
  const [names, setNames] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [counselled, setCounselled] = useState(false)
  const key = useDebounced(JSON.stringify(lines), 350)
  const plan = useQuery({
    queryKey: ['x', 'pharmacy', 'plan', store, rx?.id ?? null, patientId, key],
    queryFn: () => api<Plan>('/pharmacy/plan', {
      method: 'POST', body: { patient_id: patientId, store, prescription_id: rx?.id, items: key === 'null' ? undefined : JSON.parse(key) },
    }),
    placeholderData: (p) => p,
    enabled: key !== '[]',
  })
  useEffect(() => {
    if (lines === null && plan.data) setLines(plan.data.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, batch: null })))
  }, [lines, plan.data])
  const valid = (lines ?? []).filter((l) => l.qty > 0)
  const data = lines === null || valid.length ? plan.data : undefined  // ignore a stale plan once every line is removed
  const byItem = useMemo(() => new Map((data?.lines ?? []).map((l) => [`${l.item_id}|${l.batch ?? ''}`, l])), [data])
  const alerts = data?.alerts ?? []
  const blocking = alerts.filter((a) => a.blocking)
  const severe = alerts.filter((a) => !a.blocking && (a.severity === 'Major' || a.severity === 'Contraindicated'))
  const stale = key !== JSON.stringify(lines) || plan.isFetching
  const dispense = useMutation({
    mutationFn: () => api<{ dispense: Rec; total: number; prescription_status?: string }>('/pharmacy/dispense', {
      method: 'POST', body: {
        patient_id: patientId, store, prescription_id: rx?.id, encounter_id: rx?.encounter_id ?? undefined,
        items: valid.map((l) => ({ item_id: l.item_id, qty: l.qty, batch: l.batch || undefined })),
        override_reason: reason.trim() || undefined, counselled,
      },
    }),
    onSuccess: (r) => {
      toast.success(`Dispensed ${r.dispense.code} · ${money(r.total)} charged to the patient's account${r.prescription_status ? ` · Rx ${r.prescription_status}` : ''}`)
      qc.invalidateQueries({ queryKey: ['x', 'pharmacy'] })
      qc.invalidateQueries({ queryKey: ['x', 'inventory'] })
      onDone()
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === 'OVERRIDE_REQUIRED' ? `${e.message}` : errorMessage(e)),
  })
  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => (ls ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const p = rx?.patient
  return (
    <div className="space-y-3">
      {rx && p && (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3">
          <Avatar name={p.name} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/patients/${p.id}`} className="font-semibold text-ink hover:underline">{p.name}</Link>
              <span className="font-mono text-xs text-ink-2">{p.uhid}</span>
              <span className="text-sm text-ink-2">{[p.age !== null && p.age !== undefined ? `${p.age}y` : null, p.gender].filter(Boolean).join(' · ')}</span>
              {rx.admission && <Badge tone="blue">Admitted · {rx.admission.code}</Badge>}
            </div>
            <div className="text-xs text-ink-2">{rx.code} · {rx.doctor} · {dateTime(rx.prescribed_at)}{rx.diagnosis ? ` · ${rx.diagnosis}` : ''}{rx.valid_till ? ` · valid till ${date(rx.valid_till)}` : ''}</div>
            {rx.notes && <div className="text-xs text-ink-3">Note: {rx.notes}</div>}
          </div>
          <div className="flex flex-wrap gap-1">{(data?.allergies ?? p.allergies).map((a) => <Badge key={a} tone="red">Allergy: {a}</Badge>)}</div>
        </div>
      )}
      <Card title="Dispense" icon="ShoppingBag" pad={false} actions={<span className="text-xs text-ink-3">{store}</span>}>
        {plan.error && <div className="p-3"><ErrorBox error={plan.error} /></div>}
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>{['Medicine', 'Rx remaining', 'Qty', 'Batch (FEFO)', 'Picked', 'MRP', 'Amount', ''].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(lines ?? []).map((l, i) => {
                const pl = byItem.get(`${l.item_id}|${l.batch ?? ''}`)
                const short = pl && pl.allocated < l.qty
                return (
                  <tr key={`${l.item_id}-${i}`} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-ink">{pl?.name ?? names[l.item_id] ?? '…'}</span>
                        {pl?.schedule && CONTROLLED.includes(pl.schedule) && <Badge tone="violet">{pl.schedule}</Badge>}
                        {pl?.high_alert && <Badge tone="red">High-alert</Badge>}
                        {pl && !pl.on_prescription && rx && <Badge tone="amber">Not on Rx</Badge>}
                      </div>
                      {pl?.dose && <div className="text-xs text-ink-3">{[pl.dose, pl.frequency, pl.duration_days ? `${pl.duration_days} d` : null, pl.instructions].filter(Boolean).join(' · ')}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular text-ink-2">{pl?.remaining ?? '—'} {pl?.uom ?? ''}</td>
                    <td className="w-24 px-2 py-1.5"><Input type="number" min={0} className="tabular" value={l.qty} onChange={(e) => upd(i, { qty: Number(e.target.value) })} invalid={!!short} /></td>
                    <td className="w-56 px-2 py-1.5">
                      <Select value={l.batch ?? ''} onChange={(e) => upd(i, { batch: e.target.value || null })}>
                        <option value="">Auto (first expiry first)</option>
                        {(pl?.batches ?? []).map((b) => (
                          <option key={b.batch ?? ''} value={b.batch ?? ''}>{b.batch} · exp {b.expiry ? date(b.expiry) : '—'} · {b.qty} left</option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {pl?.allocation.map((a) => (
                        <div key={a.batch ?? ''} className="whitespace-nowrap text-ink-2">{a.batch} × {a.qty} <span className={cn((a.expiry && new Date(a.expiry).getTime() - Date.now() < 90 * 864e5) ? 'text-amber-700 dark:text-amber-300' : 'text-ink-3')}>exp {a.expiry ? date(a.expiry) : '—'}</span></div>
                      ))}
                      {short && <div className="text-red-600 dark:text-red-300">Short by {l.qty - pl!.allocated}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular text-ink-2">{money(pl?.mrp)}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular font-medium text-ink">{money(pl?.amount)}</td>
                    <td className="px-2 py-2"><button aria-label="Remove line" className="rounded p-1 text-ink-3 hover:bg-red-50 hover:text-red-600"
                      onClick={() => setLines((ls) => (ls ?? []).filter((_, j) => j !== i))}><Trash2 className="size-4" /></button></td>
                  </tr>
                )
              })}
              {lines !== null && lines.length === 0 && <tr><td colSpan={8} className="px-3 py-4 text-center text-sm text-ink-3">{rx ? 'Everything on this prescription has been dispensed.' : 'Add medicines to dispense.'}</td></tr>}
              {lines === null && <tr><td colSpan={8}><Spinner /></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
          <div className="w-80">
            <RefPicker refName="mdm.items" filter={{ type: 'Drug', status: 'Active' }} value={null} placeholder="Add a medicine…"
              onChange={(id, row) => {
                if (!id) return
                setNames((n) => ({ ...n, [id]: row?.title ?? row?.label ?? '' }))
                setLines((ls) => [...(ls ?? []), { item_id: id, qty: 1, batch: null }])
              }} />
          </div>
          <span className="ml-auto text-sm text-ink-2">Total <span className="text-lg font-semibold tabular text-ink">{money(data?.total ?? 0)}</span></span>
        </div>
      </Card>
      {alerts.length > 0 && (
        <Card title="Safety checks" icon="ShieldAlert">
          <ul className="space-y-1.5">
            {alerts.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
                <span className="text-xs text-ink-3">{a.label}</span>
                <span className="min-w-0 flex-1 text-ink">{a.message}</span>
                {a.blocking && <Badge tone="red">Blocks dispensing</Badge>}
              </li>
            ))}
          </ul>
          {severe.length > 0 && blocking.length === 0 && (
            <FieldWrap label="Override reason (recorded in the audit trail and the Rx intervention log)" required className="mt-3"
              help="e.g. Prescriber contacted — continue; monitored with INR">
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} invalid={reason.trim().length > 0 && reason.trim().length < 5} />
            </FieldWrap>
          )}
        </Card>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <label className="mr-auto flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" className="size-4 accent-brand-700" checked={counselled} onChange={(e) => setCounselled(e.target.checked)} />
          Patient / attendant counselled on dose, timing and side-effects
        </label>
        <Button variant="primary" icon="PackageCheck" loading={dispense.isPending}
          disabled={!valid.length || stale || blocking.length > 0 || (severe.length > 0 && reason.trim().length < 5)}
          onClick={() => dispense.mutate()}>
          Dispense {data ? money(data.total) : ''}
        </Button>
      </div>
    </div>
  )
}
