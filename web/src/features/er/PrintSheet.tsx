import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { ErrorBox, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { useMeta } from '@/lib/auth'
import { dateTime } from '@/lib/format'
import { erKey, hm, OUTCOME_LABEL, useVisit, type VisitDetail } from './api'
import type { VisitOrders } from './chart/Overview'

const TITLES: Record<string, string> = {
  registration: 'ER registration slip', 'case-sheet': 'Emergency case sheet', triage: 'Triage record', nursing: 'ER nursing assessment',
  'discharge-summary': 'ER discharge summary', handover: 'S-BAR handover', mlc: 'Medico-legal case — police intimation',
}

function Row({ k, v }: { k: string; v: unknown }) {
  if (v === null || v === undefined || v === '') return null
  return <tr><th className="w-48 border border-slate-300 bg-slate-50 px-2 py-1 text-left align-top font-semibold">{k}</th><td className="whitespace-pre-wrap border border-slate-300 px-2 py-1">{String(v)}</td></tr>
}

/** Printable ER documents (opened in a new tab; prints automatically; each print is audited). */
export default function PrintSheet() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const doc = params.get('doc') ?? 'case-sheet'
  const meta = useMeta()
  const q = useVisit(id)
  const clinical = !!q.data?.permissions.view_clinical
  const orders = useQuery({ queryKey: erKey('orders', id), queryFn: () => api<VisitOrders>(`/er/visits/${id}/orders`), enabled: clinical })
  const ready = q.data && (!clinical || orders.data || orders.error)
  useEffect(() => {
    if (!ready) return
    api(`/er/visits/${id}/print`, { method: 'POST', body: { document: doc } }).catch(() => {})
    const t = window.setTimeout(() => window.print(), 400)
    return () => window.clearTimeout(t)
  }, [ready, id, doc])
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} /></div>
  if (!ready) return <Spinner label="Preparing the document…" />
  const d = q.data!
  return (
    <div className="mx-auto max-w-4xl bg-white p-8 text-[12px] leading-snug text-slate-900">
      <header className="mb-4 flex items-start justify-between border-b-2 border-slate-800 pb-2">
        <div>
          <div className="text-lg font-bold">{meta.data?.hospital.name ?? 'Hospital'}</div>
          <div className="text-xs text-slate-600">Emergency Department</div>
        </div>
        <div className="text-right">
          <div className="text-base font-semibold">{TITLES[doc] ?? 'ER document'}</div>
          <div className="text-xs text-slate-600">ER no {d.summary.code} · printed {dateTime(new Date().toISOString())}</div>
        </div>
      </header>
      <Body d={d} doc={doc} orders={orders.data} />
      <footer className="mt-10 flex justify-between text-xs text-slate-600">
        <span>Signature of {doc === 'nursing' || doc === 'triage' || doc === 'handover' ? 'nurse' : 'doctor'}: ____________________</span>
        <span>Confidential patient information</span>
      </footer>
    </div>
  )
}

