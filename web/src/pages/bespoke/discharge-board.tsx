import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { NewButton, RecordDrawer, useEntity } from '@/components/records'
import { Badge, Button, Card, cn, Empty, ErrorBox, Input, Segmented, Spinner, StatTile, StatusBadge } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { useMeta, useRegistry } from '@/lib/auth'
import { dateTime, minutes, money, time } from '@/lib/format'
import type { BespokeProps } from './index'

interface Item { key: string; label: string; done: boolean; applicable: boolean; roles: string[]; signoff?: { by: string; role: string; at: string } | null }
interface Billing { cleared: boolean; unbilled_count: number; unbilled_amount: number; balance_due: number }
interface PatientLine { id: string; uhid: string; name: string; age?: number | null; gender?: string | null }
interface Base {
  id: string; code: string; status: string; discharge_type?: string | null; patient: PatientLine; bed?: string | null; ward?: string | null
  doctor?: string | null; payer?: string | null; diagnosis?: string | null; admitted_at?: string; initiated_at?: string | null
}
interface InProgress extends Base {
  checklist: { id: string; code: string; status: string; delay_reason?: string | null; expected_discharge_at?: string | null } | null
  items: Item[]; billing: Billing; pharmacy_returns: { id: string; code: string }[]
  summary: { id: string; code: string; status: string } | null
  pending: string[]; ready: boolean; tat_minutes: number | null; overdue: boolean
}
interface Done extends Base { discharged_at: string; tat_minutes: number | null; within_target: boolean }
interface DischargeBoardData {
  generated_at: string; target_minutes: number; in_progress: InProgress[]; discharged_today: Done[]
  stats: { in_progress: number; ready: number; overdue: number; discharged_today: number; avg_tat_today: number | null; within_target_pct: number | null }
}

type View = 'all' | 'ready' | 'pending' | 'overdue'

