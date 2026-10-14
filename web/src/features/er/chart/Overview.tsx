import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { Lines } from '@/components/charts'
import { Badge, Button, Card, cn, Empty, Segmented, Spinner, StatusBadge } from '@/components/ui'
import { api } from '@/lib/api'
import { dateTime, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { Rec } from '@/lib/types'
import { chartLink, erKey, STEP_PANEL, type VisitDetail, type VitalPoint } from '../api'
import { VitalsDialog, VitalsEntry } from '../dialogs'

export interface OrderRow {
  id: string; code: string; status: string; category: string; priority: string; ordered_at?: string; resulted_at?: string; verified_at?: string
  test: { id?: string; code?: string; name?: string; modality?: string; body_part?: string }
  critical: boolean; acknowledged_at?: string | null; result_values: { parameter?: string; value?: unknown; unit?: string; flag?: string; ref_range?: string }[]
  result?: string | null; impression?: string | null; pacs_url?: string | null; accession_no?: string | null; overdue: boolean
  elapsed_minutes?: number | null; target_minutes?: number; ordering_doctor?: string | null; clinical_notes?: string | null
}
export interface MedRow {
  indent_id: string; indent_code: string; status: string; priority: string; item_id: string; drug: string; qty: number; issued_qty?: number | null
  dose?: string | null; route?: string | null; frequency?: string | null; instructions?: string | null; ordered_at?: string; ordered_by?: string | null
}
export interface VisitOrders { investigations: OrderRow[]; procedures: OrderRow[]; medicines: MedRow[] }

export function useVisitOrders(id: string, enabled = true) {
  return useQuery({ queryKey: erKey('orders', id), queryFn: () => api<VisitOrders>(`/er/visits/${id}/orders`), enabled })
}

const RANGES = [{ key: '24', label: '24 hours' }, { key: '72', label: '3 days' }, { key: '168', label: '7 days' }, { key: '720', label: '30 days' }] as const

export function Overview({ d }: { d: VisitDetail }) {
  const p = d.permissions
  const id = d.summary.id
  return (
    <div className="space-y-4">
      {p.view_clinical && <VitalsCard d={d} />}
      {p.vitals && <ChartIt id={id} />}
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          <QuickActions d={d} />
          <WorkflowCard d={d} />
        </div>
        {p.view_clinical ? <RecentOrders d={d} /> : <RegistrationGlance d={d} />}
      </div>
    </div>
  )
}

function VitalsCard({ d }: { d: VisitDetail }) {
  const [hours, setHours] = useState<(typeof RANGES)[number]['key']>('24')
  const [rec, setRec] = useState(false)
  const q = useQuery({
    queryKey: erKey('vitals', d.summary.id, hours),
    queryFn: () => api<{ series: VitalPoint[]; latest: VitalPoint | null }>(`/er/visits/${d.summary.id}/vitals`, { query: { hours } }),
  })
  const l = q.data?.latest ?? d.latest_vitals
  const tiles: { icon: string; label: string; value: string | null; unit?: string; tone?: string }[] = [
    { icon: 'Heart', label: 'Blood pressure', value: l?.bp_systolic ? `${l.bp_systolic}/${l.bp_diastolic ?? '—'}` : null, unit: 'mmHg' },
    { icon: 'HeartPulse', label: 'Pulse', value: l?.pulse?.toString() ?? null, unit: '/min' },
    { icon: 'Thermometer', label: 'Temperature', value: l?.temperature?.toString() ?? null, unit: '°F' },
    { icon: 'Droplet', label: 'SpO₂', value: l?.spo2?.toString() ?? null, unit: `%${l?.o2_support && l.o2_support !== 'Room air' ? ` · ${l.o2_support}` : ''}` },
    { icon: 'Wind', label: 'Resp. rate', value: l?.resp_rate?.toString() ?? null, unit: '/min' },
    { icon: 'Brain', label: 'GCS', value: l?.gcs?.toString() ?? null, unit: '/15' },
  ]
  const data = (q.data?.series ?? []).map((v) => ({
    at: time(v.recorded_at), Systolic: v.bp_systolic, Diastolic: v.bp_diastolic, Pulse: v.pulse, 'SpO₂': v.spo2, Temp: v.temperature,
  }))
  return (
    <Card icon="Activity" title={<>Vitals & monitoring <span className="font-normal text-ink-3">· {l ? `last ${dateTime(l.recorded_at)}` : 'nothing recorded yet'}</span></>}
      actions={<>
        {l?.news2 !== undefined && l?.news2 !== null && <Badge tone={l.news2 >= 7 ? 'red' : l.news2 >= 5 ? 'amber' : 'green'}>NEWS2 {l.news2} · {l.news2_risk}</Badge>}
        {d.permissions.vitals && <Button size="sm" icon="Plus" onClick={() => setRec(true)}>Record vitals</Button>}
      </>}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl border border-line px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs text-ink-2"><Icon name={t.icon} className="size-3.5 text-brand-700 dark:text-brand-300" />{t.label}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{t.value ?? '—'} {t.value && <span className="text-xs font-normal text-ink-3">{t.unit}</span>}</div>
              {!t.value && <div className="text-[11px] text-ink-3">Not recorded</div>}
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex justify-end"><Segmented value={hours} onChange={setHours} options={RANGES.map((r) => ({ key: r.key, label: r.label }))} /></div>
          <div className="h-52">
            {q.isLoading ? <Spinner /> : data.length === 0 ? (
              <div className="grid h-full place-items-center rounded-lg bg-surface-2 text-sm text-ink-3">No readings in this period.</div>
            ) : (
              <Lines data={data} x="at" series={['Systolic', 'Diastolic', 'Pulse', 'SpO₂', 'Temp'].map((k) => ({ key: k, label: k }))} />
            )}
          </div>
        </div>
      </div>
      {rec && <VitalsDialog visitId={d.summary.id} open onClose={() => setRec(false)} />}
    </Card>
  )
}

function ChartIt({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-xl border border-line bg-surface">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm text-ink-2 hover:text-ink">
        <span className="flex items-center gap-2"><Icon name="HeartPulse" className="size-4 text-brand-700" /> Chart it — record observations</span>
        <Icon name="ChevronDown" className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="border-t border-line p-4"><VitalsEntry visitId={id} compact /></div>}
    </section>
  )
}

