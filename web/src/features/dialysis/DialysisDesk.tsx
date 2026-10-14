import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Avatar, Badge, Button, Card, cn, Empty, ErrorBox, KeyValue, PageHeader, Spinner } from '@/components/ui'
import { ApiError, get } from '@/lib/api'
import { dateTime, minutes, time, todayISO } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import { DK, kg, useDeskAccess, viralTone, type DeskAccess, type DeskRecord, type Session, type TodayBoard } from './api'
import { MachineBoard, SessionHistory, TodayStrip } from './Boards'
import PatientPicker from './PatientPicker'
import { CancelDialog, ChartPanel, CheckInForm, CheckOutForm, Notice, StartForm } from './SessionForms'

/** Dialysis desk: select a billed patient, then check in → record the session → check out. */
export default function DialysisDesk({ embedded = false }: { embedded?: boolean }) {
  const acc = useDeskAccess()
  if (!acc.ready) return <Spinner />
  if (!acc.page || !acc.view) {
    return <Empty icon="Lock" title="The dialysis desk is not available for your role">Ask an administrator if you need access to dialysis sessions.</Empty>
  }
  return <Desk embedded={embedded} acc={acc} />
}

function Desk({ embedded, acc }: { embedded: boolean; acc: DeskAccess }) {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const pid = params.get('patient')
  const [picker, setPicker] = useState(false)
  const setPid = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('patient', id)
    else p.delete('patient')
    setParams(p)
  }
  const today = useQuery({ queryKey: DK.today, queryFn: () => get<TodayBoard>('/dialysis/desk/today'), refetchInterval: 60_000 })
  useShortcuts('Dialysis desk', [{ keys: 'p', label: 'Select patient', run: () => setPicker(true) }])

  const selectBtn = <Button variant="primary" icon="Users" onClick={() => setPicker(true)} title="Select patient (P)">Select patient</Button>
  const subtitle = 'Select a patient, then check in, record the session & check out'
  return (
    <div className="space-y-4">
      {embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-base font-semibold text-ink">Dialysis</h2><p className="text-sm text-ink-2">{subtitle}</p></div>
          {selectBtn}
        </div>
      ) : <PageHeader icon="Droplets" title="Dialysis" subtitle={subtitle} actions={selectBtn} />}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] xl:items-start">
        <TodayStrip data={today.data} loading={today.isLoading} error={today.error} activePid={pid} onOpen={setPid} />
        <MachineBoard machines={today.data?.machines} loading={today.isLoading} canOperate={acc.operate} />
      </div>

      {pid ? <PatientRecord key={pid} pid={pid} acc={acc} onClose={() => setPid(null)} onPick={() => setPicker(true)} /> : (
        <Card>
          <Empty icon="UserRound" title="Select a patient to open their dialysis record."
            action={<Button variant="secondary" icon="Users" onClick={() => setPicker(true)}>Select patient</Button>}>
            Only patients billed for a dialysis service (OP bill or IP number) can be checked in.
          </Empty>
        </Card>
      )}
      {picker && <PatientPicker onClose={() => setPicker(false)} onPick={(id) => {
        // billing happens elsewhere (no dialysis change event): always show the latest entitlements
        qc.invalidateQueries({ queryKey: DK.record(id) })
        setPid(id)
        setPicker(false)
      }} />}
    </div>
  )
}

