import { useState } from 'react'
import { Link } from 'react-router'
import { RecordFormModal, useEntity } from '@/components/records'
import { Badge, cn, CopyButton } from '@/components/ui'
import { useRegistry } from '@/lib/auth'
import { dateTime, time } from '@/lib/format'
import { Icon } from '@/lib/icons'
import { chartLink, clockState, hm, liveMinutes, losState, STEP_PANEL, useErRefresh, useNow, type VisitDetail } from '../api'
import { AlertsDialog, VitalsDialog } from '../dialogs'
import { ClockBadge, StateBadge, targetText, TimeInEr, TriagePill, UnmappedBadge } from '../ui'

export function ChartHeader({ d }: { d: VisitDetail }) {
  const s = d.summary
  const p = d.permissions
  const now = useNow(30_000)
  const mins = liveMinutes(s, now)
  const los = losState(mins, s.los_target_minutes, s.state)
  const clock = clockState(s, now)
  const assigned = d.assignments[d.assignments.length - 1]
  const v = d.visit
  return (
    <section className="rounded-2xl border border-line bg-gradient-to-br from-emerald-50/70 via-surface to-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] dark:from-emerald-500/5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1.6fr)]">
        <div className="flex min-w-0 gap-3">
          <div className="relative grid size-14 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-300">
            <Icon name={d.patient.gender === 'Female' ? 'UserRound' : 'User'} className="size-7" />
            {d.patient.gender && <span className="absolute -bottom-1 -right-1 rounded-full bg-surface px-1 text-[10px] font-bold text-ink-2 ring-1 ring-line">{d.patient.gender[0]}</span>}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-700/10 dark:bg-brand-500/10 dark:text-brand-200">
                ER {s.code}<CopyButton value={s.code} label="Copy ER no" />
              </span>
              {d.temporary && <UnmappedBadge />}
              <StateBadge state={s.state} />
              {s.mlc && <Badge tone="violet">MLC{s.mlc_no ? ` · ${s.mlc_no}` : ''}</Badge>}
            </div>
            <h2 className="truncate text-xl font-semibold tracking-tight text-ink">{s.patient.name}</h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
              <span>{[s.patient.gender, s.patient.age !== null && s.patient.age !== undefined ? `${s.patient.age} y${d.patient.dob_estimated ? ' (approx.)' : ''}` : null].filter(Boolean).join(' · ') || 'Gender not known'}</span>
              {s.patient.uhid && (
                <span className="inline-flex items-center gap-0.5">UHID {d.temporary ? <i className="text-ink-3">temporary</i> : s.patient.uhid}<CopyButton value={s.patient.uhid} label="Copy UHID" /></span>
              )}
              <span className="inline-flex items-center gap-1"><Icon name="LogIn" className="size-3.5" />Arrived {dateTime(s.arrived_at)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
              <span className="inline-flex items-center gap-1"><Icon name="BedDouble" className="size-3.5" />{s.bed ? `${s.bed.ward ?? 'ER'} · Bed ${s.bed.bed_no}` : 'No bed (triage area)'}</span>
              <TriagePill triage={s.triage} />
              <span className="inline-flex items-center gap-1"><Icon name="Wallet" className="size-3.5" />{s.payer}</span>
              <span className="inline-flex items-center gap-1"><Icon name="ReceiptText" className="size-3.5" />Bill {s.bill?.code ?? '—'}</span>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <HeadCol icon="Stethoscope" label="ER doctor">
            <div className="font-semibold text-ink">{s.doctor?.name ?? 'Not assigned'}</div>
            <div className="text-xs text-ink-3">{assigned?.at ? `Assigned ${time(assigned.at)}` : p.assign ? <Link className="text-brand-700 hover:underline" to={chartLink(s.id, 'doctor-assignment')}>Assign a doctor</Link> : '—'}</div>
          </HeadCol>
          <HeadCol icon="Siren" label="Triage">
            <TriagePill triage={s.triage} />
            <div className="mt-0.5 text-xs text-ink-3">
              {s.triage ? <>Target {targetText(s.triage.target_minutes)}{s.triaged_at && ` · triaged ${time(s.triaged_at)}`}</> : 'Not triaged yet'}
            </div>
            {s.state === 'Active' && <div className="mt-1"><ClockBadge state={clock} /></div>}
          </HeadCol>
          <HeadCol icon="Clock" label="Time in ER">
            <TimeInEr minutes={mins} state={los} className="text-lg" />
            <div className="text-xs text-ink-3">{s.state === 'Active' ? `since ${time(s.arrived_at)} · target ${hm(s.los_target_minutes)}` : s.outcome ?? s.state}</div>
          </HeadCol>
          {p.view_clinical && <ClinicalCards d={d} />}
        </div>
      </div>
      {v.unidentified && v.identification_marks && p.view_clinical && (
        <p className="mt-3 text-xs text-ink-2"><b>Identification marks:</b> {v.identification_marks}</p>
      )}
      <Progress d={d} />
    </section>
  )
}

function HeadCol({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-brand-700 dark:text-brand-300" />
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
        {children}
      </div>
    </div>
  )
}

function ClinicalCards({ d }: { d: VisitDetail }) {
  const p = d.permissions
  const reg = useRegistry()
  const refresh = useErRefresh()
  const allergyEnt = useEntity('emr.allergies')
  const [dlg, setDlg] = useState<'allergy' | 'alerts' | 'vitals' | null>(null)
  const canAllergy = !!allergyEnt && reg.canEntity('emr.allergies', 'write') && p.nursing
  const lv = d.latest_vitals
  const alerts = d.summary.alerts
  return (
    <>
      <AlertCard tone={d.allergy_status === 'recorded' ? 'red' : d.allergy_status === 'nka' ? 'green' : 'amber'} icon="TriangleAlert"
        title={d.allergy_status === 'recorded' ? `Allergies (${d.allergies.length})` : d.allergy_status === 'nka' ? 'No known allergies' : 'Allergies'}
        body={d.allergy_status === 'recorded' ? d.allergies.map((a) => a.allergen).join(', ') : d.allergy_status === 'nka' ? 'Per nursing assessment' : 'not recorded'}
        action={canAllergy ? { label: 'Add', onClick: () => setDlg('allergy') } : undefined} />
      <AlertCard tone={alerts.length ? 'red' : 'green'} icon="ShieldCheck" title={alerts.length ? `${alerts.length} alert${alerts.length > 1 ? 's' : ''}` : 'No alerts'}
        body={alerts.join(' · ') || 'Violence, isolation, DNR…'} action={p.alerts ? { label: 'Edit', onClick: () => setDlg('alerts') } : undefined} />
      <AlertCard tone="blue" icon="HeartPulse" title={lv ? `Obs ${time(lv.recorded_at)}` : 'No obs yet'}
        body={lv ? [lv.bp_systolic && `BP ${lv.bp_systolic}/${lv.bp_diastolic ?? '—'}`, lv.pulse && `HR ${lv.pulse}`, lv.spo2 && `SpO₂ ${lv.spo2}%`,
          lv.news2 !== undefined && lv.news2 !== null && `NEWS2 ${lv.news2}`].filter(Boolean).join(' · ') : 'Record the first observations'}
        action={p.vitals ? { label: 'Record', onClick: () => setDlg('vitals') } : undefined} />
      {dlg === 'allergy' && allergyEnt && (
        <RecordFormModal entity={allergyEnt} open onClose={() => setDlg(null)} fixed={{ patient_id: d.patient.id }} title="Record an allergy"
          onSaved={() => { setDlg(null); refresh() }} />
      )}
      {dlg === 'alerts' && <AlertsDialog visitId={d.summary.id} open onClose={() => setDlg(null)} current={alerts} />}
      {dlg === 'vitals' && <VitalsDialog visitId={d.summary.id} open onClose={() => setDlg(null)} />}
    </>
  )
}

const CARD_TONE = {
  red: 'bg-red-50 ring-red-200 text-red-900 dark:bg-red-500/10 dark:ring-red-500/30 dark:text-red-200',
  amber: 'bg-amber-50 ring-amber-200 text-amber-900 dark:bg-amber-500/10 dark:ring-amber-500/30 dark:text-amber-200',
  green: 'bg-emerald-50 ring-emerald-200 text-emerald-900 dark:bg-emerald-500/10 dark:ring-emerald-500/30 dark:text-emerald-200',
  blue: 'bg-sky-50 ring-sky-200 text-sky-900 dark:bg-sky-500/10 dark:ring-sky-500/30 dark:text-sky-200',
}

function AlertCard({ tone, icon, title, body, action }: {
  tone: keyof typeof CARD_TONE; icon: string; title: string; body: string; action?: { label: string; onClick: () => void }
}) {
  return (
    <div className={cn('flex min-w-0 items-start gap-2 rounded-xl px-3 py-2 ring-1', CARD_TONE[tone])}>
      <Icon name={icon} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="truncate text-xs opacity-80" title={body}>{body}</div>
      </div>
      {action && (
        <button type="button" onClick={action.onClick} className="rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide hover:bg-white/60 dark:hover:bg-white/10">
          {action.label}
        </button>
      )}
    </div>
  )
}

function Progress({ d }: { d: VisitDetail }) {
  const st = d.steps
  const cur = st.steps.find((x) => x.current)
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-3 text-xs">
      <span className="inline-flex items-center gap-1 text-ink-2"><Icon name="ListChecks" className="size-4" /><b className="text-ink">{st.done}/{st.total}</b> done</span>
      <span className="flex items-center gap-1" aria-label={`Workflow ${st.done} of ${st.total} steps done`}>
        {st.steps.map((x) => (
          <span key={x.key} title={`${x.label}${x.optional ? ' (optional)' : ''} — ${x.done_at ? `done ${dateTime(x.done_at)}` : x.current ? 'current' : 'pending'}`}
            className={cn('h-2 w-6 rounded-full', x.done_at ? 'bg-emerald-500' : x.current ? 'bg-brand-800 dark:bg-brand-300' : 'bg-line-2', x.optional && !x.done_at && 'opacity-50')} />
        ))}
      </span>
      {cur ? (
        <Link to={chartLink(d.summary.id, STEP_PANEL[cur.key])} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Now: {cur.label} →</Link>
      ) : <span className="text-ink-2">{st.current_label}</span>}
    </div>
  )
}
