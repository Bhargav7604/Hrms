import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useParams } from 'react-router'
import { ErrorBox, Spinner } from '@/components/ui'
import { QrCode } from '@/portal/QrCode'
import { api } from '@/lib/api'
import { date, dateTime } from '@/lib/format'
import type { AllergyView, ChartHeader, ReactiveView } from './api'

interface PrintData extends Pick<ChartHeader, 'admission' | 'patient' | 'bed' | 'department' | 'doctor' | 'second_doctor'> {
  doc: string; hospital: { name: string }; printed_at: string; printed_by: string; allergies: AllergyView; reactive: ReactiveView
  vitals?: { recorded_at: string; bp_systolic: number | null; bp_diastolic: number | null; pulse: number | null; spo2: number | null; temperature_c: number | null; resp_rate: number | null; news2: number | null } | null
  investigations?: { test: string; status: string; ordered_at: string; reported_at?: string | null; critical: boolean; abnormal: string[]; impression?: string | null }[]
  medications?: { name: string; dose?: string; route?: string; frequency?: string }[]
  procedures?: { at: string; description: string; type: string }[]
  notes?: { noted_at: string; type: string; shift?: string; author?: string; note: string }[]
  discharge_summary?: { code: string; status: string; final_diagnosis?: string; condition_at_discharge?: string; follow_up?: string } | null
}

const css = `body{background:#fff;color:#111}.sheet{font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:800px;margin:0 auto;padding:24px}
h1{font-size:18px;margin:0}h2{font-size:13px;margin:16px 0 6px;border-bottom:1px solid #ccc;padding-bottom:2px}table{width:100%;border-collapse:collapse}
td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}.muted{color:#555}.grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}
.band{display:flex;align-items:center;gap:12px;border:2px solid #111;border-radius:10px;padding:8px 12px;width:9.5cm;height:2.6cm;box-sizing:border-box}
.red{color:#b91c1c;font-weight:600}@media print{.noprint{display:none}@page{margin:10mm}}`

