/**
 * IPD feature — API types and query hooks for /api/ipchart (backend/app/engines/ipchart.py).
 * Query keys start with ['x', <module>] so realtime change events from that module refresh them.
 */
import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'

export type Status = 'Admitted' | 'Discharge Initiated' | 'Discharged' | 'Cancelled'
export type VitalStatus = 'Normal' | 'Low' | 'High' | 'Critical low' | 'Critical high'

export interface PatientBrief {
  id: string; uhid: string; name: string; gender?: string | null; age?: number | null; dob?: string | null; phone?: string | null
  blood_group?: string | null; aadhaar_last4?: string | null; status?: string | null; payer_type?: string | null
}

export interface Perms {
  admit: boolean; accept: boolean; condition: boolean; clinical: boolean; observe: boolean; order: boolean; void_order: boolean
  indent: boolean; void_indent: boolean; pharmacy_return: boolean; charge: boolean; equipment: boolean; void_usage: boolean
  collect: boolean; discount: boolean; rate_override: boolean; void_charge: boolean; money: boolean; discharge: boolean
  revoke_discharge: boolean; sponsor: boolean; change_patient: boolean; doctor_note: boolean; nursing_note: boolean
  instruct: boolean; consent: boolean; documents: boolean; configure: boolean
  tabs: Record<TabKey, boolean>
  clearance_roles: Record<string, string[]>
}

export type TabKey = 'overview' | 'forms' | 'documents' | 'consent' | 'cath' | 'dietary' | 'doctor' | 'hic' | 'monitoring' | 'nursing'
  | 'order_desk' | 'order_medication' | 'investigations' | 'ot'

export interface VitalPoint {
  id: string; recorded_at: string; bp_systolic: number | null; bp_diastolic: number | null; pulse: number | null; resp_rate: number | null
  spo2: number | null; temperature_c: number | null; blood_sugar: number | null; pain_score: number | null; bmi: number | null
  weight?: number | null; o2_support?: string | null; gcs?: number | null; news2: number | null; news2_risk: string | null
  recorded_by?: string | null; recorded_by_name?: string | null
  status: Record<string, VitalStatus | null>
}

export interface ChartHeader {
  admission: {
    id: string; code: string; status: Status; started_at: string; ended_at?: string | null; diagnosis?: string | null; reason?: string | null
    admission_type?: string; admission_source?: string; payer: string; payer_label: string; authorisation_no?: string | null
    approved_amount?: number | null; package_admission?: boolean; expected_los?: number | null; attendant_name?: string | null
    attendant_phone?: string | null; mlc?: boolean; isolation?: string | null; discharge_type?: string | null
    discharge_initiated_at?: string | null; discharge_initiated_by?: string | null; accepted_at?: string | null; accepted_by?: string | null
    condition: string; condition_at?: string | null; condition_by?: string | null; admitted_by?: string | null
    condition_log: { condition: string; previous: string; by: string; role: string; at: string; note?: string | null }[]
    sponsor_history: { from: Record<string, unknown>; to: Record<string, unknown>; by: string; at: string; reason: string }[]
    sponsor: { id: string; name: string; payer_type?: string } | null
    package: { id: string; name: string; price?: number | null } | null
    los_days: number | null
  }
  patient: PatientBrief
  bed: { id: string; bed_no: string; category?: string; room?: string | null; ward_id?: string; ward?: string; floor?: string | null } | null
  department: { id: string; name: string } | null
  doctor: { id: string; name: string; designation?: string | null } | null
  second_doctor: { id: string; name: string } | null
  allergies: AllergyView
  reactive: ReactiveView
  last_obs: VitalPoint | null
  counts: Record<string, number>
  tracker: { done: number; total: number; next: string | null; steps: Record<string, StepState> }
  permissions: Perms
  options: { conditions: string[]; allergy_types: string[]; reactive: string[]; shifts: string[]; discharge_types: string[]; isolation: string[] }
}

export interface AllergyView { status: 'unknown' | 'nka' | 'present'; nka: boolean; types: string[]; substance?: string | null; list: string[]; by?: string | null; at?: string | null }
export interface ReactiveView { status: 'unknown' | 'non_reactive' | 'reactive'; conditions: string[]; other?: string | null; by?: string | null; at?: string | null; isolation: string }