function PatientRecord({ pid, acc, onClose, onPick }: { pid: string; acc: DeskAccess; onClose: () => void; onPick: () => void }) {
  const q = useQuery({ queryKey: DK.record(pid), queryFn: () => get<DeskRecord>(`/dialysis/desk/patients/${pid}`) })
  const [cancel, setCancel] = useState<Session | null>(null)
  if (q.isLoading) return <Card><Spinner label="Opening the dialysis record…" /></Card>
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return <Card><Empty icon="UserX" title="Patient not found" action={<Button onClick={onPick}>Select another patient</Button>} /></Card>
    }
    return <Card><ErrorBox error={q.error} /></Card>
  }
  const r = q.data!
  const canOperate = acc.operate && r.can_operate
  const s = r.open_session
  const running = s?.status === 'In Progress'
  const last = r.sessions.find((x) => x.status === 'Completed')
  const lastToday = !s && last && (last.ended_at ?? '').slice(0, 10) === todayISO() ? last : null
  const cancelBtn = s && canOperate
    ? <Button size="xs" variant="ghost" icon="Ban" className="text-red-600 hover:text-red-700" onClick={() => setCancel(s)}>Cancel session</Button>
    : undefined

  return (
    <div className="space-y-4">
      <Banner r={r} onClose={onClose} />
      <Stepper s={s} />
      {!r.plan && (
        <Notice tone="amber">No active dialysis prescription on file — the viral status is unconfirmed, so dedicated (HBsAg / HCV / HIV) machines are not offered and an isolation / AKI machine is preferred.</Notice>
      )}
      {!canOperate && <Notice>View only — check-in, sessions and check-out are recorded by the dialysis nurses and doctors.</Notice>}

      {!s && (
        <Card title="Check-in" icon="LogIn">
          {lastToday && <div className="mb-3"><Notice tone="blue">Last session {lastToday.code} completed at {time(lastToday.ended_at)}{lastToday.uf_achieved_ml !== null && lastToday.uf_achieved_ml !== undefined ? ` · UF ${lastToday.uf_achieved_ml} ml` : ''}.</Notice></div>}
          {canOperate ? <CheckInForm r={r} /> : <Entitlements r={r} />}
        </Card>
      )}

      {s && !running && (
        <Card title={<>Session {s.code} <Badge tone="amber" dot>{s.status}</Badge></>} icon="Activity" actions={cancelBtn}>
          <SessionFacts s={s} />
          {canOperate && <div className="mt-4 border-t border-line pt-4"><StartForm r={r} s={s} /></div>}
        </Card>
      )}

      {s && running && (
        <>
          <Card title={<>Session {s.code} <Badge tone="blue" dot>In Progress</Badge></>} icon="Activity" actions={cancelBtn}>
            <SessionFacts s={s} />
            {s.machine_warning && <div className="mt-3"><Notice tone="amber">⚠ {s.machine_warning}</Notice></div>}
          </Card>
          <Card pad={false} title="Intradialytic chart" icon="LineChart"><ChartPanel s={s} canOperate={canOperate} /></Card>
          {canOperate && <Card title="Check-out" icon="LogOut"><CheckOutForm key={s.id} r={r} s={s} /></Card>}
        </>
      )}

      <Card pad={false} title="Recent sessions" icon="History"><SessionHistory sessions={r.sessions} /></Card>
      {cancel && <CancelDialog s={cancel} onClose={() => setCancel(null)} />}
    </div>
  )
}

