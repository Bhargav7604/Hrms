import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Avatar, Badge, Button, Card, cn, Empty, ErrorBox, FieldWrap, Input, Kbd, Segmented, Spinner, StatusBadge, Textarea, type BadgeTone } from '@/components/ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { ago, dateTime, minutes, money } from '@/lib/format'
import type { BespokeProps } from './index'

type Category = 'LAB' | 'RAD' | 'PROC'
type Priority = 'Routine' | 'Urgent' | 'STAT'

interface Svc {
  id: string; code: string; name: string; category: Category; rate?: number | null; tat_minutes?: number | null
  sample_type?: string | null; container?: string | null; modality?: string | null; body_part?: string | null
  contrast?: boolean; prep_instructions?: string | null; section?: string | null
}
interface OrderSet { key: string; name: string; description: string; priority: Priority; items: Svc[]; missing: string[] }
interface Catalogue { services: Svc[]; order_sets: OrderSet[] }
interface OrderRow {
  id: string; code: string; status: string; category: string; priority: string; test: { id: string | null; name: string | null }
  ordered_at: string; critical: boolean; acknowledged_at?: string | null; result_values: { parameter: string; value: string; flag?: string | null }[]
  result?: string | null; impression?: string | null; ordering_doctor?: string | null; location: string
}
interface Context {
  patient: { id: string; uhid: string; name: string; title?: string; gender?: string | null; age?: number | null; status?: string; blood_group?: string | null; payer_type?: string | null }
  allergies: string[]
  encounter: { id: string; code: string; type: string; status: string; bed?: string | null; ward?: string | null; doctor?: string | null; diagnosis?: string | null } | null
  recent: OrderRow[]
}
interface Line { svc: Svc; priority: Priority; notes: string }
interface DupWarning { service_id: string; test: string; code: string; status: string; ordered_at: string }

const CATEGORY_TONE: Record<string, BadgeTone> = { LAB: 'cyan', RAD: 'violet', PROC: 'blue' }
const PRIORITY_TONE: Record<string, BadgeTone> = { STAT: 'red', Urgent: 'amber', Routine: 'gray' }
const PRIORITIES: Priority[] = ['Routine', 'Urgent', 'STAT']

export default function Cpoe(_: BespokeProps) {
  const [params, setParams] = useSearchParams()
  const pid = params.get('patient')
  const setPatient = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('patient', id); else p.delete('patient')
    setParams(p)
  }
  const ctx = useQuery({
    queryKey: ['x', 'orders', 'context', pid],
    queryFn: () => api<Context>(`/orders/patient/${pid}/context`),
    enabled: !!pid,
  })
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <FieldWrap label="Patient" className="w-full max-w-md">
            <RefPicker refName="registration.patients" kind="patient" value={pid} onChange={(id) => setPatient(id)} placeholder="Search UHID, name or mobile" />
          </FieldWrap>
          {ctx.data && <PatientStrip c={ctx.data} />}
        </div>
      </Card>
      {!pid && <Empty icon="ListPlus" title="Choose a patient to start ordering">Lab tests, imaging and procedures are charged automatically when signed, and duplicates within 24 hours are flagged.</Empty>}
      {ctx.isLoading && <Spinner />}
      {ctx.error && <ErrorBox error={ctx.error} />}
      {ctx.data && <OrderEntry key={ctx.data.patient.id} c={ctx.data} />}
      {ctx.data && <RecentOrders rows={ctx.data.recent} />}
    </div>
  )
}

function PatientStrip({ c }: { c: Context }) {
  const p = c.patient
  const e = c.encounter
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2">
      <Avatar name={p.name} size="sm" />
      <div className="min-w-0">
        <Link to={`/patients/${p.id}`} className="font-medium text-ink hover:underline">{p.title || p.name}</Link>
        <div className="text-xs text-ink-2"><span className="font-mono">{p.uhid}</span>{p.age != null && ` · ${p.age}y`}{p.gender && ` ${p.gender}`}{p.blood_group && ` · ${p.blood_group}`}</div>
      </div>
      <div className="text-xs text-ink-2">
        {e ? <>{e.type === 'IPD' ? <b className="text-ink">{[e.ward, e.bed].filter(Boolean).join(' · ') || 'Inpatient'}</b> : <b className="text-ink">Emergency</b>} · {e.code}{e.doctor && ` · ${e.doctor}`}</> : 'Outpatient (no active admission)'}
        {e?.diagnosis && <div className="truncate">Dx: {e.diagnosis}</div>}
      </div>
      {c.allergies.length > 0
        ? <Badge tone="red" className="ml-auto">Allergies: {c.allergies.join(', ')}</Badge>
        : <Badge tone="green" className="ml-auto">No known allergies</Badge>}
    </div>
  )
}

