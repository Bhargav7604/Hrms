import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { EntityView, RecordFormModal } from '@/components/records'
import { Avatar, Badge, Button, Card, Empty, ErrorBox, KeyValue, Select, Spinner, StatusBadge, Tabs } from '@/components/ui'
import { api } from '@/lib/api'
import { useRegistry } from '@/lib/auth'
import { age, ago, date, dateTime, money } from '@/lib/format'
import { Icon } from '@/lib/icons'
import type { Rec } from '@/lib/types'

interface Summary {
  patient: Rec
  active_encounter: Rec | null
  encounters: Rec[]
  orders: Rec[]
  allergies: string[]
  problems: Rec[]
  vitals: Rec[]
  appointments: Rec[]
  prescriptions: Rec[]
  family: Rec[]
  account: { unbilled: number; outstanding: number; deposit_balance: number }
  alerts: { tone: 'red' | 'amber' | 'gray'; text: string }[]
  refs: Record<string, string>
}
interface TimelineEvent { id: string; code: string; title: string; status: string; module: string; entity: string; label: string; module_name: string; at: string }

type Tab = 'overview' | 'timeline' | 'records' | 'billing'

export default function Patient360() {
  const { id = '' } = useParams()
  const reg = useRegistry()
  const nav = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')
  const [edit, setEdit] = useState(false)
  const q = useQuery({ queryKey: ['patient', id, 'summary'], queryFn: () => api<Summary>(`/patients/${id}/summary`) })
  const patientEnt = reg.entity('registration.patients')

  if (q.isLoading) return <Spinner label="Loading patient record…" />
  if (q.error) return <ErrorBox error={q.error} />
  const s = q.data!
  const p = s.patient
  const go = (module: string, page: string) => nav(`/m/${module}/${page}?patient=${id}`)
  const actions = [
    { m: 'appointments', p: 'booking-desk', label: 'Book', icon: 'CalendarPlus' },
    { m: 'orders', p: 'cpoe', label: 'Order', icon: 'ListPlus' },
    { m: 'emr', p: 'patient-chart', label: 'Chart', icon: 'Activity' },
    { m: 'billing', p: 'billing-desk', label: 'Bill', icon: 'Receipt' },
  ].filter((a) => reg.canPage(a.m, a.p))

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={p.title} size="lg" />
          <div className="min-w-[16rem] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-ink">{p.title}</h1>
              <StatusBadge status={p.status} />
              {p.category && p.category !== 'General' && <Badge tone="violet">{p.category}</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
              <span className="font-mono font-medium text-ink">{p.code}</span>
              <span>{[p.age !== null && p.age !== undefined ? `${p.age} y` : age(p.dob), p.gender].filter(Boolean).join(' · ')}</span>
              {p.blood_group && <span>Blood {p.blood_group}</span>}
              <span>{p.phone}</span>
              {p.abha_id && <span>ABHA {p.abha_id}</span>}
              <span>{p.payer_type}</span>
            </div>
            {s.alerts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {s.alerts.map((a) => (
                  <span key={a.text} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${a.tone === 'red' ? 'bg-red-50 text-red-700 ring-1 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300' : a.tone === 'amber' ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-slate-100 text-slate-700'}`}>
                    <AlertTriangle className="size-3.5" /> {a.text}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex w-full flex-wrap gap-2 xl:w-auto">
            {actions.map((a) => <Button key={a.p} size="sm" icon={a.icon} onClick={() => go(a.m, a.p)}>{a.label}</Button>)}
            {patientEnt && reg.canEntity('registration.patients', 'write') && <Button size="sm" icon="Pencil" onClick={() => setEdit(true)}>Edit</Button>}
            <Button size="sm" icon="Printer" onClick={() => window.open(`/print/registration/patients/${id}`, '_blank')}>UHID card</Button>
          </div>
        </div>
        {s.active_encounter && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900 dark:bg-brand-500/10 dark:text-brand-200">
            <Icon name={s.active_encounter.type === 'IPD' ? 'BedDouble' : s.active_encounter.type === 'ER' ? 'Siren' : 'Stethoscope'} className="size-4" />
            <b>{s.active_encounter.type} {s.active_encounter.code}</b>
            <StatusBadge status={s.active_encounter.status} />
            {s.active_encounter.bed_id && <span>Bed {s.refs[s.active_encounter.bed_id] ?? ''}</span>}
            {s.active_encounter.doctor_id && <span>{s.refs[s.active_encounter.doctor_id]}</span>}
            <span>since {dateTime(s.active_encounter.started_at)} ({ago(s.active_encounter.started_at)})</span>
            {s.active_encounter.diagnosis && <span>· {s.active_encounter.diagnosis}</span>}
          </div>
        )}
      </section>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview', icon: 'LayoutPanelLeft' },
        { key: 'timeline', label: 'Timeline', icon: 'History' },
        { key: 'records', label: 'All records', icon: 'FolderOpen' },
        { key: 'billing', label: 'Billing', icon: 'Receipt' },
      ]} />

      {tab === 'overview' && <Overview s={s} />}
      {tab === 'timeline' && <Timeline id={id} />}
      {tab === 'records' && <AllRecords id={id} />}
      {tab === 'billing' && <BillingTab id={id} s={s} />}

      {patientEnt && <RecordFormModal entity={patientEnt} open={edit} onClose={() => setEdit(false)} initial={p} onSaved={() => q.refetch()} />}
    </div>
  )
}

function Overview({ s }: { s: Summary }) {
  const v = s.vitals[0]
  const p = s.patient
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Latest vitals" icon="Activity" actions={v && <span className="text-xs text-ink-3">{dateTime(v.recorded_at)}</span>}>
          {v ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {[['BP', v.bp_systolic ? `${v.bp_systolic}/${v.bp_diastolic ?? '–'}` : '—', 'mmHg'], ['Pulse', v.pulse, 'bpm'], ['SpO₂', v.spo2, '%'],
                ['Temp', v.temperature, '°F'], ['RR', v.resp_rate, '/min'], ['Pain', v.pain_score, '/10']].map(([l, val, u]) => (
                <div key={l as string} className="rounded-lg bg-surface-2 p-2.5">
                  <div className="text-xs text-ink-3">{l}</div>
                  <div className="text-lg font-semibold tabular-nums text-ink">{val ?? '—'} <span className="text-xs font-normal text-ink-3">{val ? u : ''}</span></div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-ink-3">No vitals recorded.</p>}
        </Card>
        <Card title="Orders & results" icon="ClipboardList" pad={false}>
          {s.orders.length === 0 ? <Empty icon="ClipboardList" title="No orders" /> : (
            <table className="w-full text-sm">
              <tbody>
                {s.orders.slice(0, 12).map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2"><Badge tone="gray">{o.category}</Badge></td>
                    <td className="px-2 py-2 text-ink">{s.refs[o.service_id] ?? o.title}</td>
                    <td className="px-2 py-2">{o.critical ? <Badge tone="red">Critical</Badge> : null}</td>
                    <td className="px-2 py-2 text-xs text-ink-3">{dateTime(o.ordered_at)}</td>
                    <td className="px-4 py-2 text-right"><StatusBadge status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Encounters" icon="Hospital" pad={false}>
          {s.encounters.length === 0 ? <Empty icon="Hospital" title="No visits yet" /> : (
            <table className="w-full text-sm">
              <tbody>
                {s.encounters.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{e.code}</td>
                    <td className="px-2 py-2"><Badge tone="cyan">{e.type}</Badge></td>
                    <td className="px-2 py-2 text-ink-2">{s.refs[e.department_id] ?? ''}</td>
                    <td className="px-2 py-2 text-ink-2">{s.refs[e.doctor_id] ?? ''}</td>
                    <td className="px-2 py-2 text-xs text-ink-3">{date(e.started_at)}{e.ended_at ? ` → ${date(e.ended_at)}` : ''}</td>
                    <td className="px-4 py-2 text-right"><StatusBadge status={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Allergies & problems" icon="ShieldAlert">
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-1.5">
              {s.allergies.length ? s.allergies.map((a) => <Badge key={a} tone="red">{a}</Badge>) : <span className="text-ink-3">No known allergies</span>}
            </div>
            <ul className="space-y-1">{s.problems.map((pr) => <li key={pr.id} className="flex justify-between"><span>{pr.problem}</span><span className="text-xs text-ink-3">{pr.icd_code}</span></li>)}</ul>
          </div>
        </Card>
        <Card title="Account" icon="Wallet">
          <KeyValue cols={1} items={[
            { label: 'Unbilled charges', value: money(s.account.unbilled) },
            { label: 'Outstanding bills', value: money(s.account.outstanding) },
            { label: 'Deposit available', value: money(s.account.deposit_balance) },
          ]} />
        </Card>
        <Card title="Appointments" icon="CalendarDays">
          <ul className="space-y-2 text-sm">
            {s.appointments.slice(0, 6).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{date(a.appt_date)} {a.slot} · {s.refs[a.doctor_id] ?? ''}</span>
                <StatusBadge status={a.status} />
              </li>
            ))}
            {!s.appointments.length && <li className="text-ink-3">None</li>}
          </ul>
        </Card>
        <Card title="Demographics" icon="IdCard">
          <KeyValue cols={1} items={[
            { label: 'Date of birth', value: date(p.dob) },
            { label: 'Address', value: [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ') || '—' },
            { label: 'ID', value: p.id_type ? `${p.id_type} ${p.id_number ?? ''}` : '—' },
            { label: 'Emergency contact', value: p.emergency_contact_name ? `${p.emergency_contact_name} (${p.emergency_contact_relation ?? ''}) ${p.emergency_contact_phone ?? ''}` : '—' },
            { label: 'Registered', value: dateTime(p.created_at) },
          ]} />
        </Card>
      </div>
    </div>
  )
}

function Timeline({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['patient', id, 'timeline'], queryFn: () => api<TimelineEvent[]>(`/patients/${id}/timeline`) })
  if (q.isLoading) return <Spinner />
  if (!q.data?.length) return <Empty icon="History" title="Nothing recorded yet" />
  let lastDay = ''
  return (
    <Card pad>
      <ol className="space-y-1">
        {q.data.map((e) => {
          const day = date(e.at)
          const head = day !== lastDay
          lastDay = day
          return (
            <li key={`${e.entity}-${e.id}`}>
              {head && <div className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-3 first:mt-0">{day}</div>}
              <Link to={`/m/${e.module}/${e.entity}?r=${e.id}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                <span className="w-12 text-xs tabular-nums text-ink-3">{dateTime(e.at).split(', ')[1]}</span>
                <Badge tone="gray">{e.module_name}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{e.label}{e.title ? ` — ${e.title}` : ''}</span>
                <span className="font-mono text-xs text-ink-3">{e.code}</span>
                <StatusBadge status={e.status} />
                <ChevronRight className="size-4 text-ink-3" />
              </Link>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function AllRecords({ id }: { id: string }) {
  const reg = useRegistry()
  const options = useMemo(() => reg.modules.flatMap((m) =>
    m.entities.filter((e) => e.patient && m.access.entities[e.key]?.read).map((e) => ({ fqn: e.fqn, label: `${m.name} — ${e.label}`, suite: m.suite }))), [reg.modules])
  const [fqn, setFqn] = useState(options[0]?.fqn ?? '')
  const ent = reg.entity(fqn)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-2">Record type</span>
        <Select value={fqn} onChange={(e) => setFqn(e.target.value)} className="max-w-md">
          {reg.meta?.suites.map((s) => (
            <optgroup key={s.id} label={s.name}>
              {options.filter((o) => o.suite === s.id).map((o) => <option key={o.fqn} value={o.fqn}>{o.label}</option>)}
            </optgroup>
          ))}
        </Select>
        <span className="text-xs text-ink-3">{options.length} patient record types across all modules</span>
      </div>
      {ent && <EntityView key={fqn} entity={ent} fixed={{ patient_id: id }} compact />}
    </div>
  )
}

function BillingTab({ id, s }: { id: string; s: Summary }) {
  const reg = useRegistry()
  const inv = reg.entity('billing.invoices')
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Card><div className="text-xs text-ink-3">Unbilled</div><div className="text-lg font-semibold">{money(s.account.unbilled)}</div></Card>
        <Card><div className="text-xs text-ink-3">Outstanding</div><div className="text-lg font-semibold">{money(s.account.outstanding)}</div></Card>
        <Card><div className="text-xs text-ink-3">Deposit available</div><div className="text-lg font-semibold">{money(s.account.deposit_balance)}</div></Card>
      </div>
      {reg.canPage('billing', 'billing-desk') && <Link className="text-sm text-brand-700 hover:underline" to={`/m/billing/billing-desk?patient=${id}`}>Open billing desk →</Link>}
      {inv && reg.canEntity(inv.fqn) && <EntityView entity={inv} fixed={{ patient_id: id }} compact />}
    </div>
  )
}