export default function DischargeBoard(_: BespokeProps) {
  const [view, setView] = useState<View>('all')
  const [q, setQ] = useState('')
  const [openChecklist, setOpenChecklist] = useState<string | null>(null)
  const checklists = useEntity('discharge.checklists')
  const board = useQuery({
    queryKey: ['x', 'discharge', 'board'],
    queryFn: () => api<DischargeBoardData>('/adt/discharge-board'),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (board.data?.in_progress ?? []).filter((r) =>
      (view === 'all' || (view === 'ready' && r.ready) || (view === 'pending' && !r.ready) || (view === 'overdue' && r.overdue))
      && (!term || [r.patient.name, r.patient.uhid, r.code, r.bed, r.ward, r.doctor].some((v) => v?.toLowerCase().includes(term))))
  }, [board.data, view, q])

  if (board.isLoading) return <Spinner label="Loading discharges…" />
  if (board.error) return <ErrorBox error={board.error} />
  const d = board.data!
  const s = d.stats
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile icon="LogOut" label="Discharge initiated" value={s.in_progress} onClick={() => setView('all')} />
        <StatTile icon="CircleCheck" label="Ready to go" value={s.ready} onClick={() => setView('ready')} />
        <StatTile icon="Timer" label={`Over ${minutes(d.target_minutes)} target`} value={s.overdue} tone={s.overdue ? 'alert' : 'default'} onClick={() => setView('overdue')} />
        <StatTile icon="DoorOpen" label="Discharged today" value={s.discharged_today} />
        <StatTile icon="Clock" label="Avg discharge TAT today" value={s.avg_tat_today != null ? minutes(s.avg_tat_today) : '—'} />
        <StatTile icon="Target" label="Within 3 h (NABH)" value={s.within_target_pct != null ? `${s.within_target_pct}%` : '—'} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Patient, UHID, IP no., bed, ward" className="pl-8" aria-label="Search discharges" />
        </div>
        <Segmented value={view} onChange={setView} options={[
          { key: 'all', label: `All ${s.in_progress}` }, { key: 'ready', label: `Ready ${s.ready}` },
          { key: 'pending', label: `Pending ${s.in_progress - s.ready}` }, { key: 'overdue', label: `Overdue ${s.overdue}` },
        ]} />
        <span className="ml-auto text-xs text-ink-3">Updated {time(d.generated_at)} · TAT clock runs from the discharge order</span>
      </div>

      {rows.length === 0 ? (
        <Card><Empty icon="LogOut" title={view === 'all' && !q ? 'No discharges in progress' : 'Nothing matches'}>Discharges start when a doctor or nurse initiates discharge on the admission or bed board.</Empty></Card>
      ) : (
        <div className="space-y-3">{rows.map((r) => <DischargeCard key={r.id} r={r} target={d.target_minutes} onOpenChecklist={setOpenChecklist} />)}</div>
      )}

      <Card title={`Discharged today (${d.discharged_today.length})`} icon="DoorOpen" pad={false}>
        {d.discharged_today.length === 0 ? <Empty icon="DoorOpen" title="No discharges completed yet today" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
                <tr>{['Patient', 'IP no.', 'Bed', 'Type', 'Initiated', 'Discharged', 'Discharge TAT'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {d.discharged_today.map((x) => (
                  <tr key={x.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2"><Link to={`/ip/admissions/${x.id}`} className="font-medium text-ink hover:underline">{x.patient.name}</Link> <span className="font-mono text-xs text-ink-3">{x.patient.uhid}</span></td>
                    <td className="px-3 py-2 font-mono text-xs">{x.code}</td>
                    <td className="px-3 py-2">{x.bed ?? '—'} <span className="text-xs text-ink-3">{x.ward}</span></td>
                    <td className="px-3 py-2">{x.discharge_type ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-2">{x.initiated_at ? time(x.initiated_at) : '—'}</td>
                    <td className="px-3 py-2 text-ink-2">{time(x.discharged_at)}</td>
                    <td className="px-3 py-2">
                      {x.tat_minutes == null ? <span className="text-ink-3">—</span> : (
                        <Badge tone={x.within_target ? 'green' : 'red'}>{minutes(x.tat_minutes)} · {x.within_target ? 'within target' : 'over target'}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {checklists && openChecklist && <RecordDrawer entity={checklists} id={openChecklist} onClose={() => setOpenChecklist(null)} />}
    </div>
  )
}

function DischargeCard({ r, target, onOpenChecklist }: { r: InProgress; target: number; onOpenChecklist: (id: string) => void }) {
  const qc = useQueryClient()
  const reg = useRegistry()
  const summaries = useEntity('discharge.summaries')
  const role = useMeta().data?.user.role ?? ''
  const refresh = () => { qc.invalidateQueries({ queryKey: ['x', 'discharge'] }); qc.invalidateQueries({ queryKey: ['m', 'discharge'] }) }

  const toggle = useMutation({
    mutationFn: (it: Item) => api(`/m/discharge/checklists/${r.checklist!.id}`, { method: 'PUT', body: { [it.key]: !it.done } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const start = useMutation({
    mutationFn: () => api(`/adt/encounters/${r.id}/checklist`, { method: 'POST' }),
    onSuccess: () => { toast.success('Discharge checklist started'); refresh() },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const discharge = useMutation({
    mutationFn: () => api<{ turnaround_request?: { code: string } | null }>(`/adt/encounters/${r.id}/discharge`, { method: 'POST', body: {} }),
    onSuccess: (res) => {
      toast.success(`${r.patient.name} discharged${res.turnaround_request ? ` · bed ${r.bed} sent for cleaning (${res.turnaround_request.code})` : ''}`)
      refresh()
      qc.invalidateQueries({ queryKey: ['x', 'ipd'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const tat = r.tat_minutes
  const tatTone = tat == null ? 'gray' : tat > target ? 'red' : tat > target * 0.66 ? 'amber' : 'green'
  const canDischarge = reg.canEntity('ipd.admissions', 'write')
  const done = r.items.filter((i) => i.applicable && i.done).length
  const applicable = r.items.filter((i) => i.applicable).length

  return (
    <section className={cn('rounded-xl border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]', r.ready ? 'border-emerald-300 dark:border-emerald-500/40' : r.overdue ? 'border-red-300 dark:border-red-500/40' : 'border-line')}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <Link to={`/ip/admissions/${r.id}`} className="font-semibold text-ink hover:underline">{r.patient.name}</Link>
          <span className="ml-2 font-mono text-xs text-ink-3">{r.patient.uhid}</span>
          <span className="ml-2 text-xs text-ink-2">{[r.patient.age != null && `${r.patient.age}y`, r.patient.gender].filter(Boolean).join(' ')}</span>
        </div>
        <span className="text-sm text-ink-2"><b className="text-ink">{r.bed ?? '—'}</b> {r.ward}</span>
        <span className="text-sm text-ink-2">{r.doctor}</span>
        <span className="font-mono text-xs text-ink-3">{r.code}</span>
        {r.discharge_type && r.discharge_type !== 'Routine' && <Badge tone="red">{r.discharge_type}</Badge>}
        {r.payer && r.payer !== 'Cash' && <Badge tone="violet">{r.payer}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Badge tone={tatTone}>TAT {tat == null ? 'not started' : minutes(tat)}</Badge>
          <Badge tone={r.ready ? 'green' : 'amber'} dot>{r.ready ? 'Ready' : 'Pending'}</Badge>
        </div>
      </header>
      <div className="grid gap-4 p-4 lg:grid-cols-[1.4fr_1fr_auto]">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Checklist {r.checklist && <span className="normal-case tracking-normal">· {done}/{applicable}</span>}</h4>
            {r.checklist && (
              <button className="text-xs text-brand-700 hover:underline dark:text-brand-300" onClick={() => onOpenChecklist(r.checklist!.id)}>Open {r.checklist.code}</button>
            )}
          </div>
          {!r.checklist ? (
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-line-2 p-3 text-sm text-ink-2">
              Checklist not started.
              {reg.canEntity('discharge.checklists', 'write') && <Button size="sm" loading={start.isPending} onClick={() => start.mutate()}>Start checklist</Button>}
            </div>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {r.items.map((it) => {
                const allowed = role === 'admin' || it.roles.includes(role)
                const disabled = !it.applicable || !allowed || r.checklist?.status === 'Complete' || toggle.isPending
                return (
                  <li key={it.key}>
                    <label title={!it.applicable ? 'Not applicable for this discharge type' : allowed ? undefined : `Signed off by: ${it.roles.join(', ')}`}
                      className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-surface-2', disabled && 'cursor-not-allowed opacity-70')}>
                      <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={it.done} disabled={disabled}
                        onChange={() => toggle.mutate(it)} />
                      <span className="min-w-0">
                        <span className={cn('block', it.done ? 'text-ink' : 'text-ink-2', !it.applicable && 'line-through')}>{it.label}</span>
                        <span className="block text-[11px] text-ink-3">
                          {!it.applicable ? 'N/A' : it.signoff ? `${it.signoff.by} · ${time(it.signoff.at)}` : it.roles.join(' / ')}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Billing clearance</h4>
            {r.billing.cleared ? <Badge tone="green" dot>Cleared — no dues</Badge> : (
              <div className="space-y-1">
                <Badge tone="red" dot>Not cleared</Badge>
                <p className="text-xs text-ink-2">
                  {r.billing.unbilled_count > 0 && <>{r.billing.unbilled_count} unbilled · {money(r.billing.unbilled_amount)}</>}
                  {r.billing.unbilled_count > 0 && r.billing.balance_due > 0 && ' · '}
                  {r.billing.balance_due > 0 && <>balance {money(r.billing.balance_due)}</>}
                </p>
              </div>
            )}
            <Link to={`/m/billing/billing-desk?patient=${r.patient.id}`} className="mt-1 block text-xs text-brand-700 hover:underline dark:text-brand-300">Open billing desk →</Link>
            <Link to={`/ip/admissions/${r.id}?tab=overview`} className="mt-1 block text-xs text-brand-700 hover:underline dark:text-brand-300">Open IP chart & discharge tracker →</Link>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Pharmacy returns</h4>
            {r.pharmacy_returns.length === 0 ? <span className="text-ink-2">None awaiting acceptance</span> : (
              <span className="flex flex-wrap gap-1">{r.pharmacy_returns.map((x) => (
                <Link key={x.id} to={`/m/pharmacy/returns?r=${x.id}`}><Badge tone="amber">{x.code} · requested</Badge></Link>
              ))}</span>
            )}
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Discharge summary</h4>
            {r.summary ? (
              <Link to={`/m/discharge/summaries?r=${r.summary.id}`} className="inline-flex items-center gap-2 hover:underline">
                <span className="font-mono text-xs">{r.summary.code}</span><StatusBadge status={r.summary.status} />
              </Link>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-ink-2">Not drafted</span>
                <NewButton entity={summaries} variant="secondary" label="Draft summary" fixed={{ patient_id: r.patient.id, encounter_id: r.id }}
                  onSaved={() => refresh()} />
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-48 flex-col justify-between gap-3">
          <div className="text-xs text-ink-2">
            <div>Ordered {r.initiated_at ? dateTime(r.initiated_at) : '—'}</div>
            {r.checklist?.expected_discharge_at && <div>Expected {dateTime(r.checklist.expected_discharge_at)}</div>}
            {r.checklist?.delay_reason && r.checklist.delay_reason !== 'None' && <div className="text-amber-700 dark:text-amber-300">Delay: {r.checklist.delay_reason}</div>}
          </div>
          {!r.ready && r.pending.length > 0 && (
            <ul className="space-y-0.5 text-xs text-red-700 dark:text-red-300">
              {r.pending.slice(0, 4).map((p) => <li key={p}>• {p}</li>)}
              {r.pending.length > 4 && <li>+ {r.pending.length - 4} more</li>}
            </ul>
          )}
          {canDischarge && (
            <Button variant="success" icon="DoorOpen" disabled={!r.ready} loading={discharge.isPending}
              title={r.ready ? undefined : 'All checklist items, billing clearance and pharmacy returns must be complete'}
              onClick={() => { if (confirm(`Discharge ${r.patient.name} from bed ${r.bed ?? ''}? The bed goes for cleaning.`)) discharge.mutate() }}>
              Discharge
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