export type StepState = 'done' | 'in_progress' | 'pending'
export interface TrackerStep { key: string; label: string; done: boolean; at?: string | null; by?: string | null; detail?: string | null; state: StepState; notify_roles: string[] }
export interface ClearanceRow {
  id: string; code: string; department: string; status: string; cleared_at?: string | null; cleared_by?: string | null; hold_reason?: string | null
  remarks?: string | null; roles: string[]; blocker?: string | null; can_sign: boolean; can_hold: boolean
}
export interface Tracker {
  admission: { id: string; code: string; status: Status }
  steps: TrackerStep[]; done: number; total: number; next: string | null; clearances: ClearanceRow[]; configured_clearances: string[]
  notifications: { step: string; roles: string[]; at: string; by: string; message: string }[]; roles: string[]
  billing: { cleared: boolean; invoices: number; balance_due?: number; unbilled_amount?: number }
  can_configure: boolean; can_initiate: boolean; can_revoke: boolean
}

export interface TrackerItem { key: string; label: string; optional: boolean; done: boolean; at?: string | null; by?: string | null; go: { tab: string; sub?: string; action?: string } }
export interface VisitTracker { items: TrackerItem[]; done: number; total: number; pending: number }

export interface AdmissionRow {
  id: string; code: string; status: Status; started_at: string; ended_at?: string | null
  patient: { id: string; name: string; uhid: string; gender?: string | null; age?: number | null; phone?: string | null }
  ward: { id: string | null; name: string | null }; bed_no?: string | null; doctor?: string | null; payer: string; payer_label: string
  sponsor: { id: string; name: string } | null; condition: string; condition_at?: string | null; condition_by?: string | null
  accepted_at?: string | null; accepted_by?: string | null; diagnosis?: string | null; discharge_type?: string | null; isolation?: string | null
  mlc: boolean; los_days: number | null
}

export interface OrderRow {
  id: string; code: string; test: string; category: string; status: string; stage: string; priority: string; indent_no?: string | null
  qty: number; ordered_at: string; ordering_doctor?: string | null; created_by?: string | null; critical: boolean; report_ready: boolean
  verified_at?: string | null; voided_by?: string | null; voided_at?: string | null; void_reason?: string | null; can_void: boolean
  notes?: string | null; rate?: number; discount?: number; total?: number
}

export interface ChargeRow {
  id: string; code: string; at: string; description: string; service?: string | null; category?: string | null; type: string; source?: string | null
  qty: number; status: string; grade?: string | null; performed_by?: string | null; entered_by?: string | null; voided_by?: string | null
  voided_at?: string | null; void_reason?: string | null; can_void: boolean; rate?: number; discount?: number; amount?: number
}

export interface Service {
  id: string; code: string; name: string; category: string; rate?: number | null; rate_private?: number | null; rate_icu?: number | null
  rate_international?: number | null; tat_minutes?: number | null; sample_type?: string | null; modality?: string | null
}

export interface Medicine {
  id: string; code: string; name: string; generic?: string | null; form?: string | null; strength?: string | null; uom?: string | null
  packing: string; available: number | null; schedule?: string | null; high_alert: boolean; type?: string; mrp?: number | null
}

export interface SafetyAlert { type: string; label: string; severity: string; item: string; with?: string | null; message: string; blocking: boolean }

export const K = {
  chart: (id: string) => ['x', 'ipd', 'chart', id] as const,
  vitals: (id: string, w: string) => ['x', 'emr', 'ipchart', id, 'vitals', w] as const,
  overview: (id: string) => ['x', 'orders', 'ipchart', id, 'overview'] as const,
  timeline: (id: string) => ['x', 'ipd', 'ipchart', id, 'timeline'] as const,
  notes: (id: string, kind: string) => ['x', 'emr', 'ipchart', id, 'notes', kind] as const,
  instructions: (id: string) => ['x', 'ipd', 'ipchart', id, 'instructions'] as const,
  consents: (id: string) => ['x', 'consents', 'ipchart', id] as const,
  investigations: (id: string, scope: string) => ['x', 'orders', 'ipchart', id, 'investigations', scope] as const,
  charges: (id: string) => ['x', 'billing', 'ipchart', id, 'charges'] as const,
  indents: (id: string) => ['x', 'pharmacy', 'ipchart', id, 'indents'] as const,
  medicines: (id: string) => ['x', 'pharmacy', 'ipchart', id, 'ledger'] as const,
  returnable: (id: string) => ['x', 'pharmacy', 'ipchart', id, 'returnable'] as const,
  equipment: (id: string) => ['x', 'ipd', 'ipchart', id, 'equipment'] as const,
  tracker: (id: string) => ['x', 'discharge', 'ipchart', id, 'tracker'] as const,
  list: (q: Record<string, unknown>) => ['x', 'ipd', 'admissions', q] as const,
  onBed: (q: Record<string, unknown>) => ['x', 'ipd', 'on-bed', q] as const,
  form: () => ['x', 'ipd', 'admission-form'] as const,
}