function QuickActions({ d }: { d: VisitDetail }) {
  const p = d.permissions
  const id = d.summary.id
  const items = [
    { show: p.vitals, icon: 'HeartPulse', label: 'Add observation', to: chartLink(id, 'vitals') },
    { show: p.orders, icon: 'TestTubeDiagonal', label: 'Investigations', to: chartLink(id, 'investigations') },
    { show: p.orders, icon: 'Pill', label: 'Order medicine', to: chartLink(id, 'medicines') },
    { show: p.doctor || p.view_clinical, icon: 'Stethoscope', label: 'Doctor assessment', to: chartLink(id, 'doctor-assessment') },
    { show: p.dispose || p.abscond || p.view_clinical, icon: 'LogOut', label: 'Disposition', to: chartLink(id, 'disposition') },
    { show: p.view_clinical, icon: 'FileText', label: 'ER discharge summary', to: `/er/visits/${id}/print?doc=discharge-summary`, blank: true },
    { show: p.details, icon: 'UserPen', label: 'Patient details', to: chartLink(id, 'registration', { edit: 'details' }) },
    { show: p.view_billing, icon: 'IndianRupee', label: 'Billing & closure', to: chartLink(id, 'billing') },
    { show: p.documents, icon: 'Paperclip', label: 'Documents', to: chartLink(id, 'documents') },
  ].filter((x) => x.show)
  if (!items.length) return null
  return (
    <Card icon="Zap" title="Quick actions" pad={false}>
      <div className="grid grid-cols-3 gap-1 p-2">
        {items.map((x) => (
          <Link key={x.label} to={x.to} target={x.blank ? '_blank' : undefined}
            className="flex flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-center text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><Icon name={x.icon} className="size-4" /></span>
            {x.label}
          </Link>
        ))}
      </div>
    </Card>
  )
}

