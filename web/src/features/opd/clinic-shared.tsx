import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge, cn, PageHeader, type BadgeTone } from '@/components/ui'
import { api, errorMessage, get, post } from '@/lib/api'
import { useAuth, useRegistry } from '@/lib/auth'
import { dateTime, initials, time } from '@/lib/format'

/** Shared pieces of the OPD clinic screens (Nurse Worklist and My Clinic). */

// ------------------------------------------------------------------ data

export const STAGES = ['Not arrived', 'Awaiting vitals', 'Waiting', 'With doctor', 'Seen'] as const
export type Stage = (typeof STAGES)[number]

/** One OP visit of the day, as returned by /opd/worklist and /opd/my-clinic. */
export interface Visit {
  id: string; code: string; date: string; slot?: string | null; token_no?: number | null; type?: string | null; status: string; stage: Stage
  priority?: string | null; patient_id: string; patient: string; uhid: string; age?: number | null; gender?: string | null; phone?: string | null
  doctor_id?: string | null; doctor?: string | null; department_id?: string | null; department?: string | null; reason?: string | null
  encounter_id?: string | null; allergies: string[]; vitals_done: boolean; vitals_at?: string | null; in_at?: string | null; out_at?: string | null
  duration_min?: number | null; wait_min?: number | null; bill?: string | null; bill_status?: string | null; charge_status?: string | null
  consult_fee?: number | null
}

export interface DoctorOption { id: string; name: string; department_id?: string | null; department?: string | null; visits?: number }

export interface VitalsView {
  id: string; code?: string; recorded_at?: string | null; height?: number | null; weight?: number | null; bmi?: number | null
  bp_systolic?: number | null; bp_diastolic?: number | null; standing_bp_systolic?: number | null; standing_bp_diastolic?: number | null
  pulse?: number | null; resp_rate?: number | null; spo2?: number | null; o2_support?: string | null; temperature?: number | null
  pain_score?: number | null; blood_sugar?: number | null; head_circumference?: number | null; waist?: number | null; muac?: number | null
  gcs?: number | null; lmp?: string | null; news2?: number | null; news2_risk?: string | null; remarks?: string | null; status?: string | null
}

export interface AllergyItem { allergen: string; severity?: string | null; reaction?: string | null; source?: string | null }

export interface VisitVitals {
  appointment: { id: string; code: string; status: string; type?: string | null; reason?: string | null; token_no?: number | null; encounter_id?: string | null; doctor_id?: string | null }
  patient: { id: string; code: string; title: string; age?: number | null; gender?: string | null; dob?: string | null; blood_group?: string | null; phone?: string | null }
  allergies: AllergyItem[]
  vitals: VitalsView | null
  assessment: Record<string, unknown> | null
  previous: VitalsView[]
}

/** Query keys: appointment changes (check-in, vitals, consultation) refresh every OPD clinic screen through realtime. */
export const OPK = {
  all: ['x', 'appointments'] as const,
  worklist: (q: object) => ['x', 'appointments', 'opd-worklist', q] as const,
  clinic: (q: object) => ['x', 'appointments', 'opd-clinic', q] as const,
  doctors: (d: string) => ['x', 'appointments', 'opd-doctors', d] as const,
  visit: (id: string) => ['x', 'appointments', 'opd-visit-vitals', id] as const,
}

export function useClinicDoctors(date: string, enabled = true) {
  return useQuery({
    queryKey: OPK.doctors(date),
    queryFn: () => get<DoctorOption[]>('/opd/doctors', { date }),
    enabled,
    staleTime: 60_000,
  })
}

// ------------------------------------------------------------------ access

const VIEW_ROLES = ['doctor', 'nurse', 'management']

/**
 * What the signed-in user may see and do on an OPD clinic screen. Mirrors the server rules so no control ends in a 403:
 * view (worklist, my clinic, visit vitals): doctor, nurse, management · vitals: nurse, doctor · check-in: nurse, front office,
 * doctor · OP EMR write: the consulting doctor — admin passes every check.
 */
export function useClinicAccess(page: 'nurse-worklist' | 'my-clinic') {
  const { user } = useAuth()
  const reg = useRegistry()
  const me = user ?? reg.meta?.user ?? null
  const role = me?.role ?? ''
  const admin = role === 'admin'
  const edit = reg.canPage('opd', page, 'edit')
  return {
    ready: !!reg.meta && !!me,
    role,
    employeeId: me?.employee_id ?? null,
    page: reg.canPage('opd', page),
    view: admin || VIEW_ROLES.includes(role),
    checkIn: edit && (admin || ['nurse', 'front_office', 'doctor'].includes(role)),
    vitals: edit && (admin || ['nurse', 'doctor'].includes(role)),
    /** doctors open (and, for their own patients, start) the consultation; admin may too */
    emrOpen: admin || role === 'doctor',
    hospital: reg.meta?.hospital.name ?? 'Hospital',
  }
}