/** Printable wristband (QR), face sheet and case summary for an admission. */
export default function PrintDoc() {
  const { id = '', doc = 'wristband' } = useParams()
  const q = useQuery({ queryKey: ['x', 'ipd', 'print', id, doc], queryFn: () => api<PrintData>(`/ipchart/admissions/${id}/print`, { query: { doc } }) })
  useEffect(() => { if (q.data) setTimeout(() => window.print(), 400) }, [q.data])
  if (q.isLoading) return <Spinner label="Preparing…" />
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} /></div>
  const d = q.data!
  const a = d.admission
  const p = d.patient
  const allergy = d.allergies.status === 'present' ? [...d.allergies.types, ...d.allergies.list].join(', ') : d.allergies.status === 'nka' ? 'No known allergies' : 'Not recorded'
  if (doc === 'wristband') {
    return (
      <div className="sheet"><style>{css}</style>
        <div className="band">
          <QrCode value={`${p.uhid}|${a.code}`} size={80} title={`UHID ${p.uhid}, IP ${a.code}`} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{p.name}</div>
            <div>{p.age != null ? `${p.age}y` : ''} {p.gender ?? ''} · DOB {p.dob ? date(p.dob) : '—'}</div>
            <div>UHID <b>{p.uhid}</b> · IP <b>{a.code}</b></div>
            <div>{d.bed ? `${d.bed.ward} · Bed ${d.bed.bed_no}` : ''}</div>
            {d.allergies.status === 'present' && <div className="red">ALLERGY: {allergy}</div>}
          </div>
        </div>
        <p className="muted noprint">Print on wristband stock. The QR holds the UHID and IP number for bedside barcode verification.</p>
      </div>
    )
  }
  const rows: [string, string | null | undefined][] = [
    ['UHID', p.uhid], ['IP number', a.code], ['Name', p.name], ['Age / sex', `${p.age ?? '—'} / ${p.gender ?? '—'}`], ['Date of birth', p.dob ? date(p.dob) : '—'],
    ['Mobile', p.phone], ['Blood group', p.blood_group], ['Admitted', dateTime(a.started_at)], ['Ward / bed', d.bed ? `${d.bed.ward} · ${d.bed.bed_no}` : '—'],
    ['Department', d.department?.name], ['Primary consultant', d.doctor?.name], ['Second consultant', d.second_doctor?.name], ['Category', `${a.payer_label}${a.sponsor ? ` · ${a.sponsor.name}` : ''}`],
    ['Auth letter no', a.authorisation_no], ['Admission type', `${a.admission_type ?? ''} · from ${a.admission_source ?? ''}`], ['Attendant', [a.attendant_name, a.attendant_phone].filter(Boolean).join(' · ')],
    ['MLC', a.mlc ? 'Yes' : 'No'], ['Condition', a.condition], ['Allergies', allergy], ['Reactive', d.reactive.status === 'reactive' ? d.reactive.conditions.join(', ') : d.reactive.status === 'non_reactive' ? 'Non reactive' : 'Not recorded'],
  ]
  return (
    <div className="sheet"><style>{css}</style>
      <h1>{d.hospital.name}</h1>
      <div className="muted">{doc === 'face-sheet' ? 'Admission face sheet' : 'Inpatient case summary'} · printed {dateTime(d.printed_at)} by {d.printed_by}</div>
      <h2>Patient & admission</h2>
      <table><tbody>{Array.from({ length: Math.ceil(rows.length / 2) }, (_, i) => (
        <tr key={i}>{rows.slice(i * 2, i * 2 + 2).map(([k, v]) => <><th key={k} style={{ width: '18%' }}>{k}</th><td key={`${k}v`}>{v || '—'}</td></>)}</tr>
      ))}</tbody></table>
      <h2>Reason for admission / provisional diagnosis</h2>
      <p>{a.reason || '—'}</p><p><b>{a.diagnosis || '—'}</b></p>
      {doc === 'case-summary' && <>
        {d.vitals && <><h2>Latest observations</h2><p>{dateTime(d.vitals.recorded_at)} · BP {d.vitals.bp_systolic}/{d.vitals.bp_diastolic} · HR {d.vitals.pulse} · RR {d.vitals.resp_rate} · SpO₂ {d.vitals.spo2}% · Temp {d.vitals.temperature_c} °C{d.vitals.news2 != null ? ` · NEWS2 ${d.vitals.news2}` : ''}</p></>}
        <h2>Investigations</h2>
        {d.investigations?.length ? <table><thead><tr><th>Test</th><th>Status</th><th>Reported</th><th>Abnormal / impression</th></tr></thead><tbody>{d.investigations.map((x, i) => (
          <tr key={i}><td>{x.test}{x.critical ? ' (critical)' : ''}</td><td>{x.status}</td><td>{x.reported_at ? dateTime(x.reported_at) : '—'}</td><td>{[...x.abnormal, x.impression].filter(Boolean).join('; ') || '—'}</td></tr>
        ))}</tbody></table> : <p className="muted">None</p>}
        <h2>Current medications</h2>
        {d.medications?.length ? <ul>{d.medications.map((m, i) => <li key={i}>{m.name} — {[m.dose, m.route, m.frequency].filter(Boolean).join(' ')}</li>)}</ul> : <p className="muted">None on record</p>}
        <h2>Procedures</h2>
        {d.procedures?.length ? <ul>{d.procedures.map((x, i) => <li key={i}>{dateTime(x.at)} · {x.description} ({x.type})</li>)}</ul> : <p className="muted">None</p>}
        <h2>Course in hospital (progress notes)</h2>
        {d.notes?.length ? d.notes.map((n, i) => <p key={i}><b>{dateTime(n.noted_at)}{n.shift ? ` · ${n.shift}` : ''} · {n.author}</b><br />{n.note}</p>) : <p className="muted">No notes</p>}
        {d.discharge_summary && <><h2>Discharge summary</h2><p>{d.discharge_summary.code} · {d.discharge_summary.status} · {d.discharge_summary.final_diagnosis} · {d.discharge_summary.condition_at_discharge}</p></>}
      </>}
      <p className="muted" style={{ marginTop: 24 }}>Computer-generated document — confidential patient information.</p>
    </div>
  )
}