export function WorkflowCard({ d }: { d: VisitDetail }) {
  const st = d.steps
  return (
    <Card icon="ListChecks" title="ER workflow" actions={<span className="text-xs text-ink-3">{st.done}/{st.total} done</span>} pad={false}>
      <ol className="divide-y divide-line">
        {st.steps.map((s, i) => (
          <li key={s.key}>
            <Link to={chartLink(d.summary.id, STEP_PANEL[s.key])}
              className={cn('flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2', s.current && 'bg-brand-50 dark:bg-brand-500/10')}>
              <span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold',
                s.done_at ? 'bg-emerald-600 text-white' : s.current ? 'bg-brand-800 text-white dark:bg-brand-300 dark:text-brand-950' : 'bg-surface-2 text-ink-3 ring-1 ring-line')}>
                {s.done_at ? <Icon name="Check" className="size-3" /> : i + 1}
              </span>
              <span className={cn('flex-1', s.current ? 'font-semibold text-ink' : 'text-ink-2')}>
                {s.label}{s.optional && <span className="ml-1 text-[11px] text-ink-3">optional</span>}
              </span>
              <span className="text-[11px] text-ink-3">{s.done_at ? dateTime(s.done_at).replace(/^\d+ \w+ \d+, /, '') : s.current ? <b className="text-brand-700 dark:text-brand-300">Now →</b> : ''}</span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  )
}

function RecentOrders({ d }: { d: VisitDetail }) {
  const p = d.permissions
  const id = d.summary.id
  const q = useVisitOrders(id)
  const list = (rows: OrderRow[] | undefined, empty: string) => !rows?.length ? <p className="px-4 py-6 text-center text-sm text-ink-3">{empty}</p> : (
    <ul className="divide-y divide-line">
      {rows.slice(0, 6).map((o) => (
        <li key={o.id} className="flex items-center gap-2 px-4 py-2 text-sm">
          <span className="flex-1 truncate text-ink">{o.test.name}</span>
          {o.priority !== 'Routine' && <Badge tone={o.priority === 'STAT' ? 'red' : 'amber'}>{o.priority}</Badge>}
          {o.critical && <Badge tone="red">Critical</Badge>}
          <StatusBadge status={o.status} />
          <span className="w-12 text-right text-xs text-ink-3">{time(o.ordered_at)}</span>
        </li>
      ))}
    </ul>
  )
  if (q.isLoading) return <Spinner />
  return (
    <div className="grid content-start gap-4 xl:grid-cols-2">
      <Card icon="FlaskConical" title="Recent investigations" pad={false}
        actions={<Link to={chartLink(id, p.orders ? 'investigations' : 'lab')}><Button size="xs" variant="ghost">View all</Button></Link>}>
        {list(q.data?.investigations, 'No investigations ordered yet.')}
      </Card>
      <Card icon="Pill" title="Recent medications" pad={false}
        actions={p.orders && <Link to={chartLink(id, 'medicines')}><Button size="xs" variant="ghost" icon="Plus">Add medication</Button></Link>}>
        {!q.data?.medicines.length ? <p className="px-4 py-6 text-center text-sm text-ink-3">No medicines ordered yet.</p> : (
          <ul className="divide-y divide-line">
            {q.data.medicines.slice(0, 6).map((m, i) => (
              <li key={`${m.indent_id}-${i}`} className="flex items-center gap-2 px-4 py-2 text-sm">
                <span className="flex-1 truncate text-ink">{m.drug} <span className="text-xs text-ink-3">{[m.dose, m.route, m.frequency].filter(Boolean).join(' · ')}</span></span>
                <StatusBadge status={m.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card icon="Scissors" title="Recent procedures & services" pad={false} className="xl:col-span-2"
        actions={p.orders && <Link to={chartLink(id, 'procedures')}><Button size="xs" variant="ghost" icon="Plus">Add procedure</Button></Link>}>
        {list(q.data?.procedures, 'No procedures or services yet.')}
      </Card>
    </div>
  )
}

function RegistrationGlance({ d }: { d: VisitDetail }) {
  const v: Rec = d.visit
  return (
    <Card icon="IdCard" title="Visit at a glance">
      {!v ? <Empty title="No details" /> : (
        <dl className="grid gap-3 sm:grid-cols-2">
          {[['Arrival mode', v.arrival_mode], ['Brought by', [v.brought_by_type, v.brought_by].filter(Boolean).join(' — ')], ['Attendant mobile', v.attendant_phone],
            ['Payer', v.payer], ['Presenting complaint', v.chief_complaint], ['Outcome', d.summary.outcome ?? 'In the ER']].map(([k, val]) => (
            <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd className="text-sm text-ink">{val || '—'}</dd></div>
          ))}
        </dl>
      )}
    </Card>
  )
}