/** Open the OP EMR of a visit (creates the encounter if needed; the consulting doctor starts the consultation). */
export function useOpenEmr() {
  const nav = useNavigate()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (apptId: string) => post<{ encounter_id: string; appointment_id: string }>(`/opd/visits/${apptId}/open`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: OPK.all })
      nav(`/op/emr/${r.encounter_id}`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

// ------------------------------------------------------------------ presentation

export const STAGE_TONE: Record<string, BadgeTone> = {
  'Not arrived': 'gray', 'Awaiting vitals': 'amber', Waiting: 'blue', 'With doctor': 'violet', Seen: 'green',
}

export function StagePill({ stage, className }: { stage: string; className?: string }) {
  return <Badge tone={STAGE_TONE[stage] ?? 'gray'} dot className={className}>{stage}</Badge>
}

export function ageSex(age?: number | null, gender?: string | null): string {
  return [age !== null && age !== undefined ? `${age}y` : null, gender || null].filter(Boolean).join(' · ')
}

export function AgeSexChip({ age, gender }: { age?: number | null; gender?: string | null }) {
  const label = ageSex(age, gender)
  if (!label) return null
  return <Badge tone="violet" className="uppercase tracking-wide text-[10px]">{label}</Badge>
}

/** Initials avatar tinted by sex (sky = male, pink = female, neutral = other / not recorded). */
export function GenderAvatar({ gender, name, size = 'md' }: { gender?: string | null; name?: string; size?: 'sm' | 'md' }) {
  const g = (gender ?? '').toLowerCase()
  const tone = g.startsWith('f')
    ? 'bg-pink-100 text-pink-800 ring-pink-600/20 dark:bg-pink-500/15 dark:text-pink-200'
    : g.startsWith('m')
      ? 'bg-sky-100 text-sky-800 ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-200'
      : 'bg-surface-2 text-ink-2 ring-line'
  return (
    <span title={gender ?? 'Sex not recorded'}
      className={cn('grid shrink-0 place-items-center rounded-full font-semibold ring-1', size === 'sm' ? 'size-7 text-[11px]' : 'size-9 text-xs', tone)}>
      {initials(name)}
    </span>
  )
}

/** Red ⚠ allergy flag with the allergens as text (tooltip carries the full list). */
export function AllergyFlag({ allergies, compact }: { allergies: string[]; compact?: boolean }) {
  if (!allergies.length) return null
  const all = allergies.join(', ')
  const text = compact ? (allergies.length > 1 ? `${allergies[0]} +${allergies.length - 1}` : allergies[0]) : all
  return (
    <span title={`Allergies: ${all}`} className="inline-flex min-w-0 items-center gap-0.5 text-xs font-medium text-red-700 dark:text-red-300">
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate"><span className="sr-only">Allergy: </span>{text}</span>
    </span>
  )
}

export function AllergyChip({ allergies }: { allergies: string[] }) {
  if (!allergies.length) return null
  return (
    <span title={`Allergies: ${allergies.join(', ')}`}>
      <Badge tone="red"><AlertTriangle className="size-3" aria-hidden /> Allergy{allergies.length > 1 ? ` (${allergies.length})` : ''}</Badge>
    </span>
  )
}

/** Page header on the full-screen route; a compact header row when embedded in the module workspace. */
export function ScreenHeader({ embedded, icon, title, subtitle, actions }: {
  embedded?: boolean; icon: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode
}) {
  if (!embedded) return <PageHeader icon={icon} title={title} subtitle={subtitle} actions={actions} />
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {subtitle && <p className="text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ files

/** Client-side CSV of the rows on screen (Excel-friendly UTF-8 with BOM). */
export function downloadCsv(name: string, columns: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = [columns, ...rows].map((r) => r.map(cell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export const PRINT_CSS = `body{font:12px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f1720;margin:24px}
h1{font-size:16px;margin:0} h2{font-size:13px;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:#4b5563}
.sub{color:#4b5563;margin:2px 0 12px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #cfd6de;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f4f6f8;font-weight:600;width:22%} .grid th{width:auto} .allergy{color:#b91c1c;font-weight:600}
.foot{margin-top:14px;color:#8a919c;font-size:10px} @page{margin:12mm}`

/** Open a print window immediately (pop-up blockers allow it inside the click) and fill it when ready. */
export function openPrintWindow(): Window | null {
  const w = window.open('', '_blank')
  if (!w) { toast.error('Allow pop-ups to print'); return null }
  w.document.write('<p style="font:14px system-ui;padding:24px">Preparing…</p>')
  return w
}

export function writePrint(w: Window, title: string, body: string) {
  w.document.open()
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}
    <div class="foot">Printed ${esc(dateTime(new Date().toISOString()))} · Vlack HRMS — confidential patient information.</div>
    <script>window.onload=()=>{window.print()}</script></body></html>`)
  w.document.close()
}

const VITAL_ROWS: [keyof VitalsView, string, string?][] = [
  ['temperature', 'Temperature', '°F'], ['pulse', 'Pulse', '/min'], ['resp_rate', 'Respiratory rate', '/min'], ['spo2', 'SpO₂', '%'],
  ['o2_support', 'Oxygen support'], ['pain_score', 'Pain score', '/10'], ['weight', 'Weight', 'kg'], ['height', 'Height', 'cm'],
  ['bmi', 'BMI', 'kg/m²'], ['blood_sugar', 'RBS', 'mg/dL'], ['gcs', 'GCS'], ['head_circumference', 'Head circumference', 'cm'],
  ['muac', 'MUAC', 'cm'], ['waist', 'Waist', 'cm'], ['lmp', 'LMP'], ['remarks', 'Remarks'],
]

const ASSESS_ROWS: [string, string][] = [
  ['chief_complaint', 'Chief complaint'], ['pain_location', 'Pain location'], ['fall_risk', 'Fall risk'], ['nutrition_risk', 'Nutrition screen'],
  ['mobility', 'Mobility'], ['lmp', 'LMP'], ['pregnancy_status', 'Pregnancy'], ['smoking', 'Smoking'], ['current_medications', 'Current medications'],
  ['observations', 'Other observations'],
]

/** Print the visit slip with the recorded vitals and nursing assessment of the visit. */
export async function printVisitSlip(v: Visit, hospital: string) {
  const w = openPrintWindow()
  if (!w) return
  try {
    const d = await api<VisitVitals>(`/opd/visits/${v.id}/vitals`)
    const vt = d.vitals
    const kv = (pairs: [string, unknown][]) => pairs.filter(([, x]) => x !== null && x !== undefined && x !== '')
      .map(([k, x]) => `<tr><th>${esc(k)}</th><td>${esc(x)}</td></tr>`).join('')
    const allergies = d.allergies.length ? `<span class="allergy">${esc(d.allergies.map((a) => a.allergen).join(', '))}</span>` : 'None recorded'
    let vitals = '<p>No vitals recorded for this visit.</p>'
    if (vt) {
      const bp = vt.bp_systolic ? `${vt.bp_systolic}/${vt.bp_diastolic ?? '—'} mmHg` : null
      const sbp = vt.standing_bp_systolic ? `${vt.standing_bp_systolic}/${vt.standing_bp_diastolic ?? '—'} mmHg` : null
      vitals = `<table>${kv([['Recorded', dateTime(vt.recorded_at)], ['BP (sitting)', bp], ['BP (standing)', sbp],
        ...VITAL_ROWS.map(([k, label, unit]): [string, unknown] => [label, vt[k] !== null && vt[k] !== undefined ? `${vt[k]}${unit ? ` ${unit}` : ''}` : null]),
        ['NEWS2', vt.news2 !== null && vt.news2 !== undefined ? `${vt.news2}${vt.news2_risk ? ` (${vt.news2_risk})` : ''}` : null]])}</table>`
    }
    const a = d.assessment
    const assess = a ? `<h2>Nursing assessment</h2><table>${kv([
      ...ASSESS_ROWS.map(([k, label]): [string, unknown] => [label, a[k] as unknown]),
      ['Allergies reviewed', a.allergies_reviewed === true ? 'Yes' : a.allergies_reviewed === false ? 'No' : null]])}</table>` : ''
    writePrint(w, `Visit slip ${d.patient.title}`, `<h1>${esc(hospital)}</h1><div class="sub">OP visit slip · ${esc(v.code)}</div>
      <table>${kv([['Patient', d.patient.title], ['UHID', d.patient.code], ['Age / sex', ageSex(d.patient.age, d.patient.gender)],
        ['Visit', [v.date, v.slot, v.type].filter(Boolean).join(' · ')], ['Token', v.token_no], ['Doctor', v.doctor], ['Department', v.department],
        ['Bill', v.bill], ['Checked in', v.in_at ? time(v.in_at) : null]])}<tr><th>Allergies</th><td>${allergies}</td></tr></table>
      <h2>Vitals</h2>${vitals}${assess}`)
  } catch (e) {
    w.close()
    toast.error(errorMessage(e))
  }
}