function Body({ d, doc, orders }: { d: VisitDetail; doc: string; orders?: VisitOrders }) {
  const s = d.summary
  const v = d.visit
  const n = d.nursing
  const a = d.doctor_assessment
  const patient = (
    <table className="mb-3 w-full border-collapse">
      <tbody>
        <Row k="Patient" v={`${s.patient.name}${d.temporary ? ' (temporary record — UHID not mapped)' : ` · UHID ${s.patient.uhid}`}`} />
        <Row k="Age / sex" v={[s.patient.age !== null && s.patient.age !== undefined ? `${s.patient.age} y` : null, s.patient.gender].filter(Boolean).join(' / ')} />
        <Row k="Arrived" v={`${dateTime(s.arrived_at)} · ${v.arrival_mode ?? ''}`} />
        <Row k="Bed / doctor" v={`${s.bed?.bed_no ?? '—'} · ${s.doctor?.name ?? '—'}`} />
        <Row k="Triage" v={s.triage?.label ?? 'Not triaged'} />
        <Row k="MLC" v={s.mlc ? `Yes${s.mlc_no ? ` — ${s.mlc_no}` : ''}` : 'No'} />
      </tbody>
    </table>
  )
  const inv = orders?.investigations ?? []
  const meds = orders?.medicines ?? []
  switch (doc) {
    case 'registration':
      return <>{patient}<table className="w-full border-collapse"><tbody>
        <Row k="Brought by" v={[v.brought_by_type, v.brought_by].filter(Boolean).join(' — ')} /><Row k="Attendant mobile" v={v.attendant_phone} />
        <Row k="Payer" v={v.payer} /><Row k="Presenting complaint" v={v.chief_complaint} /><Row k="Registered by" v={v.registered_by} />
      </tbody></table></>
    case 'triage':
      return <>{patient}<table className="w-full border-collapse"><tbody>
        {d.triage_history.map((t) => <Row key={t.id} k={dateTime(t.triaged_at)} v={`${t.triage_level}${t.retriage ? ` (re-triage: ${t.retriage_reason})` : ''}${t.red_flags?.length ? ` · ${t.red_flags.join(', ')}` : ''}`} />)}
      </tbody></table></>
    case 'nursing':
      return <>{patient}<table className="w-full border-collapse"><tbody>
        <Row k="Assessed" v={n && dateTime(n.assessed_at)} /><Row k="AVPU / airway / breathing" v={n && [n.avpu, n.airway, n.breathing].filter(Boolean).join(' · ')} />
        <Row k="Circulation / fall risk" v={n && [n.circulation, n.fall_risk && `fall risk ${n.fall_risk}`].filter(Boolean).join(' · ')} /><Row k="Skin" v={n?.skin} />
        <Row k="Vitals" v={n && `BP ${n.bp_systolic ?? '—'}/${n.bp_diastolic ?? '—'} · HR ${n.pulse ?? '—'} · RR ${n.resp_rate ?? '—'} · T ${n.temperature ?? '—'} °F · SpO₂ ${n.spo2 ?? '—'}% (${n.spo2_on ?? '—'}) · GRBS ${n.grbs ?? '—'}`} />
        <Row k="GCS" v={n && `E${n.gcs_e ?? '-'} V${n.gcs_v ?? '-'} M${n.gcs_m ?? '-'} = ${n.gcs_total ?? '—'}`} /><Row k="Pain" v={n && `${n.pain_score ?? '—'}/10 · ${[n.pain_location, n.pain_character, n.pain_type, n.pain_duration].filter(Boolean).join(', ')}`} />
        <Row k="Allergies" v={n && `Medication: ${n.medication_allergy ?? '—'} · Food: ${n.food_allergy ?? '—'}${n.other_allergies ? ` · ${n.other_allergies}` : ''}`} /><Row k="Notes" v={n?.notes} />
      </tbody></table></>
    case 'handover':
      return <>{patient}{d.handovers.map((h) => <table key={h.id} className="mb-2 w-full border-collapse"><tbody>
        <Row k={`${h.shift} · ${dateTime(h.handover_at)}`} v={`S: ${h.situation}\nB: ${h.background ?? ''}\nA: ${h.assessment ?? ''}\nR: ${h.recommendation ?? ''}`} />
      </tbody></table>)}</>
    case 'mlc':
      return <>{patient}<p className="mb-2">To the Station House Officer, {v.police_station ?? '____________ Police Station'}.</p>
        <p className="mb-2">This is to inform you that the above patient was brought to the Emergency Department on {dateTime(s.arrived_at)} by {[v.brought_by_type, v.brought_by].filter(Boolean).join(' — ') || '—'} with {v.chief_complaint}. The case has been registered as a medico-legal case{s.mlc_no ? ` (MLC no. ${s.mlc_no})` : ''}{d.mlc_case ? `, register entry ${d.mlc_case.code}` : ''}. Kindly take necessary action.</p>
        <table className="w-full border-collapse"><tbody><Row k="Identification marks" v={v.identification_marks} /><Row k="Examining doctor" v={s.doctor?.name} /></tbody></table></>
    default: // case sheet & discharge summary
      return <>{patient}<table className="w-full border-collapse"><tbody>
        <Row k="Presenting complaints" v={a?.presenting_complaints ?? v.chief_complaint} /><Row k="History" v={a?.history} /><Row k="Past history" v={a?.past_history} />
        <Row k="Examination" v={a && [a.general_examination, a.cvs && `CVS: ${a.cvs}`, a.rs && `RS: ${a.rs}`, a.cns && `CNS: ${a.cns}`, a.abdomen && `P/A: ${a.abdomen}`, a.local_examination].filter(Boolean).join('\n')} />
        <Row k="Diagnosis" v={v.provisional_diagnosis ?? a?.provisional_diagnosis} />
        <Row k="Investigations" v={inv.map((o) => `${o.test.name} — ${o.status}${o.impression ? `: ${o.impression}` : ''}${o.result_values.length ? `: ${o.result_values.map((r) => `${r.parameter} ${String(r.value ?? '')} ${r.unit ?? ''}${r.flag && r.flag !== 'Normal' ? ` (${r.flag})` : ''}`).join(', ')}` : ''}`).join('\n')} />
        <Row k="Medicines given" v={meds.map((m) => `${m.drug} ${[m.dose, m.route, m.frequency].filter(Boolean).join(' ')}`).join('\n')} />
        <Row k="Treatment & course" v={d.treatments.slice().reverse().map((t) => `${dateTime(t.recorded_at)} ${t.entry_type}: ${t.details}`).join('\n')} />
        {doc === 'discharge-summary' && <>
          <Row k="Outcome" v={v.disposition ? `${OUTCOME_LABEL[v.disposition] ?? v.disposition} · ${dateTime(v.disposed_at)}` : 'Still in the ER'} />
          <Row k="Condition" v={v.condition_at_disposition} /><Row k="Advice" v={v.disposition_notes} /><Row k="Follow-up" v={v.followup_advice} />
          <Row k="Referred / transferred to" v={v.referred_to} /><Row k="Time in ER" v={hm(s.minutes_in_er)} />
        </>}
      </tbody></table></>
  }
}
