import { useMutation, useQuery } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RefPicker } from '@/components/fields'
import { Badge, Button, Card, cn, Empty, FieldWrap, Input, Select, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { dateTime, minutes, money, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { Rec } from '@/lib/types'
import { useErRefresh, type VisitDetail } from '../api'
import { useVisitOrders, type OrderRow } from './Overview'

interface Svc { id: string; code: string; name: string; category: string; rate?: number; tat_minutes?: number; section?: string | null; sample_type?: string | null; modality?: string | null }
interface OrderSet { key: string; name: string; description: string; priority: string; items: Svc[] }
type Priority = 'Routine' | 'Urgent' | 'STAT'

function useCatalogue() {
  return useQuery({ queryKey: ['x', 'orders', 'catalogue'], queryFn: () => api<{ services: Svc[]; order_sets: OrderSet[] }>('/orders/catalogue'), staleTime: 10 * 60_000 })
}

// ------------------------------------------------------------------ CPOE (investigations / procedures)

export function OrderEntry({ d, kind }: { d: VisitDetail; kind: 'investigations' | 'procedures' }) {
  const p = d.permissions
  const cats = kind === 'investigations' ? ['LAB', 'RAD'] : ['PROC']
  const q = useVisitOrders(d.summary.id)
  const rows = (kind === 'investigations' ? q.data?.investigations : q.data?.procedures) ?? []
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {p.orders && <OrderForm d={d} cats={cats} title={kind === 'investigations' ? 'Order investigations' : 'Order procedures & services'} />}
      <Card icon={kind === 'investigations' ? 'FlaskConical' : 'Scissors'} title={kind === 'investigations' ? 'Investigations on this visit' : 'Procedures & services on this visit'} pad={false}
        className={cn(!p.orders && 'xl:col-span-2')}>
        {q.isLoading ? <Spinner /> : !rows.length ? <Empty icon="FlaskConical" title={kind === 'investigations' ? 'No investigations ordered yet' : 'No procedures yet'} /> : <OrderTable rows={rows} />}
      </Card>
    </div>
  )
}

function OrderTable({ rows }: { rows: OrderRow[] }) {
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-surface-2 text-left text-[11px] uppercase text-ink-3">
          <tr>{['Order', 'Test', 'Priority', 'Ordered', 'TAT', 'Status'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="px-3 py-1.5 text-xs text-ink-3">{o.code}</td>
              <td className="px-3 py-1.5 text-ink">{o.test.name}{o.critical && <Badge tone="red" className="ml-1">Critical</Badge>}</td>
              <td className="px-3 py-1.5">{o.priority === 'Routine' ? <span className="text-xs text-ink-3">Routine</span> : <Badge tone={o.priority === 'STAT' ? 'red' : 'amber'}>{o.priority}</Badge>}</td>
              <td className="px-3 py-1.5 text-xs text-ink-2">{dateTime(o.ordered_at)}</td>
              <td className={cn('px-3 py-1.5 text-xs', o.overdue ? 'font-semibold text-red-600' : 'text-ink-2')}>{minutes(o.elapsed_minutes)}{o.overdue && ' · overdue'}</td>
              <td className="px-3 py-1.5"><StatusBadge status={o.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function OrderForm({ d, cats, title }: { d: VisitDetail; cats: string[]; title: string }) {
  const refresh = useErRefresh()
  const cat = useCatalogue()
  const [q, setQ] = useState('')
  const [cart, setCart] = useState<(Svc & { priority: Priority })[]>([])
  const [notes, setNotes] = useState('')
  const [doctor, setDoctor] = useState<string | null>(d.summary.doctor?.id ?? null)
  const [warnings, setWarnings] = useState<Rec[] | null>(null)
  const needsDoctor = !d.permissions.doctor
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (cat.data?.services ?? []).filter((x) => cats.includes(x.category) && !cart.some((c) => c.id === x.id)
      && (!s || x.name.toLowerCase().includes(s) || x.code?.toLowerCase().includes(s))).slice(0, 12)
  }, [cat.data, q, cats, cart])
  const sets = (cat.data?.order_sets ?? []).filter((s) => s.items.some((i) => cats.includes(i.category)))
  const add = (s: Svc, pr: Priority = 'STAT') => setCart((c) => (c.some((x) => x.id === s.id) ? c : [...c, { ...s, priority: pr }]))
  const m = useMutation({
    mutationFn: (confirm: boolean) => api<{ count: number; amount: number }>('/orders/cpoe', {
      method: 'POST', body: {
        patient_id: d.summary.patient.id, encounter_id: d.summary.id, items: cart.map((c) => ({ service_id: c.id, priority: c.priority })),
        clinical_notes: notes || d.summary.provisional_diagnosis || d.summary.chief_complaint || null,
        ordering_doctor: needsDoctor ? doctor : undefined, confirm_duplicates: confirm,
      },
    }),
    onSuccess: (r) => { toast.success(`${r.count} order(s) placed · ${money(r.amount)}`); setCart([]); setNotes(''); setWarnings(null); refresh() },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE_ORDER') { setWarnings((e.details?.warnings as Rec[]) ?? []); return }
      toast.error(errorMessage(e))
    },
  })
  const total = cart.reduce((s, c) => s + Number(c.rate ?? 0), 0)
  return (
    <Card icon="ShoppingCart" title={title}>
      {cat.isLoading ? <Spinner /> : (
        <>
          {sets.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {sets.map((s) => (
                <button key={s.key} type="button" title={s.description} onClick={() => s.items.filter((i) => cats.includes(i.category)).forEach((i) => add(i, s.priority as Priority))}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-2 ring-1 ring-line hover:text-ink">+ {s.name}</button>
              ))}
            </div>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tests by name or code…" className="pl-8"
              onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); add(list[0]); setQ('') } }} />
          </div>
          {q && (
            <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-line scroll-thin">
              {list.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No matching test</li>}
              {list.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => { add(s); setQ('') }} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2">
                    <span><span className="text-ink">{s.name}</span> <span className="text-xs text-ink-3">{s.code} · {s.section ?? s.category}</span></span>
                    <span className="text-xs tabular-nums text-ink-2">{money(s.rate)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
            {cart.length === 0 && <li className="px-3 py-4 text-center text-sm text-ink-3">Add tests from the search or an order set.</li>}
            {cart.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="flex-1 text-ink">{c.name} <span className="text-xs text-ink-3">{c.code}</span></span>
                <Select className="h-7 w-24 text-xs" value={c.priority} onChange={(e) => setCart(cart.map((x) => (x.id === c.id ? { ...x, priority: e.target.value as Priority } : x)))}>
                  {['STAT', 'Urgent', 'Routine'].map((pp) => <option key={pp}>{pp}</option>)}
                </Select>
                <span className="w-20 text-right text-xs tabular-nums text-ink-2">{money(c.rate)}</span>
                <button type="button" aria-label={`Remove ${c.name}`} onClick={() => setCart(cart.filter((x) => x.id !== c.id))} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"><X className="size-4" /></button>
              </li>
            ))}
          </ul>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <FieldWrap label="Clinical notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={d.summary.provisional_diagnosis ?? d.summary.chief_complaint ?? ''} /></FieldWrap>
            {needsDoctor && (
              <FieldWrap label="Ordering doctor (verbal / telephone order)" required>
                <RefPicker refName="employees.employees" extraFilter={{ category: 'Doctor' }} value={doctor} onChange={(id) => setDoctor(id)}
                  label={doctor === d.summary.doctor?.id ? d.summary.doctor?.name ?? undefined : undefined} />
              </FieldWrap>
            )}
          </div>
          {warnings && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
              <p className="font-medium text-amber-900 dark:text-amber-200">Already ordered in the last 24 hours</p>
              <ul className="mt-1 text-xs text-amber-900 dark:text-amber-200">{warnings.map((w) => <li key={w.order_id}>{w.test} — {w.code} · {w.status} · {time(w.ordered_at)}</li>)}</ul>
              <Button size="sm" variant="warning" className="mt-2" loading={m.isPending} onClick={() => m.mutate(true)}>Order anyway</Button>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between">
            <span className="text-sm text-ink-2">{cart.length} item(s) · <b className="text-ink">{money(total)}</b></span>
            <Button variant="primary" icon="Send" disabled={!cart.length || (needsDoctor && !doctor)} loading={m.isPending} onClick={() => m.mutate(false)}>Place order</Button>
          </div>
        </>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ medicines (pharmacy indent)

const ROUTES = ['IV', 'IM', 'Oral', 'SC', 'Nebulised', 'Sublingual', 'PR', 'Topical', 'Inhalation']
const FREQ = ['STAT', 'SOS', 'OD', 'BD', 'TDS', 'QID', 'Q4H', 'Q6H', 'Q8H', 'HS']
interface MedLine { key: number; item: string | null; label?: string; qty: string; dose: string; route: string; frequency: string; instructions: string }
const blankLine = (key: number): MedLine => ({ key, item: null, qty: '1', dose: '', route: 'IV', frequency: 'STAT', instructions: '' })

export function MedicinesPanel({ d }: { d: VisitDetail }) {
  const refresh = useErRefresh()
  const q = useVisitOrders(d.summary.id)
  const [lines, setLines] = useState<MedLine[]>([blankLine(1)])
  const [priority, setPriority] = useState<Priority>('STAT')
  const [alerts, setAlerts] = useState<Rec[] | null>(null)
  const [override, setOverride] = useState('')
  const ready = lines.filter((l) => l.item && Number(l.qty) > 0)
  const m = useMutation({
    mutationFn: () => api<Rec>(`/er/visits/${d.summary.id}/medicines`, {
      method: 'POST', body: {
        priority, override_reason: override || null,
        items: ready.map((l) => ({ item: l.item, qty: Number(l.qty), dose: l.dose || null, route: l.route || null, frequency: l.frequency || null, instructions: l.instructions || null })),
      },
    }),
    onSuccess: (r) => { toast.success(`Indent ${r.code} raised to the IP pharmacy`); setLines([blankLine(Date.now())]); setAlerts(null); setOverride(''); refresh() },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SAFETY_ALERTS') { setAlerts((e.details?.alerts as Rec[]) ?? []); return }
      toast.error(errorMessage(e))
    },
  })
  const upd = (k: number, patch: Partial<MedLine>) => setLines(lines.map((l) => (l.key === k ? { ...l, ...patch } : l)))
  const meds = q.data?.medicines ?? []
  return (
    <div className="space-y-4">
      {d.permissions.orders && (
        <Card icon="Pill" title="Order medicine" actions={<span className="flex items-center gap-2 text-xs text-ink-2">Priority
          <Select className="h-8 w-28" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{['STAT', 'Urgent', 'Routine'].map((x) => <option key={x}>{x}</option>)}</Select></span>}>
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="grid items-end gap-2 rounded-lg bg-surface-2/60 p-2 ring-1 ring-line md:grid-cols-[minmax(0,2.2fr)_70px_minmax(0,1fr)_110px_100px_minmax(0,1.2fr)_32px]">
                <FieldWrap label="Medicine"><RefPicker refName="mdm.items" value={l.item} label={l.label} onChange={(id, r) => upd(l.key, { item: id, label: r?.title ?? r?.label })} placeholder="Search drug…" /></FieldWrap>
                <FieldWrap label="Qty"><Input type="number" min={1} value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></FieldWrap>
                <FieldWrap label="Dose"><Input value={l.dose} onChange={(e) => upd(l.key, { dose: e.target.value })} placeholder="e.g. 1 g" /></FieldWrap>
                <FieldWrap label="Route"><Select value={l.route} onChange={(e) => upd(l.key, { route: e.target.value })}>{ROUTES.map((r) => <option key={r}>{r}</option>)}</Select></FieldWrap>
                <FieldWrap label="Frequency"><Select value={l.frequency} onChange={(e) => upd(l.key, { frequency: e.target.value })}>{FREQ.map((r) => <option key={r}>{r}</option>)}</Select></FieldWrap>
                <FieldWrap label="Instructions"><Input value={l.instructions} onChange={(e) => upd(l.key, { instructions: e.target.value })} placeholder="e.g. over 15 min" /></FieldWrap>
                <button type="button" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
                  className="mb-1.5 grid size-7 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink disabled:opacity-30"><X className="size-4" /></button>
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" icon="Plus" className="mt-2" onClick={() => setLines([...lines, blankLine(Date.now())])}>Add medicine</Button>
          {alerts && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-500/30 dark:bg-red-500/10">
              <p className="flex items-center gap-1.5 font-medium text-red-800 dark:text-red-200"><Icon name="ShieldAlert" className="size-4" />Drug safety alerts</p>
              <ul className="mt-1 space-y-0.5 text-xs text-red-900 dark:text-red-200">{alerts.map((a, i) => <li key={i}><b>{a.severity}</b> · {a.message}</li>)}</ul>
              <FieldWrap label="Override reason (audited)" className="mt-2"><Textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} /></FieldWrap>
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button variant="primary" icon="Send" disabled={!ready.length || (!!alerts && override.trim().length < 5)} loading={m.isPending} onClick={() => m.mutate()}>
              {alerts ? 'Override & send indent' : 'Send to pharmacy'}
            </Button>
          </div>
        </Card>
      )}
      <Card icon="ClipboardList" title="Medicines on this visit" pad={false}>
        {q.isLoading ? <Spinner /> : !meds.length ? <Empty icon="Pill" title="No medicines ordered yet" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-2 text-left text-[11px] uppercase text-ink-3">
                <tr>{['Medicine', 'Dose · route · frequency', 'Qty', 'Issued', 'Indent', 'Ordered', 'Status'].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {meds.map((x, i) => (
                  <tr key={`${x.indent_id}-${i}`}>
                    <td className="px-3 py-1.5 text-ink">{x.drug}{x.instructions && <span className="block text-xs text-ink-3">{x.instructions}</span>}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-2">{[x.dose, x.route, x.frequency].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-1.5 tabular-nums">{x.qty}</td>
                    <td className="px-3 py-1.5 tabular-nums">{x.issued_qty ?? '—'}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-3">{x.indent_code} · {x.priority}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-2">{dateTime(x.ordered_at)}{x.ordered_by && <span className="block">{x.ordered_by}</span>}</td>
                    <td className="px-3 py-1.5"><StatusBadge status={x.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ results

const FLAG_TONE: Record<string, 'red' | 'amber' | 'green' | 'gray'> = {
  Normal: 'green', Low: 'amber', High: 'amber', Abnormal: 'amber', 'Critical Low': 'red', 'Critical High': 'red',
}

export function ResultsPanel({ d, kind }: { d: VisitDetail; kind: 'lab' | 'radiology' }) {
  const q = useVisitOrders(d.summary.id)
  const rows = (q.data?.investigations ?? []).filter((o) => o.category === (kind === 'lab' ? 'LAB' : 'RAD'))
  if (q.isLoading) return <Spinner />
  if (!rows.length) return <Card><Empty icon={kind === 'lab' ? 'FlaskConical' : 'ScanLine'} title={kind === 'lab' ? 'No lab tests on this visit' : 'No imaging on this visit'} /></Card>
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {rows.map((o) => (
        <Card key={o.id} icon={kind === 'lab' ? 'FlaskConical' : 'ScanLine'}
          title={<>{o.test.name} <span className="font-normal text-ink-3">· {o.code}</span></>}
          actions={<>{o.critical && <Badge tone={o.acknowledged_at ? 'amber' : 'red'}>{o.acknowledged_at ? 'Critical · acknowledged' : 'Critical'}</Badge>}<StatusBadge status={o.status} /></>}>
          <p className="mb-2 text-xs text-ink-3">Ordered {dateTime(o.ordered_at)} · {o.priority}{o.resulted_at && ` · resulted ${dateTime(o.resulted_at)}`}{o.verified_at && ` · verified ${dateTime(o.verified_at)}`}</p>
          {kind === 'lab' ? (
            o.result_values.length ? (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line">
                  {o.result_values.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1 pr-2 text-ink-2">{r.parameter}</td>
                      <td className={cn('py-1 pr-2 font-medium tabular-nums', r.flag && r.flag !== 'Normal' ? 'text-red-600' : 'text-ink')}>{String(r.value ?? '—')} <span className="text-xs font-normal text-ink-3">{r.unit}</span></td>
                      <td className="py-1 pr-2 text-xs text-ink-3">{r.ref_range}</td>
                      <td className="py-1">{r.flag && <Badge tone={FLAG_TONE[r.flag] ?? 'gray'}>{r.flag}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-sm text-ink-3">{o.result ?? 'Result pending.'}</p>
          ) : (
            <>
              {o.impression ? <p className="whitespace-pre-wrap text-sm text-ink"><b>Impression:</b> {o.impression}</p> : <p className="text-sm text-ink-3">Report pending.</p>}
              {o.result && <details className="mt-2 text-sm"><summary className="cursor-pointer text-ink-2">Full report</summary><p className="mt-1 whitespace-pre-wrap text-ink">{o.result}</p></details>}
              {o.pacs_url && (
                <a href={o.pacs_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
                  <Icon name="ScanLine" className="size-4" /> Open images in PACS{o.accession_no && ` (${o.accession_no})`}
                </a>
              )}
            </>
          )}
        </Card>
      ))}
    </div>
  )
}