/** Every chart-scoped query (refresh after an action that touches several areas). */
export const chartScope = (qc: { invalidateQueries: (f: { predicate: (q: { queryKey: readonly unknown[] }) => boolean }) => unknown }, id: string) =>
  qc.invalidateQueries({ predicate: (q) => q.queryKey.includes(id) })

export function useChart(id: string) {
  return useQuery({ queryKey: K.chart(id), queryFn: () => api<ChartHeader>(`/ipchart/admissions/${id}`), enabled: !!id, staleTime: 10_000 })
}

export function useTracker(id: string, enabled = true) {
  return useQuery({ queryKey: K.tracker(id), queryFn: () => api<Tracker>(`/ipchart/admissions/${id}/tracker`), enabled: !!id && enabled })
}

/** Optional endpoints owned by other work packages: a 404 / 403 resolves to null instead of an error. */
export async function optional<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T | null> {
  try {
    return await api<T>(path, { query })
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 405)) return null
    throw e
  }
}

/** Count of patient-tagged internal messages (W1 messaging) — tolerant of shape and absence. */
export function useMessageCount(patientId?: string, encounterId?: string) {
  return useQuery({
    queryKey: ['x', 'messaging', 'chart-count', patientId, encounterId],
    queryFn: async () => {
      const r = await optional<unknown>('/messages', { patient_id: patientId, encounter_id: encounterId, limit: 50 })
      if (!r) return null
      if (Array.isArray(r)) return r.length
      const o = r as Record<string, unknown>
      if (typeof o.total === 'number') return o.total
      if (typeof o.count === 'number') return o.count
      if (Array.isArray(o.rows)) return o.rows.length
      return null
    },
    enabled: !!patientId,
    staleTime: 30_000,
  })
}

/** Settlement status from IP billing (W8) — tolerant reader; null when not available. */
export interface Settlement { settled: boolean; label: string; paid?: number | null; balance?: number | null }
export function useSettlement(admissionId: string, enabled = true) {
  return useQuery({
    queryKey: ['x', 'billing', 'ipbilling-summary', admissionId],
    queryFn: async (): Promise<Settlement | null> => {
      const r = await optional<Record<string, unknown>>(`/ipbilling/admissions/${admissionId}/summary`)
      if (!r) return null
      const pick = (...keys: string[]) => {
        for (const k of keys) {
          const parts = k.split('.')
          let v: unknown = r
          for (const p of parts) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined
          if (v !== undefined && v !== null) return v
        }
        return undefined
      }
      const balance = Number(pick('balance_due', 'balance', 'totals.balance_due', 'summary.balance_due') ?? NaN)
      const paid = Number(pick('paid', 'collected', 'totals.paid', 'summary.paid') ?? NaN)
      const status = String(pick('settlement_status', 'status', 'bill_status') ?? '')
      const settled = Boolean(pick('settled', 'is_settled')) || /settled|paid/i.test(status) || (!Number.isNaN(balance) && balance <= 0 && !Number.isNaN(paid) && paid > 0)
      return { settled, label: status || (settled ? 'Settled' : 'Pending'), paid: Number.isNaN(paid) ? null : paid, balance: Number.isNaN(balance) ? null : balance }
    },
    enabled: !!admissionId && enabled,
    staleTime: 30_000,
  })
}

export const PAYER_TONE: Record<string, 'violet' | 'gray' | 'blue' | 'cyan'> = { Corporate: 'violet', Insurance: 'blue', 'Government Scheme': 'cyan', Cash: 'gray' }

export function conditionTone(c?: string | null): 'red' | 'amber' | 'green' | 'gray' | 'blue' {
  switch (c) {
    case 'Critical': return 'red'
    case 'Serious': return 'amber'
    case 'Guarded': return 'amber'
    case 'Fair': return 'blue'
    case 'Stable': return 'green'
    default: return 'gray'
  }
}

export function vitalTone(s?: string | null): 'green' | 'amber' | 'red' | 'gray' {
  if (!s) return 'gray'
  if (s.startsWith('Critical')) return 'red'
  if (s === 'Normal') return 'green'
  return 'amber'
}

export const ROLE_LABEL: Record<string, string> = {
  doctor: 'Doctors', nurse: 'Nurses', front_office: 'Front office', billing: 'Billing', pharmacist: 'Pharmacy', lab: 'Laboratory',
  radiology: 'Radiology', support: 'Support services', quality: 'Quality', management: 'Management',
}

/** Client-side CSV download for small in-page tables. */
export function downloadCsv(name: string, columns: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = [columns, ...rows].map((r) => r.map(esc).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