function OrderEntry({ c }: { c: Context }) {
  const qc = useQueryClient()
  const role = useMeta().data?.user.role ?? ''
  const isDoctor = role === 'doctor'
  const cat = useQuery({ queryKey: ['x', 'orders', 'catalogue'], queryFn: () => api<Catalogue>('/orders/catalogue'), staleTime: 10 * 60_000 })
  const [lines, setLines] = useState<Line[]>([])
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<'ALL' | Category>('ALL')
  const [active, setActive] = useState(0)
  const [indication, setIndication] = useState('')
  const [orderSet, setOrderSet] = useState<string | null>(null)
  const [doctor, setDoctor] = useState<string | null>(null)
  const [serverDup, setServerDup] = useState<DupWarning[] | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => { searchRef.current?.focus() }, [])

  const inCart = useMemo(() => new Set(lines.map((l) => l.svc.id)), [lines])
  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (cat.data?.services ?? []).filter((s) => (category === 'ALL' || s.category === category)
      && (!term || s.name.toLowerCase().includes(term) || s.code.toLowerCase().includes(term) || (s.section ?? '').toLowerCase().includes(term)))
  }, [cat.data, q, category])
  const grouped = useMemo(() => {
    const m = new Map<string, Svc[]>()
    for (const s of results) {
      const k = `${s.category}${s.section ? ` · ${s.section}` : ''}`
      m.set(k, [...(m.get(k) ?? []), s])
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [results])
  const flat = useMemo(() => grouped.flatMap(([, v]) => v), [grouped])
  useEffect(() => { setActive(0) }, [q, category])

  const recentDup = useMemo(() => {
    const cutoff = Date.now() - 24 * 3600_000
    const m = new Map<string, OrderRow>()
    for (const o of c.recent) if (o.test.id && o.status !== 'Cancelled' && new Date(o.ordered_at).getTime() >= cutoff && !m.has(o.test.id)) m.set(o.test.id, o)
    return m
  }, [c.recent])
  const contrastAllergy = c.allergies.some((a) => /contrast|iodin/i.test(a))

  const add = (s: Svc, priority: Priority = 'Routine') => {
    if (inCart.has(s.id)) return
    setLines((cur) => [...cur, { svc: s, priority, notes: '' }])
    setServerDup(null)
  }
  const addSet = (set: OrderSet) => {
    const fresh = set.items.filter((s) => !inCart.has(s.id))
    setLines((cur) => [...cur, ...fresh.map((s) => ({ svc: s, priority: set.priority, notes: '' }))])
    setOrderSet(set.name)
    setServerDup(null)
    toast.message(`${set.name}: ${fresh.length} test${fresh.length === 1 ? '' : 's'} added${set.items.length - fresh.length ? `, ${set.items.length - fresh.length} already in the order` : ''}`)
  }
  const update = (id: string, patch: Partial<Line>) => setLines((cur) => cur.map((l) => (l.svc.id === id ? { ...l, ...patch } : l)))

  const submit = useMutation({
    mutationFn: (confirm: boolean) => api<{ count: number; amount: number; orders: { code: string }[] }>('/orders/cpoe', {
      method: 'POST',
      body: {
        patient_id: c.patient.id, encounter_id: c.encounter?.id, clinical_notes: indication || undefined, order_set: orderSet,
        ordering_doctor: isDoctor ? undefined : doctor, confirm_duplicates: confirm,
        items: lines.map((l) => ({ service_id: l.svc.id, priority: l.priority, clinical_notes: l.notes || undefined })),
      },
    }),
    onSuccess: (r) => {
      toast.success(`${r.count} order${r.count === 1 ? '' : 's'} signed · ${money(r.amount)} charged to the patient account`)
      setLines([]); setIndication(''); setOrderSet(null); setServerDup(null)
      qc.invalidateQueries({ queryKey: ['x', 'orders'] })
      qc.invalidateQueries({ queryKey: ['m', 'orders'] })
      qc.invalidateQueries({ queryKey: ['patient', c.patient.id] })
      searchRef.current?.focus()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE_ORDER') setServerDup((e.details?.warnings as DupWarning[]) ?? [])
      else toast.error(errorMessage(e))
    },
  })
  const needsDoctor = !isDoctor && role !== 'admin' && !doctor
  const total = lines.reduce((s, l) => s + Number(l.svc.rate || 0), 0)
  const canSubmit = lines.length > 0 && !needsDoctor && !submit.isPending

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (canSubmit) submit.mutate(false) }
    else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); add(flat[active]); setQ('') }
  }

  if (cat.isLoading) return <Spinner label="Loading catalogue…" />
  if (cat.error) return <ErrorBox error={cat.error} />

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card title="Test & service catalogue" icon="FlaskConical" pad={false}>
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
              <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} className="pl-8"
                placeholder="Search tests, scans, procedures…" aria-label="Search catalogue" />
            </div>
            <Segmented value={category} onChange={setCategory} options={[
              { key: 'ALL', label: 'All' }, { key: 'LAB', label: 'Lab' }, { key: 'RAD', label: 'Imaging' }, { key: 'PROC', label: 'Procedures' },
            ]} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {cat.data!.order_sets.map((s) => (
              <button key={s.key} type="button" title={`${s.description}\n${s.items.map((i) => i.name).join(', ')}`} onClick={() => addSet(s)}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800 ring-1 ring-inset ring-brand-700/20 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-200">
                <Plus className="size-3" />{s.name} <span className="opacity-70">({s.items.length})</span>
                {s.priority === 'STAT' && <span className="rounded bg-red-600 px-1 text-[9px] font-bold text-white">STAT</span>}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-ink-3"><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move · <Kbd>Enter</Kbd> to add · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> to sign</p>
        </div>
        <div className="max-h-[520px] overflow-y-auto scroll-thin">
          {flat.length === 0 && <Empty icon="SearchX" title="No matching tests" />}
          {grouped.map(([g, items]) => (
            <div key={g}>
              <div className="sticky top-0 z-[1] border-b border-line bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g}</div>
              {items.map((s) => {
                const idx = flat.indexOf(s)
                const added = inCart.has(s.id)
                const dup = recentDup.get(s.id)
                return (
                  <button key={s.id} type="button" onClick={() => add(s)} onMouseEnter={() => setActive(idx)} disabled={added}
                    className={cn('flex w-full items-center justify-between gap-3 border-b border-line px-3 py-1.5 text-left text-sm last:border-0',
                      idx === active ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-2', added && 'opacity-60')}>
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{s.name}</span>
                      <span className="block truncate text-xs text-ink-3">
                        {s.code}{s.sample_type ? ` · ${s.sample_type}` : ''}{s.modality ? ` · ${s.modality}` : ''}{s.contrast ? ' · contrast' : ''}{s.tat_minutes ? ` · TAT ${minutes(s.tat_minutes)}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {dup && <Badge tone="amber">ordered {ago(dup.ordered_at)}</Badge>}
                      <span className="tabular text-xs text-ink-2">{money(s.rate, true)}</span>
                      {added ? <Check className="size-4 text-emerald-600" /> : <Plus className="size-4 text-ink-3" />}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </Card>

      <Card title={`Order (${lines.length})`} icon="ClipboardList" pad={false}
        actions={lines.length > 0 && <Button size="xs" variant="ghost" onClick={() => { setLines([]); setOrderSet(null); setServerDup(null) }}>Clear</Button>}>
        {lines.length === 0 ? (
          <Empty icon="ClipboardList" title="No tests added yet">Search the catalogue or pick an order set.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((l) => {
              const dup = recentDup.get(l.svc.id)
              return (
                <li key={l.svc.id} className={cn('px-3 py-2', l.priority === 'STAT' && 'bg-red-50/60 dark:bg-red-500/5')}>
                  <div className="flex items-center gap-2">
                    <Badge tone={CATEGORY_TONE[l.svc.category] ?? 'gray'}>{l.svc.category}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{l.svc.name}</span>
                    <div className="inline-flex rounded-lg border border-line-2 bg-surface-2 p-0.5" role="radiogroup" aria-label={`Priority for ${l.svc.name}`}>
                      {PRIORITIES.map((p) => (
                        <button key={p} type="button" role="radio" aria-checked={l.priority === p} onClick={() => update(l.svc.id, { priority: p })}
                          className={cn('rounded-md px-2 py-0.5 text-xs font-medium', l.priority === p
                            ? p === 'STAT' ? 'bg-red-600 text-white' : p === 'Urgent' ? 'bg-amber-500 text-white' : 'bg-surface text-ink shadow-sm ring-1 ring-line'
                            : 'text-ink-2 hover:text-ink')}>{p}</button>
                      ))}
                    </div>
                    <span className="w-16 text-right text-xs tabular text-ink-2">{money(l.svc.rate, true)}</span>
                    <button type="button" className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-red-600" aria-label={`Remove ${l.svc.name}`}
                      onClick={() => setLines((cur) => cur.filter((x) => x.svc.id !== l.svc.id))}><X className="size-4" /></button>
                  </div>
                  <Input className="mt-1.5 h-8 text-xs" value={l.notes} onChange={(e) => update(l.svc.id, { notes: e.target.value })}
                    placeholder="Clinical indication for this test (optional — defaults to the indication below)" />
                  {dup && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Already ordered {ago(dup.ordered_at)} — {dup.code} ({dup.status})</p>}
                  {l.svc.contrast && contrastAllergy && <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">Contrast study — patient has a recorded contrast / iodine allergy</p>}
                  {l.svc.prep_instructions && <p className="mt-1 text-xs text-ink-3">Prep: {l.svc.prep_instructions}</p>}
                </li>
              )
            })}
          </ul>
        )}
        <div className="space-y-3 border-t border-line p-3">
          <FieldWrap label="Clinical indication / provisional diagnosis">
            <Textarea rows={2} value={indication} onChange={(e) => setIndication(e.target.value)} placeholder={c.encounter?.diagnosis ?? 'e.g. Fever 5 days, suspected dengue'} />
          </FieldWrap>
          {!isDoctor && (
            <FieldWrap label="Ordering doctor (verbal / telephone order)" required={role !== 'admin'} help="Verbal orders must be countersigned by the doctor within 24 hours.">
              <RefPicker refName="employees.employees" filter={{ category: 'Doctor' }} value={doctor} onChange={(id) => setDoctor(id)} placeholder="Search doctor" />
            </FieldWrap>
          )}
          {serverDup && serverDup.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
              <p className="font-medium text-amber-900 dark:text-amber-200">Already ordered in the last 24 hours:</p>
              <ul className="mt-1 space-y-0.5 text-xs text-amber-900 dark:text-amber-200">
                {serverDup.map((w) => <li key={w.code}>{w.test} — {w.code}, {w.status}, {dateTime(w.ordered_at)}</li>)}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="warning" loading={submit.isPending} onClick={() => submit.mutate(true)}>Order anyway</Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  const ids = new Set(serverDup.map((w) => w.service_id))
                  setLines((cur) => cur.filter((l) => !ids.has(l.svc.id))); setServerDup(null)
                }}>Remove duplicates</Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-ink-2">
              {lines.length} test{lines.length === 1 ? '' : 's'} · estimated <b className="text-ink">{money(total)}</b>
              {orderSet && <span className="ml-2 text-xs text-ink-3">({orderSet})</span>}
              {lines.some((l) => l.priority === 'STAT') && <Badge tone="red" className="ml-2">STAT — lab / radiology alerted</Badge>}
            </div>
            <Button variant="primary" icon="FileCheck" disabled={!canSubmit} loading={submit.isPending && !serverDup} onClick={() => submit.mutate(false)}>
              Sign & submit
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function RecentOrders({ rows }: { rows: OrderRow[] }) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'resulted'>('all')
  const shown = rows.filter((r) => filter === 'all' || (filter === 'pending' ? !['Resulted', 'Verified', 'Cancelled'].includes(r.status) : ['Resulted', 'Verified'].includes(r.status)))
  return (
    <Card title="Orders in the last 30 days" icon="RotateCcwClock" pad={false}
      actions={<Segmented value={filter} onChange={setFilter} options={[{ key: 'all', label: 'All' }, { key: 'pending', label: 'Pending' }, { key: 'resulted', label: 'Resulted' }]} />}>
      {shown.length === 0 ? <Empty icon="RotateCcwClock" title="No orders" /> : (
        <div className="max-h-96 overflow-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-line bg-surface-2 text-xs text-ink-2">
              <tr>{['Ordered', 'Order', 'Test', 'Priority', 'Status', 'Result', 'By'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const abnormal = o.result_values.filter((v) => v.flag && v.flag !== 'Normal')
                return (
                  <tr key={o.id} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-2">{dateTime(o.ordered_at)}</td>
                    <td className="px-3 py-1.5"><Link className="font-mono text-xs text-brand-700 hover:underline dark:text-brand-300" to={`/m/orders/orders?r=${o.id}`}>{o.code}</Link></td>
                    <td className="px-3 py-1.5"><Badge tone={CATEGORY_TONE[o.category] ?? 'gray'} className="mr-1.5">{o.category}</Badge>{o.test.name}</td>
                    <td className="px-3 py-1.5"><Badge tone={PRIORITY_TONE[o.priority] ?? 'gray'}>{o.priority}</Badge></td>
                    <td className="px-3 py-1.5"><StatusBadge status={o.status} /></td>
                    <td className="max-w-xs truncate px-3 py-1.5 text-xs">
                      {o.critical && <Badge tone="red" className="mr-1">{o.acknowledged_at ? 'Critical · ack' : 'CRITICAL'}</Badge>}
                      {abnormal.length > 0 ? abnormal.slice(0, 3).map((v) => `${v.parameter} ${v.value} (${v.flag})`).join('; ')
                        : o.impression || (o.result_values.length ? 'Within normal limits' : o.result ? o.result.slice(0, 60) : '—')}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-2">{o.ordering_doctor ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