function Banner({ r, onClose }: { r: DeskRecord; onClose: () => void }) {
  const p = r.patient
  const plan = r.plan
  const access = r.access.find((a) => a.status === 'In Use') ?? r.access[0]
  const accessText = access ? `${access.access_type}${access.site ? ` (${access.site})` : ''}${access.status ? ` · ${access.status}` : ''}` : plan?.vascular_access ?? 'Not recorded'
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3">
        <Avatar name={p.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link to={`/patients/${p.id}`} className="text-lg font-semibold text-ink hover:underline">{p.name ?? 'Patient'}</Link>
            <span className="text-sm text-ink-2">{[p.uhid, p.age !== null && p.age !== undefined ? `${p.age}y` : null, p.gender, p.phone].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={viralTone(plan?.viral_status)} dot>Viral status: {plan?.viral_status ?? 'not on file'}</Badge>
            <Badge tone="gray">Dry weight {kg(plan?.dry_weight_kg)}</Badge>
            <Badge tone={access && access.status && access.status !== 'In Use' ? 'amber' : 'gray'}>Access: {accessText}</Badge>
            {plan && <Badge tone="cyan">{[plan.modality, plan.frequency, plan.duration_hours ? `${plan.duration_hours} h` : null, plan.blood_flow_rate ? `Qb ${plan.blood_flow_rate}` : null].filter(Boolean).join(' · ')}</Badge>}
            {plan?.payer && <Badge tone="gray">{plan.payer}</Badge>}
          </div>
          <div className="mt-2 text-sm"><EntitlementLine r={r} /></div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close the patient record" title="Close"><X className="size-4" /></Button>
      </div>
    </Card>
  )
}

function EntitlementLine({ r }: { r: DeskRecord }) {
  const bills = r.entitlements.filter((e) => e.available > 0)
  const s = r.open_session
  if (s?.billing_ref) {
    return <span className="text-ink">Session {s.code} billed on <b>{s.billing_ref}</b>{r.available_sessions > 0 ? <span className="text-ink-2"> · {r.available_sessions} more unused session(s)</span> : null}</span>
  }
  if (r.ip) {
    return <span className="text-ink">Admitted · <b>IP {r.ip.ip_no}</b>{r.ip.ward ? ` · ${r.ip.ward}` : ''}{r.ip.bed ? ` / ${r.ip.bed}` : ''} <span className="text-ink-2">— sessions are charged to the IP account at check-out</span>{bills.length ? ` · also ${r.available_sessions} unused OP session(s)` : ''}</span>
  }
  if (r.available_sessions > 0) {
    return <span className="text-ink"><b>{r.available_sessions}</b> unused session{r.available_sessions === 1 ? '' : 's'} on OP bill{bills.length === 1 ? '' : 's'} {bills.map((b) => b.bill).join(', ')}</span>
  }
  return <span className="font-medium text-amber-700 dark:text-amber-300">Not billed — bill a dialysis session at the OP counter before the next check-in</span>
}

function Entitlements({ r }: { r: DeskRecord }) {
  if (!r.entitlements.length && !r.ip) return <p className="text-sm text-ink-3">No dialysis bill or admission to use.</p>
  return (
    <ul className="space-y-1 text-sm">
      {r.entitlements.map((e) => (
        <li key={e.charge_id} className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">Bill {e.bill}</span>
          <span className="text-ink-2">{e.service}</span>
          <Badge tone={e.available ? 'green' : 'gray'}>{e.available ? `${e.available} of ${e.sessions} unused` : 'All used'}</Badge>
          {e.used_by.length > 0 && <span className="text-xs text-ink-3">used by {e.used_by.map((u) => u.code).join(', ')}</span>}
        </li>
      ))}
      {r.ip && <li className="text-ink-2">IP {r.ip.ip_no} — charged per session at check-out</li>}
    </ul>
  )
}

function SessionFacts({ s }: { s: Session }) {
  const running = s.status === 'In Progress'
  const elapsed = running && s.started_at ? Math.max(0, Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000)) : null
  const items: { label: ReactNode; value: ReactNode }[] = [
    { label: 'Checked in', value: dateTime(s.checked_in_at ?? s.scheduled_at) },
    { label: 'Billed on', value: s.billing_ref ?? '—' },
    { label: 'Modality · access', value: [s.modality, s.access_used].filter(Boolean).join(' · ') || '—' },
    { label: 'Pre weight · BP', value: `${kg(s.pre_weight)} · ${s.pre_bp ?? '—'}` },
    { label: 'Pre pulse · temp', value: `${s.pre_pulse ?? '—'} /min · ${s.pre_temperature ?? '—'} °F` },
  ]
  if (running) {
    items.push(
      { label: 'Machine', value: s.machine_name ?? '—' },
      { label: 'Started', value: <>{time(s.started_at)}{elapsed !== null && <span className="text-ink-3"> · {minutes(elapsed)} ago</span>}</> },
      { label: 'UF goal · Qb', value: `${s.uf_goal_ml !== null && s.uf_goal_ml !== undefined ? `${s.uf_goal_ml} ml` : '—'} · ${s.blood_flow_rate ? `${s.blood_flow_rate} ml/min` : '—'}` },
      { label: 'Heparin · dialyser use', value: `${s.heparin_units !== null && s.heparin_units !== undefined ? `${s.heparin_units} IU` : '—'} · ${s.dialyser_use_no ? `use #${s.dialyser_use_no}` : '—'}` },
    )
  }
  return <KeyValue cols={3} items={items} />
}

type StepState = 'done' | 'current' | 'todo'

/** Check-in → Session → Check-out, reflecting the open session's status. */
function Stepper({ s }: { s: Session | null }) {
  const running = s?.status === 'In Progress'
  const steps: { label: string; state: StepState; detail: string }[] = [
    { label: 'Check-in', state: s ? 'done' : 'current', detail: s ? `${s.code} · ${s.status === 'Scheduled' ? 'scheduled' : `in ${time(s.checked_in_at ?? s.scheduled_at)}`}` : 'Entitlement, pre-dialysis vitals' },
    { label: 'Session', state: !s ? 'todo' : running ? 'done' : 'current', detail: running ? `Running on ${s.machine_name ?? 'machine'} since ${time(s.started_at)}` : 'Machine, UF goal, Qb, heparin' },
    { label: 'Check-out', state: running ? 'current' : 'todo', detail: 'Post weight, UF achieved, events' },
  ]
  const stateText: Record<StepState, string> = { done: 'Done', current: 'Now', todo: 'Next' }
  return (
    <ol className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-3" aria-label="Session progress">
      {steps.map((st, i) => (
        <li key={st.label} aria-current={st.state === 'current' ? 'step' : undefined} className="flex items-start gap-2.5">
          <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold',
            st.state === 'done' ? 'bg-brand-700 text-white' : st.state === 'current' ? 'bg-brand-50 text-brand-800 ring-2 ring-brand-600 dark:bg-brand-500/15 dark:text-brand-200' : 'bg-surface-2 text-ink-3 ring-1 ring-line')}>
            {st.state === 'done' ? <Check className="size-4" aria-hidden /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-ink">{st.label}
              <span className={cn('text-[11px] font-medium', st.state === 'current' ? 'text-brand-700 dark:text-brand-300' : 'text-ink-3')}>{stateText[st.state]}</span>
            </span>
            <span className="block truncate text-xs text-ink-2">{st.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
